import {
	canonicalPath,
	type EditSession,
	type InstallServices,
	isReservedPath,
	MAX_PAGE_NUMBER,
	MEDIA_PATH,
	normaliseHostname,
	pathSegments,
	SCRIPT_PATH,
	type SiteHost,
	STYLESHEET_PATH,
	siteScript,
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
import { browserLanguageRedirect, languageChoiceResponse, languageVary } from "./languages.ts";
import { type CachedPage, createPageCache, type PageCache } from "./page-cache.ts";

/** Where Modules' Site routes are: `/_wc/m/<route prefix>/…`. */
const MODULE_ROUTES = "/_wc/m";

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
 * Modules' Site routes (`/_wc/m/<route prefix>/…`) go to the Module host, which answers them where
 * the Module runs; they are never cached.
 *
 * Languages: a path's first part may name a language's prefix (`/fr/…`; `sitePages` reads it), the
 * Language switcher's links (`/_wc/lang/…`) remember the visitor's choice in a cookie, and a Site may
 * send a first visit to its home page on to the browser's language.
 *
 * Steps still to come, in their places: Redirect domains and Redirect rules before everything else,
 * language domains (with domain verification), each reserved path's feature (Forms, the Content API,
 * `sitemap.xml`, `robots.txt`, `llms.txt`, Markdown copies), and the 404 log.
 */
export function createSitePipeline(services: InstallServices, options: SitePipelineOptions = {}): Handler {
	const cache = options.pageCache ?? createPageCache();
	return async (request) => {
		const url = new URL(request.url);
		const host = await services.sitePages.resolveHost(normaliseHostname(url.hostname));
		if (!host) return notFound();
		const editing = await editModeEndpoint(services, request, host);
		if (editing) return editing;
		if (url.pathname === MODULE_ROUTES || url.pathname.startsWith(`${MODULE_ROUTES}/`)) {
			// Modules' Site routes: answered by the Module, any method it declares, never cached as pages.
			const answer = await services.modules.answerSiteRoute(host.site, request);
			if (!answer) return plainText(404, "Not Found", addressHeaders(host));
			for (const [name, value] of Object.entries(addressHeaders(host))) answer.headers.set(name, value);
			return answer;
		}
		return readOnly(request, async () => {
			if (url.pathname === MEDIA_PATH.slice(0, -1) || url.pathname.startsWith(MEDIA_PATH)) {
				return mediaFile(services, request, host, url.pathname.slice(MEDIA_PATH.length));
			}
			if (url.pathname.startsWith(STYLESHEET_PATH)) {
				return stylesheet(services, request, host, url.pathname.slice(STYLESHEET_PATH.length));
			}
			if (url.pathname.startsWith(SCRIPT_PATH)) return script(request, host, url.pathname.slice(SCRIPT_PATH.length));
			const chosen = await languageChoiceResponse(services, request, host, addressHeaders(host));
			if (chosen) return chosen;
			const segments = pathSegments(url.pathname);
			// Paths the Install keeps: each feature answers its own; until then, a plain 404.
			if (segments && isReservedPath(segments)) return plainText(404, "Not Found", addressHeaders(host));
			const edit = await editSessionOf(services, request, host);
			const number = pageNumber(url);
			if (number === undefined) return notFoundPage(services, host, url.pathname);
			if (number === 1 && url.searchParams.has(PAGE_PARAMETER)) {
				return redirect(host, canonicalPath(segments ?? []));
			}
			if (edit.session) return editModePage(services, host, edit.session, url.pathname, number);
			const redirected = await browserLanguageRedirect(services, request, host, addressHeaders(host));
			if (redirected) return redirected;
			const page = await visitorPage(services, cache, request, host);
			return edit.stale ? withEditCookieCleared(request, page) : page;
		});
	};
}

/** The query parameter naming a page of a paginated Loop: `/blog?page=2`. */
const PAGE_PARAMETER = "page";

/**
 * Which page of a paginated Loop the URL asks for: 1 without `?page`, the number it gives (2 to
 * `MAX_PAGE_NUMBER`, written without leading zeros), undefined for anything else (a page not found).
 * `?page=1` is the page itself (answered with a redirect to it).
 */
