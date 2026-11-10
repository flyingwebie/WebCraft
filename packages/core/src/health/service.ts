import { type Database, JOB_QUEUE_SCHEMA, type SchemaOptions } from "@webcraft/db";
import { healthRows, installRoles } from "@webcraft/db/schema";
import { eq, sql } from "drizzle-orm";

import type { Backups } from "../backups/service.ts";
import type { Clock } from "../clock.ts";
import type { DiskSpace } from "../disk.ts";
import type { Email } from "../email/index.ts";
import type { ErrorLog } from "../error-log/service.ts";
import type { JobQueue } from "../jobs/define.ts";
import { type Logger, withoutLogContext } from "../log.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import { SUPERADMIN_ROLE } from "../permissions/roles.ts";
import { redactText } from "../redaction.ts";
import type { InstallScope } from "../tenancy/data-layer.ts";
import type { Workers } from "../workers.ts";
import {
	backupsPart,
	type CheckedPart,
	databasePart,
	domainsPart,
	errorLogPart,
	failingReasonOf,
	type HealthCheckDeps,
	type HealthRowView,
	jobQueuePart,
	moduleLogPart,
	type QueueTrouble,
	queueTrouble,
	smtpPart,
	storagePart,
	webPart,
	workerPart,
} from "./checks.ts";
import { HEALTH_PARTS, type HealthPart, INSTALL_HEALTH_PATH } from "./parts.ts";

/**
 * Install health (`GLOSSARY.md`): every part of the Install, OK, Warning or Failing with a short
 * reason, worked out by the worker's `health.check` job every minute (and when the Install health
 * screen opens, or by the web process when the worker's checks stopped), and stored, so the admin
 * reads it without working it out on every page.
 *
 * Health alerts (`GLOSSARY.md`), worked out with each check, against flapping:
 * - a part Failing for `ALERT_AFTER_MS` (5 minutes) sends the `health-failing` System email to the
 *   Superadmin, once; one that fails and recovers within it sends nothing;
 * - an alerted part that has not been Failing for `RECOVERED_AFTER_MS` (15 minutes) sends
 *   `health-recovered`, once; failing again meanwhile continues the same alert, with no new email.
 * Both go out at once from the process that finds them (the worker may be what is failing) and can't
 * be turned off. The web part is never stored: whoever reads it is talking to a web process.
 */

/** How long a part is Failing before a Health alert goes out. */
export const ALERT_AFTER_MS = 5 * 60_000;

/** How long an alerted part works again before the "it works again" Health alert goes out. */
export const RECOVERED_AFTER_MS = 15 * 60_000;

/** A stored check older than this means the worker's minute check isn't running: the web process checks instead. */
export const STALE_CHECK_MS = 2 * 60_000;

/** Who worked a check out: the worker's job, the web process standing in for it, or the screen. */
export type HealthCheckBy = "worker" | "web" | "screen";

/** Install health as the screen shows it: every part, in order, and when it was last worked out. */
export type HealthReport = { parts: HealthRowView[]; checkedAt: Date | null };

/** One failed job, as the screen lists it: never its payload, which can hold an email or a form's answers. */
export type FailedJob = {
	id: string;
	queue: string;
	failedAt: Date | null;
	createdAt: Date;
	attempts: number;
	error: { name: string | null; message: string | null };
};

/** A queue with failed or stuck jobs, and its newest failed jobs. */
export type QueueView = QueueTrouble & { jobs: FailedJob[] };

