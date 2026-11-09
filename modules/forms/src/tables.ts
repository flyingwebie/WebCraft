import {
	index,
	integer,
	jsonb,
	moduleSchema,
	primaryKey,
	siteColumns,
	text,
	timestamp,
	uuid,
} from "@webcraft/module-sdk";

const schema = moduleSchema("forms");

/**
 * What visitors sent through a Site's Forms, as WebCraft checked and handed them over: one row per
 * Submission, in the inbox or the Spam folder (with why), with the language and page it came from.
 */
export const submissions = schema.table(
	"submissions",
	{
		...siteColumns(),
		id: uuid("id").primaryKey().defaultRandom(),
		formId: uuid("form_id").notNull(),
		formKey: text("form_key").notNull(),
		formName: text("form_name").notNull(),
		language: text("language").notNull(),
		page: text("page"),
		/** `inbox`, or `spam`. */
		folder: text("folder").notNull(),
		/** Why it is spam (`honeypot`, `too-fast`, `token`, `rate-limit`, `size`, `captcha`); null in the inbox. */
		spamReason: text("spam_reason"),
		/** The Form's fields in order, each `{ key, label, type, value }`. */
		values: jsonb("values").notNull(),
		receivedAt: timestamp("received_at", { withTimezone: true }).notNull(),
		/** When someone marked it read; null while it is unread (for everyone: one inbox per Site). */
		readAt: timestamp("read_at", { withTimezone: true }),
		/**
		 * What WebCraft knew of its sender (`FormSender`: never the address), handed back when it is taken
		 * out of the Spam folder; null for Submissions kept before SDK 1.6.
		 */
		sender: jsonb("sender"),
		/** Its values as lower-case text, for search. */
		searchText: text("search_text").notNull(),
	},
	(table) => [
		index("submissions_site_form_received_at_idx").on(table.siteId, table.formId, table.receivedAt),
		index("submissions_site_folder_received_at_idx").on(table.siteId, table.folder, table.receivedAt),
	],
);

/** How long each Form's Submissions are kept: 30, 90 or 365 days; no row (or null) for forever. */
export const retention = schema.table(
	"retention",
	{
		...siteColumns(),
		formId: uuid("form_id").notNull(),
		keepDays: integer("keep_days"),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [primaryKey({ columns: [table.siteId, table.formId] })],
);
