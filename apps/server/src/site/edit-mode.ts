import { ORPCError } from "@orpc/server";
import { toApiError } from "@webcraft/api";
import {
	type AdminLanguageCode,
	EDIT_MODE_PATH,
	type EditSession,
	type InstallServices,
	isAdminLanguage,
	isDevelopmentHostname,
	type PageEditing,
	RateLimitedError,
	type SiteHost,
} from "@webcraft/core";
import { z } from "zod";

import { clientAddress } from "../client-address.ts";
import en from "../messages/en.json" with { type: "json" };
import it from "../messages/it.json" with { type: "json" };
import { json, plainText } from "../responses.ts";
import { EDIT_ASSETS_PATH, editBarAssets } from "./edit-bar/assets.ts";

/**
 * Edit mode on a Site's own domain (ADR 0022), at the path the Install keeps for it,
 * `/_webcraft/edit/…`: following an "Edit on site" link sets the edit cookie. Answers null for
 * paths outside it.
 */
export async function editModeEndpoint(
	services: InstallServices,
	request: Request,
	host: SiteHost,
): Promise<Response | null> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith(EDIT_MODE_PATH)) return null;
	const rest = url.pathname.slice(EDIT_MODE_PATH.length);
	if (rest === "enter") {
		if (request.method !== "GET") return plainText(405, "Method Not Allowed", { allow: "GET" });
		return enter(services, request, host, url.searchParams.get("token") ?? "");
	}
	if (rest.startsWith(EDIT_API_PREFIX)) return editRequest(services, request, host, rest.slice(EDIT_API_PREFIX.length));
	if (url.pathname.startsWith(EDIT_ASSETS_PATH)) {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return plainText(405, "Method Not Allowed", { allow: "GET, HEAD" });
		}
		return assetFile(request, url.pathname.slice(EDIT_ASSETS_PATH.length));
	}
	return plainText(404, "Not Found", { "x-robots-tag": "noindex" });
}

/** The editing bar's words, by Admin language: the `editBar` part of the admin's message files. */
const BAR_WORDS: Record<AdminLanguageCode, (typeof en)["editBar"]> = { en: en.editBar, it: it.editBar };

/** Where the editing bar sends edit requests, under `/_webcraft/edit/`: `api/<action>`. */
const EDIT_API_PREFIX = "api/";

/** The header edit requests carry the Edit mode session's header token in. */
export const EDIT_TOKEN_HEADER = "x-webcraft-edit-token";

/** What an edit request may do, by action: each gets the session and the request's JSON body. */
const EDIT_ACTIONS: Readonly<Record<string, EditAction>> = {
	/** Saves a value typed in place to the Draft. */
	save: async (services, session, body) => json(200, await services.editMode.save(session, parse(regionChange, body))),
	/**
	 * What the editing bar shows for a page: its changes, the Site's pages, who is editing, and the
	 * bar's words in the person's Admin language.
	 */
	state: async (services, session, body, _request, host) => {
		const state = await services.editMode.pageState(session, host, parse(pagePath, body).path);
		const chosen = state.person.adminLanguage;
		const language = chosen && isAdminLanguage(chosen) ? chosen : (await services.settings.read()).defaultAdminLanguage;
		return json(200, { ...state, words: BAR_WORDS[language] });
	},
	/** Undoes one of the page's changes. */
	undo: async (services, session, body, _request, host) =>
		json(200, await services.editMode.undo(session, host, parse(pageChange, body))),
	/** Discards every change of the page. */
	discard: async (services, session, body, _request, host) =>
		json(200, await services.editMode.discard(session, host, parse(pagePath, body).path)),
	/** Publishes the page's changes. */
	publish: async (services, session, body, _request, host) =>
		json(200, await services.editMode.publish(session, host, parse(pagePath, body).path)),
	/** Ends Edit mode for this browser: the cookie is cleared and opens nothing any more. */
	end: async (services, session, _body, request) => {
		await services.editMode.end(session);
		const response = json(200, { ended: true });
		response.headers.append("set-cookie", clearEditCookie(request));
		return response;
	},
};

type EditAction = (
	services: InstallServices,
	session: EditSession,
	body: unknown,
	request: Request,
	host: SiteHost,
) => Promise<Response>;

const pagePath = z.object({ path: z.string().max(2000) });

const pageChange = z.object({ path: z.string().max(2000), item: z.string().max(100), key: z.string().max(200) });

const regionChange = z.object({
	item: z.string().max(100),
	field: z.string().max(200),
	value: z.string().max(200_000),
});

