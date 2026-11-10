import {
	bigint,
	foreignKey,
	index,
	jsonb,
	pgTable,
	primaryKey,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";

import { people } from "./people.ts";
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
		/**
		 * The Form's emails (`FormEmails`): its Notifications (recipients, routing, subject, intro) and its
		 * Auto-reply. Content, unlike the rest of the Form: Staff, Owners and Editors change them in this
		 * Draft and publish them on their own (`formEmails.edit`). Null: none yet.
		 */
		emailsDraft: jsonb("emails_draft"),
		/** The emails a Submission sets off; null until they are first published. */
		emailsPublished: jsonb("emails_published"),
		emailsLastPublishedAt: timestamp("emails_last_published_at", { withTimezone: true }),
		/**
		 * The emails' translations AI translation wrote, by language and place (`autoReply.subject`):
		 * the text it wrote and the Default-language text it translated. A translation is the AI's only
		 * while its text is still the one written here; once a person changes it, it is theirs.
		 */
		emailsAiTranslations: jsonb("emails_ai_translations"),
		/** When the emails' Draft was last changed, and by whom: what Publish all says about them. */
		emailsUpdatedAt: timestamp("emails_updated_at", { withTimezone: true }),
		emailsUpdatedBy: uuid("emails_updated_by").references(() => people.id, { onDelete: "set null" }),
		/** The API client or AI client the emails was last changed through (its name), or null: in the admin or Edit mode. */
		emailsUpdatedVia: text("emails_updated_via"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
		/** Who last changed the Draft (null when nobody did, or they are gone): what Publish all says. */
		updatedBy: uuid("updated_by").references(() => people.id, { onDelete: "set null" }),
		/** The API client or AI client the Draft was last changed through (its name), or null: in the admin or Edit mode. */
		updatedVia: text("updated_via"),
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

/**
 * Form uploads (GLOSSARY.md, ADR 0026): files visitors sent with a Form's file field. They are
 * private: kept in the Install's storage under `<workspace id>/<site id>/form-uploads/<id>`, never in
 * the Media library and never served on the Site; people download them through the admin when they
 * may read the Site's Submissions. Each belongs to the Submission it came with (`submission_id`, in
 * the Module keeping Submissions; null only for the moment between storing the file and keeping the
 * Submission), and is deleted with it. A Site export (#109) carries them with their Submissions.
 */
export const formUploads = pgTable(
	"form_uploads",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** The Form and the file field it came through. */
		formId: uuid("form_id").notNull(),
		fieldKey: text("field_key").notNull(),
		/** The Submission it belongs to, as the Module keeping them named it; null until it is kept. */
		submissionId: uuid("submission_id"),
		/** Its name as the visitor's computer gave it, cleaned (no folders or control characters). */
		name: text("name").notNull(),
		/** What its bytes are (read from them, never from the name), and how many there are. */
		contentType: text("content_type").notNull(),
		size: bigint("size", { mode: "number" }).notNull(),
		/** Which storage holds it (`disk` or `s3`) and under which key: it is always read from there. */
		storage: text("storage").notNull(),
		key: text("key").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "form_uploads_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		index("form_uploads_site_submission_idx").on(table.siteId, table.submissionId),
	],
);
