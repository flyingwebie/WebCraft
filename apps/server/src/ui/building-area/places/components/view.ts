/**
 * The Components place's view (`wc-view`, `documents.ts`): which Components it shows (All, Allowed
 * for Members, Unused), what the search holds, and the Component whose details are open. Filters are
 * history entries; the search and the chosen Component replace the address in place.
 */
export type ComponentsFilter = "all" | "allowed" | "unused";

export type ComponentsView = { filter: ComponentsFilter; q: string; component: string | null };

export const DEFAULT_VIEW: ComponentsView = { filter: "all", q: "", component: null };

/** Reads a view from the address (null: the default). Anything it doesn't know is left out. */
export function readComponentsView(view: string | null): ComponentsView {
	if (!view) return DEFAULT_VIEW;
	const params = new URLSearchParams(view);
	const filter = params.get("filter");
	return {
		filter: filter === "allowed" || filter === "unused" ? filter : "all",
		q: (params.get("q") ?? "").slice(0, 200),
		component: params.get("component") || null,
	};
}

/** Prints a view for the address: null when it is the default. */
export function printComponentsView(view: ComponentsView): string | null {
	const params = new URLSearchParams();
	if (view.filter !== "all") params.set("filter", view.filter);
	if (view.q) params.set("q", view.q);
	if (view.component) params.set("component", view.component);
	const printed = params.toString();
	return printed || null;
}

/** A Component as the grid filters it. */
export type Filterable = { id: string; name: string; placed: boolean };

/** The Components a view shows, in their order: the filter, then the search (in the name, any case). */
export function viewComponents<Item extends Filterable>(
	items: readonly Item[],
	view: ComponentsView,
	allowed: ReadonlySet<string>,
): Item[] {
	const words = view.q.trim().toLowerCase().split(/\s+/).filter(Boolean);
	return items.filter((item) => {
		if (view.filter === "allowed" && !allowed.has(item.id)) return false;
		if (view.filter === "unused" && item.placed) return false;
		const name = item.name.toLowerCase();
		return words.every((word) => name.includes(word));
	});
}

/**
 * A Component's tag from what the person typed: kept as it is when it is a tag already (`HeroSplit`),
 * else made of its words (`hero split` → `HeroSplit`).
 */
export function tagOf(typed: string): string {
	const trimmed = typed.trim();
	if (/^[A-Z][A-Za-z0-9]*$/.test(trimmed)) return trimmed;
	return trimmed
		.split(/[^A-Za-z0-9]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("");
}

/** The first free name for a copy: `HeroSplitCopy`, then `HeroSplitCopy2`, … */
export function copyName(name: string, taken: ReadonlySet<string>): string {
	const base = `${name}Copy`;
	if (!taken.has(base)) return base;
	for (let number = 2; ; number++) if (!taken.has(`${base}${number}`)) return `${base}${number}`;
}
