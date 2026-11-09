import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";

import { people } from "./people.ts";
import { sites, workspaces } from "./tenancy.ts";

// The Module host (`@webcraft/core` › modules). Modules' own tables live in their own Postgres
// schemas (`m_<id>`); these are WebCraft's records about Modules.

/**
 * What the Superadmin approved for each Module: the version they saw on the consent screen and
 * everything it asked for then (`granted`, a list of consent items such as `host:api.example.com`).
 * A later version that asks for nothing more runs on this approval; one that asks for more is off
 * everywhere until the Superadmin approves it again. No row: never approved, or withdrawn.
 */
export const moduleApprovals = pgTable("module_approvals", {
	moduleId: text("module_id").primaryKey(),
	version: text("version").notNull(),
	granted: jsonb("granted").$type<string[]>().notNull(),
	approvedAt: timestamp("approved_at", { withTimezone: true }).notNull(),
	approvedBy: uuid("approved_by").references(() => people.id, { onDelete: "set null" }),
});

/**
 * Where Staff switched a Module on or off: on a Site (Site-level Modules, `site_id` set) or on a
 * Workspace (Workspace-level Modules, `site_id` null). No row: the Module's `onByDefault`. A
 * Workspace table, reached through the data layer; switching off keeps the Module's data.
 */
export const moduleSwitches = pgTable(
	"module_switches",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		moduleId: text("module_id").notNull(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		siteId: uuid("site_id"),
		on: boolean("on").notNull(),
		changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
		changedBy: uuid("changed_by").references(() => people.id, { onDelete: "set null" }),
	},
	(table) => [
		unique("module_switches_place_unique").on(table.moduleId, table.workspaceId, table.siteId).nullsNotDistinct(),
		foreignKey({
			name: "module_switches_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
	],
);

/**
 * The Module log: what Modules wrote and what went wrong while they ran (a failed event or job, a
 * Site route or procedure that threw), for the Superadmin. Like the Audit log it has no foreign
 * keys, so a line outlives the Workspace or Site it mentions. Lines older than 90 days are deleted.
 */
export const moduleLog = pgTable(
	"module_log",
	{
		id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		moduleId: text("module_id").notNull(),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
		/** `info`, `warn` or `error`. */
		level: text("level").notNull(),
		message: text("message").notNull(),
		workspaceId: uuid("workspace_id"),
		siteId: uuid("site_id"),
		/** What it was about: the event or job, the attempt, the error; never a secret's value. */
		details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
	},
	(table) => [
		index("module_log_module_id_occurred_at_idx").on(table.moduleId, table.occurredAt),
		index("module_log_occurred_at_idx").on(table.occurredAt),
	],
);

/**
 * The Module migrations the `migrate` step applied, with a SHA-256 checksum of each one's SQL: a
 * migration that changed after it was applied is refused.
 */
export const moduleMigrations = pgTable(
	"module_migrations",
	{
		moduleId: text("module_id").notNull(),
		name: text("name").notNull(),
		checksum: text("checksum").notNull(),
		appliedAt: timestamp("applied_at", { withTimezone: true }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.moduleId, table.name] })],
);

/**
 * How long the Install keeps the rows of a Module's partitioned table (a Module's `partitions`, such
 * as Site analytics' raw events), as the Superadmin set it: whole months. No row: the Module's own
 * `keepMonths`. Months older than that are dropped every day.
 */
export const modulePartitionSettings = pgTable(
	"module_partition_settings",
	{
		moduleId: text("module_id").notNull(),
		/** The partitioned table's name in the Module's schema, such as `events`. */
		tableName: text("table_name").notNull(),
		keepMonths: integer("keep_months").notNull(),
		changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
		changedBy: uuid("changed_by").references(() => people.id, { onDelete: "set null" }),
	},
	(table) => [primaryKey({ columns: [table.moduleId, table.tableName] })],
);

/**
 * The salt of the day for visitors' daily ids (`visitor.dailyId` in the Module SDK, ADR 0020): a
 * random value per day (UTC), made by whichever process needs it first. Only today's is kept: the
 * day after, it is deleted, so nobody can tell any more whose an earlier day's ids were. Never
 * stored with anything visitors did.
 */
export const visitorSalts = pgTable("visitor_salts", {
	day: text("day").primaryKey(),
	salt: text("salt").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});