export type InstallHealth = {
	/** Works out every part now, stores it and sends the Health alerts that are due. */
	check(by: HealthCheckBy): Promise<HealthReport>;
	/** What was last worked out, with the web part as it is now. */
	read(): Promise<HealthReport>;
	/** Checks when the stored check is older than `STALE_CHECK_MS` (the web process, while the worker's stopped). */
	checkIfStale(): Promise<void>;
	/** The parts Failing now, for the admin's banner: the stored ones, and the worker as its check-ins say now. */
	failing(): Promise<HealthPart[]>;
	/** Every queue with failed or stuck jobs, and the newest `perQueue` failed jobs of each. */
	queues(perQueue: number): Promise<QueueView[]>;
	/** Tries failed jobs again: the ones named, or every failed job of the queue. Recorded in the Audit log. */
	retry(scope: InstallScope, target: JobTarget): Promise<number>;
	/** Deletes failed jobs for good: the ones named, or every failed job of the queue. Recorded in the Audit log. */
	discard(scope: InstallScope, target: JobTarget): Promise<number>;
};

/** Failed jobs to act on: some of one queue, or all of it. */
export type JobTarget = { queue: string; jobIds: readonly string[] | "all" };

/** The queue named isn't one WebCraft has. */
export class JobQueueNotFoundError extends Error {
	override name = "JobQueueNotFoundError";
	constructor(queue: string) {
		super(`There is no job queue named ${queue}.`);
	}
}

