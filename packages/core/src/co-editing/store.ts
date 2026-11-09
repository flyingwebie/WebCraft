import { AsyncLocalStorage } from "node:async_hooks";
import { draftDocumentChanges, draftDocuments } from "@webcraft/db/schema";
import { and, asc, eq, gt, isNull, lte, type SQL, sql } from "drizzle-orm";
import * as Y from "yjs";

import type { AuditVia } from "../audit.ts";
import { sameJson } from "../content/json.ts";
import { type HistoryItem, itemIdOf } from "../history/items.ts";
import { personIdOf } from "../permissions/can.ts";
import type { Executor, SiteScope } from "../tenancy/data-layer.ts";
import { changeDocument, documentFrom, mergeChange, readDocument } from "./document.ts";
import { documentView } from "./view.ts";

/**
 * Shared documents as Postgres keeps them (ADR 0025): each item's document has a merged state and the
 * changes made since, in order; every change is announced on `DRAFTS_CHANNEL` with ids only (Postgres
 * caps a notification at 8000 bytes), and web processes holding the document read it from here.
 *
 * Every write to a Draft that a document exists for becomes a change to that document: the content
 * store's writers call `noteDraftChange`, which calls `mirrorDraftChange` here. So an API call, an AI
 * client, AI translation or a restore changing one value lands in the document as a change to that
 * value, and the people editing it live see it and keep their own work.
 */

/** The channel every web process LISTENs on. */
export const DRAFTS_CHANNEL = "webcraft_drafts";

/** How many changes a document keeps before they are merged into its state. */
const MERGE_AFTER = 200;

export type DocumentRow = typeof draftDocuments.$inferSelect;

/** Who made a change, and how they came in. */
export type ChangeAuthor = { personId: string | null; via: AuditVia | null };

/** What is announced on `DRAFTS_CHANNEL`: ids and names only. */
export type DraftsNotice =
	| { t: "change"; d: string; c: number; p: string | null; v: AuditVia | null }
	| { t: "presence"; d: string; from: string; list: unknown[] }
	| { t: "published"; s: string; k: string; i: string | null; p: string | null; v: AuditVia | null };

/** Set while the shared document itself writes a Draft: that write is already in the document. */
const documentWrites = new AsyncLocalStorage<true>();

/** Runs a save that the shared document makes, so the Draft row it writes isn't brought back into the document. */
export function writingFromDocument<Result>(work: () => Promise<Result>): Promise<Result> {
	return documentWrites.run(true, work);
}

function itemCondition(item: HistoryItem): SQL {
	const id = itemIdOf(item);
	return and(
		eq(draftDocuments.itemKind, item.kind),
		id === null ? isNull(draftDocuments.itemId) : eq(draftDocuments.itemId, id),
	) as SQL;
}

/** An item's document, held until the transaction ends; undefined when it has none. */
export async function lockDocument(scope: SiteScope, item: HistoryItem): Promise<DocumentRow | undefined> {
	const [row] = await scope.db
		.select()
		.from(draftDocuments)
		.where(scope.where(draftDocuments, itemCondition(item)))
		.for("update");
	return row;
}

/** What reads a Site's documents: a Site scope, or the background scope the web process reads with. */
export type DocumentReader = Pick<SiteScope, "db" | "where">;

/** The document a row holds: its state, then each change after it. Answers the last change it holds. */
export async function documentOf(scope: DocumentReader, row: DocumentRow): Promise<{ doc: Y.Doc; through: number }> {
	const doc = new Y.Doc({ gc: false });
	Y.applyUpdate(doc, row.state);
	const through = await applyChanges(scope, doc, row.id, row.stateThrough);
	return { doc, through: Math.max(through, row.stateThrough) };
}

/** Applies a document's changes after `after` to `doc`; answers the last one applied (or `after`). */
export async function applyChanges(
	scope: DocumentReader,
	doc: Y.Doc,
	documentId: string,
	after: number,
	origin?: unknown,
): Promise<number> {
	const changes = await scope.db
		.select({ id: draftDocumentChanges.id, update: draftDocumentChanges.update })
		.from(draftDocumentChanges)
		.where(
			scope.where(
				draftDocumentChanges,
				and(eq(draftDocumentChanges.documentId, documentId), gt(draftDocumentChanges.id, after)),
			),
		)
		.orderBy(asc(draftDocumentChanges.id));
	let through = after;
	for (const change of changes) {
		Y.applyUpdate(doc, change.update, origin);
		through = change.id;
	}
	return through;
}

/**
 * Makes an item's document from its Draft (as its table stores it), unless it has one, and answers
 * it, held until the transaction ends. Hold the item first (`lockItem`).
 */
