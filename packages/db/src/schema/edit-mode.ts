import { foreignKey, index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { people, sessions } from "./people.ts";
import { sites } from "./tenancy.ts";

// Edit mode (`@webcraft/core` › edit-mode, ADR 0022): a person signed in to the admin opens a Site
// in Edit mode on the Site's own domain. Both tables are Site data (`workspace_id`, `site_id`, with a
// foreign key to `sites (workspace_id, id)`), and both hang off the admin session that asked: signing
// out, or that session being revoked or ending, deletes them with it. Only hashes of their tokens
// are stored.

/**
 * "Edit on site" links: each works once, within 60 seconds of being made, for one person and one
 * Site. Following one on the Site's domain starts an Edit mode session there.
 */
export const editLinks = pgTable(
	"edit_links",
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
			name: "edit_links_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("edit_links_expires_at_idx").on(table.expiresAt),
	],
);

/**
 * Edit mode sessions: one browser's edit cookie on one Site's domain, for at most 8 hours. Every
 * edit request checks the admin session it belongs to and the person's access again.
 */
export const editSessions = pgTable(
	"edit_sessions",
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
		/** The SHA-256 of the edit cookie's value, in hexadecimal. */
		tokenHash: text("token_hash").notNull().unique(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "edit_sessions_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("edit_sessions_admin_session_id_idx").on(table.adminSessionId),
		index("edit_sessions_expires_at_idx").on(table.expiresAt),
	],
);
