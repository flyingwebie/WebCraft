import type { Database } from "@webcraft/db";
import { updateChecks } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";
import semver from "semver";
import { z } from "zod";

import type { Clock } from "./clock.ts";
import { type GuardedFetch, GuardedFetchError } from "./guarded-fetch.ts";
import { defineJob } from "./jobs/define.ts";
import { defineSchedule } from "./jobs/schedules.ts";
import type { Logger } from "./log.ts";
import { WEBCRAFT_VERSION } from "./version.ts";

/**
 * The update check: the newest WebCraft release, read from a public release feed
 * (`WEBCRAFT_UPDATE_FEED`, the project's latest-release JSON on GitHub unless set, `off` to turn it
 * off). The request carries nothing about the Install: a plain `User-Agent: WebCraft`, no id, no
 * version, no query added. The worker checks once a day; `webcraft admin check-update` checks at
 * once; the admin's "Update available" notice reads the last result and never calls out itself.
 */
export type Updates = {
	/** The last check's result. */
	latest(): Promise<UpdateCheck>;
	/**
	 * Reads the feed now and keeps the result. With `onlyIfDue`, it doesn't when the last check is
	 * less than a day old.
	 */
	check(options?: { onlyIfDue?: boolean }): Promise<UpdateCheck>;
};

/** A release the feed listed. */
export type Release = { version: string; url: string | null; notes: string; publishedAt: Date | null };

export type UpdateCheck = {
	/** This build's version. */
	running: string;
	/** Off when `WEBCRAFT_UPDATE_FEED=off`. */
	enabled: boolean;
	/** When the feed was last read, or null before the first check. */
	checkedAt: Date | null;
	/** The newest release the last check found. */
	latest: Release | null;
	/** Whether that release is newer than this build. */
	updateAvailable: boolean;
	/** Why the last check couldn't read the feed (`unreachable`, `timeout`, `status`, `format`, …). */
	problem: string | null;
};

/** How long a check stays fresh. */
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** The most of the release notes kept and shown. */
const NOTES_MAX_LENGTH = 4000;

/** What every request to the feed says it is: nothing more. */
const USER_AGENT = "WebCraft";

export function createUpdates(options: {
	database: Database;
	feed: string | null;
	fetch: GuardedFetch;
	clock: Clock;
	log: Logger;
}): Updates {
	const { database, feed, fetch, clock, log } = options;
	const { db } = database;

	const latest = async (): Promise<UpdateCheck> => {
		const [row] = await db.select().from(updateChecks).where(eq(updateChecks.id, 1));
		const release: Release | null = row?.latestVersion
			? {
					version: row.latestVersion,
					url: row.releaseUrl,
					notes: row.notes ?? "",
					publishedAt: row.publishedAt,
				}
			: null;
		return {
			running: WEBCRAFT_VERSION,
			enabled: feed !== null,
			checkedAt: row?.checkedAt ?? null,
			latest: release,
			updateAvailable: feed !== null && release !== null && isNewer(release.version, WEBCRAFT_VERSION),
			problem: row?.problem ?? null,
		};
	};

	return {
		latest,
		async check(checkOptions = {}) {
			if (feed === null) return latest();
			const before = await latest();
			if (
				checkOptions.onlyIfDue &&
				before.checkedAt &&
				clock.now().getTime() - before.checkedAt.getTime() < UPDATE_CHECK_INTERVAL_MS - 60 * 60 * 1000
			) {
				return before;
			}
			const now = clock.now();
			let release: Release | null = null;
			let problem: string | null = null;
			try {
				release = await readFeed(fetch, feed);
			} catch (error) {
				problem =
					error instanceof GuardedFetchError ? error.problem : error instanceof FeedError ? error.problem : "error";
				log.warn("The update check couldn't read the release feed", { feed, problem, error });
			}
			// A failed check keeps the release found before, so the notice doesn't come and go.
			const values = release
				? {
						checkedAt: now,
						latestVersion: release.version,
						releaseUrl: release.url,
						notes: release.notes,
						publishedAt: release.publishedAt,
						problem: null,
					}
				: { checkedAt: now, problem };
			await db
				.insert(updateChecks)
				.values({ id: 1, ...values })
				.onConflictDoUpdate({ target: updateChecks.id, set: values });
			return latest();
		},
	};
}

/** The feed answered something that isn't a release. */
class FeedError extends Error {
	override name = "FeedError";
	readonly problem: "status" | "format";
	constructor(problem: "status" | "format") {
		super(`The release feed's answer can't be read (${problem}).`);
		this.problem = problem;
	}
}

/** A release as GitHub's API gives it (`/releases/latest`, or the list `/releases`). */
const githubRelease = z.object({
	tag_name: z.string(),
	html_url: z.string().nullish(),
	body: z.string().nullish(),
	published_at: z.string().nullish(),
	draft: z.boolean().optional(),
	prerelease: z.boolean().optional(),
});

/** A release as a static file of one's own gives it. */
const plainRelease = z.object({
	version: z.string(),
	url: z.string().nullish(),
	notes: z.string().nullish(),
	publishedAt: z.string().nullish(),
});

async function readFeed(fetch: GuardedFetch, feed: string): Promise<Release> {
	const request = new Request(feed, { headers: { "user-agent": USER_AGENT, accept: "application/json" } });
	const response = await fetch(request, {
		allowedHosts: [new URL(feed).hostname],
		timeoutMs: 10_000,
		maxBytes: 2 * 1024 * 1024,
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new FeedError("status");
	}
	let json: unknown;
	try {
		json = await response.json();
	} catch {
		throw new FeedError("format");
	}
	const candidates = Array.isArray(json) ? json : [json];
	for (const candidate of candidates) {
		const github = githubRelease.safeParse(candidate);
		if (github.success) {
			if (github.data.draft || github.data.prerelease) continue;
			return release(github.data.tag_name, github.data.html_url, github.data.body, github.data.published_at);
		}
		const plain = plainRelease.safeParse(candidate);
		if (plain.success) return release(plain.data.version, plain.data.url, plain.data.notes, plain.data.publishedAt);
	}
	throw new FeedError("format");
}

function release(
	tag: string,
	url: string | null | undefined,
	notes: string | null | undefined,
	publishedAt: string | null | undefined,
): Release {
	const version = semver.valid(semver.clean(tag) ?? tag);
	if (!version) throw new FeedError("format");
	const published = publishedAt ? new Date(publishedAt) : null;
	return {
		version,
		url: url && /^https:\/\//.test(url) ? url : null,
		notes: (notes ?? "").replace(/\r\n?/g, "\n").trim().slice(0, NOTES_MAX_LENGTH),
		publishedAt: published && !Number.isNaN(published.getTime()) ? published : null,
	};
}

/** Whether `candidate` is a newer version than `running` (a development build that isn't a version never is behind). */
function isNewer(candidate: string, running: string): boolean {
	return semver.valid(candidate) !== null && semver.valid(running) !== null && semver.gt(candidate, running);
}

/** The daily update check (05:29 UTC), in the worker. */
export const updatesCheck = defineJob({
	name: "updates.check",
	payload: z.object({}),
	queue: { retryLimit: 0, expireInSeconds: 300 },
	async run(_payload, { updates }) {
		await updates.check({ onlyIfDue: true });
	},
});

export const updatesCheckSchedule = defineSchedule({ job: updatesCheck, cron: "29 5 * * *", payload: {} });
