import type { Database } from "@webcraft/db";
import { rateLimits } from "@webcraft/db/schema";
import { lt, sql } from "drizzle-orm";
import { z } from "zod";

import type { Clock } from "./clock.ts";
import { defineJob } from "./jobs/define.ts";
import { defineSchedule } from "./jobs/schedules.ts";
import type { Logger } from "./log.ts";

/** A limit: at most `limit` requests per `windowMs`, counted in fixed windows from the first request. */
export type RateLimitRule = { limit: number; windowMs: number };

/**
 * The limits WebCraft applies, by name. `auth` covers the auth endpoints (signing in, confirming who
 * you are, setup tokens and invite links), per client address: guessing is slowed down from any one
 * address, and lockout stops it for any one account.
 */
export const RATE_LIMITS = {
	auth: { limit: 10, windowMs: 60_000 },
} as const satisfies Record<string, RateLimitRule>;

export type RateLimitName = keyof typeof RATE_LIMITS;

/** Too many requests: try again after `retryAfterSeconds`. */
export class RateLimitedError extends Error {
	override name = "RateLimitedError";
	readonly retryAfterSeconds: number;
	constructor(retryAfterSeconds: number) {
		super("Too many attempts. Wait a moment, then try again.");
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

export type RateLimits = {
	/**
	 * Counts one request against a limit for one subject, such as a client address (null: one the
	 * web process can't tell; those share one count). Throws `RateLimitedError` once the subject has
	 * used up the limit in the current window; the refused requests count too.
	 */
	hit(name: RateLimitName, subject: string | null): Promise<void>;
	/**
	 * Counts one request against a limit of a feature's own (a Form's per-address limits), under a key
	 * it makes (`form:<id>:minute:<address>`), and answers whether it is within the limit. Requests
	 * beyond it count too.
	 */
	count(key: string, rule: RateLimitRule): Promise<boolean>;
	/** Deletes the counters whose window ended; answers how many. */
	purge(): Promise<number>;
};

export function createRateLimits({
	database,
	clock,
	log,
	keyHash,
}: {
	database: Database;
	clock: Clock;
	log: Logger;
	/**
	 * The key counters are kept under (HMAC-SHA256, derived from the Master key): a counter's key
	 * names a client address, which is never kept, so the table holds only a keyed hash of it.
	 */
	keyHash: CryptoKey;
}): RateLimits {
	const { db } = database;
	const hashed = async (key: string) => {
		const signature = await crypto.subtle.sign("HMAC", keyHash, new TextEncoder().encode(key));
		return Array.from(new Uint8Array(signature), (byte) => byte.toString(16).padStart(2, "0")).join("");
	};
	/** Counts one request under `key` in its current window, and answers the count and when the window ends. */
	const counted = async (plainKey: string, rule: RateLimitRule) => {
		const key = await hashed(plainKey);
		const now = clock.now();
		const windowEndsAt = new Date(now.getTime() + rule.windowMs);
		const ended = sql`${rateLimits.windowEndsAt} <= ${now.toISOString()}::timestamptz`;
		// One statement: requests at the same moment, from any web process, each count once.
		const [counter] = await db
			.insert(rateLimits)
			.values({ key, hits: 1, windowEndsAt })
			.onConflictDoUpdate({
				target: rateLimits.key,
				set: {
					hits: sql`case when ${ended} then 1 else ${rateLimits.hits} + 1 end`,
					windowEndsAt: sql`case when ${ended} then ${windowEndsAt.toISOString()}::timestamptz else ${rateLimits.windowEndsAt} end`,
				},
			})
			.returning({ hits: rateLimits.hits, windowEndsAt: rateLimits.windowEndsAt });
		return counter;
	};
	return {
		async count(key, rule) {
			const counter = await counted(key, rule);
			return !counter || counter.hits <= rule.limit;
		},

		async hit(name, subject) {
			const rule: RateLimitRule = RATE_LIMITS[name];
			const now = clock.now();
			const counter = await counted(`${name}:${subject ?? "unknown"}`, rule);
			if (!counter || counter.hits <= rule.limit) return;
			if (counter.hits === rule.limit + 1) {
				log.warn("Too many requests from one client address: refused until the limit's window ends", {
					limit: name,
					clientAddress: subject,
					until: counter.windowEndsAt,
				});
			}
			const retryAfterSeconds = Math.max(1, Math.ceil((counter.windowEndsAt.getTime() - now.getTime()) / 1000));
			throw new RateLimitedError(retryAfterSeconds);
		},

		async purge() {
			const deleted = await db
				.delete(rateLimits)
				.where(lt(rateLimits.windowEndsAt, clock.now()))
				.returning({ key: rateLimits.key });
			return deleted.length;
		},
	};
}

/** Deletes rate limit counters whose window ended. */
export const rateLimitsPurge = defineJob({
	name: "rate-limits.purge",
	payload: z.object({}),
	async run(_payload, { rateLimits, log }) {
		const deleted = await rateLimits.purge();
		if (deleted > 0) log.debug("Deleted ended rate limit counters", { deleted });
	},
});

/** The rate limit purge runs every day at 04:23 UTC. */
export const rateLimitsPurgeSchedule = defineSchedule({ job: rateLimitsPurge, cron: "23 4 * * *", payload: {} });
