import { customType, foreignKey, index, pgTable, primaryKey, text, uuid } from "drizzle-orm/pg-core";

import { entries } from "./content.ts";
import { sites } from "./tenancy.ts";

/** Postgres's full-text document type. Written and read only through SQL functions (`to_tsvector`). */
const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });

/**
 * The Site search index (ADR 0021): one full-text document per published Entry and language it is
 * shown in, built from its Post Type's Searched fields and their weights, in the language's text search
 * configuration (`simple` where Postgres has none). Every Post Type is indexed; whether one shows in
 * Site search is its `searchable` setting. Kept up to date by publishing, and rebuilt by a job when
 * Searched fields or the Site's languages change. Site data: the data layer limits every query to one
 * Site, and queries name the language, so each Site and language has an index of its own.
 */
export const searchDocuments = pgTable(
	"search_documents",
	{
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		entryId: uuid("entry_id").notNull(),
		/** The language the document is in: a BCP 47 tag, one of the Site's languages. */
		language: text("language").notNull(),
		/** The Searched fields' text, each weighted A to D. */
		document: tsvector("document").notNull(),
		/** The Searched fields' text besides the title, as plain text, for the snippets hits show. */
		text: text("text").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.entryId, table.language] }),
		foreignKey({
			name: "search_documents_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "search_documents_entry_fkey",
			columns: [table.siteId, table.entryId],
			foreignColumns: [entries.siteId, entries.id],
		}).onDelete("cascade"),
		index("search_documents_site_id_language_idx").on(table.siteId, table.language),
		index("search_documents_document_idx").using("gin", table.document),
	],
);
