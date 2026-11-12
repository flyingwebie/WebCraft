import {
	canonicalPath,
	type EditSession,
	FILE_POLICY,
	type InstallServices,
	isReservedPath,
	isRobot,
	LIBRARY_PATH,
	MEDIA_PATH,
	mediaPolicy,
	normaliseHostname,
	PAGE_PARAMETER,
	pageHref,
	pageNumberIn,
	pathSegments,
	readFilterState,
	SCRIPT_PATH,
	SEARCH_RATE_LIMIT,
	SENT_PARAMETER,
	SITE_SECURITY_HEADERS,
	SITEMAP_LIMITS,
	type SiteHost,
	type SitemapLimits,
	type SiteScope,
	SOCIAL_CARD_PATH,
	STYLESHEET_PATH,
	searchQueryIn,
	showsDrafts,
	siteScript,
	socialCardFile,
	VERIFY_PATH,
} from "@webcraft/core";

import { FILTER_FRAGMENTS_PATH } from "@webcraft/renderer";

import { clientAddress, recordVisitorAddress, sameClient } from "../client-address.ts";
import { matchesETag, mediaFileResponse } from "../media-response.ts";
import { type Handler, json, notFound, payloadTooLarge, plainText, readOnly, withinBodyCeiling } from "../responses.ts";
import { consentRecordPost, isConsentPath } from "./consent.ts";
import { contentApiAnswer, isContentApiPath } from "./content-api.ts";
import { discoveryFile, stagingRobots } from "./discovery.ts";
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
import { pageParts } from "./filter-fragments.ts";
import { formPost, isFormPath, sentPage, withFormTokens } from "./forms.ts";
import { browserLanguageRedirect, languageChoiceResponse, languageVary } from "./languages.ts";
import { type CachedPage, createPageCache, type PageCache } from "./page-cache.ts";
import { isShareHost, shareAnswer } from "./share.ts";
import { stagingEndpoint, stagingRefusal } from "./staging.ts";

/** Where Modules' Site routes are: `/_wc/m/<route prefix>/…`. */
const MODULE_ROUTES = "/_wc/m";

