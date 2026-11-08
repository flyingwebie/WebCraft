import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Rate limit counters: how many requests one key (such as `auth:203.0.113.7`, the auth endpoints
 * from one client address) made in its current window, and when that window ends. Kept in Postgres
 * so every web process counts together; rows whose window ended are purged every day.
 */
export const rateLimits = pgTable("rate_limits", {
	key: text("key").primaryKey(),
	hits: integer("hits").notNull(),
	windowEndsAt: timestamp("window_ends_at", { withTimezone: true }).notNull(),
});