/** A body that isn't what the action takes. */
class BadEditRequest extends Error {}

function parse<Schema extends z.ZodType>(schema: Schema, body: unknown): z.infer<Schema> {
	const parsed = schema.safeParse(body);
	if (!parsed.success) throw new BadEditRequest("The request isn't what this action takes.");
	return parsed.data;
}

/**
 * An edit request from the editing bar (ADR 0022). Each one is checked from scratch: it must be a
 * `POST` from the Site's own pages (its `Origin`, and `Sec-Fetch-Site` when the browser sends it),
 * carry an edit cookie whose session still holds (the admin session it came from, the person's
 * access to the Site, at most 8 hours), and that session's header token, which no other site can
 * read. Refusals answer JSON with a code, as the Management API does.
 */
async function editRequest(
	services: InstallServices,
	request: Request,
	host: SiteHost,
	action: string,
): Promise<Response> {
	if (request.method !== "POST") return plainText(405, "Method Not Allowed", { allow: "POST" });
	if (!fromSitePages(request)) {
		return json(403, { code: "EDIT_REQUEST_REFUSED", message: "Edit requests must come from the Site's own pages." });
	}
	const edit = await editSessionOf(services, request, host);
	if (!edit.session) {
		const ended = json(401, { code: "EDIT_MODE_ENDED", message: "Edit mode has ended. Open it again from the admin." });
		if (edit.stale) ended.headers.append("set-cookie", clearEditCookie(request));
		return ended;
	}
	const token = request.headers.get(EDIT_TOKEN_HEADER) ?? "";
	if (!(await services.editMode.checkHeaderToken(edit.session, token))) {
		return json(403, { code: "EDIT_REQUEST_REFUSED", message: "The request has no valid Edit mode token." });
	}
	const answer = Object.hasOwn(EDIT_ACTIONS, action) ? EDIT_ACTIONS[action] : undefined;
	if (!answer) return json(404, { code: "NOT_FOUND", message: "There is no such edit request." });
	try {
		const contentType = request.headers.get("content-type") ?? "";
		if (!/^application\/json(;|$)/i.test(contentType)) throw new BadEditRequest("Send the request as JSON.");
		const body: unknown = await request.json().catch(() => {
			throw new BadEditRequest("The request isn't valid JSON.");
		});
		return await answer(services, edit.session, body, request, host);
	} catch (error) {
		if (error instanceof BadEditRequest) return json(400, { code: "BAD_REQUEST", message: error.message });
		const refusal = toApiError(error);
		if (!(refusal instanceof ORPCError)) throw error;
		return json(refusal.status, { code: refusal.code, message: refusal.message, data: refusal.data });
	}
}

/**
 * Whether a request comes from the Site's own pages: its `Origin` is the Site's, and the browser
 * (when it says) calls it same-origin. Browsers send `Origin` with every `POST`, so a request without
 * one doesn't come from a page in Edit mode.
 */
function fromSitePages(request: Request): boolean {
	const fetchSite = request.headers.get("sec-fetch-site");
	if (fetchSite !== null && fetchSite !== "same-origin") return false;
	const origin = request.headers.get("origin");
	if (!origin) return false;
	try {
		return new URL(origin).host === new URL(request.url).host;
	} catch {
		return false;
	}
}

/**
 * One of the editing bar's files. Each is named by the hash of its content, so browsers keep it for
 * a year; it holds nothing about the Site or the person, so anyone may load it.
 */
async function assetFile(request: Request, name: string): Promise<Response> {
	const file = (await editBarAssets()).byName.get(name);
	if (!file) return plainText(404, "Not Found", { "x-robots-tag": "noindex" });
	return new Response(request.method === "HEAD" ? null : file.body, {
		headers: {
			"content-type": file.contentType,
			"cache-control": "public, max-age=31536000, immutable",
			"x-content-type-options": "nosniff",
			"x-robots-tag": "noindex",
		},
	});
}

/**
 * Whether a page request comes in Edit mode: the Edit mode session its edit cookie holds, checked
 * again (the admin session it came from, the person's access). `stale` when it carries an edit
 * cookie that no longer opens Edit mode: the answer clears it.
 */
export async function editSessionOf(
	services: InstallServices,
	request: Request,
	host: SiteHost,
): Promise<{ session: EditSession; stale: false } | { session: null; stale: boolean }> {
	const cookie = cookieValue(request, editCookieName(new URL(request.url).hostname));
	if (!cookie) return { session: null, stale: false };
	const session = await services.editMode.session(host, cookie);
	return session ? { session, stale: false } : { session: null, stale: true };
}

