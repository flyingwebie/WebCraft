import {
	bigint,
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

import { installRoles, people } from "./people.ts";

/**
 * Workspaces: one per client organisation (ADR 0001). Every row of tenant data is tied to one, and
 * the data layer in `@webcraft/core` never queries tenant data without one (ADR 0007).
 */
export const workspaces = pgTable("workspaces", {
	id: uuid("id").primaryKey().defaultRandom(),
	name: text("name").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

/**
 * Sites: one website inside a Workspace. The slug is unique on the Install, because a Site's
 * Staging address is `<slug>.<sites domain>`.
 *
 * Tables of Site data carry both `workspace_id` and `site_id`, with a foreign key to
 * `(workspace_id, id)` here, so a row can never point at a Site of another Workspace.
 *
 * `page_cache_generation` goes up with every publish: the web process keeps rendered pages under
 * the generation they were rendered at, so raising it clears the Site's whole page cache, from any
 * process (the worker publishes too).
 */
export const sites = pgTable(
	"sites",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		slug: text("slug").notNull().unique(),
		/**
		 * The Default language: the one the Site is written in first, a BCP 47 tag, one of its
		 * `site_languages`. Its URLs have no language prefix; other languages fall back to it.
		 */
		defaultLanguage: text("default_language").notNull().default("en"),
		/**
		 * Whether a visitor's first request to the home page is sent on to the home page in the
		 * language their browser prefers (ADR 0010). Off by default.
		 */
		browserLanguageRedirect: boolean("browser_language_redirect").notNull().default(false),
		/**
		 * How the Site's Content Security Policy applies (ADR 0023): `strict` (the default: scripts only
		 * from the Site and its allowed hosts), `relaxed` (inline scripts and `eval` allowed, for tag
		 * managers) or `reportOnly` (the strict policy reported, not enforced).
		 */
		cspMode: text("csp_mode").notNull().default("strict"),
		/**
		 * The CDN in front of the Site (`cloudflare`, `fastly`), or null. On connections from that CDN's
		 * published address ranges (`cdn_ranges`), the visitor's address is the one in the CDN's own header.
		 */
		cdn: text("cdn"),
		pageCacheGeneration: bigint("page_cache_generation", { mode: "number" }).notNull().default(0),
		/**
		 * Which version of WebCraft's search index the Site's index was last rebuilt for; 0 when a
		 * change (Searched fields, a language added) asks for a rebuild. Sites behind the current
		 * version are rebuilt by the `search.rebuild-due` job.
		 */
		searchIndexVersion: integer("search_index_version").notNull().default(0),
		/** When a rebuild of the search index was last queued and hasn't finished; null when none is waiting. */
		searchRebuildClaimedAt: timestamp("search_rebuild_claimed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [unique("sites_workspace_id_id_unique").on(table.workspaceId, table.id)],
);

/**
 * The Workspaces a Staff member is assigned to, when they aren't assigned to all of them
 * (`install_roles.all_workspaces`). Staff reach Workspaces only this way: they never hold a
 * Membership (ADR 0001).
 */
export const staffWorkspaces = pgTable(
	"staff_workspaces",
	{
		personId: uuid("person_id")
			.notNull()
			.references(() => installRoles.personId, { onDelete: "cascade" }),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.personId, table.workspaceId] }),
		index("staff_workspaces_workspace_id_idx").on(table.workspaceId),
	],
);

/**
 * A Member's place in one Workspace: a text role key (`owner`, `editor`, `author`; ADR 0028) and
 * the Sites they reach, kept apart from the role: every Site of the Workspace (`all_sites`) or the
 * Sites listed in `membership_sites`.
 */
export const memberships = pgTable(
	"memberships",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		role: text("role").notNull(),
		allSites: boolean("all_sites").notNull().default(true),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		unique("memberships_workspace_id_person_id_unique").on(table.workspaceId, table.personId),
		unique("memberships_id_workspace_id_unique").on(table.id, table.workspaceId),
		index("memberships_person_id_idx").on(table.personId),
	],
);

/** The Sites a Membership reaches when it doesn't reach them all; always Sites of its own Workspace. */
export const membershipSites = pgTable(
	"membership_sites",
	{
		membershipId: uuid("membership_id").notNull(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.membershipId, table.siteId] }),
		foreignKey({
			name: "membership_sites_membership_fkey",
			columns: [table.membershipId, table.workspaceId],
			foreignColumns: [memberships.id, memberships.workspaceId],
		}).onDelete("cascade"),
		foreignKey({
			name: "membership_sites_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
	],
);

/**
 * Invitations waiting to be accepted. Only a SHA-256 hash of each invite's token is stored; the
 * token itself is only in the email. `role` is the text role key the invite grants. An invite is
 * deleted once it is accepted, revoked or replaced.
 *
 * - A Staff invite (`staff`) has no Workspace: it assigns every Workspace (`all_workspaces`) or
 *   those in `invite_workspaces`.
 * - A Member invite (`owner`, `editor`, `author`) belongs to one Workspace (`workspace_id`), and the
 *   Membership it gives reaches every Site of it (`all_sites`) or those in `invite_sites`. There is
 *   at most one pending Member invite per address and Workspace.
 */
export const invites = pgTable(
	"invites",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		email: text("email").notNull(),
		tokenHash: text("token_hash").notNull().unique(),
		role: text("role").notNull(),
		/** Staff invites: whether the Staff member will reach every Workspace, or those in `invite_workspaces`. */
		allWorkspaces: boolean("all_workspaces").notNull().default(false),
		/** Member invites: the Workspace the Membership is in. Null for Staff invites. */
		workspaceId: uuid("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }),
		/** Member invites: whether the Membership will reach every Site, or those in `invite_sites`. */
		allSites: boolean("all_sites").notNull().default(true),
		invitedBy: uuid("invited_by").references(() => people.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		index("invites_email_idx").on(table.email),
		index("invites_workspace_id_idx").on(table.workspaceId),
		unique("invites_id_workspace_id_unique").on(table.id, table.workspaceId),
		// Staff invites have no Workspace, and nulls never collide: this holds Member invites only.
		unique("invites_email_workspace_id_unique").on(table.email, table.workspaceId),
	],
);

/** The Sites a Member invite's Membership will reach, when not all of them; always Sites of its own Workspace. */
export const inviteSites = pgTable(
	"invite_sites",
	{
		inviteId: uuid("invite_id").notNull(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.inviteId, table.siteId] }),
		foreignKey({
			name: "invite_sites_invite_fkey",
			columns: [table.inviteId, table.workspaceId],
			foreignColumns: [invites.id, invites.workspaceId],
		}).onDelete("cascade"),
		foreignKey({
			name: "invite_sites_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
	],
);

/** The Workspaces a Staff invite assigns, when it doesn't assign them all. */
export const inviteWorkspaces = pgTable(
	"invite_workspaces",
	{
		inviteId: uuid("invite_id")
			.notNull()
			.references(() => invites.id, { onDelete: "cascade" }),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
	},
	(table) => [primaryKey({ columns: [table.inviteId, table.workspaceId] })],
);
