import { sql } from "drizzle-orm";
import { boolean, check, index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * Everyone with an account on the Install: the Superadmin, Staff and Members. `@webcraft/auth`
 * signs people in with these rows (its library calls this table "user"); WebCraft adds each
 * person's admin preferences. Emails are stored in lower case.
 */
export const people = pgTable(
	"people",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		name: text("name").notNull(),
		email: text("email").notNull().unique(),
		emailVerified: boolean("email_verified").notNull().default(false),
		image: text("image"),
		/** The person's Admin language, such as `it`. Null follows the Install's default Admin language. */
		adminLanguage: text("admin_language"),
		/** Light or dark admin, or `system` to follow the device. */
		adminTheme: text("admin_theme").notNull().default("system"),
		/**
		 * Wrong codes in a row at the second step of signing in, since the last right one (or the last
		 * lock); 10 lock the second step. Wrong passwords are counted in `sign_in_throttles`.
		 */
		failedAttempts: integer("failed_attempts").notNull().default(0),
		/** Until when the second step of signing in is locked after too many wrong codes; null or past: not locked. */
		lockedUntil: timestamp("locked_until", { withTimezone: true }),
		/**
		 * Until when the reminder to add two-factor authentication stays hidden, after "Remind me
		 * later"; null or past: it shows while the person has no second factor.
		 */
		twoFactorReminderUntil: timestamp("two_factor_reminder_until", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [check("people_admin_theme_known", sql`${table.adminTheme} in ('system', 'light', 'dark')`)],
);

/**
 * Wrong passwords for a person, counted by where they come from (`origin`), so that an outsider's
 * guesses stop the outsider and never the person:
 *
 * - `network:<keyed hash>`: sign-in attempts from one network (an IPv4 address, or an IPv6 /64).
 *   `known_at` is when the person last signed in from it.
 * - `session:<session id>`: attempts to confirm who the person is, in one admin session.
 * - `account`: sign-in attempts from every network together.
 *
 * `failed_attempts` are those in a row; `locked_until` is until when nothing from that origin is
 * checked (for `account`: from networks the person hasn't signed in from). A client address is
 * never kept: a network is an HMAC of it under a key derived from the Master key.
 */
export const signInThrottles = pgTable(
	"sign_in_throttles",
	{
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		origin: text("origin").notNull(),
		failedAttempts: integer("failed_attempts").notNull().default(0),
		lockedUntil: timestamp("locked_until", { withTimezone: true }),
		knownAt: timestamp("known_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.personId, table.origin] }),
		index("sign_in_throttles_updated_at_idx").on(table.updatedAt),
	],
);

/**
 * Signed-in sessions in the admin. `started_at` and `last_active_at` come from WebCraft's clock and
 * decide how long a session lasts; `identity_checked_at` is when the person last proved who they
 * are in this session (signing in counts), which Sensitive actions need within the last 10 minutes.
 * `ip_address` is the client address WebCraft saw when the session was last renewed, and
 * `user_agent` the browser that signed in; the other columns belong to the sign-in library.
 */
export const sessions = pgTable(
	"sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		token: text("token").notNull().unique(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		ipAddress: text("ip_address"),
		userAgent: text("user_agent"),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
		lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull(),
		identityCheckedAt: timestamp("identity_checked_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [index("sessions_person_id_idx").on(table.personId)],
);

/**
 * The ways a person signs in: for now one row per person holding their password hash (provider
 * `credential`). Later sign-in methods add rows of their own. The sign-in library calls it "account".
 */
export const credentials = pgTable(
	"credentials",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		accountId: text("account_id").notNull(),
		providerId: text("provider_id").notNull(),
		accessToken: text("access_token"),
		refreshToken: text("refresh_token"),
		idToken: text("id_token"),
		accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
		scope: text("scope"),
		password: text("password"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [index("credentials_person_id_idx").on(table.personId)],
);

/** Short-lived values the sign-in library checks once, such as verification codes. */
export const verifications = pgTable(
	"verifications",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		identifier: text("identifier").notNull(),
		value: text("value").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [index("verifications_identifier_idx").on(table.identifier)],
);

/**
 * Install-level roles (ADR 0001, ADR 0028): `superadmin` or `staff`, stored as a text role key so
 * custom roles can be added without a migration. Members hold their role on a Membership instead.
 *
 * Which Workspaces Staff reach is kept apart from the role: all of them (`all_workspaces`, including
 * Workspaces created later) or those in `staff_workspaces`. The Superadmin reaches every Workspace.
 */
export const installRoles = pgTable("install_roles", {
	personId: uuid("person_id")
		.primaryKey()
		.references(() => people.id, { onDelete: "cascade" }),
	role: text("role").notNull(),
	allWorkspaces: boolean("all_workspaces").notNull().default(false),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
