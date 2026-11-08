import {
	canonicalPath,
	type InstallServices,
	MEDIA_PATH,
	normaliseHostname,
	pathSegments,
	type SiteHost,
} from "@webcraft/core";

import { matchesETag, mediaFileResponse } from "../media-response.ts";
import { type Handler, notFound, plainText, readOnly } from "../responses.ts";
import { type CachedPage, createPageCache, type PageCache } from "./page-cache.ts";

export type SitePipelineOptions = {
	/** The page cache; a new one holding the default amount unless given. */
	pageCache?: PageCache;
};

/**
 * The Site request pipeline: every hostname other than the admin host comes here (ADR 0004). It
 * resolves the hostname to a Site (its Staging address, `<site slug>.<sites domain>`, for now), answers
 * the paths the Install keeps (`/_media/…`, never kept as pages), then the page at the URL from the
 * page cache, rendering and keeping it on a miss. Hostnames that are no Site's get the unbranded 404,
 * and nothing here ever reaches the admin.
 *
 * Steps still to come, in order: Redirect domains and rules, language prefixes and domains, more
 * reserved paths (`/_webcraft/…`, `/_content/v1/…`), special files (`sitemap.xml`, `robots.txt`,
 * `llms.txt`), then the Entry by URL pattern, and the Site's 404 page and 404 log.
 */
export function createSitePipeline(services: InstallServices, options: SitePipelineOptions = {}): Handler {
	const cache = options.pageCache ?? createPageCache();
	return async (request) => {
		const url = new URL(request.url);
		const host = await services.sitePages.resolveHost(normaliseHostname(url.hostname));
		if (!host) return notFound();
		return readOnly(request, async () => {
			if (url.pathname === MEDIA_PATH.slice(0, -1) || url.pathname.startsWith(MEDIA_PATH)) {
				return mediaFile(services, request, host, url.pathname.slice(MEDIA_PATH.length));
			}
			const segments = pathSegments(url.pathname);
			if (!segments) return siteNotFound(host);
			// Pages are kept by normalised URL: one form of the path, and no query parameters (no
			// parameter changes a page yet; Filters will allow theirs, sorted).
			const key = canonicalPath(segments);
			const cached = cache.get(host.site.id, host.cacheGeneration, key);
			if (cached) return pageResponse(request, host, cached, "HIT");
			const rendered = await services.sitePages.render(host, url.pathname);
			if (!rendered) return siteNotFound(host);
			const page = { html: rendered.html, etag: await etagOf(rendered.html) };
			cache.set(host.site.id, host.cacheGeneration, key, page);
			return pageResponse(request, host, page, "MISS");
		});
	};
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
	return response ?? siteNotFound(host);
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

/** A path with no page on a known Site: the plain, unbranded 404 until Sites get their own 404 page. */
function siteNotFound(host: SiteHost): Response {
	return plainText(404, "Not Found", addressHeaders(host));
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
