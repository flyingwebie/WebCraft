import { moduleSchema, siteColumns, text, timestamp, uuid } from "@webcraft/module-sdk";

const schema = moduleSchema("sample");

/** A note on a Site: written by people in the admin, by visitors through the Site route, or by the Module itself. */
export const notes = schema.table("notes", {
	...siteColumns(),
	id: uuid("id").primaryKey().defaultRandom(),
	body: text("body").notNull(),
	/** Who wrote it: `person`, `visitor` or `module`. */
	source: text("source").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
});

/** A table in the Module's schema that its definition doesn't list: WebCraft refuses it. */
export const stray = schema.table("stray", { ...siteColumns(), id: uuid("id").primaryKey() });

/** A table in another Module's schema: WebCraft refuses it too. */
export const elsewhere = moduleSchema("sample-board").table("pins", { ...siteColumns(), id: uuid("id").primaryKey() });
