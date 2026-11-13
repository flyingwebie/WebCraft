import { components, postTypes, templates } from "@webcraft/db/schema";
import { type ElementTree, filtersPlacedIn } from "@webcraft/renderer";

import { storedComponentVersion } from "../content/component-versions.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";

/**
 * Where a Filter is placed: a Template (by kind, with its Post Type for an Entry or Archive template)
 * or one of the Site's Components whose Draft or published version holds `{{@filter}}` for it, its
 * form or one of its controls. The Filter builder opens each in the visual builder.
 */
export type FilterPlacement = {
	kind: "siteTemplate" | "searchTemplate" | "entryTemplate" | "archiveTemplate" | "component";
	id: string;
	/** The Post Type's name for an Entry or Archive template, the Component's name; null otherwise. */
	name: string | null;
	/** The Post Type of an Entry or Archive template; null otherwise. */
	postTypeId: string | null;
};

export type FilterUsage = { usedIn: FilterPlacement[] };

// A Template row's own `kind` to a FilterPlacement's (Components need none: their placements are
// always "component"). Related to, but not the same table as, the two switches on
// `FilterPlacement["kind"]` itself (`targetOf` in `preview.ts`, `builderPath` in
// `apps/server/src/ui/filters/LayoutTab.tsx`): see the comment on `targetOf` for why those two stay apart.
const KINDS = {
	site: "siteTemplate",
	search: "searchTemplate",
	entry: "entryTemplate",
	archive: "archiveTemplate",
} as const;

/** Where each of the Site's Filters is placed. */
export async function filterUsages(scope: Pick<SiteScope, "select">): Promise<(filterId: string) => FilterUsage> {
	const placements = new Map<string, FilterPlacement[]>();
	const add = (filterIds: Iterable<string>, placement: FilterPlacement) => {
		for (const filterId of filterIds) {
			const list = placements.get(filterId) ?? [];
			if (!list.some((known) => known.kind === placement.kind && known.id === placement.id)) list.push(placement);
			placements.set(filterId, list);
		}
	};
	const placedIn = (...trees: unknown[]) =>
		new Set(trees.flatMap((tree) => (tree ? filtersPlacedIn(tree as ElementTree) : [])));
	const names = new Map((await scope.select(postTypes)).map((postType) => [postType.id, postType.name]));
	for (const row of await scope.select(templates)) {
		add(placedIn(row.draft, row.published), {
			kind: KINDS[row.kind as keyof typeof KINDS] ?? "siteTemplate",
			id: row.id,
			name: row.postTypeId ? (names.get(row.postTypeId) ?? null) : null,
			postTypeId: row.postTypeId,
		});
	}
	for (const row of await scope.select(components)) {
		add(
			placedIn(
				storedComponentVersion(row.draft).tree,
				row.published === null ? null : storedComponentVersion(row.published).tree,
			),
			{ kind: "component", id: row.id, name: row.name, postTypeId: null },
		);
	}
	return (filterId) => ({ usedIn: placements.get(filterId) ?? [] });
}
