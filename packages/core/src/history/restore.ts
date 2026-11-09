import { scripts, templates } from "@webcraft/db/schema";
import { readDesignSystem } from "@webcraft/renderer";
import { eq } from "drizzle-orm";

import { restoreConsentTextDraft } from "../consent/text.ts";
import { storedComponentVersion } from "../content/component-versions.ts";
import { type ComponentSources, NO_MODULE_COMPONENTS, saveComponentDraft } from "../content/components.ts";
import { restoreEntryDraft } from "../content/entries.ts";
import { ScriptNotFoundError, TemplateNotFoundError } from "../content/errors.ts";
import { restoreGlobalsDraft } from "../content/globals.ts";
import { restoreLoopDraft } from "../content/loops.ts";
import { saveScriptDraft } from "../content/scripts.ts";
import { saveArchiveTemplate, saveEntryTemplate, saveSearchTemplate, saveSiteTemplate } from "../content/templates.ts";
import { editable, saveDesignSystemDraft } from "../design-system/drafts.ts";
import { saveFilterDraft } from "../filters/filters.ts";
import { saveFormDraft, saveFormEmails } from "../forms/forms.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { saveCheckpoint } from "./checkpoints.ts";
import { type CopyRef, getCopy, type HistoryCopy } from "./copies.ts";
import { type HistoryItem, type HistoryItemSummary, itemIdOf, itemState } from "./items.ts";

/** What a restore did: the copy it put into the Draft, and the Checkpoint of the Draft saved first (null: nothing new to keep). */
export type Restored = { item: HistoryItemSummary; restored: HistoryCopy; checkpoint: HistoryCopy | null };

/**
 * Restores a Revision or Checkpoint into an item's Draft (open the Site with
 * `historyEditPermission(item)`: anyone who may change the Draft). In one transaction: the Draft as it
 * is is saved as a Checkpoint first (unless the newest Revision or Checkpoint holds it already), then
 * the copy's version is written into the Draft through the item's own save, checked as any change is
 * (a Template placing a Component deleted since is refused), and the restore goes in the Audit log
 * (`draft.restore`). Nothing is published: visitors see the change once someone publishes it. With
 * Co-editing (ADR 0025) it is one more change to the shared Draft.
 */
export async function restoreCopy(
	scope: SiteScope,
	item: HistoryItem,
	ref: CopyRef,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<Restored> {
	return scope.transaction(async (tx) => {
		const state = await itemState(tx, item);
		const copy = await getCopy(tx, item, ref);
		const checkpoint = await saveCheckpoint(tx, item, "restore");
		await writeDraft(tx, item, copy.content, sources);
		const { content: _, ...restored } = copy;
		await tx.audit("draft.restore", {
			item: { kind: item.kind, ...("id" in item ? { id: item.id } : {}) },
			name: state.summary.name,
			from: { type: restored.type, id: restored.id, at: restored.at.toISOString() },
		});
		return { item: (await itemState(tx, item)).summary, restored, checkpoint };
	});
}

/** Writes a version into an item's Draft through the item's own save. */
async function writeDraft(scope: SiteScope, item: HistoryItem, content: unknown, sources: ComponentSources) {
	const id = itemIdOf(item) ?? "";
	switch (item.kind) {
		case "entry":
			await restoreEntryDraft(scope, id, content);
			return;
		case "globals":
			await restoreGlobalsDraft(scope, content);
			return;
		case "consentBanner":
			await restoreConsentTextDraft(scope, content);
			return;
		case "formEmails":
			await saveFormEmails(scope, id, content as Record<string, unknown>);
			return;
		case "form":
			await saveFormDraft(scope, id, content as Record<string, unknown>);
			return;
		case "filter":
			await saveFilterDraft(scope, id, content as Record<string, unknown>);
			return;
		case "loop":
			await restoreLoopDraft(scope, id, content);
			return;
		case "component": {
			const version = storedComponentVersion(content);
			await saveComponentDraft(scope, id, { props: version.props, tree: version.tree }, sources);
			return;
		}
		case "template": {
			const row = await scope.first(templates, eq(templates.id, id));
			if (!row) throw new TemplateNotFoundError();
			if (row.kind === "site") await saveSiteTemplate(scope, content, sources);
			else if (row.kind === "search") await saveSearchTemplate(scope, content, sources);
			else if (row.kind === "archive") await saveArchiveTemplate(scope, row.postTypeId ?? "", content, sources);
			else await saveEntryTemplate(scope, row.postTypeId ?? "", content, sources);
			return;
		}
		case "script": {
			const row = await scope.first(scripts, eq(scripts.id, id));
			if (!row) throw new ScriptNotFoundError();
			await saveScriptDraft(scope, row.entryId, typeof content === "string" ? content : "");
			return;
		}
		case "designSystem": {
			const { tokens, classes, baseStyles, customCss, darkMode } = editable(readDesignSystem(content));
			await saveDesignSystemDraft(scope, {
				tokens,
				classes: classes.map(({ generated: _, ...each }) => each),
				baseStyles,
				customCss,
				darkMode,
			});
			return;
		}
	}
}
