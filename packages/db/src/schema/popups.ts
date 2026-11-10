import { foreignKey, jsonb, pgTable, text, timestamp, unique, uuid } from "drizzle-orm/pg-core";
import { components } from "./content.ts";
import { people } from "./people.ts";
import { sites } from "./tenancy.ts";
export const popups = pgTable(
	"popups",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		key: text("key").notNull(),
		name: text("name").notNull(),
		componentId: uuid("component_id").notNull(),
		draft: jsonb("draft").notNull(),
		published: jsonb("published"),
		contentDraft: jsonb("content_draft").notNull(),
		contentPublished: jsonb("content_published"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
		updatedVia: text("updated_via"),
		contentUpdatedAt: timestamp("content_updated_at", { withTimezone: true }).notNull(),
		contentUpdatedBy: uuid("content_updated_by").references(() => people.id, { onDelete: "set null" }),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		lastPublishedAt: timestamp("last_published_at", { withTimezone: true }),
		contentUpdatedVia: text("content_updated_via"),
		contentPublishedAt: timestamp("content_published_at", { withTimezone: true }),
	},
	(t) => [
		foreignKey({
			name: "popups_site_fkey",
			columns: [t.workspaceId, t.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		unique("popups_site_key_unique").on(t.siteId, t.key),
		unique("popups_site_id_unique").on(t.siteId, t.id),
		foreignKey({
			name: "popups_component_fkey",
			columns: [t.siteId, t.componentId],
			foreignColumns: [components.siteId, components.id],
		}),
	],
);
