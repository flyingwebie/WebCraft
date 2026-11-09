import { sql } from "drizzle-orm";
import { boolean, check, foreignKey, index, integer, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

import { sites } from "./tenancy.ts";

// Webhooks (spec story 139): calls the Install makes to an outside address when something happens on
// a Site, signed with a secret, retried, and kept in a delivery log. Site tables: every row carries
// `workspace_id` and `site_id`, with a foreign key to `sites (workspace_id, id)`.

/**
 * A Site's Webhooks, Site settings that Staff change (saved at once, recorded in the Audit log, never
 * part of Publish all). The signing secret is a secret of the Site (`webhook:<id>:signing`), never
 * stored here. A Webhook that keeps failing is switched off by itself (`switched_off_reason`).
 */
export const webhooks = pgTable(
	"webhooks",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** What Staff call it, such as "Build hook"; the URL's host unless they named it. */
		name: text("name").notNull(),
		/** Where it is sent: an `https` URL without credentials. */
		url: text("url").notNull(),
		/** The events it receives, such as `publish`. */
		events: text("events").array().notNull(),
		/** Whether it receives events; switched off ones receive nothing. */
		enabled: boolean("enabled").notNull().default(true),
		/** Why it is off when WebCraft switched it off (`failing`); null when it is on or Staff switched it off. */
		switchedOffReason: text("switched_off_reason"),
		/** When it was last switched off, by Staff or by WebCraft. */
		switchedOffAt: timestamp("switched_off_at", { withTimezone: true }),
		/** Deliveries that failed in a row (after all their attempts; test sends don't count). */
		failuresInARow: integer("failures_in_a_row").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "webhooks_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("webhooks_site_id_idx").on(table.siteId),
		check("webhooks_switched_off_reason_known", sql`${table.switchedOffReason} in ('failing')`),
	],
);

/**
 * The delivery log: one row per event sent to a Webhook (or test send), with the body exactly as it
 * is sent on every attempt. Its id is the delivery id the receiver gets on every attempt, so it can
 * drop a copy. Kept 30 days.
 */
export const webhookDeliveries = pgTable(
	"webhook_deliveries",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		webhookId: uuid("webhook_id").notNull(),
		/** The event, such as `publish`, or `test` for a test send. */
		event: text("event").notNull(),
		/** The JSON body, as sent. It holds no secret and no Content values. */
		body: text("body").notNull(),
		/** A test send: sent once, at once, never retried and never counted as a failure. */
		test: boolean("test").notNull().default(false),
		/** `queued`, `retrying`, `delivered` or `failed`. */
		status: text("status").notNull(),
		/** Attempts made so far, across redeliveries. */
		attempts: integer("attempts").notNull().default(0),
		/** The last attempt's HTTP status, when the receiver answered. */
		lastStatusCode: integer("last_status_code"),
		/** What went wrong with the last attempt (`status`, `timeout`, …), or `switched-off` when it was stopped. */
		lastProblem: text("last_problem"),
		/** When the next attempt is due, while `queued` or `retrying`. */
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		/** When it was delivered or failed for good (until a redelivery). */
		finishedAt: timestamp("finished_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "webhook_deliveries_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "webhook_deliveries_webhook_fkey",
			columns: [table.webhookId],
			foreignColumns: [webhooks.id],
		}).onDelete("cascade"),
		index("webhook_deliveries_webhook_created_idx").on(table.webhookId, table.createdAt.desc(), table.id.desc()),
		index("webhook_deliveries_created_at_idx").on(table.createdAt),
		check("webhook_deliveries_status_known", sql`${table.status} in ('queued', 'retrying', 'delivered', 'failed')`),
	],
);

/** Each attempt of a delivery: when, how long, what the receiver answered (a short excerpt) or what went wrong. */
export const webhookDeliveryAttempts = pgTable(
	"webhook_delivery_attempts",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		deliveryId: uuid("delivery_id").notNull(),
		/** 1 for the first attempt, counting on across redeliveries. */
		number: integer("number").notNull(),
		attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
		durationMs: integer("duration_ms").notNull(),
		/** The receiver's HTTP status; null when it didn't answer. */
		statusCode: integer("status_code"),
		/** What went wrong (`status`, `redirect`, `timeout`, `unreachable`, `address`, `size`); null when delivered. */
		problem: text("problem"),
		/** The start of the receiver's answer, as text. */
		responseExcerpt: text("response_excerpt"),
	},
	(table) => [
		foreignKey({
			name: "webhook_delivery_attempts_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "webhook_delivery_attempts_delivery_fkey",
			columns: [table.deliveryId],
			foreignColumns: [webhookDeliveries.id],
		}).onDelete("cascade"),
		index("webhook_delivery_attempts_delivery_idx").on(table.deliveryId, table.number),
	],
);
