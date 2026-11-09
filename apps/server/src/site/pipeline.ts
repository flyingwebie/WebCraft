import {
	canonicalPath,
	type EditSession,
	type InstallServices,
	isReservedPath,
	MEDIA_PATH,
	normaliseHostname,
	pathSegments,
	type SiteHost,
} from "@webcraft/core";

import { matchesETag, mediaFileResponse } from "../media-response.ts";
import { type Handler, notFound, plainText, readOnly } from "../responses.ts";
import {
	clearEditCookie,
	EDIT_MODE_PAGE_HEADERS,
	editModeEndpoint,
	editModeHtml,
	editSessionOf,
	pageEditing,
} from "./edit-mode.ts";
import { type CachedPage, createPageCache, type PageCache } from "./page-cache.ts";

export type SitePipelineOptions = {
	/** The page cache; a new one holding the default amount unless given. */
	pageCache?: PageCache;
};

/**
 * The Site request pipeline: every hostname other than the admin host comes here (ADR 0004). It
 * resolves the hostname to a Site (its Staging address, `<site slug>.<sites domain>`, for now), keeps
 * the paths the Install reserves (`/_…`, and files such as `/robots.txt`) apart (Media files answer at
 * `/_media/…`, never kept as pages), then answers the page
 * at the URL from the page cache, rendering and keeping it on a miss: an Entry by its Post Type's URL
 * pattern, else a Page by its path (the home page at `/`). A path with no page gets the Site's 404
 * page. Hostnames that are no Site's get the unbranded 404, and nothing here ever reaches the admin.
 *
 * Steps still to come, in their places: Redirect domains and Redirect rules before everything else,
 * language prefixes and domains, each reserved path's feature (Forms, the Content API,
 * Modules, `sitemap.xml`, `robots.txt`, `llms.txt`, Markdown copies), and the 404 log.
 */
export function createSitePipeline(services: InstallServices, options: SitePipelineOptions = {}): Handler {
	const cache = options.pageCache ?? createPageCache();
	return async (request) => {
		const url = new URL(request.url);
		const host = await services.sitePages.resolveHost(normaliseHostname(url.hostname));
		if (!host) return notFound();
		const editing = await editModeEndpoint(services, request, host);
		if (editing) return editing;
		return readOnly(request, async () => {
			if (url.pathname === MEDIA_PATH.slice(0, -1) || url.pathname.startsWith(MEDIA_PATH)) {
				return mediaFile(services, request, host, url.pathname.slice(MEDIA_PATH.length));
			}
			const segments = pathSegments(url.pathname);
			// Paths the Install keeps: each feature answers its own; until then, a plain 404.
			if (segments && isReservedPath(segments)) return plainText(404, "Not Found", addressHeaders(host));
			const edit = await editSessionOf(services, request, host);
			if (edit.session) return editModePage(services, host, edit.session, url.pathname);
			const page = await visitorPage(services, cache, request, host);
			return edit.stale ? withEditCookieCleared(request, page) : page;
		});
	};
}

/**
 * The page visitors get at the URL, from the page cache, rendering and keeping it on a miss. Pages
 * are kept by normalised URL: one form of the path, and no query parameters (no parameter changes a
 * page yet; Filters will allow theirs, sorted).
 */
async function visitorPage(services: InstallServices, cache: PageCache, request: Request, host: SiteHost) {
	const { pathname } = new URL(request.url);
	const segments = pathSegments(pathname);
	if (!segments) return notFoundPage(services, host);
	const key = canonicalPath(segments);
	const cached = cache.get(host.site.id, host.cacheGeneration, key);
	if (cached) return pageResponse(request, host, cached, "HIT");
	const answer = await services.sitePages.render(host, pathname);
	if (!answer) return notFoundPage(services, host);
	if (answer.kind === "redirect") return redirect(host, answer.location);
	const page = { html: answer.html, etag: await etagOf(answer.html) };
	cache.set(host.site.id, host.cacheGeneration, key, page);
	return pageResponse(request, host, page, "MISS");
}

