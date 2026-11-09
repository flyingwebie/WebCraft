import {
	canonicalPath,
	type EditSession,
	FILE_POLICY,
	type InstallServices,
	isReservedPath,
	LIBRARY_PATH,
	MEDIA_PATH,
	mediaPolicy,
	normaliseHostname,
	PAGE_PARAMETER,
	pageHref,
	pageNumberIn,
	pathSegments,
	SCRIPT_PATH,
	SEARCH_PARAMETER,
	SEARCH_RATE_LIMIT,
	SITE_SECURITY_HEADERS,
	type SiteHost,
	type SiteScope,
	STYLESHEET_PATH,
	searchQueryIn,
	siteScript,
	VERIFY_PATH,
} from "@webcraft/core";

import { clientAddress, recordVisitorAddress } from "../client-address.ts";
import { matchesETag, mediaFileResponse } from "../media-response.ts";
import { type Handler, notFound, plainText, readOnly } from "../responses.ts";
import { consentRecordPost, isConsentPath } from "./consent.ts";
import {
	clearEditCookie,
	codeModeOf,
	EDIT_MODE_PAGE_HEADERS,
	editModeEndpoint,
	editModeHtml,
	editSessionOf,
	pageEditing,
	safeModeOf,
} from "./edit-mode.ts";
import { formPost, isFormPath, sentPage, withFormTokens } from "./forms.ts";
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
 * Every answer on a Site's domain carries the fixed security headers (ADR 0023), and pages the Site's
 * Content Security Policy, which is kept with each page in the page cache.
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
		const hostname = normaliseHostname(url.hostname);
		// Domain verification comes first: a domain waiting for DNS belongs to no Site yet.
		if (url.pathname.startsWith(VERIFY_PATH)) {
			return withSecurityHeaders(
				await readOnly(request, () => verification(services, hostname, url.pathname.slice(VERIFY_PATH.length))),
			);
		}
		const host = await services.sitePages.resolveHost(hostname);
		if (!host) return notFound();
		// From here on the client address is the visitor's, as the Site's CDN gives it when it has one.
		await recordVisitorAddress(request, services, host);
		return withSecurityHeaders(await siteAnswer(services, cache, request, host));
	};
}

/** What a request on one of the Site's hostnames answers, before the security headers every answer gets. */
async function siteAnswer(
	services: InstallServices,
	cache: PageCache,
	request: Request,
	host: SiteHost,
): Promise<Response> {
	const url = new URL(request.url);
	// A Redirect domain sends every request on to the same path on the Primary domain (ADR 0015).
	if (host.address === "redirect") return domainRedirect(host, url);
	const editing = await editModeEndpoint(services, request, host);
	if (editing) return editing;
	if (url.pathname === MODULE_ROUTES || url.pathname.startsWith(`${MODULE_ROUTES}/`)) {
		// Modules' Site routes: answered by the Module, any method it declares, never cached as pages.
		const answer = await services.modules.answerSiteRoute(host.site, request);
		if (!answer) return plainText(404, "Not Found", addressHeaders(host));
		for (const [name, value] of Object.entries(addressHeaders(host))) answer.headers.set(name, value);
		return answer;
	}
	// Forms post to the Site itself; their answers are made for one visitor and never cached.
	if (isFormPath(url.pathname)) return formPost(services, request, host, addressHeaders(host));
	// So does the consent script, with a visitor's choice on the Consent banner.
	if (isConsentPath(url.pathname)) return consentRecordPost(services, request, host, addressHeaders(host));
	return readOnly(request, async () => {
		if (url.pathname === MEDIA_PATH.slice(0, -1) || url.pathname.startsWith(MEDIA_PATH)) {
			return mediaFile(services, request, host, url.pathname.slice(MEDIA_PATH.length));
		}
		if (url.pathname.startsWith(STYLESHEET_PATH)) {
			return stylesheet(services, request, host, url.pathname.slice(STYLESHEET_PATH.length));
		}
		if (url.pathname.startsWith(SCRIPT_PATH)) {
			return script(services, request, host, url.pathname.slice(SCRIPT_PATH.length));
		}
		if (url.pathname.startsWith(LIBRARY_PATH)) {
			return library(services, request, host, url.pathname.slice(LIBRARY_PATH.length));
		}
		const chosen = await languageChoiceResponse(services, request, host, addressHeaders(host));
		if (chosen) return chosen;
		const segments = pathSegments(url.pathname);
		// Paths the Install keeps: each feature answers its own; until then, a plain 404.
		if (segments && isReservedPath(segments)) return plainText(404, "Not Found", addressHeaders(host));
		const edit = await editSessionOf(services, request, host);
		// Which page of a paginated Loop: `?page=2`; anything else that isn't a page number is no page.
		const number = pageNumberIn(url.searchParams);
		if (number === undefined) return notFoundPage(services, host, url.pathname);
		if (number === 1 && url.searchParams.has(PAGE_PARAMETER)) {
			// A search's first page keeps the search.
			const query = searchQueryIn(url.searchParams);
			const search = query ? `?${new URLSearchParams({ [SEARCH_PARAMETER]: query })}` : "";
			return redirect(host, `${canonicalPath(segments ?? [])}${search}`);
		}
		if (edit.session) {
			return editModePage(
				services,
				host,
				edit.session,
				url.pathname,
				await codeModeOf(services, request, edit.session),
				safeModeOf(request),
				number,
				searchQueryIn(url.searchParams),
			);
		}
		const redirected = await browserLanguageRedirect(services, request, host, addressHeaders(host));
		if (redirected) return redirected;
		const page = await visitorPage(services, cache, request, host, number);
		return edit.stale ? withEditCookieCleared(request, page) : page;
	});
}

