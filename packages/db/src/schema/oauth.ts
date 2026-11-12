import {
	boolean,
	foreignKey,
	index,
	integer,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";

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
	/**
	 * The grant types it registered for: `authorization_code`, `refresh_token`, and the device
	 * authorization grant (`urn:ietf:params:oauth:grant-type:device_code`, RFC 8628), which needs no
	 * redirect address. Null for clients registered before it: the authorization code and refresh grants.
	 */
	grantTypes: text("grant_types").array(),
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
		/**
		 * Where the person was sent back to after approving: the address's host is shown with the grant.
		 * Empty for a grant approved with a device code (`webcraft login`), which sends nobody anywhere.
		 */
		redirectUri: text("redirect_uri").notNull(),
		/**
		 * What its tokens are for (RFC 8707): the public Management API (`<admin origin>/api/v1`, the
		 * CLI's) or the MCP server. Null for grants made before it: the MCP server.
		 */
		resource: text("resource"),
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

/**
 * A device sign-in (the OAuth 2.0 device authorization grant, RFC 8628): `webcraft login` asks for
 * one, shows the person its user code and polls the token endpoint while they approve it in the
 * admin. Both codes are kept as keyed hashes only; it lasts 10 minutes and gives tokens once.
 */
export const oauthDeviceCodes = pgTable(
	"oauth_device_codes",
	{
		/** The keyed hash of the device code the client polls with. */
		deviceCodeHash: text("device_code_hash").primaryKey(),
		/** The keyed hash of the user code the person types (its letters only, upper case). */
		userCodeHash: text("user_code_hash").notNull().unique(),
		clientId: uuid("client_id")
			.notNull()
			.references(() => oauthClients.id, { onDelete: "cascade" }),
		/** The resource its tokens will be for (RFC 8707). */
		resource: text("resource").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		/**
		 * The client address the code was asked for from, if known: the approval page shows its network,
		 * and a code that arrives in a link is only looked up for a browser on the same network. Gone
		 * with the row, a day after the code's 10 minutes at the latest.
		 */
		requestedFrom: text("requested_from"),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		/** How many seconds the client waits between polls: 5, and 5 more each time it polls too fast. */
		intervalSeconds: integer("interval_seconds").notNull(),
		lastPolledAt: timestamp("last_polled_at", { withTimezone: true }),
		/** `pending`, `approved` (its grant waits for the client's next poll), `denied` or `used`. */
		status: text("status").notNull(),
		/** The grant made when the person approved it. */
		grantId: uuid("grant_id").references(() => oauthGrants.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("oauth_device_codes_expires_at_idx").on(table.expiresAt),
		index("oauth_device_codes_client_id_idx").on(table.clientId),
	],
);
