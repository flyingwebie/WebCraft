import { sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The Audit log: who did what, where, when and how they came in. Append-only: rows are inserted
 * and never changed (a trigger refuses updates). It has no foreign keys on purpose, so an entry
 * outlives the person, Workspace or Site it mentions.
 */
export const auditLog = pgTable(
	"audit_log",
	{
		/** Increases with every entry, so entries written in the same instant keep their order. */
		id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
		/** Who acted; null when WebCraft itself did. */
		personId: uuid("person_id"),
		/** How they came in: `admin`, `command` (a `webcraft admin …` command); later Edit mode, tokens, AI clients, Modules. */
		via: text("via").notNull(),
		/** The name that goes with `via`: the command, the token, the AI client or the Module. */
		viaName: text("via_name"),
		workspaceId: uuid("workspace_id"),
		siteId: uuid("site_id"),
		/** What they did, such as `site.create`. */
		action: text("action").notNull(),
		/** What the action changed, such as a name or an email address; never a secret's value. */
		details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
	},
	(table) => [
		index("audit_log_occurred_at_idx").on(table.occurredAt),
		index("audit_log_workspace_id_occurred_at_idx").on(table.workspaceId, table.occurredAt),
	],
);
