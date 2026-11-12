import type { Database } from "@webcraft/db";
import { rateLimits } from "@webcraft/db/schema";
import { lt, sql } from "drizzle-orm";
import { z } from "zod";

import type { Clock } from "./clock.ts";
import { ipRangeText, parseIpRange } from "./ip-ranges.ts";
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

/**
 * Who a limit per client address counts, as the last part of its counter's key: an IPv4 address as it
 * is, and an IPv6 address by its /64 (`2001:db8:0:1::/64`). One IPv6 connection has a whole /64 of its
 * own, 2^64 addresses, and may send each request from another: counted one by one, no limit would
 * hold. An address the web process couldn't tell (null) is `unknown`: those share one count.
 *
 * Every limit per client address is counted through here (`hit`, and `count` and `tally` given an
 * address): never write an address into a key yourself.
 */
function addressSubject(address: string | null): string {
	if (address === null) return "unknown";
	const network = parseIpRange(`${address}/${IPV6_CLIENT_PREFIX}`);
	return network?.family === 6 ? ipRangeText(network) : address;
}

/** The part of an IPv6 address that names one connection: the /64 a provider gives it. */
const IPV6_CLIENT_PREFIX = 64;

/** Where a key stands after one more request: `within` the limit or not, what is left, and when the window ends. */
export type RateLimitTally = { within: boolean; limit: number; remaining: number; resetsAt: Date };

export type RateLimits = {
	/**
	 * Counts one request against a named limit for the client address it came from (null: one the web
	 * process can't tell; those share one count; an IPv6 client counts by its /64). Throws
	 * `RateLimitedError` once the address has used up the limit in the current window; the refused
	 * requests count too.
	 */
	hit(name: RateLimitName, address: string | null): Promise<void>;
	/**
	 * Counts one request against a limit of a feature's own, under a key it makes, and answers whether
	 * it is within the limit. Requests beyond it count too. A limit per client address gives the
	 * address apart from the key (`count("form:<id>:minute", rule, address)`; null for one the web
	 * process couldn't tell), never inside it: the limiter decides who that address counts as (an IPv6
	 * client by its /64) and adds it to the key.
	 */
	count(key: string, rule: RateLimitRule, address?: string | null): Promise<boolean>;
	/**
	 * Counts one request under `key` like `count`, and answers where the key stands: whether this
	 * request is within the limit, how many more the window allows and when it ends (for `RateLimit`
	 * and `Retry-After` headers). API tokens' limits use it.
	 */
	tally(key: string, rule: RateLimitRule, address?: string | null): Promise<RateLimitTally>;
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
	 * names a client address, which the table never keeps, so it holds only a keyed hash of it. (The
	 * one warning `hit` writes when an address uses up the `auth` limit does name the address, in the
	 * log: whoever runs the Install must be able to see who is guessing.)
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
	/** A counter's key: the feature's own, and who the address counts as when the limit is per client address. */
	const keyFor = (key: string, address: string | null | undefined) =>
		address === undefined ? key : `${key}:${addressSubject(address)}`;
	return {
		async count(key, rule, address) {
			const counter = await counted(keyFor(key, address), rule);
			return !counter || counter.hits <= rule.limit;
		},

		async tally(key, rule, address) {
			const counter = await counted(keyFor(key, address), rule);
			const hits = counter?.hits ?? 1;
			return {
				within: hits <= rule.limit,
				limit: rule.limit,
				remaining: Math.max(0, rule.limit - hits),
				resetsAt: counter?.windowEndsAt ?? new Date(clock.now().getTime() + rule.windowMs),
			};
		},

		async hit(name, address) {
			const rule: RateLimitRule = RATE_LIMITS[name];
			const now = clock.now();
			const counter = await counted(keyFor(name, address), rule);
			if (!counter || counter.hits <= rule.limit) return;
			if (counter.hits === rule.limit + 1) {
				log.warn("Too many requests from one client address: refused until the limit's window ends", {
					limit: name,
					clientAddress: address,
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
