import { sql } from "drizzle-orm";
import { boolean, foreignKey, index, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { people } from "./people.ts";
import { sites, workspaces } from "./tenancy.ts";

/**
 * API tokens: a credential a person creates so a script or AI client can act as them through the
 * Management API (`/api/v1`), within one Workspace, never with more access than they have now.
 *
 * The token itself is shown once, when it is made; only a keyed hash of it is kept (`secret_hash`,
 * HMAC-SHA256 under a key derived from the Master key), so a request finds its token with one
 * indexed lookup. `hint` is its last 4 characters, to tell tokens apart in the list.
 *
 * A token reaches every Site of its Workspace (`all_sites`) or those in `api_token_sites`, and may
 * be read-only. It stops at `expires_at` (null: never) or once revoked: by its person, or by
 * WebCraft when the person no longer reaches what it was made for (`revoked_reason`). Rows stay
 * after that, so a script holding a revoked token is told so.
 */
export const apiTokens = pgTable(
	"api_tokens",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		secretHash: text("secret_hash").notNull().unique(),
		hint: text("hint").notNull(),
		allSites: boolean("all_sites").notNull().default(true),
		readOnly: boolean("read_only").notNull().default(false),
		/**
		 * The Toolsets switched on: WebCraft's own keys and Modules' (`m.<id>`). Tokens made before
		 * Toolsets have every one but Submissions, which is only ever on when its person chose it.
		 */
		toolsets: text("toolsets")
			.array()
			.notNull()
			.default(sql`'{content,media,structure,forms,publishing,translation,siteSettings,analytics}'::text[]`),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		/** When a request last used it, at most once a minute. */
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		/** `person` (its person revoked it) or `access` (its person no longer reaches what it was made for). */
		revokedReason: text("revoked_reason"),
	},
	(table) => [
		index("api_tokens_person_id_idx").on(table.personId),
		index("api_tokens_workspace_id_idx").on(table.workspaceId),
		unique("api_tokens_id_workspace_id_unique").on(table.id, table.workspaceId),
	],
);

/** The Sites a token reaches when it doesn't reach them all; always Sites of its own Workspace. */
export const apiTokenSites = pgTable(
	"api_token_sites",
	{
		tokenId: uuid("token_id").notNull(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.tokenId, table.siteId] }),
		foreignKey({
			name: "api_token_sites_token_fkey",
			columns: [table.tokenId, table.workspaceId],
			foreignColumns: [apiTokens.id, apiTokens.workspaceId],
		}).onDelete("cascade"),
		foreignKey({
			name: "api_token_sites_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
	],
);
