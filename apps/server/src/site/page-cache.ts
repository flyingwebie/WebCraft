/** A rendered page, as the page cache keeps it. */
export type CachedPage = {
	html: string;
	/** A strong ETag of the HTML: the same page always has the same one. */
	etag: string;
};

/**
 * The web process's page cache: rendered HTML per Site, by normalised URL (ADR 0004). Each page is
 * kept under the Site's page cache generation, which every publish raises in Postgres (from the web
 * process or the worker), so a publish retires the Site's whole cache at once in every web process.
 * It holds at most `maxBytes` of HTML, forgetting the least recently used pages first.
 */
export type PageCache = {
	get(siteId: string, generation: number, key: string): CachedPage | undefined;
	set(siteId: string, generation: number, key: string, page: CachedPage): void;
};

/** How much HTML the page cache holds unless told otherwise: 64 MiB. */
export const DEFAULT_PAGE_CACHE_BYTES = 64 * 1024 * 1024;

export function createPageCache(options: { maxBytes?: number } = {}): PageCache {
	const maxBytes = options.maxBytes ?? DEFAULT_PAGE_CACHE_BYTES;
	// Insertion order is use order: a page read is moved to the end, the first one goes first.
	const pages = new Map<string, CachedPage & { siteId: string }>();
	const generations = new Map<string, number>();
	let bytes = 0;

	const remove = (key: string) => {
		const page = pages.get(key);
		if (!page) return;
		pages.delete(key);
		bytes -= sizeOf(page);
	};

	/** Notes the Site's newest generation, dropping the pages older ones left behind. */
	const advance = (siteId: string, generation: number): boolean => {
		const known = generations.get(siteId);
		if (known !== undefined && generation < known) return false;
		if (known !== undefined && generation > known) {
			for (const [key, page] of pages) if (page.siteId === siteId) remove(key);
		}
		generations.set(siteId, generation);
		return true;
	};

	return {
		get(siteId, generation, key) {
			if (!advance(siteId, generation)) return undefined;
			const cacheKey = `${siteId} ${key}`;
			const page = pages.get(cacheKey);
			if (!page) return undefined;
			pages.delete(cacheKey);
			pages.set(cacheKey, page);
			return { html: page.html, etag: page.etag };
		},

		set(siteId, generation, key, page) {
			// A request that read an older generation than another one since must not store its page.
			if (!advance(siteId, generation)) return;
			const cacheKey = `${siteId} ${key}`;
			remove(cacheKey);
			const entry = { ...page, siteId };
			if (sizeOf(entry) > maxBytes) return;
			pages.set(cacheKey, entry);
			bytes += sizeOf(entry);
			for (const oldest of pages.keys()) {
				if (bytes <= maxBytes) break;
				remove(oldest);
			}
		},
	};
}

/** Roughly the memory a page takes: two bytes per character. */
function sizeOf(page: CachedPage): number {
	return page.html.length * 2;
}
