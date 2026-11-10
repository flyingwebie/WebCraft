import { components, popups, templates } from "@webcraft/db/schema";
import { type ElementTree, type PopupFound, popupsPlacedIn } from "@webcraft/renderer";
import { storedComponentVersion } from "../content/component-versions.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";

/** Explicit placements bypass Display rules, so their phone Checks must include that possibility. */
export async function popupAttachments(scope: Pick<SiteScope, "select">): Promise<ReadonlySet<string>> {
	const trees = [
		...(await scope.select(templates)).map((row) => row.draft as ElementTree),
		...(await scope.select(components)).map((row) => storedComponentVersion(row.draft).tree),
	];
	return new Set(trees.flatMap(popupsPlacedIn));
}

export async function sitePopups(scope: Pick<SiteScope, "select">, which: "draft" | "published") {
	const rows = await scope.select(popups);
	const found = (row: (typeof rows)[number] | undefined): PopupFound =>
		!row
			? undefined
			: which === "published" && !row.published
				? { refused: `The Popup ${row.key} is not published yet.` }
				: { id: row.id, key: row.key };
	return {
		keyed: (key: string) => found(rows.find((r) => r.key === key)),
		byId: (id: string) => found(rows.find((r) => r.id === id)),
		keyOf: (id: string) => rows.find((r) => r.id === id)?.key,
	};
}