export async function ensureDocument(scope: SiteScope, item: HistoryItem, draft: unknown): Promise<DocumentRow> {
	const existing = await lockDocument(scope, item);
	if (existing) return existing;
	const now = scope.now();
	const doc = documentFrom(documentView(item.kind, draft));
	await scope.db
		.insert(draftDocuments)
		.values({
			workspaceId: scope.workspace.id,
			siteId: scope.site.id,
			itemKind: item.kind,
			itemId: itemIdOf(item),
			state: Buffer.from(Y.encodeStateAsUpdate(doc)),
			draft: draft ?? null,
			createdAt: now,
			usedAt: now,
		})
		.onConflictDoNothing();
	doc.destroy();
	const made = await lockDocument(scope, item);
	if (!made) throw new Error("The shared document could not be made.");
	return made;
}

/**
 * Keeps a change to a document (a Yjs update), who made it, and the item's Draft as its table stores
 * it now; then announces it, once the transaction commits, to every web process. Merges the
 * document's changes into its state once it has many. Hold the document first (`lockDocument`).
 */
export async function recordChange(
	scope: SiteScope,
	row: DocumentRow,
	update: Uint8Array,
	draft: unknown,
	author: ChangeAuthor,
): Promise<number> {
	const now = scope.now();
	const [change] = await scope.db
		.insert(draftDocumentChanges)
		.values({
			workspaceId: scope.workspace.id,
			siteId: scope.site.id,
			documentId: row.id,
			update: Buffer.from(update),
			personId: author.personId,
			via: author.via,
			madeAt: now,
		})
		.returning({ id: draftDocumentChanges.id });
	if (!change) throw new Error("The change could not be kept.");
	await scope.update(draftDocuments, { draft: draft ?? null, usedAt: now }, eq(draftDocuments.id, row.id));
	await mergeIfLong(scope, row);
	await notify(scope.db, { t: "change", d: row.id, c: change.id, p: author.personId, v: author.via });
	return change.id;
}

/** Merges a document's changes into its state once there are many of them. */
async function mergeIfLong(scope: SiteScope, row: DocumentRow): Promise<void> {
	const changes = scope.where(
		draftDocumentChanges,
		and(eq(draftDocumentChanges.documentId, row.id), gt(draftDocumentChanges.id, row.stateThrough)),
	);
	if ((await scope.count(draftDocumentChanges, changes)) < MERGE_AFTER) return;
	const { doc, through } = await documentOf(scope, row);
	await scope.update(
		draftDocuments,
		{ state: Buffer.from(Y.encodeStateAsUpdate(doc)), stateThrough: through },
		eq(draftDocuments.id, row.id),
	);
	await scope.delete(
		draftDocumentChanges,
		and(eq(draftDocumentChanges.documentId, row.id), lte(draftDocumentChanges.id, through)),
	);
	doc.destroy();
}

/** Announces something to every web process, once the transaction commits. */
export async function notify(executor: Executor, notice: DraftsNotice): Promise<void> {
	await executor.execute(sql`select pg_notify(${DRAFTS_CHANNEL}, ${JSON.stringify(notice)})`);
}

/**
 * Tells the web processes that an item was published, once the publish commits, so the people editing
 * it live see who published it. Nothing is announced for an item nobody opened live.
 */
export async function announcePublished(scope: SiteScope, item: HistoryItem): Promise<void> {
	const [open] = await scope.db
		.select({ id: draftDocuments.id })
		.from(draftDocuments)
		.where(scope.where(draftDocuments, itemCondition(item)));
	if (!open) return;
	await notify(scope.db, {
		t: "published",
		s: scope.site.id,
		k: item.kind,
		i: itemIdOf(item),
		p: personIdOf(scope.access.actor),
		v: scope.access.via,
	});
}

/**
 * Brings a write to an item's Draft into its document, when it has one: called by `noteDraftChange`
 * in the transaction that writes the Draft, for every writer but the document itself. Only the values
 * the write changed (`before` to `after`, as the table stores them) change in the document; the rest
 * keeps whatever people typed meanwhile.
 */
export async function mirrorDraftChange(
	scope: SiteScope,
	item: HistoryItem,
	before: unknown,
	after: unknown,
): Promise<void> {
	if (documentWrites.getStore()) return;
	const row = await lockDocument(scope, item);
	if (!row) return;
	await bringIn(scope, item, row, before, after, {
		personId: personIdOf(scope.access.actor),
		via: scope.access.via,
	});
}

/**
 * Brings a Draft written outside the document (`before` to `after`) into it. Answers whether the
 * document changed.
 */
export async function bringIn(
	scope: SiteScope,
	item: HistoryItem,
	row: DocumentRow,
	before: unknown,
	after: unknown,
	author: ChangeAuthor,
): Promise<boolean> {
	const { doc } = await documentOf(scope, row);
	const vector = Y.encodeStateVector(doc);
	const next = mergeChange(documentView(item.kind, before), documentView(item.kind, after), readDocument(doc));
	changeDocument(doc, next);
	const changed = !sameBytes(vector, Y.encodeStateVector(doc));
	if (changed) {
		await recordChange(scope, row, Y.encodeStateAsUpdate(doc, vector), after, author);
	} else if (!sameJson(row.draft, after)) {
		await scope.update(draftDocuments, { draft: after ?? null }, eq(draftDocuments.id, row.id));
	}
	doc.destroy();
	return changed;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
