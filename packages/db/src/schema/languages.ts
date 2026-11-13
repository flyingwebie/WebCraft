import { foreignKey, integer, pgTable, primaryKey, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";

import { sites } from "./tenancy.ts";

/**
 * A Site's languages (Structure, ADR 0010): its Default language (`sites.default_language`) and
 * every other one, each with its BCP 47 code, the name visitors see it by and its text direction.
 * The Default language's URLs have no prefix; every other language's start with its code in lower
 * case (`/fr/…`, `/pt-br/…`). A language may also be mapped to a domain of its own, which the Site
 * answers on in that language once domains are verified (#82); on the Staging address every
 * language keeps its prefix. Translated values themselves live per Field and per language in the
 * content store (ADR 0003).
 */
export const siteLanguages = pgTable(
	"site_languages",
	{
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** The BCP 47 tag in its canonical form: `en`, `pt-BR`, `zh-Hant`. */
		code: text("code").notNull(),
		/** The language's name as visitors read it, usually in the language itself: `Français`. */
		name: text("name").notNull(),
		/** `ltr` or `rtl`. */
		direction: text("direction").notNull(),
		/** A domain of its own (`bakery.fr`), in lower case; null for none. Unique on the Install. */
		domain: text("domain"),
		/** Where the language comes in the Site's lists (the Language switcher, `hreflang`), from 0. */
		position: integer("position").notNull(),
		/**
		 * How the language is kept up to date (its Translation mode): `automatic` (AI translation is
		 * published together with the Default language's publish), `review` (AI translation lands in the
		 * Draft for a person to publish) or `manual` (people translate). Unused on the Default language.
		 */
		translationMode: text("translation_mode").notNull().default("manual"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.siteId, table.code] }),
		foreignKey({
			name: "site_languages_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("site_languages_domain_unique").on(table.domain),
	],
);
