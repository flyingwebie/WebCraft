import { bigint, bytea, foreignKey, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { people } from "./people.ts";
import { sites } from "./tenancy.ts";

// Co-editing (`@webcraft/core` › co-editing, ADR 0025): each Draft people edit live is a shared
// document (a Yjs document) that merges everyone's changes. Postgres keeps it: its merged state, and
// the changes made since that state was last merged, in order. Web processes holding the document
// hear of each new change through LISTEN/NOTIFY and read it from here. Site data like the content
// store: every row carries `workspace_id` and `site_id`, with a foreign key to `sites (workspace_id, id)`.
//
// An item is named as publishing names it: `item_kind` (`entry`, `globals`, `template`, …) and
// `item_id`, null for the items a Site has one of (the Globals, the Design system).

/**
 * One shared document per item being co-edited, made from its Draft the first time someone opens it
 * live. A document that goes is made again from the Draft with a new `id`, so an editor holding the
 * old one starts again from the new one rather than merging two unrelated histories.
 */
export const draftDocuments = pgTable(
	"draft_documents",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		itemKind: text("item_kind").notNull(),
		itemId: uuid("item_id"),
		/** The document's state (a Yjs update) with every change up to `stateThrough` merged in. */
		state: bytea("state").notNull(),
		/** The last change merged into `state`; the changes after it are in `draft_document_changes`. */
		stateThrough: bigint("state_through", { mode: "number" }).notNull().default(0),
		/**
		 * The item's Draft as its table stored it after the document's last change: a Draft written
		 * any other way (one that didn't go through the document) shows as a difference, and is brought
		 * into the document before anyone edits on.
		 */
		draft: jsonb("draft"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		/** When it last changed, or someone last opened it: documents unused for long are removed. */
		usedAt: timestamp("used_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "draft_documents_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("draft_documents_item_unique").on(table.siteId, table.itemKind, table.itemId).nullsNotDistinct(),
	],
);

/**
 * The changes to a document since its state was last merged, each a Yjs update, with who made it
 * and how they came in (`via`, as the Audit log records it). Merged into the state from time to time.
 */
export const draftDocumentChanges = pgTable(
	"draft_document_changes",
	{
		id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		documentId: uuid("document_id")
			.notNull()
			.references(() => draftDocuments.id, { onDelete: "cascade" }),
		update: bytea("update").notNull(),
		/** Who made it; null when nobody did (a Module, an Import's background work) or they are gone. */
		personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
		/** How it came in (`AuditVia`). */
		via: jsonb("via"),
		madeAt: timestamp("made_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "draft_document_changes_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("draft_document_changes_document_idx").on(table.documentId, table.id),
	],
);
