import type { PostType } from "../content/post-types.ts";
import { type ListedUrl, type Listing, listedEntries, listedPostTypes } from "./listed.ts";

/**
 * Sitemaps (spec story 117), as the sitemaps protocol (0.9) writes them: `/sitemap.xml` is an index
 * of one sitemap per Post Type with listed pages (Pages first), each at `/sitemaps/<key>-<n>.xml`,
 * numbered from 1 and split into further parts past the protocol's limits (`SITEMAP_LIMITS`). Each
 * address carries `lastmod` (its last publish, as a W3C datetime) and its `hreflang` alternates as
 * `xhtml:link` elements. What is listed is `listed.ts`'s rule.
 *
 * Parts are split exactly: the index walks each Post Type's listed addresses once, a batch of Entries
 * at a time, and notes where each part starts; a part then reads only from there. Where parts start
 * is remembered per page cache generation, so a part asked for after the index reads only its own
 * Entries.
 */

/** How much one sitemap file may hold: the protocol's 50,000 addresses and 50 MB (uncompressed). */
export type SitemapLimits = { urls: number; bytes: number };

export const SITEMAP_LIMITS: SitemapLimits = { urls: 50_000, bytes: 50 * 1024 * 1024 };

/** Where a domain's sitemap index is. */
export const SITEMAP_PATH = "/sitemap.xml";

/** Where a Post Type's sitemaps are: `/sitemaps/<Post Type key>-<part>.xml`. */
export const SITEMAPS_FOLDER = "/sitemaps/";

const NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9";
const XHTML = "http://www.w3.org/1999/xhtml";
const HEAD = '<?xml version="1.0" encoding="UTF-8"?>\n';
const URLSET_OPEN = `<urlset xmlns="${NAMESPACE}" xmlns:xhtml="${XHTML}">\n`;
const URLSET_CLOSE = "</urlset>\n";

/** Where a part starts: the Entry (by id; empty for the Archive page) and how many of its addresses go before. */
type PartStart = { entryId: string; skip: number; urls: number; lastmod: Date | null };

/** A sitemap file's name for a Post Type and part: `blog-1.xml`. */
export function sitemapName(postType: Pick<PostType, "key">, part: number): string {
	return `${postType.key}-${part}.xml`;
}

/** Reads a sitemap file's name back: its Post Type key and part, or null for any other name. */
export function readSitemapName(name: string): { key: string; part: number } | null {
	const match = /^([a-z][a-z0-9-]*)-([1-9][0-9]{0,5})\.xml$/.exec(name);
	return match ? { key: match[1] as string, part: Number(match[2]) } : null;
}

/** Remembers where each Post Type's parts start, per Site, page cache generation, domain and limits. */
export function createPartStarts() {
	const kept = new Map<string, Promise<PartStart[]>>();
	return {
		of(list: Listing, postType: PostType, limits: SitemapLimits): Promise<PartStart[]> {
			const key = [
				list.host.site.id,
				list.host.cacheGeneration,
				list.host.origin,
				postType.id,
				limits.urls,
				limits.bytes,
			].join(" ");
			const found = kept.get(key);
			if (found) {
				kept.delete(key);
				kept.set(key, found);
				return found;
			}
			const starts = partStarts(list, postType, limits);
			kept.set(key, starts);
			starts.catch(() => kept.delete(key));
			for (const oldest of kept.keys()) {
				if (kept.size <= KEPT_PART_STARTS) break;
				kept.delete(oldest);
			}
			return starts;
		},
	};
}

/** How many Post Types' part starts a web process remembers, across Sites. */
const KEPT_PART_STARTS = 200;

export type PartStarts = ReturnType<typeof createPartStarts>;

/** The sitemap index of a domain: each listed Post Type's parts, with the newest change in each. */
export async function sitemapIndex(list: Listing, starts: PartStarts, limits: SitemapLimits): Promise<string> {
	let xml = `${HEAD}<sitemapindex xmlns="${NAMESPACE}">\n`;
	for (const postType of await listedPostTypes(list)) {
		const parts = await starts.of(list, postType, limits);
		parts.forEach((part, index) => {
			const loc = `${list.host.origin}${SITEMAPS_FOLDER}${sitemapName(postType, index + 1)}`;
			const lastmod = part.lastmod ? `<lastmod>${w3cDate(part.lastmod)}</lastmod>` : "";
			xml += `<sitemap><loc>${escapeXml(loc)}</loc>${lastmod}</sitemap>\n`;
		});
	}
	return `${xml}</sitemapindex>\n`;
}

/** One part of a Post Type's sitemap (`/sitemaps/<key>-<n>.xml`); null when the Site lists no such part. */
export async function sitemapPart(
	list: Listing,
	starts: PartStarts,
	limits: SitemapLimits,
	name: string,
): Promise<string | null> {
	const read = readSitemapName(name);
	if (!read) return null;
	const postType = (await listedPostTypes(list)).find((candidate) => candidate.key === read.key);
	if (!postType) return null;
	const start = (await starts.of(list, postType, limits))[read.part - 1];
	if (!start) return null;
	let xml = HEAD + URLSET_OPEN;
	let count = 0;
	let skip = start.skip;
	for await (const entry of listedEntries(list, postType, { from: start.entryId })) {
		for (const url of entry.urls) {
			if (skip > 0) {
				skip--;
				continue;
			}
			xml += urlXml(url);
			if (++count >= start.urls) return xml + URLSET_CLOSE;
		}
	}
	return xml + URLSET_CLOSE;
}

/** Walks a Post Type's listed addresses once, noting where each part starts within both limits. */
async function partStarts(list: Listing, postType: PostType, limits: SitemapLimits): Promise<PartStart[]> {
	const room = limits.bytes - byteLength(HEAD + URLSET_OPEN + URLSET_CLOSE);
	const parts: (PartStart & { bytes: number })[] = [];
	for await (const entry of listedEntries(list, postType)) {
		entry.urls.forEach((url: ListedUrl, index) => {
			const size = byteLength(urlXml(url));
			const last = parts.at(-1);
			if (!last || last.urls >= limits.urls || (last.urls > 0 && last.bytes + size > room)) {
				parts.push({ entryId: entry.id, skip: index, urls: 0, bytes: 0, lastmod: null });
			}
			const part = parts.at(-1) as PartStart & { bytes: number };
			part.urls++;
			part.bytes += size;
			if (url.lastmod && (!part.lastmod || url.lastmod > part.lastmod)) part.lastmod = url.lastmod;
		});
	}
	return parts.map(({ bytes: _, ...part }) => part);
}

/** One address of a sitemap: `<url>` with `loc`, `lastmod` and its alternates. */
function urlXml(url: ListedUrl): string {
	const lastmod = url.lastmod ? `<lastmod>${w3cDate(url.lastmod)}</lastmod>` : "";
	const alternates = url.alternates
		.map(
			(alternate) =>
				`<xhtml:link rel="alternate" hreflang="${escapeXml(alternate.hreflang)}" href="${escapeXml(encodedAddress(alternate.href))}"/>`,
		)
		.join("");
	return `<url><loc>${escapeXml(encodedAddress(url.loc))}</loc>${lastmod}${alternates}</url>\n`;
}

/** An address as the protocol wants it: every character outside ASCII percent-encoded. */
function encodedAddress(address: string): string {
	try {
		return new URL(address).href;
	} catch {
		return address;
	}
}

/** A time as a W3C datetime, to the second, in UTC: `2026-03-02T09:00:00Z`. */
export function w3cDate(at: Date): string {
	return at.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** Text escaped for XML, in elements and in attribute values. */
export function escapeXml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

function byteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}