/**
 * The policy pages in Edit mode are sent with (ADRs 0022, 0023): scripts and stylesheets only from
 * the Site's own domain, so no outside script runs with the person's edit session; the page can't be
 * framed by another site, nor post forms or change its base address.
 */
const EDIT_MODE_POLICY = [
	"default-src 'self'",
	"script-src 'self'",
	"style-src 'self'",
	"img-src 'self' data: https:",
	"media-src 'self' https:",
	"font-src 'self'",
	"connect-src 'self'",
	"frame-src https:",
	"object-src 'none'",
	"base-uri 'none'",
	"form-action 'self'",
	"frame-ancestors 'none'",
].join("; ");

/** Headers on every page in Edit mode: never kept by anyone, never indexed, under the strict policy. */
export const EDIT_MODE_PAGE_HEADERS: Readonly<Record<string, string>> = {
	"cache-control": "no-store",
	"x-robots-tag": "noindex, nofollow",
	"referrer-policy": "same-origin",
	"x-content-type-options": "nosniff",
	"content-security-policy": EDIT_MODE_POLICY,
};

/** What a page needs to render for Edit mode: the person's scope, and WebCraft's files in <head>. */
export async function pageEditing(session: EditSession): Promise<PageEditing> {
	const files = await editBarAssets();
	return {
		scope: session.scope,
		head: {
			meta: [["webcraft-edit-token", session.headerToken]],
			scripts: [files.script.path],
			stylesheets: [files.pageStyles.path],
		},
	};
}

/** A page in Edit mode, as HTML with Edit mode's headers. */
export function editModeHtml(status: number, html: string): Response {
	return new Response(html, {
		status,
		headers: { "content-type": "text/html; charset=utf-8", ...EDIT_MODE_PAGE_HEADERS },
	});
}

/** The `Set-Cookie` line that clears an edit cookie that no longer opens Edit mode. */
export function clearEditCookie(request: Request): string {
	return editCookie(new URL(request.url).hostname, "", 0);
}

/** One cookie's value from a request's `Cookie` header. */
function cookieValue(request: Request, name: string): string | undefined {
	for (const part of (request.headers.get("cookie") ?? "").split(";")) {
		const separator = part.indexOf("=");
		if (separator > 0 && part.slice(0, separator).trim() === name) return part.slice(separator + 1).trim() || undefined;
	}
	return undefined;
}

/**
 * Follows an "Edit on site" link: uses it up, sets the edit cookie and sends the browser on to the
 * page, so the link's token never stays in the address bar or the history. A link that doesn't work
 * (used, expired, another Site's) says so plainly.
 */
async function enter(services: InstallServices, request: Request, host: SiteHost, token: string): Promise<Response> {
	const headers = { "referrer-policy": "no-referrer", "x-robots-tag": "noindex" };
	try {
		// The link holds a token, so trying links is limited like signing in.
		await services.rateLimits.hit("auth", clientAddress(request, services.config));
	} catch (error) {
		if (!(error instanceof RateLimitedError)) throw error;
		return plainText(429, "Too many attempts. Wait a moment, then try again.", {
			...headers,
			"retry-after": String(error.retryAfterSeconds),
		});
	}
	const entered = token ? await services.editMode.enter(host, token) : null;
	if (!entered) {
		return plainText(
			403,
			"This Edit mode link has expired or was used already. Open Edit mode again from the admin.",
			headers,
		);
	}
	const hostname = new URL(request.url).hostname;
	const maxAge = Math.max(0, Math.floor((entered.expiresAt.getTime() - services.clock.now().getTime()) / 1000));
	return new Response(null, {
		status: 303,
		headers: {
			location: entered.path,
			"cache-control": "no-store",
			"set-cookie": editCookie(hostname, entered.cookie, maxAge),
			...headers,
		},
	});
}

/**
 * The edit cookie's name: with the `__Host-` prefix (only this hostname, `Secure`, path `/`), except
 * on a plain-HTTP development hostname under `.localhost`.
 */
export function editCookieName(hostname: string): string {
	return isDevelopmentHostname(hostname) ? "webcraft-edit" : "__Host-webcraft-edit";
}

/** The `Set-Cookie` line for the edit cookie: `HttpOnly`, `Secure` (but in development), `SameSite=Lax`. */
function editCookie(hostname: string, value: string, maxAge: number): string {
	const secure = isDevelopmentHostname(hostname) ? "" : "; Secure";
	return `${editCookieName(hostname)}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly${secure}; SameSite=Lax`;
}
