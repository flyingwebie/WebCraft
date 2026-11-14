import { foreignKey, index, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { sites } from "./tenancy.ts";

/**
 * When each open Check of a Site was first seen. Checks are worked out whenever they are read
 * (`services.checks`); reading them keeps one row per Check found, by what it is (`key`: a hash of the
 * item, language, check and where it is), and drops the rows of Checks no longer found, so a Check fixed
 * and broken again starts over.
 */
export const checkSightings = pgTable(
	"check_sightings",
	{
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		key: text("key").notNull(),
		/** The item it is on (`entry`, `template`, `component`, `popup`, `designSystem`) and its id. */
		itemKind: text("item_kind").notNull(),
		itemId: text("item_id").notNull(),
		language: text("language").notNull(),
		firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		primaryKey({ name: "check_sightings_pkey", columns: [table.siteId, table.key] }),
		foreignKey({
			name: "check_sightings_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("check_sightings_item_idx").on(table.siteId, table.itemKind, table.itemId),
	],
);
