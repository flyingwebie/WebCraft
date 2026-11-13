import { sql } from "drizzle-orm";
import { bigint, index, jsonb, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

/**
 * The Audit log: who did what, where, when and how they came in. Append-only: rows are inserted
 * and never changed (triggers in the migration `audit-log-append-only` refuse updates and
 * truncation; deleting old entries stays possible for retention). It has no foreign keys on
 * purpose, so an entry outlives the person, Workspace or Site it mentions.
 */
export const auditLog = pgTable(
	"audit_log",
	{
		/** Increases with every entry, so entries written in the same instant keep their order. */
		id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
		/** Who acted; null when WebCraft itself did. */
		personId: uuid("person_id"),
		/**
		 * How they came in: `admin`, `command` (a `webcraft admin …` command), `editMode`, `token`,
		 * `aiClient`, `module`, `translation`, or `impersonation` (Staff or the Superadmin acting as the
		 * person: "<Staff> as <Member>").
		 */
		via: text("via").notNull(),
		/**
		 * The name that goes with `via`: the command, the token, the AI client, the Module, or the name
		 * of the person impersonating, as it was then.
		 */
		viaName: text("via_name"),
		/** Who acted as the person (`via` is `impersonation`): the Superadmin or a Staff member. */
		impersonatorId: uuid("impersonator_id"),
		workspaceId: uuid("workspace_id"),
		siteId: uuid("site_id"),
		/** What they did, such as `site.create`. */
		action: text("action").notNull(),
		/** What the action changed, such as a name or an email address; never a secret's value. */
		details: jsonb("details").notNull().default(sql`'{}'::jsonb`),
	},
	(table) => [
		// Retention removes entries by age.
		index("audit_log_occurred_at_idx").on(table.occurredAt),
		// The screens page through entries newest first (by id) within a Workspace, a Site, a person
		// or an action, so each filter reads one index and a page costs the same on a large log.
		index("audit_log_workspace_id_id_idx").on(table.workspaceId, table.id),
		index("audit_log_site_id_id_idx").on(table.siteId, table.id),
		index("audit_log_person_id_id_idx").on(table.personId, table.id),
		index("audit_log_impersonator_id_id_idx").on(table.impersonatorId, table.id),
		index("audit_log_action_id_idx").on(table.action, table.id),
	],
);
