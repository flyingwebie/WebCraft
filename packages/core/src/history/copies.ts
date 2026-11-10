import { checkpoints, postTypes, revisions } from "@webcraft/db/schema";
import { and, desc, eq, isNull, type SQL, sql } from "drizzle-orm";

import { isUuid } from "../ids.ts";
import { personIdOf } from "../permissions/can.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { type Attribution, attribution, peopleNames, storedVia } from "./attribution.ts";
import { type HistoryItem, type ItemState, itemIdOf, itemState } from "./items.ts";
import { readHistorySettings } from "./settings.ts";

/**
 * Revisions and Checkpoints, together an item's history. Both hold the item's whole version as its
 * table stores it; a Revision is saved by each publish, a Checkpoint from the Draft while it is edited
 * (see `checkpoints.ts`).
 */

/** Which kind of saved copy: a Revision (a publish) or a Checkpoint (the Draft, while it was edited). */
export type CopyType = "revision" | "checkpoint";

/** Why a Checkpoint was saved: 10 minutes of changes, the last person leaving, a restore over it, or a submission for Review. */
export type CheckpointReason = "activity" | "left" | "restore" | "review";

/** Names one saved copy of an item. */
export type CopyRef = { type: CopyType; id: string };

/** One saved copy, as history lists it. */
export type HistoryCopy = {
	type: CopyType;
	id: string;
	/** When it was saved: a Revision when it was published, a Checkpoint when it was taken. */
	at: Date;
	/**
	 * A Revision: who published it. A Checkpoint: who made the last change the Draft held. Null when
	 * nobody is known.
	 */
	by: Attribution | null;
	/** Why a Checkpoint was saved; null for a Revision. */
	reason: CheckpointReason | null;
	/** A Checkpoint: when the Draft it holds was last changed; a Revision: when it was published. */
	changedAt: Date;
};

/** A saved copy with the version it holds. */
export type StoredCopy = HistoryCopy & { content: unknown };

export class RevisionNotFoundError extends Error {
	override name = "RevisionNotFoundError";
	constructor() {
		super("This item has no such Revision. It may have been removed after the time Revisions are kept.");
	}
}

export class CheckpointNotFoundError extends Error {
	override name = "CheckpointNotFoundError";
	constructor() {
		super("This item has no such Checkpoint. It may have been removed after the time Checkpoints are kept.");
	}
}

/** Whether new Revisions are saved for an item, and if not, which switch is off. */
export type RevisionsState = { on: boolean; off: "install" | "postType" | null };

/** Whether publishing an item saves a Revision now: the Install's switch, then an Entry's Post Type's. */
export async function revisionsState(scope: SiteScope, state: Pick<ItemState, "postTypeId">): Promise<RevisionsState> {
	const settings = await readHistorySettings(scope.db);
	if (!settings.revisionsOn) return { on: false, off: "install" };
	if (state.postTypeId) {
		const postType = await scope.first(postTypes, eq(postTypes.id, state.postTypeId));
		if (postType && !postType.revisions) return { on: false, off: "postType" };
	}
	return { on: true, off: null };
}

/**
 * Saves a Revision of an item just published, in the publish's transaction: its whole published
 * version, every language, who published it, how they came in and when. Nothing when Revisions are
 * off for the Install or, for an Entry, its Post Type. Publishing one item, Publish all and Scheduled
 * publishes all come through `publishItems`, which calls it for each item.
 */
export async function saveRevision(scope: SiteScope, item: HistoryItem): Promise<void> {
	const state = await itemState(scope, item);
	if (state.published === null || !(await revisionsState(scope, state)).on) return;
	await scope.insert(revisions, {
		itemKind: item.kind,
		itemId: itemIdOf(item),
		content: state.published,
		publishedAt: scope.now(),
		publishedBy: personIdOf(scope.access.actor),
		via: scope.access.via,
	});
}

/** The condition naming one item's rows in a history table. */
export function itemWhere(table: typeof revisions | typeof checkpoints, item: HistoryItem): SQL {
	const id = itemIdOf(item);
	return and(eq(table.itemKind, item.kind), id === null ? isNull(table.itemId) : eq(table.itemId, id)) as SQL;
}

/** The most copies one page of history lists, and how many it lists unless asked. */
export const HISTORY_PAGE = { default: 50, max: 100 } as const;

/** Where a page of history continues: after the copy saved at `at` with `id` (newest first). */
type Cursor = { at: Date; id: string };

function cursorOf(copy: HistoryCopy): string {
	return `${copy.at.toISOString()}~${copy.id}`;
}

