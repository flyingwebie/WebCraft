import { sql } from "drizzle-orm";
import { bigint, foreignKey, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { entries } from "./content.ts";
import { people } from "./people.ts";
import { popups } from "./popups.ts";
import { scheduledPublishes } from "./scheduled-publishes.ts";
import { sites } from "./tenancy.ts";

// Reviews (GLOSSARY.md › Review): an Author submits a Draft, and someone who may publish it publishes
// it, schedules it or sends it back with a comment. Site data like the content store: every row
// carries `workspace_id` and `site_id`, with a foreign key to `sites (workspace_id, id)`. Rows stay
// after they are decided (the comment of one sent back shows until the item is submitted again or
// published); the Audit log keeps the whole story.

/**
 * One submission of one item for Review: the item, named as publishing names it (`item_kind`, and the
 * Entry for an Entry: the Globals and the Consent banner's words are one per Site), its state
 * (`status`: `inReview` while it waits, then `withdrawn`, `sentBack`, `published` or `scheduled`), who
 * submitted it and how, with their note, the version of the Draft they submitted (`version`,
 * `draftVersion`, which "Changed since submitted" compares the Draft with), and who decided it, when,
 * with the comment of one sent back and the time of one scheduled. An item waits in at most one Review
 * at a time. `cleared_at`: when a sent-back comment stopped showing, because the item was published.
 */
export const reviews = pgTable(
	"reviews",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/** Rises with each submission: an item's newest Review is its highest, even within one moment. */
		serial: bigint("serial", { mode: "number" }).generatedAlwaysAsIdentity(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		itemKind: text("item_kind").notNull(),
		/** The Entry under review; null for the items a Site has one of. Deleting the Entry deletes its Reviews. */
		entryId: uuid("entry_id"),
		popupId: uuid("popup_id"),
		status: text("status").notNull(),
		/** Who submitted it; null once they are deleted. */
		submittedBy: uuid("submitted_by").references(() => people.id, { onDelete: "set null" }),
		/** How they came in (`AuditVia`). */
		submittedVia: jsonb("submitted_via").notNull(),
		submittedAt: timestamp("submitted_at", { withTimezone: true }).notNull(),
		note: text("note"),
		version: text("version").notNull(),
		decidedBy: uuid("decided_by").references(() => people.id, { onDelete: "set null" }),
		decidedVia: jsonb("decided_via"),
		decidedAt: timestamp("decided_at", { withTimezone: true }),
		comment: text("comment"),
		scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
		/**
		 * The Scheduled publish that ended it (`scheduled`); null otherwise. When that Scheduled publish
		 * is removed without ever publishing it (cancelled, or a run that failed), it is put back to
		 * `inReview` in the same transaction, so it doesn't wait forever for a time that won't come.
		 */
		scheduleId: uuid("schedule_id"),
		clearedAt: timestamp("cleared_at", { withTimezone: true }),
	},
	(table) => [
		foreignKey({
			name: "reviews_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		foreignKey({
			name: "reviews_entry_fkey",
			columns: [table.siteId, table.entryId],
			foreignColumns: [entries.siteId, entries.id],
		}).onDelete("cascade"),
		// A single column, not (site_id, schedule_id): a composite FK's ON DELETE SET NULL would null
		// site_id too, which is NOT NULL. scheduled_publishes.id is already a Site-wide unique uuid.
		foreignKey({
			name: "reviews_schedule_fkey",
			columns: [table.scheduleId],
			foreignColumns: [scheduledPublishes.id],
		}).onDelete("set null"),
		foreignKey({
			name: "reviews_popup_fkey",
			columns: [table.siteId, table.popupId],
			foreignColumns: [popups.siteId, popups.id],
		}).onDelete("cascade"),
		// One waiting Review per item (the Globals and the Consent banner's words have no Entry).
		uniqueIndex("reviews_one_waiting")
			.on(table.siteId, table.itemKind, sql`coalesce(entry_id::text, popup_id::text, '')`)
			.where(sql`status = 'inReview'`),
		index("reviews_site_id_status_idx").on(table.siteId, table.status, table.serial),
		index("reviews_site_id_item_idx").on(table.siteId, table.itemKind, table.entryId, table.serial),
		index("reviews_entry_id_idx").on(table.entryId),
		index("reviews_schedule_id_idx").on(table.scheduleId),
	],
);
