import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { people, sessions } from "./people.ts";

/**
 * Impersonation (ADR 0008): the Superadmin or a Staff member acting in the admin as another person,
 * for at most an hour. It rides on the impersonator's own admin session (`session_id`): while one is
 * going, that session acts as the person; when it ends, the same session is the impersonator's
 * again. Rows stay after they end, as the record of who impersonated whom and for how long.
 */
export const impersonations = pgTable(
	"impersonations",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		/** The admin session that acts as the person; null once that session has ended. */
		sessionId: uuid("session_id").references(() => sessions.id, { onDelete: "set null" }),
		/** Who impersonates: the Superadmin or a Staff member. */
		impersonatorId: uuid("impersonator_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		/** Who is impersonated: a Member, or Staff (by the Superadmin only). */
		personId: uuid("person_id")
			.notNull()
			.references(() => people.id, { onDelete: "cascade" }),
		/**
		 * The Workspaces the impersonation reaches: the person's Workspaces the impersonator may
		 * impersonate in (Staff: the ones they are assigned to). Null: everything the person reaches
		 * (the Superadmin).
		 */
		workspaceIds: uuid("workspace_ids").array(),
		/** Why, as the impersonator wrote it (optional); kept in the Audit log too. */
		reason: text("reason"),
		/** The admin page to go back to when it stops: where it was started. */
		returnTo: text("return_to"),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
		/** When it ends by itself: at most an hour after it started. */
		endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
		/** When it ended; null while it goes on (until `ends_at`). */
		endedAt: timestamp("ended_at", { withTimezone: true }),
		/** Why it ended: `stopped`, `time` (the hour ran out) or `signedOut` (the session ended). */
		endReason: text("end_reason"),
	},
	(table) => [
		// One impersonation at a time in a session.
		uniqueIndex("impersonations_one_per_session_idx").on(table.sessionId).where(sql`${table.endedAt} is null`),
		index("impersonations_due_idx").on(table.endsAt).where(sql`${table.endedAt} is null`),
	],
);
