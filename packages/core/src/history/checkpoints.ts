import { checkpoints, draftChanges } from "@webcraft/db/schema";
import { and, desc, eq, isNull, type SQL, sql } from "drizzle-orm";

import type { AuditVia } from "../audit.ts";
import { mirrorDraftChange } from "../co-editing/store.ts";
import { lockComponents } from "../content/components.ts";
import { sameJson } from "../content/json.ts";
import { snapshotPropContracts } from "../content/prop-migrations.ts";
import { personIdOf } from "../permissions/can.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { storedVia } from "./attribution.ts";
import { type CheckpointReason, type HistoryCopy, listCopies, newestCopy } from "./copies.ts";
import { type HistoryItem, itemIdOf, itemState } from "./items.ts";
import { changedParts } from "./parts.ts";

/**
 * Checkpoints (GLOSSARY.md): an item's Draft, saved while it is edited, so a Draft that was changed
 * or written over can be got back before it is published. One is saved:
 * - after 10 minutes of activity: the first change to a Draft once its newest Revision or Checkpoint
 *   (or, with none, the item itself) is 10 minutes old or more saves the Draft as it was just before
 *   that change;
 * - when the last person editing it leaves (`draftLeft`): the Draft as it is;
 * - before a restore writes over it.
 * Never when the Draft is what the item's newest Revision or Checkpoint holds.
 *
 * Every Draft change also records who changed each part and when (`draft_changes`), which Compare
 * shows. Each place that writes a Draft calls `noteDraftChange` in its transaction, which also
 * brings the write into the item's shared document when it has one (Co-editing, ADR 0025); a change
 * made in the shared document is saved through the same writers, and `draftLeft` runs when its last
 * participant goes.
 */

/** How long a Draft is changed before another Checkpoint is saved. */
export const CHECKPOINT_EVERY_MS = 10 * 60 * 1000;

/**
 * A Draft as it was before a change: what it held, when it was last changed and by whom, and when the
 * item was made (activity counts from then while nothing of it is saved yet).
 */
export type DraftBefore = { content: unknown; changedAt: Date; changedBy: string | null; since: Date };

/** Who made the last change a Draft holds, as the Draft changes record it. */
type LastChange = { personId: string | null; via: AuditVia | null; changedAt: Date };

function itemCondition(item: HistoryItem): SQL {
	const id = itemIdOf(item);
	return and(
		eq(draftChanges.itemKind, item.kind),
		id === null ? isNull(draftChanges.itemId) : eq(draftChanges.itemId, id),
	) as SQL;
}

/** The newest recorded change to an item's Draft, or what its row says when none is recorded. */
async function lastChange(
	scope: SiteScope,
	item: HistoryItem,
	fallback: Pick<DraftBefore, "changedAt" | "changedBy">,
): Promise<LastChange> {
	const newest = await scope.first(draftChanges, itemCondition(item), { orderBy: [desc(draftChanges.changedAt)] });
	if (newest && newest.changedAt.getTime() >= fallback.changedAt.getTime() - 1000) {
		return { personId: newest.personId, via: storedVia(newest.via), changedAt: newest.changedAt };
	}
	return { personId: fallback.changedBy, via: null, changedAt: fallback.changedAt };
}

async function insertCheckpoint(
	scope: SiteScope,
	item: HistoryItem,
	content: unknown,
	reason: CheckpointReason,
	last: LastChange,
): Promise<void> {
	await scope.insert(checkpoints, {
		itemKind: item.kind,
		itemId: itemIdOf(item),
		content,
		takenAt: scope.now(),
		reason,
		changedBy: last.personId,
		changedVia: last.via,
		changedAt: last.changedAt,
	});
}

/**
 * Notes a change to an item's Draft, in the transaction that writes it: who changed each part and
 * when, and, after 10 minutes of activity, a Checkpoint of the Draft as it was before. `created`: the
 * item was just made, so its Draft had nothing to keep.
 */
