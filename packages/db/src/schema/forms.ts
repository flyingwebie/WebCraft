import { foreignKey, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { sites } from "./tenancy.ts";

// Forms (`@webcraft/core` › forms): what visitors fill in on a Site. A Form is Structure with a Draft
// and a published version, like a Component; what visitors send (Submissions) is kept by the Module
// that receives them (the Forms Module), in its own tables, never here.

/**
 * The Site's Forms. Each version (`draft`, `published`) is a `FormVersion`: its fields with their
 * labels, help, options and messages in every language (ADR 0003's per-language text, as fixed text
 * in Templates keeps it), what happens after sending, and its spam limits. Trees place a Form by id
 * (`{{@form <key>}}` in Template markup), so changing its key or name changes nothing placed.
 */
export const forms = pgTable(
	"forms",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** How Template markup names it, `{{@form contact}}`: lower-case words joined by dashes. Unique on the Site. */
		key: text("key").notNull(),
		/** What Staff and clients call it in the admin, such as "Wedding cake enquiry". */
		name: text("name").notNull(),
		draft: jsonb("draft").notNull(),
		/** What visitors fill in; null until the first publish. */
		published: jsonb("published"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		lastPublishedAt: timestamp("last_published_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "forms_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("forms_site_id_id_unique").on(table.siteId, table.id),
		unique("forms_site_id_key_unique").on(table.siteId, table.key),
	],
);

/**
 * A Site's settings for all its Forms (Structure without a Draft: a change applies at once): so far
 * its CAPTCHA, off (null) unless Staff set one up. The CAPTCHA's secret key is the Site secret
 * `forms.captcha.secret`, never stored here.
 */
export const formSettings = pgTable(
	"form_settings",
	{
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		captcha: jsonb("captcha"),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		primaryKey({ name: "form_settings_pkey", columns: [table.siteId] }),
		foreignKey({
			name: "form_settings_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
	],
);
