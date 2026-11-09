import type { Database } from "@webcraft/db";

import type { SiteScope } from "../tenancy/data-layer.ts";
import { draftLeft } from "./checkpoints.ts";
import {
	type CopyRef,
	getCopy,
	type HistoryCopy,
	listCopies,
	type RevisionsState,
	revisionsState,
	type StoredCopy,
} from "./copies.ts";
import { type HistoryItem, type HistoryItemSummary, itemState } from "./items.ts";
import { changeHistorySettings, type HistorySettings, readHistorySettings } from "./settings.ts";

export { type Attribution, clientOf } from "./attribution.ts";
export { CHECKPOINT_EVERY_MS, type DraftBefore, noteDraftChange } from "./checkpoints.ts";
export {
	CheckpointNotFoundError,
	type CheckpointReason,
	type CopyRef,
	type CopyType,
	HISTORY_PAGE,
	type HistoryCopy,
	RevisionNotFoundError,
	type RevisionsState,
	type StoredCopy,
} from "./copies.ts";
export {
	type HistoryGroup,
	type HistoryItem,
	type HistoryItemSummary,
	historyEditPermission,
	historyReadPermission,
} from "./items.ts";
export { HISTORY_LIMITS, type HistorySettings } from "./settings.ts";

/** One page of an item's history, as `history.list` answers it. */
export type HistoryPage = {
	item: HistoryItemSummary;
	copies: HistoryCopy[];
	/** Where the next page starts; null after the last. */
	cursor: string | null;
	/** Whether publishing it saves a Revision now, and if not which switch is off. */
	revisions: RevisionsState;
	/** How long Revisions and Checkpoints are kept on this Install. */
	retention: Omit<HistorySettings, "revisionsOn">;
};

/**
 * An item's history (GLOSSARY.md › Revision, Checkpoint): every publish saves a Revision of the
 * version it published, and the Draft is saved as a Checkpoint while it is edited; people compare
 * them with the Draft and restore them into it, which never publishes.
 */
export type HistoryService = {
	/**
	 * One page of an item's history, newest first. Open the Site with `historyReadPermission(item)`:
	 * whatever reading the item itself needs.
	 */
	list(scope: SiteScope, item: HistoryItem, options?: { cursor?: string; limit?: number }): Promise<HistoryPage>;
	/** One saved copy with the whole version it holds, every language included. */
	get(scope: SiteScope, item: HistoryItem, ref: CopyRef): Promise<{ item: HistoryItemSummary; copy: StoredCopy }>;
	/**
	 * The last person editing an item's Draft left (open the Site with `historyReadPermission(item)`):
	 * its Draft is saved as a Checkpoint unless nothing changed since the newest Revision or Checkpoint.
	 * The admin's editors call it as they close; Co-editing (#71) calls it when its last participant goes.
	 */
	leave(scope: SiteScope, item: HistoryItem): Promise<HistoryCopy | null>;
	/** Install settings › Revisions. */
	settings(): Promise<HistorySettings>;
	/** Changes Install settings › Revisions (open the Install with `install.manage`). */
	changeSettings: typeof changeHistorySettings;
};

export function createHistory(deps: { database: Database }): HistoryService {
	return {
		async list(scope, item, options = {}) {
			const state = await itemState(scope, item);
			const page = await listCopies(scope, item, options);
			const { revisionsOn: _, ...retention } = await readHistorySettings(scope.db);
			return { item: state.summary, ...page, revisions: await revisionsState(scope, state), retention };
		},
		async get(scope, item, ref) {
			const state = await itemState(scope, item);
			return { item: state.summary, copy: await getCopy(scope, item, ref) };
		},
		async leave(scope, item) {
			await itemState(scope, item);
			return draftLeft(scope, item);
		},
		settings: () => readHistorySettings(deps.database.db),
		changeSettings: changeHistorySettings,
	};
}