/**
 * Adds the security headers every answer on a Site's domain carries (ADR 0023): `nosniff`, a strict
 * referrer policy, no framing by other sites, and, on answers that bring no policy of their own (a
 * page brings the Site's, Edit mode its own, a Media file one its viewer can open with), the fixed
 * directives: no plugins, no base-tag changes, forms only to the Site.
 */
function withSecurityHeaders(response: Response): Response {
	const headers = new Headers(response.headers);
	for (const [name, value] of Object.entries(SITE_SECURITY_HEADERS)) {
		if (!headers.has(name)) headers.set(name, value);
	}
	if (!headers.has("content-security-policy")) headers.set("content-security-policy", FILE_POLICY);
	return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

/**
 * A Redirect domain's answer: 301 to the same path and query on the Primary domain, or the plain 404
 * while the Site has no verified Primary domain to send visitors to.
 */
function domainRedirect(host: SiteHost, url: URL): Response {
	if (!host.redirectTo) return notFound();
	return new Response(null, {
		status: 301,
		headers: { location: `${host.redirectTo}${url.pathname}${url.search}`, "cache-control": PAGE_CACHE_CONTROL },
	});
}

/** Where a redirect goes, with the request's query when it keeps it (a page that moved to another address). */
function withQuery(answer: { location: string; keepQuery?: boolean }, url: URL): string {
	return answer.keepQuery ? `${answer.location}${url.search}` : answer.location;
}

/**
 * A domain verification request, `/_webcraft/verify/<token>` (ADR 0015): on one of the Install's
 * domains, with that domain's own token, the answer only this Install makes for it; anything else is
 * the plain 404. Never kept by anyone, as a new token's answer must come from the Install itself.
 */
async function verification(services: InstallServices, hostname: string, token: string): Promise<Response> {
	const answer = await services.domains.verificationAnswer(hostname, token);
	return answer === null ? plainText(404, "Not Found") : plainText(200, answer);
}

/**
 * The page visitors get at the URL, from the page cache, rendering and keeping it on a miss. Pages
 * are kept by normalised URL: one form of the path, and of the query parameters only the page of a
 * paginated Loop (`?page=2`, each page its own entry; Filters will allow theirs, sorted). A page
 * that shows something time changes is kept until then.
 */
async function visitorPage(
	services: InstallServices,
	cache: PageCache,
	request: Request,
	host: SiteHost,
	number: number,
) {
	const url = new URL(request.url);
	const { pathname } = url;
	const segments = pathSegments(pathname);
	if (!segments) return notFoundPage(services, host, pathname);
	// A Form just sent shows its message on a page answered for the visitor alone, before the cache.
	const sent = await sentPage(services, request, host, number, addressHeaders(host));
	if (sent) return sent;
	// Searches are never cached: one client address runs a limited number of them (ADR 0021).
	const query = searchQueryIn(url.searchParams);
	if (query && (await services.sitePages.isSearchPage(host, pathname))) {
		const address = clientAddress(request, services.config) ?? "unknown";
		if (!(await services.rateLimits.count(`search:${host.site.id}:${address}`, SEARCH_RATE_LIMIT))) {
			return tooManySearches(host);
		}
	}
	// The same path is another page on each of the Site's addresses (its language, its links), and
	// each page of a paginated Loop another page.
	const key = `${host.origin}${pageHref(canonicalPath(segments), number)}`;
	const cached = cache.get(host.site.id, host.cacheGeneration, key, services.clock.now());
	if (cached) return pageResponse(services, request, host, cached, "HIT");
	// A page kept in the cache holds no visitor's Form token: each answer fills in its own.
	const answer = await services.sitePages.render(host, pathname, undefined, {
		forms: { cached: true },
		page: number,
		search: searchQueryIn(url.searchParams),
	});
	if (!answer) return notFoundPage(services, host, pathname);
	if (answer.kind === "redirect") return redirect(host, withQuery(answer, url));
	// The search results page shows one visitor's search: never kept, never indexed (ADR 0021).
	if (answer.searchPage) return searchResponse(services, host, answer.html, answer.headers);
	const page = {
		html: answer.html,
		etag: await etagOf(answer.html),
		headers: answer.headers,
		expiresAt: answer.expiresAt?.getTime() ?? null,
	};
	cache.set(host.site.id, host.cacheGeneration, key, page);
	return pageResponse(services, request, host, page, "MISS");
}

/**
 * The page at a path in Edit mode: the same page visitors would get, rendered afresh for the person
 * with the Drafts of its Content and its editable regions tagged; in Code mode (`code`, the Site
 * opened with `structure.edit`), with the Drafts of the Structure too, every element tagged. It never
 * touches the page cache.
 */
async function editModePage(
	services: InstallServices,
	host: SiteHost,
	session: EditSession,
	pathname: string,
	code: SiteScope | null,
	safe: boolean,
	page: number,
	search: string,
): Promise<Response> {
	const editing = await pageEditing(session, code, safe);
	const answer = pathSegments(pathname)
		? await services.sitePages.render(host, pathname, editing, { page, search })
		: null;
	if (answer?.kind === "redirect") {
		return new Response(null, { status: 301, headers: { location: answer.location, ...EDIT_MODE_PAGE_HEADERS } });
	}
	if (answer) return editModeHtml(200, answer.html, answer.headers);
	const notFoundPage = await services.sitePages.notFound(host, pathname, editing);
	return editModeHtml(404, notFoundPage.html, notFoundPage.headers);
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
		? await mediaFileResponse(request, file, {
				"cache-control": MEDIA_CACHE_CONTROL,
				"content-security-policy": mediaPolicy(file.contentType),
				...addressHeaders(host),
			})
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
 * A script a page runs, `/_wc/js/<hash>.js`: one WebCraft's own page parts need (the theme
 * toggle's), or the Site's published Site script or a page script. Never inline, so the Site's
 * Content Security Policy can allow only its own files (ADR 0023); named by its hash, so it may be
 * kept for a year.
 */
async function script(services: InstallServices, request: Request, host: SiteHost, name: string): Promise<Response> {
	const text = siteScript(name) ?? (await services.sitePages.script(host, name));
	if (text === null) return plainText(404, "Not Found", addressHeaders(host));
	return immutableFile(request, host, text, "text/javascript; charset=utf-8", `"${name.slice(0, -".js".length)}"`);
}

/**
 * One of the Site's Libraries, `/_wc/lib/<hash>-<file name>` (ADR 0023): a copy WebCraft keeps of a
 * script package, served from the Site so pages need no outside host. Named by its hash, so it may be
 * kept for a year; one an update or a removal replaced is still served for 30 days.
 */
async function library(services: InstallServices, request: Request, host: SiteHost, name: string): Promise<Response> {
	const file = await services.sitePages.libraryFile(host, name);
	if (!file) return plainText(404, "Not Found", addressHeaders(host));
	return immutableFile(
		request,
		host,
		file.bytes as Uint8Array<ArrayBuffer>,
		"text/javascript; charset=utf-8",
		`"${file.hash}"`,
	);
}

/** A file named by its content hash: kept for a year, answered with 304 while the ETag holds. */
function immutableFile(
	request: Request,
	host: SiteHost,
	body: string | Uint8Array<ArrayBuffer>,
	type: string,
	etag: string,
): Response {
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

async function pageResponse(
	services: InstallServices,
	request: Request,
	host: SiteHost,
	page: CachedPage,
	cacheStatus: "HIT" | "MISS",
): Promise<Response> {
	const headers: Record<string, string> = {
		"cache-control": PAGE_CACHE_CONTROL,
		etag: page.etag,
		"x-cache": cacheStatus,
		"x-content-type-options": "nosniff",
		...page.headers,
		...languageVary(host, new URL(request.url).pathname),
		...addressHeaders(host),
	};
	if (matchesETag(request.headers.get("if-none-match"), page.etag)) {
		return new Response(null, { status: 304, headers });
	}
	// The page cache holds no Form token: each answer gets its own (the ETag is the cached page's).
	const html = await withFormTokens(services, host, page.html);
	return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

/** A client address that searched more than `SEARCH_RATE_LIMIT` allows: asked to wait until its minute ends. */
function tooManySearches(host: SiteHost): Response {
	return plainText(429, "Too Many Requests", {
		"retry-after": String(SEARCH_RATE_LIMIT.windowMs / 1000),
		"cache-control": "no-store",
		...addressHeaders(host),
	});
}

/**
 * The Site's search results page, answered for one visitor: never kept in the page cache, by
 * browsers or by proxies (`no-store`, a Form token of its own), and never indexed by search engines,
 * on any of the Site's addresses (`noindex`).
 */
async function searchResponse(
	services: InstallServices,
	host: SiteHost,
	html: string,
	pageHeaders: Record<string, string>,
): Promise<Response> {
	return new Response(await withFormTokens(services, host, html), {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"x-robots-tag": "noindex",
			...pageHeaders,
		},
	});
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
			...page.headers,
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
