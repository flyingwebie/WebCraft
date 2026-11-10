import {
	type InstallServices,
	LLMS_FILE,
	MARKDOWN_SUFFIX,
	ROBOTS_PATH,
	SITEMAP_LIMITS,
	SITEMAP_PATH,
	SITEMAPS_FOLDER,
	type SiteHost,
	type SitemapLimits,
	STAGING_ROBOTS,
} from "@webcraft/core";

import { matchesETag } from "../media-response.ts";
import { readOnly } from "../responses.ts";
import type { CachedPage, PageCache } from "./page-cache.ts";

/**
 * The Site's discovery files (spec stories 117, 118, 119), at the Site pipeline's reserved-path step:
 * robots.txt, the sitemaps, each language's llms.txt and Entries' Markdown copies. Each is built on request on one of the Site's domains and kept in the page cache under
 * the Site's page cache generation, like a page, so a publish or a change to a setting shows at once
 * on every web process. The Staging address offers none of them: its robots.txt keeps every crawler out.
 */

/** Discovery files may be kept, but are checked with the server each time, like pages. */
const FILE_CACHE_CONTROL = "public, max-age=0, must-revalidate";

/**
 * The Staging address's robots.txt, which keeps every crawler out: answered to everyone, before the
 * Staging address's access check, so crawlers read it. Null for every other request.
 */
export async function stagingRobots(request: Request, host: SiteHost): Promise<Response | null> {
	if (host.address !== "staging" || new URL(request.url).pathname !== ROBOTS_PATH) return null;
	return readOnly(
		request,
		() =>
			new Response(STAGING_ROBOTS, {
				status: 200,
				headers: {
					"content-type": "text/plain; charset=utf-8",
					"cache-control": FILE_CACHE_CONTROL,
					"x-content-type-options": "nosniff",
					"x-robots-tag": "noindex",
				},
			}),
	);
}

/**
 * A discovery file at a request's path on one of the Site's domains, from the page cache or built
 * and kept on a miss; null for a path that names none (the pipeline then answers its plain 404).
 */
export async function discoveryFile(
	services: InstallServices,
	cache: PageCache,
	request: Request,
	host: SiteHost,
	limits: SitemapLimits = SITEMAP_LIMITS,
): Promise<Response | null> {
	if (host.address === "staging" || host.address === "redirect") return null;
	const { pathname } = new URL(request.url);
	if (pathname === ROBOTS_PATH) {
		return kept(services, cache, request, host, pathname, TEXT, () => services.discovery.robots(host));
	}
	if (pathname === SITEMAP_PATH) {
		return kept(services, cache, request, host, pathname, XML, () => services.discovery.sitemapIndex(host, limits));
	}
	if (pathname.startsWith(SITEMAPS_FOLDER)) {
		const name = pathname.slice(SITEMAPS_FOLDER.length);
		return kept(services, cache, request, host, pathname, XML, () => services.discovery.sitemap(host, name, limits));
	}
	if (pathname === `/${LLMS_FILE}` || pathname.endsWith(`/${LLMS_FILE}`)) {
		return kept(services, cache, request, host, pathname, TEXT, async () => {
			const answer = await services.discovery.llms(host, pathname);
			return answer && "location" in answer ? { redirect: answer.location } : (answer?.text ?? null);
		});
	}
	if (pathname.endsWith(MARKDOWN_SUFFIX)) {
		return kept(services, cache, request, host, pathname, MARKDOWN, async () => {
			const answer = await services.discovery.markdown(host, pathname);
			if (!answer) return null;
			if ("location" in answer) return { redirect: answer.location };
			// The page's canonical URL, as its head names it: a copy never competes with its page.
			return { text: answer.text, headers: { link: `<${answer.canonical}>; rel="canonical"` } };
		});
	}
	return null;
}

const TEXT = "text/plain; charset=utf-8";
const XML = "application/xml; charset=utf-8";
const MARKDOWN = "text/markdown; charset=utf-8";

/**
 * A file kept in the page cache under its address, built with `build` on a miss: its text, where it
 * is instead (a 301, kept by nobody), or null for no such file.
 */
async function kept(
	services: InstallServices,
	cache: PageCache,
	request: Request,
	host: SiteHost,
	pathname: string,
	contentType: string,
	build: () => Promise<string | { text: string; headers: Record<string, string> } | { redirect: string } | null>,
): Promise<Response | null> {
	const key = `${host.origin}${pathname}`;
	const found = cache.get(host.site.id, host.cacheGeneration, key, services.clock.now());
	if (found) return fileResponse(request, found, "HIT");
	const built = await build();
	if (built === null) return null;
	if (typeof built !== "string" && "redirect" in built) {
		return new Response(null, {
			status: 301,
			headers: { location: built.redirect, "cache-control": FILE_CACHE_CONTROL },
		});
	}
	const text = typeof built === "string" ? built : built.text;
	const headers = typeof built === "string" ? {} : built.headers;
	const file: CachedPage = {
		html: text,
		etag: await etagOf(text),
		headers: { "content-type": contentType, ...headers },
	};
	cache.set(host.site.id, host.cacheGeneration, key, file);
	return fileResponse(request, file, "MISS");
}

function fileResponse(request: Request, file: CachedPage, cacheStatus: "HIT" | "MISS"): Response {
	const headers: Record<string, string> = {
		"cache-control": FILE_CACHE_CONTROL,
		etag: file.etag,
		"x-cache": cacheStatus,
		"x-content-type-options": "nosniff",
		...file.headers,
	};
	if (matchesETag(request.headers.get("if-none-match"), file.etag)) {
		return new Response(null, { status: 304, headers });
	}
	return new Response(file.html, { status: 200, headers });
}

/** A strong ETag: the SHA-256 of the text, in base64url. */
async function etagOf(text: string): Promise<string> {
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
	return `"${Buffer.from(digest).toString("base64url")}"`;
}