/**
 * The page at a path in Edit mode: the same page visitors would get, rendered afresh for the person
 * with the Drafts of its Content and its editable regions tagged. It never touches the page cache.
 */
async function editModePage(
	services: InstallServices,
	host: SiteHost,
	session: EditSession,
	pathname: string,
): Promise<Response> {
	const editing = await pageEditing(session);
	const answer = pathSegments(pathname) ? await services.sitePages.render(host, pathname, editing) : null;
	if (answer?.kind === "redirect") {
		return new Response(null, { status: 301, headers: { location: answer.location, ...EDIT_MODE_PAGE_HEADERS } });
	}
	if (answer) return editModeHtml(200, answer.html);
	return editModeHtml(404, (await services.sitePages.notFound(host, editing)).html);
}

/**
 * A visitor's answer to a request whose edit cookie no longer opens Edit mode (its admin session
 * signed out, access lost, run out): the cookie is cleared, and an answer setting a cookie is never kept.
 */
function withEditCookieCleared(request: Request, response: Response): Response {
	const headers = new Headers(response.headers);
	headers.append("set-cookie", clearEditCookie(request));
	headers.set("cache-control", "no-store");
	return new Response(response.body, { status: response.status, headers });
}

/**
 * Media files are named by their content hash (ADR 0026): a name always holds the same bytes, so
 * browsers, the page cache and CDNs may keep them for a year without asking again.
 */
const MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";

/** A Media file of the Site, `/_media/<hash>-<name>`: an original or a variant, never a raw upload. */
async function mediaFile(services: InstallServices, request: Request, host: SiteHost, name: string): Promise<Response> {
	const file = await services.sitePages.mediaFile(host, name);
	const response = file
		? await mediaFileResponse(request, file, { "cache-control": MEDIA_CACHE_CONTROL, ...addressHeaders(host) })
		: null;
	if (file && !response) {
		services.log.error("A Media file is missing from storage", { siteId: host.site.id, name });
	}
	return response ?? plainText(404, "Not Found", addressHeaders(host));
}

/**
 * Pages may be kept, but must be checked with the server each time (it answers 304 while the ETag
 * holds): a publish changes them at once, and nothing can clear a browser's copy.
 */
const PAGE_CACHE_CONTROL = "public, max-age=0, must-revalidate";

function pageResponse(request: Request, host: SiteHost, page: CachedPage, cacheStatus: "HIT" | "MISS"): Response {
	const headers: Record<string, string> = {
		"cache-control": PAGE_CACHE_CONTROL,
		etag: page.etag,
		"x-cache": cacheStatus,
		"x-content-type-options": "nosniff",
		...addressHeaders(host),
	};
	if (matchesETag(request.headers.get("if-none-match"), page.etag)) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(page.html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

/**
 * A path with no page on a known Site: the Site's 404 page, with status 404. It is never kept in the
 * page cache, nor by browsers and proxies, so every miss reaches the Site (and its 404 log) and a page
 * published at the path shows at once.
 */
async function notFoundPage(services: InstallServices, host: SiteHost): Promise<Response> {
	const page = await services.sitePages.notFound(host);
	return new Response(page.html, {
		status: 404,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			...addressHeaders(host),
		},
	});
}

/** A permanent redirect within the Site, such as the home page's own path to `/`. */
function redirect(host: SiteHost, location: string): Response {
	return new Response(null, {
		status: 301,
		headers: { location, "cache-control": PAGE_CACHE_CONTROL, ...addressHeaders(host) },
	});
}

/** A Staging address is never indexed by search engines. */
function addressHeaders(host: SiteHost): Record<string, string> {
	return host.address === "staging" ? { "x-robots-tag": "noindex" } : {};
}

/** A strong ETag: the SHA-256 of the HTML, in base64url. */
async function etagOf(html: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html)));
	return `"${Buffer.from(digest).toString("base64url")}"`;
}
