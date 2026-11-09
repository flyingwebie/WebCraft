import type { ModuleApi } from "@webcraft/module-sdk";
import type siteAnalytics from "@webcraft/module-site-analytics";

import { fromAddress, type TestBrowser, type TestInstall } from "./index.ts";
import { moduleApi } from "./modules.ts";

/** Where the collection script posts, on a Site's own domain. */
export const COLLECT_PATH = "/_wc/m/analytics/event";

/** A person's browser on a computer, as its user agent says. */
export const DESKTOP_CHROME =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
/** A person's phone. */
export const IPHONE_SAFARI =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

/** One event, as the collection script sends it (`modules/site-analytics/src/script.ts`). */
export type CollectedEvent = {
	t: "pageview" | "consent" | "link" | "event";
	p: string;
	r?: string;
	us?: string | null;
	um?: string | null;
	uc?: string | null;
	i?: 0 | 1;
	w?: number;
	n?: string;
	h?: string;
	c?: 0 | 1;
};

export type AnalyticsVisitor = {
	/** Sends an event as the collection script does: from the Site's own page, with the visitor's cookies. */
	send(event: CollectedEvent, options?: { headers?: Record<string, string> }): Promise<Response>;
	/** Sends a page view of `path`. */
	view(path: string, extra?: Partial<CollectedEvent>): Promise<Response>;
	/** Answers the Site's Consent banner as the consent script does, keeping the cookie it sets. */
	answer(choices: { analytics: boolean; marketing?: boolean; media?: boolean }): Promise<void>;
	/** The visitor's cookies, as `name=value` pairs. */
	readonly cookies: Map<string, string>;
};

/**
 * A visitor's browser on a Site's origin, sending what the collection script sends: from `address`
 * (a documentation address the test Install places in a country, see `countries.ts`), with a user agent.
 */
export function analyticsVisitor(
	install: TestInstall,
	origin: string,
	options: { address?: string; userAgent?: string } = {},
): AnalyticsVisitor {
	const address = options.address ?? "203.0.113.7";
	const userAgent = options.userAgent ?? DESKTOP_CHROME;
	const cookies = new Map<string, string>();
	const headers = (extra: Record<string, string> = {}) => {
		const sent = new Headers({ "user-agent": userAgent, "sec-fetch-site": "same-origin", ...extra });
		if (cookies.size > 0) sent.set("cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
		return sent;
	};
	const visitor: AnalyticsVisitor = {
		cookies,
		send(event, sendOptions = {}) {
			const request = new Request(`${origin}${COLLECT_PATH}`, {
				method: "POST",
				headers: headers({ "content-type": "text/plain;charset=UTF-8", ...sendOptions.headers }),
				body: JSON.stringify(event),
			});
			return install.request(fromAddress(request, address));
		},
		view(path, extra = {}) {
			return visitor.send({ t: "pageview", p: path, r: "", w: 1280, ...extra });
		},
		async answer(choices) {
			const request = new Request(`${origin}/_wc/consent`, {
				method: "POST",
				headers: headers({ "content-type": "application/json" }),
				body: JSON.stringify({
					choices: {
						analytics: choices.analytics,
						marketing: choices.marketing ?? false,
						media: choices.media ?? false,
					},
					version: 1,
					language: "en",
				}),
			});
			const response = await install.request(fromAddress(request, address));
			if (response.status !== 201) throw new Error(`The Consent banner answered ${response.status}.`);
			for (const line of response.headers.getSetCookie()) {
				const [pair = ""] = line.split(";");
				const separator = pair.indexOf("=");
				cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
			}
		},
	};
	return visitor;
}

/** Site analytics' procedures, as the admin calls them. */
export function analyticsApi(browser: TestBrowser): ModuleApi<typeof siteAnalytics> {
	return moduleApi<typeof siteAnalytics>(browser, "site-analytics");
}

/** A day's range, from midnight to midnight (UTC). */
export function dayOf(time: Date): { from: Date; to: Date } {
	const from = new Date(Date.UTC(time.getUTCFullYear(), time.getUTCMonth(), time.getUTCDate()));
	return { from, to: new Date(from.getTime() + 24 * 60 * 60 * 1000) };
}

/**
 * A Site with a published home page, live on its own domain (verified, so it answers there), with
 * Site analytics switched on: its origin, and its Staging address's.
 */
export async function liveSite(
	install: TestInstall,
	staff: TestBrowser,
	workspaceId: string,
	domain: string,
): Promise<{ siteId: string; origin: string; staging: string }> {
	const { id: siteId, slug } = await install.createSite(workspaceId, { name: "Bakery" });
	const pages = (await staff.api.postTypes.list({ siteId })).postTypes.find((postType) => postType.builtIn === "page");
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: pages?.id as string, title: "Home" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.pages.setHomePage({ siteId, pageId: entry.id });
	await staff.api.domains.add({ siteId, name: domain });
	install.connectDomain(domain);
	await install.clock.advance(60_000);
	const drained = await install.drainJobs();
	if (drained.failed.length > 0) throw new Error(`Jobs failed: ${drained.failed.map((job) => job.name).join(", ")}`);
	await staff.api.modules.setOnSite({ siteId, moduleId: "site-analytics", on: true });
	return { siteId, origin: `https://${domain}`, staging: `https://${slug}.sites.test` };
}