export type SitePipelineOptions = {
	/** The page cache; a new one holding the default amount unless given. */
	pageCache?: PageCache;
	/** How much one sitemap file holds: the protocol's limits unless given (a test of splitting needs fewer). */
	sitemapLimits?: Partial<SitemapLimits>;
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
 * Redirect domains and then the Site's Redirect rules (kept by the Module that keeps them, SDK 1.5)
 * come before everything else; a visitor's request the 404 page answers goes to the Site's 404 log.
 *
 * The Content API (`/_content/v1/…`, ADR 0029) answers before the Staging address's checks: it shows
 * published content only, to frontends holding one of the Site's Content keys.
 *
 * The discovery files (robots.txt, sitemaps, `llms.txt`, Markdown copies) answer at the reserved-path
 * step, kept in the page cache like pages (`discovery.ts`); the Staging address's robots.txt answers
 * before its access check.
 */
export function createSitePipeline(services: InstallServices, options: SitePipelineOptions = {}): Handler {
	const cache = options.pageCache ?? createPageCache();
	const limits = { ...SITEMAP_LIMITS, ...options.sitemapLimits };
	return (request) =>
		withinBodyCeiling(
			request,
			() => answer(request),
			() => withSecurityHeaders(payloadTooLarge()),
		);
	async function answer(request: Request): Promise<Response> {
		const url = new URL(request.url);
		const hostname = normaliseHostname(url.hostname);
		// Domain verification comes first: a domain waiting for DNS belongs to no Site yet.
		if (url.pathname.startsWith(VERIFY_PATH)) {
			return withSecurityHeaders(
				await readOnly(request, () => verification(services, hostname, url.pathname.slice(VERIFY_PATH.length))),
			);
		}
		// The Share link address is the Install's own, under the sites domain: never a Site.
		if (isShareHost(services, hostname)) return withSecurityHeaders(await shareAnswer(services, request));
		const host = await services.sitePages.resolveHost(hostname);
		if (!host) return notFound();
		// From here on the client address is the visitor's, as the Site's CDN gives it when it has one.
		await recordVisitorAddress(request, services, host);
		return withSecurityHeaders(await siteAnswer(services, cache, request, host, limits));
	}
}

/** What a request on one of the Site's hostnames answers, before the security headers every answer gets. */
async function siteAnswer(
	services: InstallServices,
	cache: PageCache,
	request: Request,
	host: SiteHost,
	limits: SitemapLimits,
): Promise<Response> {
	const url = new URL(request.url);
	// A Redirect domain sends every request on to the same path on the Primary domain (ADR 0015).
	if (host.address === "redirect") return domainRedirect(host, url);
	// The Content API (ADR 0029): published content only, opened by a Content key, so the Staging
	// address's sign-in doesn't apply to it.
	if (isContentApiPath(url.pathname)) return contentApiAnswer(services, cache, request, host);
	// The Staging address shows the Site with its Drafts to the people reviewing it, and to nobody else
	// (ADR 0014): its own ways in first (a link from the admin, the staging password), then a page
	// asking everyone else to sign in, whatever they asked for.
	const staging = await stagingEndpoint(services, request, host);
	if (staging) return staging;
	// Its robots.txt keeps every crawler out, and crawlers must be able to read that.
	const robots = await stagingRobots(request, host);
	if (robots) return robots;
	const refused = await stagingRefusal(services, request, host);
	if (refused) return refused;
	// Redirect rules come next, before anything the Site answers itself (the Install's own `/_…`
	// paths aside): its pages, files and Edit mode.
	if (request.method === "GET" || request.method === "HEAD") {
		const redirected = await ruleRedirect(services, host, url);
		if (redirected) return redirected;
	}
	const editing = await editModeEndpoint(services, request, host);
	if (editing) return editing;
	if (url.pathname === MODULE_ROUTES || url.pathname.startsWith(`${MODULE_ROUTES}/`)) {
		// Modules' Site routes: answered by the Module, any method it declares, never cached as pages.
		// The Module learns of the visitor only what WebCraft tells it (never the address or WebCraft's cookies).
		const edit = await editSessionOf(services, request, host);
		const answer = await services.modules.answerSiteRoute(
			{
				site: host.site,
				via: host.address === "staging" ? "staging" : "domain",
				clientAddress: clientAddress(request, services.config),
				editing: edit.session !== null,
			},
			request,
		);
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
		if (url.pathname.startsWith(SOCIAL_CARD_PATH)) {
			const file = await socialCardFile(services.data.visitors(host.site), url.pathname.slice(SOCIAL_CARD_PATH.length));
			if (!file) return plainText(404, "Not Found", addressHeaders(host));
			const etag = `"${file.hash}"`;
			const headers = {
				"content-type": "image/png",
				"cache-control": "public, max-age=0, must-revalidate",
				etag,
				...addressHeaders(host),
			};
			if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
			return new Response(request.method === "HEAD" ? null : new Uint8Array(file.png), { headers });
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
		// The parts of a page a Filter's script swaps in place (GLOSSARY.md › Filter).
		if (url.pathname === FILTER_FRAGMENTS_PATH || url.pathname.startsWith(`${FILTER_FRAGMENTS_PATH}/`)) {
			return filterFragments(services, cache, request, host);
		}
		return pageAnswer(services, cache, request, host, false, limits);
	});
}

/**
 * The page at a request's path, as visitors, the people reviewing the Staging address or a person in
 * Edit mode see it. `fragment` says the page is asked for its parts by a Filter's script: a path with
 * no page then tells the 404 log nothing.
 */
async function pageAnswer(
	services: InstallServices,
	cache: PageCache,
	request: Request,
	host: SiteHost,
	fragment = false,
	limits: SitemapLimits = SITEMAP_LIMITS,
): Promise<Response> {
	const url = new URL(request.url);
	const segments = pathSegments(url.pathname);
	// Paths the Install keeps: each feature answers its own (the discovery files here), else a plain 404.
	if (segments && isReservedPath(segments)) {
		if (fragment) return plainText(404, "Not Found", addressHeaders(host));
		const file = await discoveryFile(services, cache, request, host, limits);
		return file ?? plainText(404, "Not Found", addressHeaders(host));
	}
	const edit = await editSessionOf(services, request, host);
	// Which page of a paginated Loop: `?page=2`; anything else that isn't a page number is no page.
	// (`?page=1` goes on to the page itself, keeping its search and Filters' choices: see `render`.)
	const number = pageNumberIn(url.searchParams);
	if (number === undefined) return notFoundPage(services, request, host, url.pathname);
	if (edit.session) {
		return editModePage(
			services,
			host,
			edit.session,
			url.pathname,
			await codeModeOf(services, request, edit.session),
			safeModeOf(request),
			number,
			url.searchParams,
		);
	}
	if (!fragment) {
		const redirected = await browserLanguageRedirect(services, request, host, addressHeaders(host));
		if (redirected) return redirected;
	}
	const page = showsDrafts(host)
		? await draftPage(services, request, host, number)
		: await visitorPage(services, cache, request, host, number, fragment);
	return edit.stale ? withEditCookieCleared(request, page) : page;
}

/**
 * What a Filter's script swaps in place: `/_wc/filter/<page path>?<choices>` answers the page at that
 * path with those choices, exactly as a request for it would (from the page cache, on the Staging
 * address, in Edit mode), as JSON: its address in normal form (`url`, where a plain form's fields went
 * on to), its title, each Filter's form by id, and each region of its filtered Loops (their items and
 * pagination) by name, as the server rendered and escaped them. Anything but a page is a plain 404,
 * and the script then loads the page instead.
 */
async function filterFragments(
	services: InstallServices,
	cache: PageCache,
	request: Request,
	host: SiteHost,
): Promise<Response> {
	const url = new URL(request.url);
	const headers = { "cache-control": "no-store", "x-robots-tag": "noindex", ...addressHeaders(host) };
	// The rest of the path is a page's path on this Site. Read as an address, `//other.example/shop`
	// would name another host, so anything that isn't a path of whole segments is no page.
	const path = url.pathname.slice(FILTER_FRAGMENTS_PATH.length) || "/";
	if (pathSegments(path) === undefined) return plainText(404, "Not Found", headers);
	let target = new URL(`${path}${url.search}`, url.origin);
	// A plain form's fields go on to their normal address once; a page's first page once more.
	for (let hop = 0; hop < 3; hop++) {
		const inner = new Request(target, { headers: request.headers });
		sameClient(request, inner);
		const response = await pageAnswer(services, cache, inner, host, true);
		const location = response.headers.get("location");
		if (response.status >= 300 && response.status < 400 && location) {
			const next = new URL(location, target);
			if (next.origin !== target.origin) break;
			target = next;
			continue;
		}
		if (response.status !== 200 || !response.headers.get("content-type")?.startsWith("text/html")) break;
		const parts = pageParts(await response.text());
		return json(200, { url: `${target.pathname}${target.search}`, ...parts }, headers);
	}
	return plainText(404, "Not Found", headers);
} /**
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
 * paginated Loop (`?page=2`, each page its own entry) and what the page's Filters allow, in their
 * normal form (keys sorted, an option list's slugs sorted; GLOSSARY.md › Filter). What a path's
 * Filters read is remembered from its last render, so a request is looked up under its normal
 * address first. A filtered page is a variant: a Site keeps a limited number of them, and one past it
 * is answered without being kept (`no-store`); one with a search in it is never kept and counts as a
 * search. A page that shows something time changes is kept until then.
 */
async function visitorPage(
	services: InstallServices,
	cache: PageCache,
	request: Request,
	host: SiteHost,
	number: number,
	fragment = false,
) {
	const url = new URL(request.url);
	const { pathname } = url;
	const first = await beforePage(services, request, host, number);
	if ("response" in first) return first.response;
	const { segments, search: query, searchPage } = first;
	// A search on the search results page counted already; a Filter's counts once, like it.
	let counted = searchPage;
	const withinSearchLimit = async () => {
		if (counted) return true;
		counted = true;
		const address = clientAddress(request, services.config) ?? "unknown";
		return services.rateLimits.count(`search:${host.site.id}:${address}`, SEARCH_RATE_LIMIT);
	};
	// The same path is another page on each of the Site's addresses (its language, its links), each
	// page of a paginated Loop another page, and each choice of its Filters another.
	const path = canonicalPath(segments);
	const pathKey = `${host.origin}${path}`;
	const reader = cache.reader(host.site.id, host.cacheGeneration, pathKey);
	const state = reader ? readFilterState(reader, url.searchParams) : undefined;
	if (state?.search !== undefined && !(await withinSearchLimit())) return tooManySearches(host);
	const firstPageAsked = number === 1 && url.searchParams.has(PAGE_PARAMETER);
	if (state && !state.differs && state.search === undefined && !firstPageAsked && !searchPage) {
		const key = `${host.origin}${pageHref(path, number, state.query)}`;
		const cached = cache.get(host.site.id, host.cacheGeneration, key, services.clock.now());
		if (cached) return pageResponse(services, request, host, cached, "HIT", { filtered: state.query !== "" });
	}
	// A filtered page past the Site's limit of them is rendered for this request alone.
	if (state && state.query !== "" && state.search === undefined && !cache.takesVariants(host.site.id)) {
		if (!(await withinUnkeptLimit(services, request, host))) return tooMany(host, UNKEPT_PAGE_LIMIT);
	}
	// A page kept in the cache holds no visitor's Form token: each answer fills in its own.
	const answer = await services.sitePages.render(host, pathname, undefined, {
		forms: { cached: true },
		page: number,
		search: query,
		query: url.searchParams,
	});
	if (!answer) {
		// Where an Entry was until it was unpublished: gone for good, not missing (and not a miss).
		if (await services.sitePages.gone(host, pathname)) return gonePage(services, request, host, pathname);
		// A path with no page: the Site's 404 log hears of it (a page past a paginated Loop's last isn't one).
		if (number === 1 && !fragment) noteMiss(services, request, host);
		return notFoundPage(services, request, host, pathname);
	}
	if (answer.kind === "redirect") return redirect(host, withQuery(answer, url), answer.temporary);
	cache.setReader(host.site.id, host.cacheGeneration, pathKey, answer.filters.reader);
	// The search results page shows one visitor's search: never kept, never indexed (ADR 0021).
	if (answer.searchPage) return searchResponse(services, host, answer.html, answer.headers);
	const filtered = answer.filters.query !== "";
	// A Filter's search box: one visitor's search, never kept, counted like Site search.
	if (answer.filters.search !== undefined) {
		if (!(await withinSearchLimit())) return tooManySearches(host);
		return searchResponse(services, host, answer.html, answer.headers, "noindex, follow");
	}
	const page = {
		html: answer.html,
		etag: await etagOf(answer.html),
		headers: answer.headers,
		expiresAt: answer.expiresAt?.getTime() ?? null,
	};
	const key = `${host.origin}${pageHref(path, number, answer.filters.query)}`;
	const kept = cache.set(host.site.id, host.cacheGeneration, key, page, { variant: filtered });
	return pageResponse(services, request, host, page, "MISS", { filtered, kept });
}

/**
 * What a page request checks before its page is rendered, on a Site's domains and on its Staging
 * address alike: a path that can't be a page (the 404 page), a Form just sent (its message, on a page
 * answered for the visitor alone, before any cache), and a search past the client address's limit
 * (searches are never cached, ADR 0021). Answers a response to send as it is, or the path's segments,
 * the search to render with and whether it is the search results page's (counted already).
 */
async function beforePage(
	services: InstallServices,
	request: Request,
	host: SiteHost,
	number: number,
): Promise<
	{ response: Response } | { segments: string[]; search: ReturnType<typeof searchQueryIn>; searchPage: boolean }
> {
	const url = new URL(request.url);
	const { pathname } = url;
	const segments = pathSegments(pathname);
	if (!segments) return { response: await notFoundPage(services, request, host, pathname) };
	// A Form's message once sent is a page answered for the visitor alone.
	if (url.searchParams.has(SENT_PARAMETER) && !showsDrafts(host)) {
		if (!(await withinUnkeptLimit(services, request, host))) return { response: tooMany(host, UNKEPT_PAGE_LIMIT) };
	}
	const sent = await sentPage(services, request, host, number, addressHeaders(host));
	if (sent) return { response: sent };
	const search = searchQueryIn(url.searchParams);
	const searchPage = search !== "" && (await services.sitePages.isSearchPage(host, pathname));
	if (searchPage) {
		const address = clientAddress(request, services.config) ?? "unknown";
		if (!(await services.rateLimits.count(`search:${host.site.id}:${address}`, SEARCH_RATE_LIMIT))) {
			return { response: tooManySearches(host) };
		}
	}
	return { segments, search, searchPage };
}

/**
 * A page on the Staging address (ADR 0014): the Site as it would be with all its Drafts published,
 * rendered afresh for each request and never kept, by the page cache, browsers or proxies (a CDN in
 * front of the Install never keeps it either: `private, no-store`), and never indexed.
 */
async function draftPage(services: InstallServices, request: Request, host: SiteHost, number: number) {
	const url = new URL(request.url);
	const { pathname } = url;
	const first = await beforePage(services, request, host, number);
	if ("response" in first) return first.response;
	const answer = await services.sitePages.render(host, pathname, undefined, {
		page: number,
		search: first.search,
		query: url.searchParams,
	});
	if (!answer) return notFoundPage(services, request, host, pathname);
	if (answer.kind === "redirect") return redirect(host, withQuery(answer, url), answer.temporary);
	return new Response(answer.html, {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": DRAFT_CACHE_CONTROL,
			"x-content-type-options": "nosniff",
			...answer.headers,
			...languageVary(host, pathname),
			...addressHeaders(host),
		},
	});
}

