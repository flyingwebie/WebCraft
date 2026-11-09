import { sql } from "drizzle-orm";
import { bigint, boolean, check, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { people } from "./people.ts";

/**
 * The Install's own settings: one row, with id 1, written the first time a setting changes. Until
 * then every setting has its default.
 */
export const installSettings = pgTable(
	"install_settings",
	{
		id: integer("id").primaryKey().default(1),
		/** The agency's name for this Install, shown at the top of the admin. */
		name: text("name"),
		/** The Admin language of everyone who hasn't chosen their own, and of signed-out pages. */
		defaultAdminLanguage: text("default_admin_language").notNull().default("en"),
		/** When the Superadmin finished the setup wizard (or was created headless); it never opens again. */
		setupFinishedAt: timestamp("setup_finished_at", { withTimezone: true }),
		/**
		 * The fingerprint of the Master key a Superadmin confirmed is stored outside the server. The
		 * banner asking for it returns when the Install runs with another key.
		 */
		masterKeyStoredFingerprint: text("master_key_stored_fingerprint"),
		masterKeyStoredAt: timestamp("master_key_stored_at", { withTimezone: true }),
		masterKeyStoredBy: uuid("master_key_stored_by").references(() => people.id, { onDelete: "set null" }),
		/**
		 * Install branding: what every System email carries. The sender name (the Install's name, then
		 * WebCraft, when unset), an HTTPS logo address, the accent colour (`#rrggbb`) and footer text.
		 */
		emailSenderName: text("email_sender_name"),
		emailLogoUrl: text("email_logo_url"),
		emailAccentColour: text("email_accent_colour"),
		emailFooter: text("email_footer"),
		/**
		 * Whether new passwords are checked against leaked-password lists (a partial-hash lookup). On
		 * unless the Superadmin switches it off, such as for an Install that is always offline.
		 */
		leakedPasswordCheck: boolean("leaked_password_check").notNull().default(true),
		/** The largest file the Media library takes, in bytes; null for the default (50 MB). */
		mediaMaxFileBytes: bigint("media_max_file_bytes", { mode: "number" }),
		/**
		 * Whether a shared Install key may call an OpenAI-compatible endpoint inside the Install's own
		 * network (a self-hosted model). Off unless the Superadmin switches it on; a Workspace's own key
		 * never may.
		 */
		aiPrivateEndpoints: boolean("ai_private_endpoints").notNull().default(false),
		/**
		 * Whether publishing saves Revisions anywhere on the Install. On unless the Superadmin switches it
		 * off; Revisions saved before stay until the usual retention removes them.
		 */
		revisionsOn: boolean("revisions_on").notNull().default(true),
		/** How many days Revisions are kept; null for the default (90). */
		revisionDays: integer("revision_days"),
		/** How many of each item's newest Revisions are kept, however old; null for the default (50). */
		revisionsKept: integer("revisions_kept"),
		/** How many days Checkpoints are kept; null for the default (30). */
		checkpointDays: integer("checkpoint_days"),
	},
	(table) => [check("install_settings_single_row", sql`${table.id} = 1`)],
);

/**
 * The one-time tokens that unlock the setup wizard on an Install with no Superadmin yet. Only a
 * SHA-256 hash of each token is stored; the web process prints the token itself in its logs when it
 * starts. Every token is deleted once a Superadmin exists.
 */
export const setupTokens = pgTable("setup_tokens", {
	tokenHash: text("token_hash").primaryKey(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

/**
 * The address ranges each CDN publishes for its servers, as the worker last fetched them
 * (`cdn.refresh-ranges`, daily, for the CDNs Sites name), in CIDR notation. A Site's CDN visitor
 * header is believed only on connections from its CDN's ranges; until a CDN's list has been fetched,
 * the ranges WebCraft shipped with count.
 */
export const cdnRanges = pgTable("cdn_ranges", {
	cdn: text("cdn").primaryKey(),
	ranges: text("ranges").array().notNull(),
	fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});
