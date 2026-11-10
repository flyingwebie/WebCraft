import { bytea, foreignKey, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { entries } from "./content.ts";
import { sites } from "./tenancy.ts";

/** Reproducible, worker-rendered PNGs, like Reports' PDFs kept in Postgres, never Media records. */
export const socialCards = pgTable(
	"social_cards",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		entryId: uuid("entry_id")
			.notNull()
			.references(() => entries.id, { onDelete: "cascade" }),
		language: text("language").notNull(),
		hash: text("hash").notNull(),
		png: bytea("png").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "social_cards_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("social_cards_input_unique").on(table.siteId, table.entryId, table.language, table.hash),
	],
);
