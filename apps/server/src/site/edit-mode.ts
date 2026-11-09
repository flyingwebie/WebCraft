import {
	EDIT_MODE_PATH,
	type EditSession,
	type InstallServices,
	isDevelopmentHostname,
	type PageEditing,
	RateLimitedError,
	type SiteHost,
} from "@webcraft/core";

import { clientAddress } from "../client-address.ts";
import { plainText } from "../responses.ts";
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
	if (url.pathname.startsWith(EDIT_ASSETS_PATH)) {
		if (request.method !== "GET" && request.method !== "HEAD") {
			return plainText(405, "Method Not Allowed", { allow: "GET, HEAD" });
		}
		return assetFile(request, url.pathname.slice(EDIT_ASSETS_PATH.length));
	}
	return plainText(404, "Not Found", { "x-robots-tag": "noindex" });
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
