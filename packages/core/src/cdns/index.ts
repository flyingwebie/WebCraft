/**
 * A CDN in front of a Site (spec story 43). A Site's CDN is a Site setting (Structure,
 * `structure.edit`, logged `cdn.change`): with it set, the web process believes the CDN's visitor
 * header (`CDNS[cdn].header`) on connections from that CDN's published address ranges that also carry
 * the Site's CDN secret (`CDN_SECRET_HEADER`), so rate limits keep counting visitors rather than the
 * CDN's servers. The ranges are shared by everyone who uses the CDN, and anyone's service there can
 * send requests on to a Site with a visitor header of its choosing: the secret, which the Site's own
 * service adds, is what says the request came through it. The ranges ship with WebCraft
 * (`BUNDLED_CDN_RANGES`) and the worker fetches each list Sites use once a day through the guarded
 * fetcher, keeping a list only when it checks out (`checkCdnList`); table `cdn_ranges`.
 */
import type { Database } from "@webcraft/db";
import { cdnRanges, sites } from "@webcraft/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import { z } from "zod";

import type { Clock } from "../clock.ts";
import { sameText } from "../domains/checks.ts";
import type { GuardedFetch } from "../guarded-fetch.ts";
import { type IpRange, parseIpRange } from "../ip-ranges.ts";
import type { JobQueue } from "../jobs/define.ts";
import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";
import type { Logger } from "../log.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { hashToken, newToken } from "../tokens.ts";
import { BUNDLED_CDN_RANGES } from "./bundled-ranges.ts";
import { CDN_LIST_MAX_BYTES, checkCdnList } from "./lists.ts";
import { CDNS, type CdnKey, isCdnKey } from "./registry.ts";

export { CDN_LIST_MAX_BYTES, CDN_LIST_MAX_RANGES, CdnListInvalidError, checkCdnList } from "./lists.ts";
export { CDN_KEYS, CDNS, type CdnDefinition, type CdnKey, isCdnKey } from "./registry.ts";

/**
 * The header (lower case) a Site's own service at its CDN adds to every request it sends on, carrying
 * the Site's CDN secret. Staff set it up at the CDN with the secret `newSiteCdnSecret` answers.
 */
export const CDN_SECRET_HEADER = "x-cdn-secret";

/** A Site without a CDN has no CDN secret to make. */
export class CdnNotSetError extends Error {
	override name = "CdnNotSetError";
	constructor() {
		super("The Site has no CDN in front: choose one first.");
	}
}

/** How long the web process keeps a CDN's ranges before reading them again: a refreshed list counts within this. */
export const CDN_RANGES_CACHE_MS = 5 * 60_000;

export type Cdns = {
	/**
	 * The address ranges a CDN's servers connect from: the list the worker last fetched, else the one
	 * this version of WebCraft shipped with. Kept in memory for `CDN_RANGES_CACHE_MS`.
	 */
	ranges(cdn: CdnKey): Promise<readonly IpRange[]>;
	/** The CDN in front of the Site, or null. Open the Site with `site.view`. */
	siteCdn(scope: SiteScope): Promise<CdnKey | null>;
	/**
	 * Sets the CDN in front of the Site (null: none), recording `cdn.change`, and has the worker fetch
	 * the CDN's list soon. A change forgets the Site's CDN secret: it was set up at the CDN it leaves.
	 * Open the Site with `structure.edit`.
	 */
	setSiteCdn(scope: SiteScope, cdn: CdnKey | null): Promise<CdnKey | null>;
	/** Whether the Site has a CDN secret. Open the Site with `site.view`. */
	siteHasCdnSecret(scope: SiteScope): Promise<boolean>;
	/**
	 * Makes the Site's CDN secret, in place of any it had, recording `cdnSecret.change`, and answers
	 * it: the only time it is shown, since only its hash is kept. Throws `CdnNotSetError` for a Site
	 * without a CDN. Open the Site with `structure.edit`.
	 */
	newSiteCdnSecret(scope: SiteScope): Promise<string>;
	/**
	 * Whether a request's `CDN_SECRET_HEADER` value is the secret whose hash a Site keeps
	 * (`SiteHost.cdnSecretHash`): never without one.
	 */
	holdsSecret(secretHash: string | null, given: string | null): Promise<boolean>;
	/** Fetches the lists of the CDNs Sites use, keeping each one that checks out (the worker's job). */
	refreshRanges(): Promise<void>;
};