export async function noteDraftChange(
	scope: SiteScope,
	item: HistoryItem,
	before: DraftBefore,
	after: unknown,
	options: { created?: boolean } = {},
): Promise<void> {
	if (sameJson(before.content ?? null, after ?? null)) return;
	// The item's shared document, when it has one, takes the change too (ADR 0025).
	await mirrorDraftChange(scope, item, before.content, after);
	// A Draft that held nothing yet (a new item, a Form without emails) has nothing to keep.
	if (!options.created && before.content !== null && before.content !== undefined) {
		const newest = await newestCopy(scope, item);
		const due = scope.now().getTime() - (newest?.at ?? before.since).getTime() >= CHECKPOINT_EVERY_MS;
		if (due) {
			const snapshot = await snapshotPropContracts(scope, item.kind, before.content, "draft");
			if (!(newest && (sameJson(newest.content, before.content) || sameJson(newest.content, snapshot))))
				await insertCheckpoint(scope, item, snapshot, "activity", await lastChange(scope, item, before));
		}
	}
	const parts = changedParts(item.kind, before.content, after);
	if (parts.length === 0) return;
	const now = scope.now();
	const personId = personIdOf(scope.access.actor);
	await scope.db
		.insert(draftChanges)
		.values(
			parts.map((place) => ({
				workspaceId: scope.workspace.id,
				siteId: scope.site.id,
				itemKind: item.kind,
				itemId: itemIdOf(item),
				part: place.part,
				language: place.language,
				personId,
				via: scope.access.via,
				changedAt: now,
			})),
		)
		.onConflictDoUpdate({
			target: [
				draftChanges.siteId,
				draftChanges.itemKind,
				draftChanges.itemId,
				draftChanges.part,
				draftChanges.language,
			],
			set: {
				personId: sql`excluded.person_id`,
				via: sql`excluded.via`,
				changedAt: sql`excluded.changed_at`,
			},
		});
}

/**
 * Saves the item's Draft as a Checkpoint now (`left` when the last person editing it leaves,
 * `restore` before a restore writes over it), unless it is what the newest Revision or Checkpoint
 * holds. Answers the Checkpoint saved, or null.
 */
export async function saveCheckpoint(
	scope: SiteScope,
	item: HistoryItem,
	reason: CheckpointReason,
): Promise<HistoryCopy | null> {
	if (["template", "component", "popup"].includes(item.kind)) await lockComponents(scope);
	const state = await itemState(scope, item);
	if (state.draft === null || state.draft === undefined) return null;
	const newest = await newestCopy(scope, item);
	const snapshot = await snapshotPropContracts(scope, item.kind, state.draft, "draft");
	if (newest && (sameJson(newest.content, state.draft) || sameJson(newest.content, snapshot))) return null;
	await insertCheckpoint(scope, item, snapshot, reason, await lastChange(scope, item, state));
	const { copies } = await listCopies(scope, item, { limit: 1 });
	return copies[0] ?? null;
}

/**
 * The last person editing an item's Draft left (open the Site with `historyEditPermission(item)`):
 * its Draft is saved as a Checkpoint unless nothing changed since the newest Revision or Checkpoint.
 * The admin's editors call it when they close; Co-editing calls it when its last participant goes.
 */
export async function draftLeft(scope: SiteScope, item: HistoryItem): Promise<HistoryCopy | null> {
	return scope.transaction((tx) => saveCheckpoint(tx, item, "left"));
}

/** Who last changed each part of an item's Draft, by `part` and language (`""` for every language). */
export async function partChanges(
	scope: SiteScope,
	item: HistoryItem,
): Promise<Map<string, { personId: string | null; via: AuditVia; changedAt: Date }>> {
	const rows = await scope.select(draftChanges, itemCondition(item));
	return new Map(
		rows.map((row) => [
			`${row.part}\u0000${row.language ?? ""}`,
			{ personId: row.personId, via: storedVia(row.via), changedAt: row.changedAt },
		]),
	);
}
