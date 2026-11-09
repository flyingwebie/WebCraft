import { foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { sites } from "./tenancy.ts";

// The Consent banner (ADR 0020): how a Site asks its visitors which Consent categories they accept,
// and the Consent records that prove what each one chose. Site tables: every row carries
// `workspace_id` and `site_id`, with a foreign key to `sites (workspace_id, id)`.

/**
 * A Site's Consent banner, made the first time the Site changes it (until then it is the default:
 * Opt-in, a bottom bar, WebCraft's own words). `mode` and `layout` are a Site setting (Structure,
 * Staff only, applied at once). Its words are Content, with a Draft and a published version like the
 * Globals: `draft` and `published` hold their values per language (ADR 0003). `version` goes up with
 * every change visitors can see, and each Consent record names the version it answered.
 */
export const consentBanners = pgTable(
	"consent_banners",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** `optIn`, `optOut`, `none` or `outside` (an outside consent service). */
		mode: text("mode").notNull().default("optIn"),
		/** `bar` (along the bottom), `box` (a corner) or `dialog` (centred, modal). */
		layout: text("layout").notNull().default("bar"),
		version: integer("version").notNull().default(1),
		/** The Draft of its words. */
		draft: jsonb("draft").notNull(),
		/** The words visitors see; null until the first publish (WebCraft's own words until then). */
		published: jsonb("published"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		/** When the setting or the Draft last changed. */
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		lastPublishedAt: timestamp("last_published_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "consent_banners_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("consent_banners_site_id_unique").on(table.siteId),
	],
);

/**
 * Consent records: the proof of one visitor's choice on the Site's Consent banner. A random id (the
 * visitor's `webcraft.consent` cookie names it), the time, the choices, the banner version and the
 * language, and nothing that identifies the visitor: no IP address, no user agent, no hash. Kept 12
 * months (`consent.purge-records`).
 */
export const consentRecords = pgTable(
	"consent_records",
	{
		id: uuid("id").primaryKey(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		/** Whether each category was accepted: `{ analytics, marketing, media }` (Necessary always is). */
		choices: jsonb("choices").notNull(),
		bannerVersion: integer("banner_version").notNull(),
		/** The language of the page the banner was answered on. */
		language: text("language").notNull(),
	},
	(table) => [
		foreignKey({
			name: "consent_records_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("consent_records_site_id_idx").on(table.siteId),
		index("consent_records_created_at_idx").on(table.createdAt),
	],
);
