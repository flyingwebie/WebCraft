/**
 * How the Content place shows a list of Entries (SPEC 8, plan BA-20): its search, its status and
 * language filters and its sorting. The view is part of the shell's address (`wc-view`, a short query
 * string), so Back returns to the view before and a reload shows the same one. Pure: no React, no API.
 */

/** The statuses a list filters by: In review counts the Reviews waiting, whatever the Entry's status. */
export const STATUS_FILTERS = ["published", "draft", "changed", "review"] as const;

export type StatusFilter = (typeof STATUS_FILTERS)[number];

/** What a list can be sorted by; a leading `-` is the other way round (Z to A, newest first). */
export const SORTS = ["title", "-title", "address", "-address", "status", "author", "-updated", "updated"] as const;

export type Sort = (typeof SORTS)[number];

/** A list's view: what it searches for, the status and language it shows, and its order. */
export type ContentView = {
	q: string;
	status: StatusFilter | null;
	/** A language the Entries shown are in (not hidden in); null for every language. */
	language: string | null;
	sort: Sort;
};

/** The longest search the address keeps. */
const SEARCH_MAX = 200;

/** A list's view when its address says nothing: Pages by address, other Entries newest first. */
export function defaultView(pages: boolean): ContentView {
	return { q: "", status: null, language: null, sort: pages ? "address" : "-updated" };
}

/** Reads a view from the address's `wc-view` (null: the default); anything it doesn't know is left out. */
export function readView(view: string | null, pages: boolean): ContentView {
	const shown = defaultView(pages);
	if (!view) return shown;
	const params = new URLSearchParams(view);
	const q = params.get("q");
	if (q) shown.q = q.slice(0, SEARCH_MAX);
	const status = params.get("status");
	if (status && (STATUS_FILTERS as readonly string[]).includes(status)) shown.status = status as StatusFilter;
	const language = params.get("language");
	if (language && /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,3}$/.test(language)) shown.language = language;
	const sort = params.get("sort");
	if (sort && (SORTS as readonly string[]).includes(sort)) shown.sort = sort as Sort;
	return shown;
}

/** A view as the address keeps it: only what differs from the default, or null when nothing does. */
export function printView(view: ContentView, pages: boolean): string | null {
	const base = defaultView(pages);
	const params = new URLSearchParams();
	// Kept as typed (a space before the next word included); a search of only spaces is none.
	if (view.q.trim()) params.set("q", view.q.slice(0, SEARCH_MAX));
	if (view.status) params.set("status", view.status);
	if (view.language) params.set("language", view.language);
	if (view.sort !== base.sort) params.set("sort", view.sort);
	return params.size ? params.toString() : null;
}

/** What a list needs of an Entry to filter and sort it. */
export type ListedEntry = {
	title: string;
	slug: string;
	/** Where it is on the Site (its Draft's address until it is published); "" when unknown. */
	address: string;
	status: "draft" | "published" | "changed";
	inReview: boolean;
	hiddenLanguages: readonly string[];
	author: string;
	updatedAt: number;
};

/** Whether an Entry is in a status filter. */
export function matchesStatus(entry: ListedEntry, status: StatusFilter | null): boolean {
	if (!status) return true;
	if (status === "review") return entry.inReview;
	return entry.status === status;
}

/** The order statuses sort in: Drafts, then changed, then published (what needs attention first). */
const STATUS_ORDER = { draft: 0, changed: 1, published: 2 } as const;

/** The Entries a view shows, in its order (titles compared as people read them, in `locale`). */
export function viewEntries<T extends ListedEntry>(entries: readonly T[], view: ContentView, locale: string): T[] {
	const q = view.q.trim().toLocaleLowerCase(locale);
	const shown = entries.filter(
		(entry) =>
			matchesStatus(entry, view.status) &&
			(!view.language || !entry.hiddenLanguages.includes(view.language)) &&
			(!q ||
				entry.title.toLocaleLowerCase(locale).includes(q) ||
				entry.slug.toLocaleLowerCase(locale).includes(q) ||
				entry.address.toLocaleLowerCase(locale).includes(q)),
	);
	const collator = new Intl.Collator(locale, { sensitivity: "base", numeric: true });
	const descending = view.sort.startsWith("-");
	const key = (descending ? view.sort.slice(1) : view.sort) as "title" | "address" | "status" | "author" | "updated";
	const compare = (a: T, b: T): number => {
		switch (key) {
			case "title":
				return collator.compare(a.title, b.title);
			case "address":
				return collator.compare(a.address, b.address);
			case "status":
				return STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
			case "author":
				return collator.compare(a.author, b.author);
			case "updated":
				return a.updatedAt - b.updatedAt;
		}
	};
	// Ties keep the list's own order (newest first), whichever way the sort goes.
	return shown
		.map((entry, index) => ({ entry, index }))
		.sort((a, b) => (descending ? -compare(a.entry, b.entry) : compare(a.entry, b.entry)) || a.index - b.index)
		.map(({ entry }) => entry);
}

/**
 * Where a new Entry would be, from its title, as the create row shows it before it is made: its slug
 * in the Post Type's URL pattern (a Page at the top level is `/<slug>`).
 */
export function newAddress(title: string, urlPattern: string, pages: boolean): string {
	const slug = slugOf(title);
	if (!slug) return "";
	if (pages) return `/${slug}`;
	return urlPattern.includes("{slug}")
		? urlPattern.replace("{slug}", slug)
		: `${urlPattern.replace(/\/$/, "")}/${slug}`;
}

/**
 * A title as a slug, the way the server makes one when none is given (`slugify` in core's
 * `content/slugs.ts`, which the shell can't import): only a preview, the server makes the real one.
 */
export function slugOf(title: string): string {
	return title
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 80)
		.replace(/-+$/, "");
}
