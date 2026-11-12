import { components, entries, templates } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";
import { lockComponents } from "../content/components.ts";
import { ComponentNotFoundError, EntryNotFoundError, TemplateNotFoundError } from "../content/errors.ts";
import { lockGlobals } from "../content/globals.ts";
import { lockSitePaths } from "../content/pages.ts";
import { type HistoryItem, itemIdOf } from "../history/items.ts";
import { isUuid } from "../ids.ts";
import { lockPopup } from "../popups/index.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";

/**
 * Holds an item for a change, as its own writers do (its row, until the transaction ends), so a
 * change made in its document and a write through its own save never interleave.
 *
 * First takes the advisory lock the item's own save would take before its row (`lockSitePaths` for
 * an Entry, which may move a Page; `lockComponents` for a Template or a Component), in the same
 * order every other writer does (`saveDraft`, `publishEntry`, `publishItems`, `renameComponent`,
 * `deleteComponent`, `saveTemplate`, `saveComponentDraft`, `post-types.ts`, `site-languages.ts`):
 * advisory lock first, row second. Taking the row first here and the advisory lock later (inside the
 * save `applyChange` runs after this) would let a live change and one of those writers each hold what
 * the other waits for, a deadlock (`40P01`) Postgres can only break by cancelling one of them.
 */
export async function lockItem(scope: SiteScope, item: HistoryItem): Promise<void> {
	const id = itemIdOf(item);
	switch (item.kind) {
		case "entry":
			// Every Entry's save may turn into a Page's move: hold the Site's paths before its row.
			await lockSitePaths(scope);
			// Page layouts may add a Component while it is being changed or deleted.
			await lockComponents(scope);
			break;
		case "template":
		case "component":
		case "popup":
			// Every Template's and Component's save takes this lock before its own row.
			await lockComponents(scope);
			break;
	}
	switch (item.kind) {
		case "popup":
		case "popupContent":
			await lockPopup(scope, item.id);
			return;
		case "entry": {
			const [row] =
				id && isUuid(id)
					? await scope.db
							.select({ id: entries.id })
							.from(entries)
							.where(scope.where(entries, eq(entries.id, id)))
							.for("update")
					: [];
			if (!row) throw new EntryNotFoundError();
			return;
		}
		case "template": {
			const [row] =
				id && isUuid(id)
					? await scope.db
							.select({ id: templates.id })
							.from(templates)
							.where(scope.where(templates, eq(templates.id, id)))
							.for("update")
					: [];
			if (!row) throw new TemplateNotFoundError();
			return;
		}
		case "component": {
			const [row] =
				id && isUuid(id)
					? await scope.db
							.select({ id: components.id })
							.from(components)
							.where(scope.where(components, eq(components.id, id)))
							.for("update")
					: [];
			if (!row) throw new ComponentNotFoundError();
			return;
		}
		case "globals":
			await lockGlobals(scope);
			return;
		default:
			return;
	}
}
