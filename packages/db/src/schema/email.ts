import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, primaryKey, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { people } from "./people.ts";
import { sites } from "./tenancy.ts";

/**
 * The Install SMTP: the mail server every System email goes through. One row, with id 1, written
 * when the Superadmin first sets it; until then emails are written to the log. The password is a
 * secret (`smtp.password` of the Install), never stored here.
 */
export const installSmtp = pgTable(
	"install_smtp",
	{
		id: integer("id").primaryKey().default(1),
		host: text("host").notNull(),
		port: integer("port").notNull(),
		/** `starttls` (upgrade a plain connection, usually port 587), `tls` (port 465) or `none`. */
		security: text("security").notNull(),
		/** Who the server signs in as; null for a server that takes mail without signing in. */
		username: text("username"),
		fromAddress: text("from_address").notNull(),
		replyTo: text("reply_to"),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
	},
	(table) => [
		check("install_smtp_single_row", sql`${table.id} = 1`),
		check("install_smtp_security_known", sql`${table.security} in ('starttls', 'tls', 'none')`),
		check("install_smtp_port_range", sql`${table.port} between 1 and 65535`),
	],
);

/**
 * A Site's email settings (Site settings, Structure: Staff change them, saved at once): the sender
 * name and reply-to address of the Site's mail (Notifications, Auto-replies), and the Site's own mail
 * server (its Site SMTP), when it has one. Without a server, the Site's mail goes through the Install
 * SMTP under the Site's name. The server's password is the Site secret `smtp.password`, never here.
 * No row: the Site has set nothing, and its mail goes through the Install SMTP under its name.
 */
export const siteSmtp = pgTable(
	"site_smtp",
	{
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** The sender name of the Site's mail; null for the Site's name. */
		fromName: text("from_name"),
		/** Where replies to the Site's mail go, unless an email names its own (a Notification: the visitor). */
		replyTo: text("reply_to"),
		/** The Site's own server: all four set, or none (then its mail goes through the Install SMTP). */
		host: text("host"),
		port: integer("port"),
		/** `starttls`, `tls` or `none`. */
		security: text("security"),
		username: text("username"),
		/** The address the Site's mail is sent from, through its own server. */
		fromAddress: text("from_address"),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
	},
	(table) => [
		primaryKey({ name: "site_smtp_pkey", columns: [table.siteId] }),
		foreignKey({
			name: "site_smtp_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		check(
			"site_smtp_server_whole",
			sql`(${table.host} is null) = (${table.port} is null) and (${table.host} is null) = (${table.security} is null) and (${table.host} is null) = (${table.fromAddress} is null)`,
		),
		check(
			"site_smtp_security_known",
			sql`${table.security} is null or ${table.security} in ('starttls', 'tls', 'none')`,
		),
		check("site_smtp_port_range", sql`${table.port} is null or ${table.port} between 1 and 65535`),
	],
);

/**
 * How each SMTP server has been doing: failed sends in a row, and since when it is Failing (3
 * failures in a row). `smtp` names the server: `install` for the Install SMTP, `site:<site id>` for
 * a Site's own server. A successful send clears it.
 */
export const smtpHealth = pgTable("smtp_health", {
	smtp: text("smtp").primaryKey(),
	failuresInARow: integer("failures_in_a_row").notNull().default(0),
	failingSince: timestamp("failing_since", { withTimezone: true }),
	lastResponse: text("last_response"),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
});

/**
 * The Email log: one row per email the Install sends, with its type, recipient, subject, which SMTP
 * it went through, its status and the mail server's last answer. Never its body, so reset and
 * invite links never land here. Rows older than 90 days are deleted every day.
 */
export const emailLog = pgTable(
	"email_log",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/** When the email was sent off: queued, or written to the log. */
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		/** The email type from the catalogue, such as `password-reset`. */
		type: text("type").notNull(),
		recipient: text("recipient").notNull(),
		/** The person it went to, when the recipient has an account. */
		personId: uuid("person_id").references(() => people.id, { onDelete: "set null" }),
		subject: text("subject").notNull(),
		/** Which SMTP it goes through: `install`, `site` (the Site's own), or `none` when it was written to the log. */
		smtp: text("smtp").notNull(),
		/** The Site whose mail it is (a Notification, an Auto-reply, a Site-level Module's email); null for the Install's own. */
		siteId: uuid("site_id").references(() => sites.id, { onDelete: "set null" }),
		/** `queued`, `retrying`, `sent`, `failed`, or `logged` (written to the log: no SMTP was set). */
		status: text("status").notNull(),
		attempts: integer("attempts").notNull().default(0),
		lastResponse: text("last_response"),
		lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
		/** When the next attempt is due, while it is `queued` or `retrying`. */
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
		/** What the email is about, such as `install-smtp`, `person` or a Form `submission`. */
		relatedKind: text("related_kind"),
		relatedId: text("related_id"),
	},
	(table) => [
		check("email_log_status_known", sql`${table.status} in ('queued', 'retrying', 'sent', 'failed', 'logged')`),
		index("email_log_created_at_idx").on(table.createdAt.desc(), table.id.desc()),
		index("email_log_related_idx").on(table.relatedKind, table.relatedId),
	],
);

/**
 * The work and alert emails each person has turned off, one row per person and email type.
 * Security emails can't be turned off, so they never appear here.
 */
export const emailOptOuts = pgTable(
	"email_opt_outs",
	{
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		type: text("type").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.personId, table.type] })],
);