export function createCdns(deps: {
	database: Database;
	clock: Clock;
	log: Logger;
	jobs: JobQueue;
	fetch: GuardedFetch;
}): Cdns {
	const { database, clock, log } = deps;
	const cached = new Map<CdnKey, { ranges: readonly IpRange[]; readAt: number }>();

	return {
		async ranges(cdn) {
			const now = clock.now().getTime();
			const kept = cached.get(cdn);
			if (kept && now - kept.readAt < CDN_RANGES_CACHE_MS) return kept.ranges;
			const [row] = await database.db
				.select({ ranges: cdnRanges.ranges })
				.from(cdnRanges)
				.where(eq(cdnRanges.cdn, cdn));
			const ranges = (row?.ranges ?? BUNDLED_CDN_RANGES[cdn]).flatMap((range) => parseIpRange(range) ?? []);
			cached.set(cdn, { ranges, readAt: now });
			return ranges;
		},

		async siteCdn(scope) {
			const [site] = await scope.db
				.select({ cdn: sites.cdn })
				.from(sites)
				.where(and(eq(sites.id, scope.site.id), eq(sites.workspaceId, scope.site.workspaceId)));
			return isCdnKey(site?.cdn) ? site.cdn : null;
		},

		async setSiteCdn(scope, cdn) {
			await scope.transaction(async (tx) => {
				const [site] = await tx.db
					.select({ cdn: sites.cdn })
					.from(sites)
					.where(and(eq(sites.id, tx.site.id), eq(sites.workspaceId, tx.site.workspaceId)))
					.for("update");
				const from = isCdnKey(site?.cdn) ? site.cdn : null;
				if (from === cdn) return;
				await tx.db
					.update(sites)
					.set({ cdn, cdnSecretHash: null })
					.where(and(eq(sites.id, tx.site.id), eq(sites.workspaceId, tx.site.workspaceId)));
				await tx.audit("cdn.change", { from, to: cdn });
			});
			if (cdn !== null) await deps.jobs.send(cdnRefreshRanges, {});
			return cdn;
		},

		async siteHasCdnSecret(scope) {
			const [site] = await scope.db
				.select({ hash: sites.cdnSecretHash })
				.from(sites)
				.where(and(eq(sites.id, scope.site.id), eq(sites.workspaceId, scope.site.workspaceId)));
			return (site?.hash ?? null) !== null;
		},

		async newSiteCdnSecret(scope) {
			const secret = newToken();
			const cdnSecretHash = await hashToken(secret);
			await scope.transaction(async (tx) => {
				const [site] = await tx.db
					.select({ cdn: sites.cdn, hash: sites.cdnSecretHash })
					.from(sites)
					.where(and(eq(sites.id, tx.site.id), eq(sites.workspaceId, tx.site.workspaceId)))
					.for("update");
				if (!isCdnKey(site?.cdn)) throw new CdnNotSetError();
				await tx.db
					.update(sites)
					.set({ cdnSecretHash })
					.where(and(eq(sites.id, tx.site.id), eq(sites.workspaceId, tx.site.workspaceId)));
				await tx.audit("cdnSecret.change", { cdn: site.cdn, replaced: site.hash !== null });
			});
			return secret;
		},

		async holdsSecret(secretHash, given) {
			if (secretHash === null || given === null || given.length > CDN_SECRET_MAX_LENGTH) return false;
			return sameText(await hashToken(given), secretHash);
		},

		async refreshRanges() {
			const used = await database.db.selectDistinct({ cdn: sites.cdn }).from(sites).where(isNotNull(sites.cdn));
			for (const { cdn } of used) {
				if (!isCdnKey(cdn)) continue;
				try {
					const ranges = await fetchList(deps.fetch, cdn);
					const fetchedAt = clock.now();
					await database.db
						.insert(cdnRanges)
						.values({ cdn, ranges, fetchedAt })
						.onConflictDoUpdate({ target: cdnRanges.cdn, set: { ranges, fetchedAt } });
					log.info("Refreshed a CDN's address ranges", { cdn, ranges: ranges.length });
				} catch (error) {
					log.warn("Couldn't refresh a CDN's address ranges; the ones it had still count", { cdn, error });
				}
			}
		},
	};
}

/** The longest `CDN_SECRET_HEADER` value hashed: a secret is 43 characters. */
const CDN_SECRET_MAX_LENGTH = 200;

/** Fetches and checks a CDN's published list: its own host only, no redirect, 10 seconds, 256 KiB. */
async function fetchList(fetch: GuardedFetch, cdn: CdnKey): Promise<string[]> {
	const { list } = CDNS[cdn];
	const response = await fetch(new Request(list, { headers: { accept: "application/json" } }), {
		allowedHosts: [new URL(list).hostname],
		maxRedirects: 0,
		timeoutMs: 10_000,
		maxBytes: CDN_LIST_MAX_BYTES,
	});
	if (!response.ok) throw new Error(`The list answered ${response.status}.`);
	let answer: unknown;
	try {
		answer = await response.json();
	} catch {
		throw new Error("The list isn't JSON.");
	}
	return checkCdnList(cdn, answer);
}

/** Fetches the published lists of the CDNs Sites use. Not retried: tomorrow's run is the next try. */
export const cdnRefreshRanges = defineJob({
	name: "cdn.refresh-ranges",
	payload: z.object({}),
	queue: { retryLimit: 0 },
	run: (_payload, context) => context.cdns.refreshRanges(),
});

/** Every day at 03:17 UTC. */
export const cdnRefreshRangesSchedule = defineSchedule({ job: cdnRefreshRanges, cron: "17 3 * * *", payload: {} });
