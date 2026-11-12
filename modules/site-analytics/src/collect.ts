import { and, desc, eq, gte, type SiteRouteContext, z } from "@webcraft/module-sdk";

import { startOf } from "./rollups.ts";
import { events, settings } from "./tables.ts";
import { browserOf, deviceOf, isBot, osOf, sourceHost } from "./visitors.ts";

/** A visit ends after this long without an event. */
export const VISIT_GAP_MS = 30 * 60 * 1000;

/**
 * What the collection path keeps is what anyone can make a Site's analytics show and store, so each
 * value is held to the shape the collection script sends, and anything else is refused (400).
 */

/** The longest page path and link address kept. */
export const MAX_PATH_LENGTH = 500;
/** The longest campaign word (`utm_source`, `utm_medium`, `utm_campaign`) and custom event name kept. */
export const MAX_WORD_LENGTH = 100;

/**
 * A page's path as a browser writes it (`location.pathname`): from `/`, the characters of a URL path
 * only (anything else arrives percent-encoded), no empty part, so never a query, a fragment, a space,
 * markup or another host.
 */
const pagePath = z
	.string()
	.max(MAX_PATH_LENGTH)
	.regex(/^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/)
	.refine((path) => !path.includes("//"));

/** Words a person chose (a campaign's, a custom event's name): any letters, no control or invisible characters. */
const words = z
	.string()
	.max(MAX_WORD_LENGTH)
	.regex(/^[^\p{C}\p{Zl}\p{Zp}]*$/u);

/** Where a link goes: an address or a path, without spaces, control or invisible characters. */
const linkAddress = z
	.string()
	.min(1)
	.max(MAX_PATH_LENGTH)
	.regex(/^[^\s\p{C}]+$/u);

/** One event as the collection script sends it (see `script.ts`). */
const incoming = z.object({
	t: z.enum(["pageview", "consent", "link", "event"]),
	p: pagePath,
	r: z.string().max(253).nullish(),
	us: words.nullish(),
	um: words.nullish(),
	uc: words.nullish(),
	/** The visitor came from another page of the Site: not an arrival, so it has no source. */
	i: z.union([z.literal(0), z.literal(1)]).optional(),
	w: z.number().int().min(0).max(100_000).optional(),
	n: words.min(1).optional(),
	h: linkAddress.optional(),
	c: z.union([z.literal(0), z.literal(1)]).optional(),
});

const LINK_KINDS = new Set(["outbound", "download", "tel", "mailto"]);

const answer = (status: number) =>
	new Response(status === 204 ? null : String(status), {
		status,
		headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
	});

/**
 * Takes one event from the collection script, `POST /_wc/m/analytics/event` on the Site's own
 * domain. WebCraft has already refused requests over the per-address limit or the size limit. Every
 * accepted request answers 204, whether it was counted or left out, so nobody learns what is counted.
 *
 * Left out (nothing kept): Staging addresses, anyone of the Install (an Edit mode session or an
 * address signed in to the admin), programs (by user agent), the Site's excluded address ranges,
 * and browsers sending Do Not Track or Global Privacy Control. Before Analytics consent only page
 * views are counted, with no visitor id; everything else waits for consent.
 */
export async function collect(request: Request, context: SiteRouteContext): Promise<Response> {
	if (!fromSitePages(request)) return answer(403);
	const type = (request.headers.get("content-type") ?? "text/plain").split(";")[0]?.trim().toLowerCase();
	if (type !== "text/plain" && type !== "application/json") return answer(415);
	let body: z.infer<typeof incoming>;
	try {
		const parsed = incoming.safeParse(JSON.parse(await request.text()));
		if (!parsed.success) return answer(400);
		body = parsed.data;
	} catch {
		return answer(400);
	}
	if (body.t === "link" && (!body.n || !LINK_KINDS.has(body.n) || !body.h)) return answer(400);
	if (body.t === "event" && !body.n) return answer(400);
	if (await leftOut(request, context)) return answer(204);

	const consent = await context.visitor.consent();
	const pageAccepted = body.c === 1;
	const accepted = consent.has("analytics") || (consent.asks === "outside" && pageAccepted);
	// Before consent, page views only: nothing else is kept.
	if (!accepted && body.t !== "pageview") return answer(204);
	const visitor = accepted ? await context.visitor.dailyId("analytics", { acceptedInPage: pageAccepted }) : null;

	const now = context.now();
	let visit: string | null = null;
	let startsVisit = false;
	let last: typeof events.$inferSelect | undefined;
	if (visitor) {
		last = await context.data.first(
			events,
			and(eq(events.visitor, visitor), gte(events.occurredAt, new Date(now.getTime() - VISIT_GAP_MS))),
			{ orderBy: [desc(events.occurredAt)] },
		);
		// Accepting on a page whose view was counted starts a visit; within one there is nothing to add.
		if (body.t === "consent" && last) return answer(204);
		visit = last?.visit ?? crypto.randomUUID();
		startsVisit = !last;
	} else if (body.t === "consent") {
		return answer(204);
	}

	const userAgent = request.headers.get("user-agent") ?? "";
	// Sources count arrivals: from another site, a campaign's link, or typed in (direct, empty).
	const campaignSource = body.us?.trim().toLowerCase();
	const source = campaignSource || (body.i === 1 ? null : sourceHost(body.r));
	// A visit's events all carry where it came from; before consent a page view is its own visit.
	const visitSource = last ? last.visitSource : source;
	await context.data.insert(events, {
		occurredAt: now,
		hour: startOf("hour", now),
		day: startOf("day", now),
		type: body.t,
		name: body.t === "link" || body.t === "event" ? (body.n ?? null) : null,
		target: body.t === "link" ? (body.h ?? null) : null,
		path: body.p,
		source,
		medium: body.um?.trim().toLowerCase() || null,
		campaign: body.uc?.trim() || null,
		country: await context.visitor.country(),
		device: deviceOf(userAgent, body.w),
		browser: browserOf(userAgent),
		os: osOf(userAgent),
		visitor,
		visit,
		startsVisit,
		visitSource,
	});
	return answer(204);
}

/** Whether the request is one Site analytics leaves out. */
async function leftOut(request: Request, context: SiteRouteContext): Promise<boolean> {
	const { headers } = request;
	if (context.visitor.via === "staging") return true;
	if (headers.get("dnt") === "1" || headers.get("sec-gpc") === "1") return true;
	if (isBot(headers.get("user-agent"))) return true;
	if (await context.visitor.signedIn()) return true;
	const row = await context.data.first(settings);
	const ranges = Array.isArray(row?.excludedRanges) ? (row.excludedRanges as string[]) : [];
	return ranges.length > 0 && context.visitor.inRanges(ranges);
}

/**
 * Whether a post comes from the Site's own pages: `Sec-Fetch-Site: same-origin`, or an `Origin` on the
 * same host where the browser doesn't say. No other site can send events for a Site.
 */
function fromSitePages(request: Request): boolean {
	const fetchSite = request.headers.get("sec-fetch-site");
	if (fetchSite !== null) return fetchSite === "same-origin";
	const origin = request.headers.get("origin");
	if (!origin) return false;
	try {
		return new URL(origin).host === new URL(request.url).host;
	} catch {
		return false;
	}
}