function pageNumber(url: URL): number | undefined {
	const given = url.searchParams.getAll(PAGE_PARAMETER);
	if (given.length === 0) return 1;
	const [value = ""] = given;
	if (given.length > 1 || !/^[1-9][0-9]{0,3}$/.test(value)) return undefined;
	const page = Number(value);
	return page <= MAX_PAGE_NUMBER ? page : undefined;
}

/**
 * The page visitors get at the URL, from the page cache, rendering and keeping it on a miss. Pages
 * are kept by normalised URL: one form of the path, and of the query parameters only the page of a
 * paginated Loop (`?page=2`, each page its own entry; Filters will allow theirs, sorted). A page
 * that shows something time changes is kept until then.
 */
async function visitorPage(services: InstallServices, cache: PageCache, request: Request, host: SiteHost) {
	const url = new URL(request.url);
	const { pathname } = url;
	const segments = pathSegments(pathname);
	if (!segments) return notFoundPage(services, host, pathname);
	const number = pageNumber(url) ?? 1;
	const key = number > 1 ? `${canonicalPath(segments)}?${PAGE_PARAMETER}=${number}` : canonicalPath(segments);
	const now = services.clock.now();
	const cached = cache.get(host.site.id, host.cacheGeneration, key, now);
	if (cached) return pageResponse(request, host, cached, "HIT");
	const answer = await services.sitePages.render(host, pathname, undefined, number);
	if (!answer) return notFoundPage(services, host, pathname);
	if (answer.kind === "redirect") return redirect(host, answer.location);
	const page = { html: answer.html, etag: await etagOf(answer.html), expiresAt: answer.expiresAt?.getTime() ?? null };
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
	page: number,
): Promise<Response> {
	const editing = await pageEditing(session);
	const answer = pathSegments(pathname) ? await services.sitePages.render(host, pathname, editing, page) : null;
	if (answer?.kind === "redirect") {
		return new Response(null, { status: 301, headers: { location: answer.location, ...EDIT_MODE_PAGE_HEADERS } });
	}
	if (answer) return editModeHtml(200, answer.html);
	return editModeHtml(404, (await services.sitePages.notFound(host, pathname, editing)).html);
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
 * The Site's stylesheet, `/_wc/css/<hash>.css`: named by the hash of what it holds, so it may
 * be kept for a year like Media files. Any other name is a plain 404.
 */
async function stylesheet(
	services: InstallServices,
	request: Request,
	host: SiteHost,
	name: string,
): Promise<Response> {
	const css = await services.sitePages.stylesheet(host, name);
	if (css === null) return plainText(404, "Not Found", addressHeaders(host));
	return immutableFile(request, host, css, "text/css; charset=utf-8", `"${name.slice(0, -".css".length)}"`);
}

/**
 * A script WebCraft's own page parts need (the theme toggle's), `/_wc/js/<hash>.js`: never inline,
 * so the Site's Content Security Policy can allow only its own files (ADR 0023).
 */
function script(request: Request, host: SiteHost, name: string): Response {
	const text = siteScript(name);
	if (text === null) return plainText(404, "Not Found", addressHeaders(host));
	return immutableFile(request, host, text, "text/javascript; charset=utf-8", `"${name.slice(0, -".js".length)}"`);
}

/** A file named by its content hash: kept for a year, answered with 304 while the ETag holds. */
function immutableFile(request: Request, host: SiteHost, body: string, type: string, etag: string): Response {
	const headers: Record<string, string> = {
		"cache-control": MEDIA_CACHE_CONTROL,
		etag,
		"x-content-type-options": "nosniff",
		...addressHeaders(host),
	};
	if (matchesETag(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });
	return new Response(body, { status: 200, headers: { "content-type": type, ...headers } });
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
		...languageVary(host, new URL(request.url).pathname),
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
async function notFoundPage(services: InstallServices, host: SiteHost, pathname: string): Promise<Response> {
	const page = await services.sitePages.notFound(host, pathname);
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