function readCursor(cursor: string | undefined): Cursor | null {
	if (!cursor) return null;
	const [at, id] = cursor.split("~");
	const time = new Date(at ?? "");
	return Number.isNaN(time.getTime()) || !id || !isUuid(id) ? null : { at: time, id };
}

/** Newest first; copies saved in the same instant by id, as the database orders uuids. */
function newerFirst(a: HistoryCopy, b: HistoryCopy): number {
	return b.at.getTime() - a.at.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * One page of an item's history, Revisions and Checkpoints together, newest first, with `cursor` for
 * the next page (null after the last).
 */
export async function listCopies(
	scope: SiteScope,
	item: HistoryItem,
	options: { cursor?: string; limit?: number } = {},
): Promise<{ copies: HistoryCopy[]; cursor: string | null }> {
	const limit = Math.min(Math.max(options.limit ?? HISTORY_PAGE.default, 1), HISTORY_PAGE.max);
	const after = readCursor(options.cursor);
	const revisionRows = await scope.select(
		revisions,
		and(
			itemWhere(revisions, item),
			after ? sql`(${revisions.publishedAt}, ${revisions.id}) < (${after.at}, ${after.id}::uuid)` : undefined,
		),
		{ orderBy: [desc(revisions.publishedAt), desc(revisions.id)], limit: limit + 1 },
	);
	const checkpointRows = await scope.select(
		checkpoints,
		and(
			itemWhere(checkpoints, item),
			after ? sql`(${checkpoints.takenAt}, ${checkpoints.id}) < (${after.at}, ${after.id}::uuid)` : undefined,
		),
		{ orderBy: [desc(checkpoints.takenAt), desc(checkpoints.id)], limit: limit + 1 },
	);
	const names = await peopleNames(scope.db, [
		...revisionRows.map((row) => row.publishedBy),
		...checkpointRows.map((row) => row.changedBy),
	]);
	const all = [
		...revisionRows.map((row) => revisionCopy(row, names)),
		...checkpointRows.map((row) => checkpointCopy(row, names)),
	].sort(newerFirst);
	const copies = all.slice(0, limit);
	const last = copies.at(-1);
	return { copies, cursor: all.length > limit && last ? cursorOf(last) : null };
}

/** One saved copy of an item, with the version it holds. */
export async function getCopy(scope: SiteScope, item: HistoryItem, ref: CopyRef): Promise<StoredCopy> {
	if (ref.type === "revision") {
		const row = isUuid(ref.id)
			? await scope.first(revisions, and(itemWhere(revisions, item), eq(revisions.id, ref.id)))
			: undefined;
		if (!row) throw new RevisionNotFoundError();
		return { ...revisionCopy(row, await peopleNames(scope.db, [row.publishedBy])), content: row.content };
	}
	const row = isUuid(ref.id)
		? await scope.first(checkpoints, and(itemWhere(checkpoints, item), eq(checkpoints.id, ref.id)))
		: undefined;
	if (!row) throw new CheckpointNotFoundError();
	return { ...checkpointCopy(row, await peopleNames(scope.db, [row.changedBy])), content: row.content };
}

/** The newest saved copy of an item, Revision or Checkpoint, with what it holds; null when none is kept. */
export async function newestCopy(scope: SiteScope, item: HistoryItem): Promise<StoredCopy | null> {
	const revision = await scope.first(revisions, itemWhere(revisions, item), {
		orderBy: [desc(revisions.publishedAt), desc(revisions.id)],
	});
	const checkpoint = await scope.first(checkpoints, itemWhere(checkpoints, item), {
		orderBy: [desc(checkpoints.takenAt), desc(checkpoints.id)],
	});
	const none = new Map<string, string>();
	const candidates = [
		...(revision ? [{ ...revisionCopy(revision, none), content: revision.content }] : []),
		...(checkpoint ? [{ ...checkpointCopy(checkpoint, none), content: checkpoint.content }] : []),
	].sort(newerFirst);
	return candidates[0] ?? null;
}

function revisionCopy(row: typeof revisions.$inferSelect, names: ReadonlyMap<string, string>): HistoryCopy {
	return {
		type: "revision",
		id: row.id,
		at: row.publishedAt,
		by: attribution(row.publishedBy, storedVia(row.via), names),
		reason: null,
		changedAt: row.publishedAt,
	};
}

function checkpointCopy(row: typeof checkpoints.$inferSelect, names: ReadonlyMap<string, string>): HistoryCopy {
	return {
		type: "checkpoint",
		id: row.id,
		at: row.takenAt,
		by:
			row.changedVia === null && row.changedBy === null
				? null
				: attribution(row.changedBy, storedVia(row.changedVia), names),
		reason: row.reason as CheckpointReason,
		changedAt: row.changedAt,
	};
}
