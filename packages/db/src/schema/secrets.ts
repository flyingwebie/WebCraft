import { sql } from "drizzle-orm";
import { bytea, check, foreignKey, integer, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { sites, workspaces } from "./tenancy.ts";

/**
 * Every Master key the Install's secrets have been encrypted under, one row per key version. Only
 * a fingerprint of each key is stored (a one-way value), never the key. The newest row is the
 * current key; `webcraft admin rotate-key` adds the next one and retires the one before.
 */
export const masterKeyVersions = pgTable("master_key_versions", {
	version: integer("version").primaryKey(),
	fingerprint: text("fingerprint").notNull().unique(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	retiredAt: timestamp("retired_at", { withTimezone: true }),
});

/**
 * Secrets, encrypted with AES-256-GCM under a key derived from the Master key. Each belongs to the
 * Install (no Workspace), a Workspace, or a Site of a Workspace, and has a name unique within its
 * owner. The authenticated data of each ciphertext binds it to its owner and name, so a ciphertext
 * moved to another row can't be decrypted there.
 *
 * A Workspace's or Site's secrets go when it is deleted. Code reaches them only through the data
 * layer (`workspace.secrets`, `site.secrets` in `@webcraft/core`), which can't name another
 * Workspace's secret.
 */
export const secrets = pgTable(
	"secrets",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
		siteId: uuid("site_id"),
		name: text("name").notNull(),
		keyVersion: integer("key_version")
			.notNull()
			.references(() => masterKeyVersions.version),
		/** The 12-byte nonce, new for every encryption. */
		iv: bytea("iv").notNull(),
		/** The encrypted value followed by the 16-byte authentication tag. */
		ciphertext: bytea("ciphertext").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		unique("secrets_owner_name_unique").on(table.workspaceId, table.siteId, table.name).nullsNotDistinct(),
		check("secrets_site_has_workspace", sql`${table.siteId} is null or ${table.workspaceId} is not null`),
		foreignKey({
			name: "secrets_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
	],
);
