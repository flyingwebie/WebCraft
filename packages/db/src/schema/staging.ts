import { foreignKey, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { people, sessions } from "./people.ts";
import { sites } from "./tenancy.ts";

// The Staging address (`@webcraft/core` › staging, ADR 0014): a Site on the agency's own domain,
// showing its Drafts to the people reviewing it. The admin's session cookie never reaches it, so a
// person signed in to the admin opens it through a single-use link, as Edit mode does. Both tables
// are Site data (`workspace_id`, `site_id`, with a foreign key to `sites (workspace_id, id)`), and both
// hang off the admin session that asked: signing out, or that session being revoked or ending,
// deletes them with it. Only hashes of their tokens are stored.

/** Links opening a Site's Staging address: each works once, within 60 seconds, for one person and one Site. */
export const stagingLinks = pgTable(
	"staging_links",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		/** The admin session the link was made in. */
		adminSessionId: uuid("admin_session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		/** The SHA-256 of the link's token, in hexadecimal. */
		tokenHash: text("token_hash").notNull().unique(),
		/** The page the link opens, a path on the Site such as `/blog/fresh-bread`. */
		path: text("path").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		/** When it was followed; a link works once. */
		usedAt: timestamp("used_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "staging_links_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("staging_links_expires_at_idx").on(table.expiresAt),
	],
);

/**
 * Staging sessions: one browser's Staging cookie on one Site's Staging address, for at most 8 hours.
 * Every request checks the admin session it belongs to and the person's access to the Site again.
 */
export const stagingSessions = pgTable(
	"staging_sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		adminSessionId: uuid("admin_session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		/** The SHA-256 of the Staging cookie's value, in hexadecimal. */
		tokenHash: text("token_hash").notNull().unique(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "staging_sessions_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("staging_sessions_admin_session_id_idx").on(table.adminSessionId),
		index("staging_sessions_expires_at_idx").on(table.expiresAt),
	],
);
