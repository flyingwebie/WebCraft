import { sql } from "drizzle-orm";
import {
	boolean,
	bytea,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uuid,
} from "drizzle-orm/pg-core";

import { dashboards, workspaceDashboards } from "./dashboards.ts";
import { people } from "./people.ts";
import { sites, workspaces } from "./tenancy.ts";

// Reports and Share links (#104, GLOSSARY.md): what a Dashboard (a Site's, or a Workspace's adding up
// its Sites) shows, sent as a PDF on a schedule, or opened by anyone holding a link. Both are Workspace
// tables that name their Site when their Dashboard is a Site's (`site_id`), so a Site scope reads a
// Site Dashboard's and a Workspace scope a Workspace Dashboard's (`site_id` null). Exactly one of
// `dashboard_id` and `workspace_dashboard_id` is set, and it goes with its Dashboard.

/**
 * A Report: a Dashboard sent on a schedule (`weekly`: each Monday for the week before; `monthly`: on
 * the 1st for the month before), each period compared with the one before, to its recipients (Content:
 * Owners change them), in its language, with AI text sent at once or held for someone to review.
 */
export const reports = pgTable(
	"reports",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		/** The Site of a Site Dashboard's Report; null for a Workspace Dashboard's. */
		siteId: uuid("site_id"),
		dashboardId: uuid("dashboard_id").references(() => dashboards.id, { onDelete: "cascade" }),
		workspaceDashboardId: uuid("workspace_dashboard_id").references(() => workspaceDashboards.id, {
			onDelete: "cascade",
		}),
		name: text("name").notNull(),
		/** `weekly` or `monthly`. */
		schedule: text("schedule").notNull(),
		/** The language of the Report's words and of the AI text in it (an admin language: `en`, `it`). */
		language: text("language").notNull(),
		/** Who it is emailed to: addresses, lower case. */
		recipients: jsonb("recipients").notNull().default(sql`'[]'::jsonb`),
		/** Whether each one waits for someone to review its AI text before it goes out. */
		review: boolean("review").notNull().default(false),
		/** Whether it goes out on its schedule. */
		active: boolean("active").notNull().default(true),
		/** When it goes out next. */
		nextRunAt: timestamp("next_run_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		createdBy: uuid("created_by").references(() => people.id, { onDelete: "set null" }),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
	},
	(table) => [
		foreignKey({
			name: "reports_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		check(
			"reports_one_dashboard",
			sql`(${table.siteId} is not null and ${table.dashboardId} is not null and ${table.workspaceDashboardId} is null) or (${table.siteId} is null and ${table.dashboardId} is null and ${table.workspaceDashboardId} is not null)`,
		),
		check("reports_schedule_known", sql`${table.schedule} in ('weekly', 'monthly')`),
		index("reports_workspace_id_idx").on(table.workspaceId),
		index("reports_dashboard_id_idx").on(table.dashboardId),
		index("reports_workspace_dashboard_id_idx").on(table.workspaceDashboardId),
		index("reports_next_run_at_idx").on(table.nextRunAt),
	],
);

/**
 * A Report's history: each time it was made (on its schedule, or a test to one person), with what it
 * showed and the AI text in it (`content`), its state, and its PDF while kept (a bounded time). Its
 * emails are in the Email log, related to it.
 */
export const reportSends = pgTable(
	"report_sends",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		siteId: uuid("site_id"),
		reportId: uuid("report_id")
			.notNull()
			.references(() => reports.id, { onDelete: "cascade" }),
		/** `scheduled`, or `test` (to the person who asked, `requested_by`). */
		kind: text("kind").notNull(),
		/** `preparing`, `review` (held for its AI text to be reviewed), `rendering`, `sent`, `failed`, `discarded`. */
		status: text("status").notNull(),
		periodFrom: timestamp("period_from", { withTimezone: true }).notNull(),
		periodTo: timestamp("period_to", { withTimezone: true }).notNull(),
		previousFrom: timestamp("previous_from", { withTimezone: true }).notNull(),
		previousTo: timestamp("previous_to", { withTimezone: true }).notNull(),
		language: text("language").notNull(),
		/** Who it goes to (addresses), as they were when it was made. */
		recipients: jsonb("recipients").notNull().default(sql`'[]'::jsonb`),
		/** What it shows: the Widgets' answers for the period and the one before, and the AI text. */
		content: jsonb("content"),
		/** Whether the AI text is in it: `written`, `noKey`, `cap`, `failed` (the provider), `none` (nothing to write about). */
		aiStatus: text("ai_status"),
		/** Its PDF, while kept. */
		pdf: bytea("pdf"),
		pdfBytes: integer("pdf_bytes"),
		renderAttempts: integer("render_attempts").notNull().default(0),
		/** Why it failed, in words for the history (never a secret). */
		problem: text("problem"),
		requestedBy: uuid("requested_by").references(() => people.id, { onDelete: "set null" }),
		approvedBy: uuid("approved_by").references(() => people.id, { onDelete: "set null" }),
		approvedAt: timestamp("approved_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		sentAt: timestamp("sent_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "report_sends_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		check("report_sends_kind_known", sql`${table.kind} in ('scheduled', 'test')`),
		check(
			"report_sends_status_known",
			sql`${table.status} in ('preparing', 'review', 'rendering', 'sent', 'failed', 'discarded')`,
		),
		index("report_sends_report_id_created_at_idx").on(table.reportId, table.createdAt),
		index("report_sends_created_at_idx").on(table.createdAt),
	],
);

/**
 * A Share link: someone without an account explores a Dashboard through it (change the range and
 * filters, never anything else), on the Install's own Share link address. Only the token's SHA-256
 * hash is kept, and the password's scrypt hash. Opens are counted, and nothing else about who opened it.
 */
export const shareLinks = pgTable(
	"share_links",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id")
			.notNull()
			.references(() => workspaces.id, { onDelete: "cascade" }),
		siteId: uuid("site_id"),
		dashboardId: uuid("dashboard_id").references(() => dashboards.id, { onDelete: "cascade" }),
		workspaceDashboardId: uuid("workspace_dashboard_id").references(() => workspaceDashboards.id, {
			onDelete: "cascade",
		}),
		name: text("name").notNull(),
		/** The language of the page's words (an admin language: `en`, `it`). */
		language: text("language").notNull(),
		tokenHash: text("token_hash").notNull().unique(),
		/** The token's last 4 characters, to tell links apart. */
		tokenHint: text("token_hint").notNull(),
		passwordHash: text("password_hash"),
		/** When the password was last set or removed: what it let in stops working then. */
		passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
		opens: integer("opens").notNull().default(0),
		lastOpenedAt: timestamp("last_opened_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		createdBy: uuid("created_by").references(() => people.id, { onDelete: "set null" }),
	},
	(table) => [
		foreignKey({
			name: "share_links_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		check(
			"share_links_one_dashboard",
			sql`(${table.siteId} is not null and ${table.dashboardId} is not null and ${table.workspaceDashboardId} is null) or (${table.siteId} is null and ${table.dashboardId} is null and ${table.workspaceDashboardId} is not null)`,
		),
		index("share_links_workspace_id_idx").on(table.workspaceId),
		index("share_links_dashboard_id_idx").on(table.dashboardId),
		index("share_links_workspace_dashboard_id_idx").on(table.workspaceDashboardId),
	],
);

/**
 * The Services list (GLOSSARY.md): the services the agency offers, written by Staff once for the whole
 * Install, which Reports' suggestions may point to. One row, with id 1, holding the list.
 */
export const reportServices = pgTable(
	"report_services",
	{
		id: integer("id").primaryKey().default(1),
		/** `{ id, name, description }[]`, in the order Staff gave them. */
		services: jsonb("services").notNull().default(sql`'[]'::jsonb`),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
	},
	(table) => [check("report_services_single_row", sql`${table.id} = 1`)],
);

/**
 * How Reports and Share links are branded across the Install (the Superadmin): the agency brand (its
 * name, logo and accent colour) and whether the agency brand, the client brand and "Made with
 * WebCraft" show. Kept apart from Install branding, which is for System emails. One row, id 1.
 */
export const installReportBranding = pgTable(
	"install_report_branding",
	{
		id: integer("id").primaryKey().default(1),
		agencyName: text("agency_name"),
		/** `#rrggbb`. */
		accentColour: text("accent_colour"),
		agencyLogo: bytea("agency_logo"),
		/** `image/png`, `image/jpeg` or `image/webp`. */
		agencyLogoType: text("agency_logo_type"),
		showAgency: boolean("show_agency").notNull().default(true),
		showClient: boolean("show_client").notNull().default(true),
		madeWith: boolean("made_with").notNull().default(true),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
	},
	(table) => [check("install_report_branding_single_row", sql`${table.id} = 1`)],
);

/**
 * A Workspace's branding of its Reports and Share links (Staff): its own agency brand in place of the
 * Install's (`own_agency`), its client brand (the Workspace's logo and name, for Workspace Dashboards
 * and Sites without their own) and its own choice of what shows (null: the Install's).
 */
export const workspaceReportBranding = pgTable("workspace_report_branding", {
	workspaceId: uuid("workspace_id")
		.primaryKey()
		.references(() => workspaces.id, { onDelete: "cascade" }),
	ownAgency: boolean("own_agency").notNull().default(false),
	agencyName: text("agency_name"),
	accentColour: text("accent_colour"),
	agencyLogo: bytea("agency_logo"),
	agencyLogoType: text("agency_logo_type"),
	/** The client's name; null for the Workspace's name. */
	clientName: text("client_name"),
	clientLogo: bytea("client_logo"),
	clientLogoType: text("client_logo_type"),
	showAgency: boolean("show_agency"),
	showClient: boolean("show_client"),
	madeWith: boolean("made_with"),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
});

/** A Site's client brand on its Reports and Share links (Staff): its name (null: the Site's) and logo. */
export const siteReportBranding = pgTable(
	"site_report_branding",
	{
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		clientName: text("client_name"),
		clientLogo: bytea("client_logo"),
		clientLogoType: text("client_logo_type"),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
	},
	(table) => [
		primaryKey({ columns: [table.workspaceId, table.siteId] }),
		foreignKey({
			name: "site_report_branding_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
	],
);
