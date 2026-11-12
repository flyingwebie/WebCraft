import type { StateReader } from "@webcraft/core";

/** A rendered page, as the page cache keeps it. */
export type CachedPage = {
	html: string;
	/** A strong ETag of the HTML: the same page always has the same one. */
	etag: string;
	/**
	 * When the page stops being valid with time alone (a Condition reading `now`, a Loop listing the
	 * last 12 months), in milliseconds since the epoch; null while only a publish changes it.
	 */
	expiresAt?: number | null;
	/** The security headers the page is sent with: its Content Security Policy (ADR 0023). */
	headers: Readonly<Record<string, string>>;
};

/**
 * The web process's page cache: rendered HTML per Site, by normalised URL (ADR 0004). Each page is
 * kept under the Site's page cache generation, which every publish raises in Postgres (from the web
 * process or the worker), so a publish retires the Site's whole cache at once in every web process.
 * It holds at most `maxBytes` of HTML, forgetting the least recently used pages first. A page that
 * shows something time changes is kept only until its `expiresAt`, by the Install's clock (`now`).
 *
 * Filtered pages (GLOSSARY.md › Filter) are kept under their normalised address, each a **variant**:
 * a Site keeps at most `maxVariants` of them at a time, and `set` keeps no more past it (the page is
 * then answered without being kept), so endless combinations of choices can't fill the cache. It also
 * remembers what each path's Filters read from an address (`reader`), so a request is looked up under
 * its normal address before anything renders.
 */
export type PageCache = {
	get(siteId: string, generation: number, key: string, now: Date): CachedPage | undefined;
	/** Keeps a page; false when it is a variant past the Site's limit, and wasn't kept. */
	set(siteId: string, generation: number, key: string, page: CachedPage, options?: { variant?: boolean }): boolean;
	/** Whether the Site still has room for another variant: past its limit, `set` keeps none. */
	takesVariants(siteId: string): boolean;
	/** What the Filters of the page at `path` (an origin and a path) read, as the last render found. */
	reader(siteId: string, generation: number, path: string): StateReader | undefined;
	setReader(siteId: string, generation: number, path: string, reader: StateReader): void;
};

/** How much HTML the page cache holds unless told otherwise: 64 MiB. */
export const DEFAULT_PAGE_CACHE_BYTES = 64 * 1024 * 1024;

/** How many filtered pages one Site keeps at a time unless told otherwise. */
export const DEFAULT_FILTER_VARIANTS = 1_000;

/** How many paths' readers the cache remembers, across Sites. */
const KEPT_READERS = 10_000;

export function createPageCache(options: { maxBytes?: number; maxVariants?: number } = {}): PageCache {
	const maxBytes = options.maxBytes ?? DEFAULT_PAGE_CACHE_BYTES;
	const maxVariants = options.maxVariants ?? DEFAULT_FILTER_VARIANTS;
	// Insertion order is use order: a page read is moved to the end, the first one goes first.
	const pages = new Map<string, CachedPage & { siteId: string; variant: boolean }>();
	const generations = new Map<string, number>();
	const variants = new Map<string, number>();
	const readers = new Map<string, { siteId: string; reader: StateReader }>();
	let bytes = 0;

	const remove = (key: string) => {
		const page = pages.get(key);
		if (!page) return;
		pages.delete(key);
		bytes -= sizeOf(page);
		if (page.variant) variants.set(page.siteId, (variants.get(page.siteId) ?? 1) - 1);
	};

	/** Notes the Site's newest generation, dropping the pages (and readers) older ones left behind. */
	const advance = (siteId: string, generation: number): boolean => {
		const known = generations.get(siteId);
		if (known !== undefined && generation < known) return false;
		if (known !== undefined && generation > known) {
			for (const [key, page] of pages) if (page.siteId === siteId) remove(key);
			for (const [key, kept] of readers) if (kept.siteId === siteId) readers.delete(key);
		}
		generations.set(siteId, generation);
		return true;
	};

	return {
		get(siteId, generation, key, now) {
			if (!advance(siteId, generation)) return undefined;
			const cacheKey = `${siteId} ${key}`;
			const page = pages.get(cacheKey);
			if (!page) return undefined;
			if (page.expiresAt != null && now.getTime() >= page.expiresAt) {
				remove(cacheKey);
				return undefined;
			}
			pages.delete(cacheKey);
			pages.set(cacheKey, page);
			return { html: page.html, etag: page.etag, headers: page.headers };
		},

		takesVariants(siteId) {
			return (variants.get(siteId) ?? 0) < maxVariants;
		},

		set(siteId, generation, key, page, { variant = false } = {}) {
			// A request that read an older generation than another one since must not store its page.
			if (!advance(siteId, generation)) return true;
			const cacheKey = `${siteId} ${key}`;
			remove(cacheKey);
			if (variant && (variants.get(siteId) ?? 0) >= maxVariants) return false;
			const entry = { ...page, siteId, variant };
			if (sizeOf(entry) > maxBytes) return true;
			pages.set(cacheKey, entry);
			bytes += sizeOf(entry);
			if (variant) variants.set(siteId, (variants.get(siteId) ?? 0) + 1);
			for (const oldest of pages.keys()) {
				if (bytes <= maxBytes) break;
				remove(oldest);
			}
			return true;
		},

		reader(siteId, generation, path) {
			if (!advance(siteId, generation)) return undefined;
			return readers.get(`${siteId} ${path}`)?.reader;
		},

		setReader(siteId, generation, path, reader) {
			if (!advance(siteId, generation)) return;
			const key = `${siteId} ${path}`;
			readers.delete(key);
			readers.set(key, { siteId, reader });
			for (const oldest of readers.keys()) {
				if (readers.size <= KEPT_READERS) break;
				readers.delete(oldest);
			}
		},
	};
}

/** Roughly the memory a page takes: two bytes per character. */
function sizeOf(page: CachedPage): number {
	return page.html.length * 2;
}
