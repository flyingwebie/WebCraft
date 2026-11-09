import { index, jsonb, moduleSchema, siteColumns, text, timestamp, uuid } from "@webcraft/module-sdk";

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
	},
	(table) => [
		index("submissions_site_form_received_at_idx").on(table.siteId, table.formId, table.receivedAt),
		index("submissions_site_folder_received_at_idx").on(table.siteId, table.folder, table.receivedAt),
	],
);
