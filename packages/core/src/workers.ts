import type { Database } from "@webcraft/db";
import { workerHeartbeats } from "@webcraft/db/schema";
import { desc, eq, lt } from "drizzle-orm";

import type { Clock } from "./clock.ts";
import type { Logger } from "./log.ts";
import { WEBCRAFT_VERSION } from "./version.ts";

/** How often a worker checks in while it runs. */
export const WORKER_BEAT_MS = 30_000;

/** A worker that checked in within this long is working; past it, it is taken for stopped. */
export const WORKER_FRESH_MS = 2 * 60_000;

/** Rows of workers that stopped without saying so are deleted once they are this old. */
const STALE_ROWS_MS = 24 * 60 * 60_000;

/** A worker as it last checked in. */
export type WorkerCheckIn = { hostname: string; version: string; startedAt: Date; beatAt: Date };

/** Whether a worker works the job queue now: the newest check-in and whether it is fresh. */
export type WorkersStatus = { working: boolean; latest: WorkerCheckIn | null; workers: WorkerCheckIn[] };

/**
 * The workers working the job queue: each checks in every `WORKER_BEAT_MS` while it runs
 * (`startWorkerHeartbeat`), so a server command and the Install's health can tell whether one runs.
 */
export type Workers = {
	/** Records that a worker runs, now. */
	beat(worker: { id: string; hostname: string; startedAt: Date }): Promise<void>;
	/** A worker stopped: it no longer counts. */
	stopped(id: string): Promise<void>;
	/** The workers that checked in, newest first, and whether one did within `WORKER_FRESH_MS`. */
	status(): Promise<WorkersStatus>;
};

export function createWorkers({ database, clock }: { database: Database; clock: Clock }): Workers {
	const { db } = database;
	return {
		async beat({ id, hostname, startedAt }) {
			const now = clock.now();
			await db
				.insert(workerHeartbeats)
				.values({ id, hostname, version: WEBCRAFT_VERSION, startedAt, beatAt: now })
				.onConflictDoUpdate({ target: workerHeartbeats.id, set: { beatAt: now } });
			await db.delete(workerHeartbeats).where(lt(workerHeartbeats.beatAt, new Date(now.getTime() - STALE_ROWS_MS)));
		},
		async stopped(id) {
			await db.delete(workerHeartbeats).where(eq(workerHeartbeats.id, id));
		},
		async status() {
			const rows = await db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.beatAt)).limit(20);
			const workers = rows.map(({ hostname, version, startedAt, beatAt }) => ({
				hostname,
				version,
				startedAt,
				beatAt,
			}));
			const latest = workers[0] ?? null;
			return {
				working: latest !== null && clock.now().getTime() - latest.beatAt.getTime() <= WORKER_FRESH_MS,
				latest,
				workers,
			};
		},
	};
}

/**
 * Checks this worker process in now and every `WORKER_BEAT_MS` until `stop` (which also says it
 * stopped). A failed check-in is logged and tried again next time.
 */
export async function startWorkerHeartbeat(
	workers: Workers,
	{ hostname, log, clock }: { hostname: string; log: Logger; clock: Clock },
): Promise<{ stop(): Promise<void> }> {
	const id = crypto.randomUUID();
	const startedAt = clock.now();
	const beat = () =>
		workers.beat({ id, hostname, startedAt }).catch((error: unknown) => {
			log.warn("The worker couldn't check in", { error });
		});
	await beat();
	const timer = setInterval(() => void beat(), WORKER_BEAT_MS);
	timer.unref?.();
	return {
		async stop() {
			clearInterval(timer);
			await workers.stopped(id).catch(() => undefined);
		},
	};
}