/** What the Staging address's pages are sent with: kept by nobody, shared caches included. */
const DRAFT_CACHE_CONTROL = "private, no-store";

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
	query: URLSearchParams,
): Promise<Response> {
	const editing = await pageEditing(session, code, safe);
	const answer = pathSegments(pathname)
		? await services.sitePages.render(host, pathname, editing, { page, search: searchQueryIn(query), query })
		: null;
	if (answer?.kind === "redirect") {
		return new Response(null, {
			status: answer.temporary ? 302 : 301,
			headers: { location: answer.location, ...EDIT_MODE_PAGE_HEADERS },
		});
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

/**
 * A page's answer. A filtered page (`filtered`) asks search engines not to index it but to follow its
 * links, as its HTML does; one the cache didn't keep (`kept: false`, past the Site's limit of
 * variants) is kept by nobody else either.
 */
async function pageResponse(
	services: InstallServices,
	request: Request,
	host: SiteHost,
	page: CachedPage,
	cacheStatus: "HIT" | "MISS",
	options: { filtered?: boolean; kept?: boolean } = {},
): Promise<Response> {
	const headers: Record<string, string> = {
		"cache-control": options.kept === false ? "no-store" : PAGE_CACHE_CONTROL,
		etag: page.etag,
		"x-cache": cacheStatus,
		"x-content-type-options": "nosniff",
		...(options.filtered ? { "x-robots-tag": FILTERED_ROBOTS } : {}),
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
	return tooMany(host, SEARCH_RATE_LIMIT);
}

/** A client address past a limit: asked to wait until the limit's window ends. */
function tooMany(host: SiteHost, limit: { windowMs: number }): Response {
	return plainText(429, "Too Many Requests", {
		"retry-after": String(limit.windowMs / 1000),
		"cache-control": "no-store",
		...addressHeaders(host),
	});
}

/**
 * How many pages the page cache keeps for nobody one client address may ask a Site for: 60 a minute,
 * together. Each is rendered for that request alone: the Site's 404 page (a path with no page, a page
 * past a paginated Loop's last), a filtered page past the Site's limit of them, a Form's message once
 * sent. Past it, a path with no page gets a plain 404 and the others wait until the minute ends, so
 * no client keeps the web process rendering. The Staging address renders everything afresh, for
 * people it knows: nothing is counted there.
 */
const UNKEPT_PAGE_LIMIT = { limit: 60, windowMs: 60_000 } as const;

/** Counts a page nobody keeps against the client address's limit: whether it is within it. */
function withinUnkeptLimit(services: InstallServices, request: Request, host: SiteHost): Promise<boolean> {
	const address = clientAddress(request, services.config) ?? "unknown";
	return services.rateLimits.count(`unkept:${host.site.id}:${address}`, UNKEPT_PAGE_LIMIT);
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
	robots = "noindex",
): Promise<Response> {
	return new Response(await withFormTokens(services, host, html), {
		status: 200,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"x-robots-tag": robots,
			...pageHeaders,
			...addressHeaders(host),
		},
	});
}

/** What a filtered or sorted page asks of search engines (GLOSSARY.md › Filter). */
const FILTERED_ROBOTS = "noindex, follow";

/**
 * A path with no page on a known Site: the Site's 404 page, with status 404. It is never kept in the
 * page cache, nor by browsers and proxies, so every miss reaches the Site (and its 404 log) and a page
 * published at the path shows at once.
 */
async function notFoundPage(
	services: InstallServices,
	request: Request,
	host: SiteHost,
	pathname: string,
): Promise<Response> {
	if (!showsDrafts(host) && !(await withinUnkeptLimit(services, request, host))) {
		return plainText(404, "Not Found", { "cache-control": "no-store", ...addressHeaders(host) });
	}
	const page = await services.sitePages.notFound(host, pathname);
	return new Response(page.html, {
		status: 404,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": showsDrafts(host) ? DRAFT_CACHE_CONTROL : "no-store",
			"x-content-type-options": "nosniff",
			...page.headers,
			...addressHeaders(host),
		},
	});
}

/**
 * A path where an Entry was until a Scheduled publish unpublished it: 410 Gone, so search engines drop
 * it, with the Site's 404 page as its body. Like the 404 page, never kept, so publishing it again
 * shows at once.
 */
async function gonePage(
	services: InstallServices,
	request: Request,
	host: SiteHost,
	pathname: string,
): Promise<Response> {
	if (!(await withinUnkeptLimit(services, request, host))) {
		return plainText(410, "Gone", { "cache-control": "no-store", "x-robots-tag": "noindex", ...addressHeaders(host) });
	}
	const page = await services.sitePages.notFound(host, pathname);
	return new Response(page.html, {
		status: 410,
		headers: {
			"content-type": "text/html; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff",
			"x-robots-tag": "noindex",
			...page.headers,
			...addressHeaders(host),
		},
	});
}

/**
 * A Redirect rule's answer: a 301 or 302 to where the rule sends the path, keeping the request's query
 * parameters the target doesn't set itself. Browsers check it again each time (it is kept like a
 * page, `max-age=0, must-revalidate`), so a changed rule shows at once; it is never kept as a page.
 */
async function ruleRedirect(services: InstallServices, host: SiteHost, url: URL): Promise<Response | null> {
	const answer = await services.sitePages.redirect(host, url.pathname);
	if (!answer) return null;
	return new Response(null, {
		status: answer.status,
		headers: {
			location: withRequestQuery(answer.location, url),
			"cache-control": PAGE_CACHE_CONTROL,
			...addressHeaders(host),
		},
	});
}

/** A redirect's location with the request's query parameters added, those it sets itself left as they are. */
function withRequestQuery(location: string, url: URL): string {
	if (url.search === "") return location;
	const absolute = !location.startsWith("/");
	const target = new URL(location, url.origin);
	const own = new Set(target.searchParams.keys());
	for (const [name, value] of url.searchParams) {
		if (!own.has(name)) target.searchParams.append(name, value);
	}
	return absolute ? target.href : `${target.pathname}${target.search}${target.hash}`;
}

/**
 * Hands a request the 404 page answered to the Site's 404 log: only a person's browser asking for the
 * page (`GET`, not a robot by its user agent, not a prefetch), with the host of the page that linked
 * there. The query string is never kept: it may hold personal data. Nothing waits for it.
 */
function noteMiss(services: InstallServices, request: Request, host: SiteHost): void {
	if (request.method !== "GET" || isRobot(request.headers.get("user-agent"))) return;
	const purpose = `${request.headers.get("sec-purpose") ?? ""} ${request.headers.get("purpose") ?? ""}`;
	if (/prefetch|prerender/i.test(purpose)) return;
	services.sitePages.noteMiss(host, new URL(request.url).pathname, referrerHost(request.headers.get("referer")));
}

/** The host of the page a request came from, in lower case; null without a `Referer` on the web. */
function referrerHost(referer: string | null): string | null {
	if (!referer) return null;
	try {
		const url = new URL(referer);
		return url.protocol === "https:" || url.protocol === "http:" ? url.hostname.toLowerCase() : null;
	} catch {
		return null;
	}
}

/**
 * A permanent redirect within the Site, such as the home page's own path to `/`; or, `temporary`, a
 * Filter's choices sent on to their normal address (a Filter may change, so it is never kept).
 */
function redirect(host: SiteHost, location: string, temporary = false): Response {
	return new Response(null, {
		status: temporary ? 302 : 301,
		headers: {
			location,
			"cache-control": temporary ? "no-store" : PAGE_CACHE_CONTROL,
			...addressHeaders(host),
		},
	});
}

/** A Staging address is never indexed by search engines (ADR 0014). */
function addressHeaders(host: SiteHost): Record<string, string> {
	return showsDrafts(host) ? { "x-robots-tag": "noindex" } : {};
}

/** A strong ETag: the SHA-256 of the HTML, in base64url. */
async function etagOf(html: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(html)));
	return `"${Buffer.from(digest).toString("base64url")}"`;
}