export function createInstallHealth(deps: {
	database: Database;
	clock: Clock;
	log: Logger;
	schema: SchemaOptions;
	workers: Workers;
	storage: InstallStorage;
	disk: DiskSpace;
	backups: Backups;
	email: Email;
	errorLog: ErrorLog;
	jobs: JobQueue;
	/** The queues WebCraft has (every job's name). */
	queueNames: readonly string[];
}): InstallHealth {
	const { database, clock, log } = deps;
	const { db } = database;

	const read = async (): Promise<HealthReport> => {
		const rows = await db.select().from(healthRows);
		const stored = new Map(rows.map((row) => [row.part, row]));
		const now = clock.now();
		const parts = HEALTH_PARTS.map((part): HealthRowView => {
			if (part === "web") return { part, ...webPart(), checkedAt: now, failingSince: null };
			const row = stored.get(part);
			return row
				? {
						part,
						status: row.status as HealthRowView["status"],
						reason: row.reason as HealthRowView["reason"],
						checkedAt: row.checkedAt,
						failingSince: row.status === "failing" ? row.failingSince : null,
					}
				: { part, status: "warning", reason: { code: "unchecked" }, checkedAt: now, failingSince: null };
		});
		const checkedAt = rows.reduce<Date | null>(
			(latest, row) => (!latest || row.checkedAt > latest ? row.checkedAt : latest),
			null,
		);
		return { parts, checkedAt };
	};

	/** Works out every stored part, each on its own: one that breaks is Failing, not the whole check. */
	const workOut = async (): Promise<Map<HealthPart, CheckedPart>> => {
		const now = clock.now();
		const checks: HealthCheckDeps = {
			database,
			schema: deps.schema,
			workers: deps.workers,
			storage: deps.storage,
			disk: deps.disk,
			backups: deps.backups,
			installSmtp: deps.email.installSmtp,
			errorLog: deps.errorLog,
			now,
		};
		const guarded = async (part: HealthPart, work: () => Promise<CheckedPart>): Promise<CheckedPart> => {
			try {
				return await work();
			} catch (error) {
				log.warn("A part of Install health couldn't be checked", { part, error });
				return { status: "failing", reason: { code: "unchecked" } };
			}
		};
		const worker = await guarded("worker", () => workerPart(checks));
		const results = await Promise.all([
			guarded("database", () => databasePart(checks)),
			guarded("jobQueue", () => jobQueuePart(checks, worker.status !== "failing")),
			guarded("storage", () => storagePart(checks)),
			guarded("backups", () => backupsPart(checks)),
			guarded("smtp", () => smtpPart(checks)),
			guarded("domains", () => domainsPart(checks)),
			guarded("errorLog", () => errorLogPart(checks)),
			guarded("moduleLog", () => moduleLogPart(checks)),
		]);
		const [database_, jobQueue, storage, backups, smtp, domains, errorLog, moduleLog] = results as [
			CheckedPart,
			CheckedPart,
			CheckedPart,
			CheckedPart,
			CheckedPart,
			CheckedPart,
			CheckedPart,
			CheckedPart,
		];
		return new Map<HealthPart, CheckedPart>([
			["worker", worker],
			["database", database_],
			["jobQueue", jobQueue],
			["storage", storage],
			["backups", backups],
			["smtp", smtp],
			["domains", domains],
			["errorLog", errorLog],
			["moduleLog", moduleLog],
		]);
	};

	/** Stores a check and works out which Health alerts are due, one check at a time across processes. */
	const store = async (checked: Map<HealthPart, CheckedPart>) => {
		const now = clock.now();
		const failing: { part: HealthPart; checked: CheckedPart }[] = [];
		const recovered: { part: HealthPart; failedMinutes: number }[] = [];
		await db.transaction(async (tx) => {
			await tx.execute(sql`select pg_advisory_xact_lock(hashtext('webcraft.install-health'))`);
			const before = new Map((await tx.select().from(healthRows)).map((row) => [row.part, row]));
			for (const [part, result] of checked) {
				const previous = before.get(part);
				const isFailing = result.status === "failing";
				let failingSince = previous?.failingSince ?? null;
				let clearSince = previous?.clearSince ?? null;
				let alertedAt = previous?.alertedAt ?? null;
				if (isFailing) {
					failingSince ??= now;
					clearSince = null;
					if (!alertedAt && now.getTime() - failingSince.getTime() >= ALERT_AFTER_MS) {
						alertedAt = now;
						failing.push({ part, checked: result });
					}
				} else if (alertedAt) {
					// Alerted: the episode lasts (and its start is kept) until it has worked for a while.
					clearSince ??= now;
					if (now.getTime() - clearSince.getTime() >= RECOVERED_AFTER_MS) {
						const from = failingSince ?? alertedAt;
						recovered.push({
							part,
							failedMinutes: Math.max(0, Math.round((clearSince.getTime() - from.getTime()) / 60_000)),
						});
						alertedAt = null;
						clearSince = null;
						failingSince = null;
					}
				} else {
					// Not alerted: a short failure ends without an email.
					failingSince = null;
					clearSince = null;
				}
				const values = {
					status: result.status,
					reason: result.reason,
					checkedAt: now,
					failingSince,
					clearSince,
					alertedAt,
				};
				await tx
					.insert(healthRows)
					.values({ part, ...values })
					.onConflictDoUpdate({ target: healthRows.part, set: values });
			}
		});
		return { failing, recovered };
	};

	/** Sends the Health alerts that are due to every Superadmin, at once from this process. */
	const alert = async (due: Awaited<ReturnType<typeof store>>) => {
		if (due.failing.length === 0 && due.recovered.length === 0) return;
		const superadmins = await db
			.select({ personId: installRoles.personId })
			.from(installRoles)
			.where(eq(installRoles.role, SUPERADMIN_ROLE));
		if (superadmins.length === 0) return;
		const to = superadmins.map(({ personId }) => ({ personId }));
		if (due.failing.length > 0) {
			await deps.email.send({
				type: "health-failing",
				to,
				now: true,
				data: {
					parts: due.failing.map(({ part, checked }) => ({ part, reason: failingReasonOf(checked) })),
					healthPath: INSTALL_HEALTH_PATH,
				},
			});
			log.warn("Parts of the Install are failing: the Superadmin was sent a Health alert", {
				parts: due.failing.map(({ part }) => part),
			});
		}
		if (due.recovered.length > 0) {
			await deps.email.send({
				type: "health-recovered",
				to,
				now: true,
				data: { parts: due.recovered, healthPath: INSTALL_HEALTH_PATH },
			});
			log.info("Parts of the Install work again: the Superadmin was sent a Health alert", {
				parts: due.recovered.map(({ part }) => part),
			});
		}
	};

	const check = async (by: HealthCheckBy): Promise<HealthReport> => {
		// The process's own work, whoever asked: its lines and alert emails name no request.
		await withoutLogContext(async () => {
			const due = await store(await workOut());
			await alert(due);
		});
		const report = await read();
		log.debug("Install health was worked out", { by });
		return report;
	};

	const knownQueue = (queue: string) => {
		if (!deps.queueNames.includes(queue)) throw new JobQueueNotFoundError(queue);
	};

	/** The failed jobs a target names that are failed now. */
	const failedIds = async (target: JobTarget): Promise<string[]> => {
		const { rows } = await database.pool.query<{ id: string }>(
			`SELECT id FROM ${JOB_QUEUE_SCHEMA}.job WHERE name = $1 AND state = 'failed'${
				target.jobIds === "all" ? "" : " AND id = ANY($2::uuid[])"
			}`,
			target.jobIds === "all" ? [target.queue] : [target.queue, [...target.jobIds]],
		);
		return rows.map((row) => row.id);
	};

	return {
		check,
		read,

		async checkIfStale() {
			const [row] = await db.select({ at: sql<Date | null>`max(${healthRows.checkedAt})` }).from(healthRows);
			const at = row?.at ? new Date(row.at) : null;
			if (at && clock.now().getTime() - at.getTime() < STALE_CHECK_MS) return;
			await check("web");
		},

		async failing() {
			const rows = await db.select({ part: healthRows.part }).from(healthRows).where(eq(healthRows.status, "failing"));
			const parts = new Set(rows.map((row) => row.part as HealthPart));
			// Between checks, the worker's check-ins say at once whether it stopped.
			const worker = await workerPart(deps);
			if (worker.status === "failing") parts.add("worker");
			else if (parts.has("worker")) parts.delete("worker");
			return HEALTH_PARTS.filter((part) => parts.has(part));
		},

		async queues(perQueue) {
			const trouble = await queueTrouble(database, clock.now(), false);
			if (trouble.length === 0) return [];
			const { rows } = await database.pool.query<{
				id: string;
				queue: string;
				failed_at: Date | null;
				created_at: Date;
				attempts: number;
				output: { name?: unknown; message?: unknown } | null;
			}>(
				`SELECT id, name AS queue, completed_on AS failed_at, created_on AS created_at,
					retry_count + 1 AS attempts, output
				FROM (
					SELECT *, row_number() OVER (PARTITION BY name ORDER BY completed_on DESC NULLS LAST, id) AS n
					FROM ${JOB_QUEUE_SCHEMA}.job WHERE state = 'failed'
				) failed
				WHERE n <= $1
				ORDER BY name, failed_at DESC NULLS LAST`,
				[perQueue],
			);
			return trouble.map((queue) => ({
				...queue,
				jobs: rows
					.filter((row) => row.queue === queue.queue)
					.map((row) => ({
						id: row.id,
						queue: row.queue,
						failedAt: row.failed_at,
						createdAt: row.created_at,
						attempts: Number(row.attempts),
						error: {
							name: typeof row.output?.name === "string" ? row.output.name.slice(0, 200) : null,
							message: typeof row.output?.message === "string" ? redactText(row.output.message).slice(0, 1000) : null,
						},
					})),
			}));
		},

		async retry(scope, target) {
			knownQueue(target.queue);
			if (!deps.jobs.retry) throw new Error("This process can't act on the job queue.");
			const ids = await failedIds(target);
			const retried = await deps.jobs.retry(target.queue, ids);
			await scope.audit("job.retry", {
				queue: target.queue,
				jobs: target.jobIds === "all" ? "all" : ids,
				count: retried,
			});
			return retried;
		},

		async discard(scope, target) {
			knownQueue(target.queue);
			if (!deps.jobs.discard) throw new Error("This process can't act on the job queue.");
			const ids = await failedIds(target);
			const discarded = await deps.jobs.discard(target.queue, ids);
			await scope.audit("job.discard", {
				queue: target.queue,
				jobs: target.jobIds === "all" ? "all" : ids,
				count: discarded,
			});
			return discarded;
		},
	};
}
