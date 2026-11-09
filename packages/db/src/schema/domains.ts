import { sql } from "drizzle-orm";
import { foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { siteLanguages } from "./languages.ts";
import { sites } from "./tenancy.ts";

/**
 * A Site's domains (ADR 0015): its Primary domain (at most one), its Redirect domains, and the
 * domains of its languages (`site_languages.domain`, mirrored here with `language` set, so every
 * domain of the Install is verified and checked the same way). Each name is unique on the Install,
 * in lower case and in its ASCII form.
 *
 * A domain serves visitors only once verified (`verified_at`): the Install fetched
 * `http://<name>/_webcraft/verify/<token>` and got back the answer only it can make. Until then it
 * waits for DNS, checked again by background jobs (`verify_round`, `next_check_at`). Once verified,
 * the hourly Domain check marks it Unreachable (`unreachable_since`) while its DNS, certificate or
 * answer is wrong.
 */
export const siteDomains = pgTable(
	"site_domains",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		workspaceId: uuid("workspace_id").notNull(),
		siteId: uuid("site_id").notNull(),
		/** The domain, in lower case and its ASCII form (`xn--…` for international names). */
		name: text("name").notNull(),
		/** `primary`, `redirect` or `language`. */
		role: text("role").notNull(),
		/** For a language's domain, the language's code (one of the Site's `site_languages`). */
		language: text("language"),
		/** When the Install confirmed the domain reaches it; null while it waits for DNS. */
		verifiedAt: timestamp("verified_at", { withTimezone: true }),
		/**
		 * The current round of automatic verification checks: every check job carries the round it
		 * belongs to, and a job of an earlier round (Staff pressed Check now since) does nothing.
		 */
		verifyRound: integer("verify_round").notNull().default(0),
		/** When the current round started: checks come every few minutes for an hour, then hourly for 7 days. */
		verifyStartedAt: timestamp("verify_started_at", { withTimezone: true }),
		/** When the next automatic check is due; null when none is (verified, or only on demand now). */
		nextCheckAt: timestamp("next_check_at", { withTimezone: true }),
		/** When the domain was last checked, by verification or the Domain check. */
		lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
		/** What the last check found wrong (`dns`, `unreachable`, `response`, `certificate-missing`, `certificate-expiring`); null when it passed. */
		lastProblem: text("last_problem"),
		/** Since when the Domain check has found the verified domain Unreachable; null while it passes. */
		unreachableSince: timestamp("unreachable_since", { withTimezone: true }),
		/** When the domain's certificate runs out, as the last check saw it. */
		certificateExpiresAt: timestamp("certificate_expires_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		foreignKey({
			name: "site_domains_site_fkey",
			columns: [table.workspaceId, table.siteId],
			foreignColumns: [sites.workspaceId, sites.id],
		}).onDelete("cascade"),
		// A language's domain goes with its language.
		foreignKey({
			name: "site_domains_language_fkey",
			columns: [table.siteId, table.language],
			foreignColumns: [siteLanguages.siteId, siteLanguages.code],
		}).onDelete("cascade"),
		uniqueIndex("site_domains_name_unique").on(table.name),
		uniqueIndex("site_domains_one_primary").on(table.siteId).where(sql`${table.role} = 'primary'`),
		uniqueIndex("site_domains_one_per_language").on(table.siteId, table.language),
		index("site_domains_next_check_at_idx").on(table.nextCheckAt),
	],
);
