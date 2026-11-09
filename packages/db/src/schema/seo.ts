import { foreignKey, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { sites } from "./tenancy.ts";

/**
 * A Site's SEO settings (Structure, Staff only, applied at once like other Site settings): what every
 * page's title, social image and structured data fall back to, and what its robots.txt says (the AI
 * crawler setting, which Owners change too, and Staff's own lines). A Site table, made the first time
 * the Site changes them (until then WebCraft's defaults apply).
 */
export const seoSettings = pgTable(
	"seo_settings",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** The name titles and structured data give the Site; null for the Site's own name. */
		siteName: text("site_name"),
		/** What title patterns put between their parts (`{separator}`), such as `·` or `|`. */
		separator: text("separator").notNull().default("·"),
		/** The social image of every page without one of its own: a Media image's id, or null. */
		defaultImage: uuid("default_image"),
		/**
		 * The organisation behind the Site, as structured data shows it on every page: its kind
		 * (`organization` or `localBusiness`), name, logo (a Media id), profiles elsewhere (`sameAs`) and
		 * the Globals its telephone, email and address come from. `{}` for the defaults.
		 */
		organization: jsonb("organization").notNull().default({}),
		/**
		 * What the Site's robots.txt says to AI crawlers (spec story 119): `allowAll`, `allowSearch` (AI
		 * search in, training out) or `blockAll`. Staff and Owners change it.
		 */
		aiCrawlers: text("ai_crawlers").notNull().default("allowAll"),
		/** Staff's own robots.txt lines, checked when saved, written after WebCraft's own groups; "" for none. */
		robotsLines: text("robots_lines").notNull().default(""),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "seo_settings_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("seo_settings_site_id_unique").on(table.siteId),
	],
);
