import { components, entries, templates } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import { ComponentNotFoundError, EntryNotFoundError, TemplateNotFoundError } from "../content/errors.ts";
import { lockGlobals } from "../content/globals.ts";
import { type HistoryItem, itemIdOf } from "../history/items.ts";
import { isUuid } from "../ids.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";

/**
 * Holds an item for a change, as its own writers do (its row, until the transaction ends), so a
 * change made in its document and a write through its own save never interleave.
 */
export async function lockItem(scope: SiteScope, item: HistoryItem): Promise<void> {
	const id = itemIdOf(item);
	switch (item.kind) {
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
