import { sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { people } from "./people.ts";
import { sites, workspaces } from "./tenancy.ts";

/**
 * The Error log: unexpected failures on the Install, one row per cause (`fingerprint`: the error's
 * kind and the top frames of its stack, made plain), with how often it happened, when it was first
 * and last seen, and the newest example (redacted). Install data, read by the Superadmin only. Rows
 * not seen for 30 days are deleted every day.
 */
export const errorGroups = pgTable(
	"error_groups",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		fingerprint: text("fingerprint").notNull().unique(),
		/** The error's kind, such as `TypeError`. */
		name: text("name").notNull(),
		/** The newest example's message and stack, redacted. */
		message: text("message").notNull(),
		stack: text("stack"),
		/** Where it happened: `request`, `job` or `process`. */
		sourceKind: text("source_kind").notNull(),
		/** The procedure, job or request (method and path) of the newest example; null for the process. */
		sourceName: text("source_name"),
		/** The newest example's request id, to find its lines in the process's log. */
		requestId: text("request_id"),
		count: bigint("count", { mode: "number" }).notNull(),
		firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
		/** When the Superadmin marked it resolved; cleared when it happens again. */
		resolvedAt: timestamp("resolved_at", { withTimezone: true }),
		resolvedBy: uuid("resolved_by").references(() => people.id, { onDelete: "set null" }),
		/** When it last came back after being marked resolved. */
		reopenedAt: timestamp("reopened_at", { withTimezone: true }),
	},
	(table) => [
		index("error_groups_last_seen_at_idx").on(table.lastSeenAt),
		index("error_groups_first_seen_at_idx").on(table.firstSeenAt),
	],
);

/** The Workspaces and Sites a cause in the Error log happened in, and how often in each. */
export const errorGroupPlaces = pgTable(
	"error_group_places",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		groupId: uuid("group_id")
			.notNull()
			.references(() => errorGroups.id, { onDelete: "cascade" }),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
		count: bigint("count", { mode: "number" }).notNull(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		unique("error_group_places_place_key").on(table.groupId, table.workspaceId, table.siteId).nullsNotDistinct(),
	],
);

/**
 * Install health as last worked out, one row per part of the Install (`part`: `worker`, `database`,
 * `jobQueue`, …): OK, Warning or Failing with a short reason, and what Health alerts need to send one
 * email when a part starts failing and one when it clears.
 */
export const healthRows = pgTable("health_rows", {
	part: text("part").primaryKey(),
	/** `ok`, `warning` or `failing`. */
	status: text("status").notNull(),
	/** Why, as a reason code and its values (`{ code: "stale", data: { lastBeatAt } }`), worded by the admin. */
	reason: jsonb("reason").notNull().default(sql`'{}'::jsonb`),
	checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
	/**
	 * Since when it has been Failing: the start of the episode, kept after an alert until the part has
	 * worked again for a while (a short break doesn't start a new one); null otherwise.
	 */
	failingSince: timestamp("failing_since", { withTimezone: true }),
	/** Since when it hasn't been Failing, after an alert went out; null otherwise. */
	clearSince: timestamp("clear_since", { withTimezone: true }),
	/** When the Health alert that it is failing went out; null once the one that it cleared did. */
	alertedAt: timestamp("alerted_at", { withTimezone: true }),
});
