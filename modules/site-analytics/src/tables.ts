import {
	boolean,
	index,
	integer,
	jsonb,
	moduleSchema,
	primaryKey,
	siteColumns,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "@webcraft/module-sdk";

const schema = moduleSchema("site-analytics");

/**
 * Raw events, one row per page view, link click, custom event or Form Submission, in monthly
 * partitions by `occurred_at` (ADR 0019): WebCraft makes them ahead of time and drops a month once
 * it is older than the Install keeps raw events. Nothing here identifies a visitor: no address, no
 * cookie; `visitor` is a daily-salted id, only after Analytics consent (ADR 0020).
 */
export const events = schema.table(
	"events",
	{
		...siteColumns(),
		id: uuid("id").notNull().defaultRandom(),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
		/** The hour and the day (UTC) it happened in, for counting by hour or day. */
		hour: timestamp("hour", { withTimezone: true }).notNull(),
		day: timestamp("day", { withTimezone: true }).notNull(),
		/**
		 * `pageview`; `consent` (the visitor accepted Analytics on a page whose view was already
		 * counted: it starts their visit without counting the page again); `link` (a click on an
		 * outbound, download, phone or email link); `event` (a custom event); `form` (a Form Submission).
		 */
		type: text("type").notNull(),
		/** A link's kind (`outbound`, `download`, `tel`, `mailto`), a custom event's name, a Form's key. */
		name: text("name"),
		/** Where a link goes, or the Form's id. */
		target: text("target"),
		path: text("path").notNull(),
		/**
		 * Where an arrival came from: a campaign's `utm_source`, else the referring site's host, empty for
		 * none (typed in, a bookmark); null when the visitor came from another page of the Site.
		 */
		source: text("source"),
		medium: text("medium"),
		campaign: text("campaign"),
		country: text("country"),
		/** `desktop`, `mobile` or `tablet`; empty when unknown (a Form Submission). */
		device: text("device").notNull(),
		browser: text("browser").notNull(),
		os: text("os").notNull(),
		/** The visitor's daily id; null before Analytics consent. */
		visitor: text("visitor"),
		/** The visit it belongs to; null before Analytics consent. */
		visit: uuid("visit"),
		/** Whether it started its visit. */
		startsVisit: boolean("starts_visit").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.id, table.occurredAt] }),
		index("events_site_occurred_at_idx").on(table.siteId, table.occurredAt),
		index("events_site_visitor_occurred_at_idx").on(table.siteId, table.visitor, table.occurredAt),
	],
);

/**
 * Hourly and daily totals built from the raw events by the `rollUp` job, kept forever: per period,
 * one row for the totals (`dimension` `total`) and one per value of each dimension (a page, a source,
 * a country, a device, a browser, an operating system, a link, a custom event, a Form).
 */
export const rollups = schema.table(
	"rollups",
	{
		...siteColumns(),
		id: uuid("id").primaryKey().defaultRandom(),
		/** `hour` or `day`. */
		period: text("period").notNull(),
		start: timestamp("start", { withTimezone: true }).notNull(),
		dimension: text("dimension").notNull(),
		value: text("value").notNull(),
		pageviews: integer("pageviews").notNull(),
		visitors: integer("visitors").notNull(),
		visits: integer("visits").notNull(),
		/** Link clicks, custom events and Form Submissions. */
		events: integer("events").notNull(),
	},
	(table) => [
		uniqueIndex("rollups_site_period_start_dimension_value_idx").on(
			table.siteId,
			table.period,
			table.start,
			table.dimension,
			table.value,
		),
		index("rollups_site_period_dimension_start_idx").on(table.siteId, table.period, table.dimension, table.start),
	],
);

/** How far each Site's rollups are built: every hour before `hoursUntil` and every day before `daysUntil`. */
export const rollupState = schema.table(
	"rollup_state",
	{
		...siteColumns(),
		hoursUntil: timestamp("hours_until", { withTimezone: true }).notNull(),
		daysUntil: timestamp("days_until", { withTimezone: true }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.siteId] })],
);

/** A Site's analytics settings: the address ranges whose visits are left out (the agency's office). */
export const settings = schema.table(
	"settings",
	{
		...siteColumns(),
		excludedRanges: jsonb("excluded_ranges").notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.siteId] })],
);
