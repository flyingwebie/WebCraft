import { boolean, foreignKey, index, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { people } from "./people.ts";
import { sites, workspaces } from "./tenancy.ts";

/**
 * AI clients and the OAuth grants people approve for them (spec › MCP server, ADR 0030).
 *
 * An AI client registers itself (OAuth 2.0 Dynamic Client Registration): its name and the exact
 * addresses it may be sent back to. A person then approves it in the admin, choosing one Workspace,
 * its Sites, the Toolsets it may use, whether it only reads and whether it may publish: that is an
 * OAuth grant. The client exchanges the one-time authorization code for an access token (1 hour)
 * and a refresh token (30 days, replaced each time it is used).
 *
 * Codes and tokens are never kept: only keyed hashes of them (HMAC-SHA256 under a key derived from
 * the Master key), so a request finds its token with one indexed lookup and a new Master key ends
 * every grant's tokens, as it signs everyone out.
 */

/** An AI client, as it registered itself. Anyone may register one; it does nothing until a person approves it. */
export const oauthClients = pgTable("oauth_clients", {
	/** The client's `client_id`. */
	id: uuid("id").primaryKey().defaultRandom(),
	/** The name it gave (`client_name`), shown on the approval page and in the Audit log. */
	name: text("name").notNull(),
	/** The addresses it may be sent back to, compared exactly: https, or http on the loopback interface. */
	redirectUris: text("redirect_uris").array().notNull(),
	/** `native` (on the person's own device) or `web`. */
	applicationType: text("application_type").notNull(),
	/** `none` (a public client, PKCE only), `client_secret_basic` or `client_secret_post`. */
	authMethod: text("auth_method").notNull(),
	/** The keyed hash of its secret, for the two methods that have one. */
	secretHash: text("secret_hash"),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

/** A person's approval of an AI client: who it acts as, where, and with what. */
export const oauthGrants = pgTable(
	"oauth_grants",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		clientId: uuid("client_id")
			.notNull()
			.references(() => oauthClients.id, { onDelete: "cascade" }),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		/** The client's name when the person approved it: changes it makes show as "<person> via <name>". */
		clientName: text("client_name").notNull(),
		/** Where the person was sent back to after approving: the address's host is shown with the grant. */
		redirectUri: text("redirect_uri").notNull(),
		allSites: boolean("all_sites").notNull().default(true),
		readOnly: boolean("read_only").notNull().default(false),
		mayPublish: boolean("may_publish").notNull().default(false),
		/** The Toolsets switched on: WebCraft's own keys and Modules' (`m.<id>`). */
		toolsets: text("toolsets").array().notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		/** When a request last used it, at most once a minute. */
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		/**
		 * `person` (its person revoked it), `access` (its person no longer reaches what it was made for)
		 * or `reuse` (a used code or refresh token came back: someone else may hold them).
		 */
		revokedReason: text("revoked_reason"),
	},
	(table) => [
		index("oauth_grants_person_id_idx").on(table.personId),
		index("oauth_grants_workspace_id_idx").on(table.workspaceId),
		index("oauth_grants_client_id_idx").on(table.clientId),
		unique("oauth_grants_id_workspace_id_unique").on(table.id, table.workspaceId),
	],
);

/** The Sites a grant reaches when it doesn't reach them all; always Sites of its own Workspace. */
export const oauthGrantSites = pgTable(
	"oauth_grant_sites",
	{
		grantId: uuid("grant_id").notNull(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.grantId, table.siteId] }),
		foreignKey({
			name: "oauth_grant_sites_grant_fkey",
			columns: [table.grantId, table.workspaceId],
			foreignColumns: [oauthGrants.id, oauthGrants.workspaceId],
		}).onDelete("cascade"),
		foreignKey({
			name: "oauth_grant_sites_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
	],
);

/** An authorization code: valid for one exchange, within a minute, with the PKCE verifier it was asked with. */
export const oauthCodes = pgTable(
	"oauth_codes",
	{
		codeHash: text("code_hash").primaryKey(),
		grantId: uuid("grant_id")
			.notNull()
			.references(() => oauthGrants.id, { onDelete: "cascade" }),
		redirectUri: text("redirect_uri").notNull(),
		/** The S256 `code_challenge` the authorization request carried. */
		codeChallenge: text("code_challenge").notNull(),
		/** The resource (RFC 8707) the client asked for: the MCP server. */
		resource: text("resource").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		usedAt: timestamp("used_at", { withTimezone: true }),
	},
	(table) => [index("oauth_codes_grant_id_idx").on(table.grantId)],
);

/** An access or refresh token of a grant. A refresh token is replaced each time it is used. */
export const oauthTokens = pgTable(
	"oauth_tokens",
	{
		tokenHash: text("token_hash").primaryKey(),
		grantId: uuid("grant_id")
			.notNull()
			.references(() => oauthGrants.id, { onDelete: "cascade" }),
		/** `access` or `refresh`. */
		kind: text("kind").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		/** A refresh token once it was exchanged, or any token revoked by its client (RFC 7009). */
		usedAt: timestamp("used_at", { withTimezone: true }),
	},
	(table) => [
		index("oauth_tokens_grant_id_idx").on(table.grantId),
		index("oauth_tokens_expires_at_idx").on(table.expiresAt),
	],
);
