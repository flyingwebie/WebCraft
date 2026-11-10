import { checkSchema, type Database, JOB_QUEUE_SCHEMA, type SchemaOptions } from "@webcraft/db";
import { moduleLog, siteDomains, sites, smtpHealth } from "@webcraft/db/schema";
import { and, eq, gte, isNotNull, like, sql } from "drizzle-orm";

import type { Backups } from "../backups/service.ts";
import type { DiskSpace } from "../disk.ts";
import type { InstallSmtp } from "../email/install-smtp.ts";
import type { ErrorLog } from "../error-log/service.ts";
import { checkBucket, type InstallStorage } from "../media/install-storage.ts";
import { WEBCRAFT_VERSION } from "../version.ts";
import type { Workers } from "../workers.ts";
import type { FailingReason, HealthPart, HealthStatus } from "./parts.ts";

/** Why a part is as it is: a reason code and its values, which the admin words. */
export type HealthReason = { code: string; data?: Record<string, unknown> };

/** One part of Install health as last worked out. */
export type HealthRowView = {
	part: HealthPart;
	status: HealthStatus;
	reason: HealthReason;
	checkedAt: Date;
	/** Since when it has been Failing; null while it isn't. */
	failingSince: Date | null;
};

export type CheckedPart = { status: HealthStatus; reason: HealthReason };

/**
 * The thresholds Install health works with:
 * - a job waiting `STUCK_AFTER_MS` past its time while a worker runs, or running that long past its
 *   expiry, is stuck (the job queue is Failing);
 * - a failed job in the last `RECENT_MS` makes the job queue a Warning;
 * - scheduled Backups run daily: none done for `BACKUP_LATE_MS` is a Warning, for `BACKUP_OVERDUE_MS`
 *   Failing;
 * - local storage is a Warning under 10% or 2 GB free, Failing under 1% or 256 MB;
 * - a new cause in the Error log, or a Module failure, in the last `RECENT_MS` is a Warning.
 */
export const HEALTH_LIMITS = {
	stuckAfterMs: 15 * 60_000,
	recentMs: 24 * 60 * 60_000,
	backupLateMs: 26 * 60 * 60_000,
	backupOverdueMs: 50 * 60 * 60_000,
	diskWarning: { share: 0.1, bytes: 2 * 1024 ** 3 },
	diskFailing: { share: 0.01, bytes: 256 * 1024 ** 2 },
} as const;

/** The Health alert reason a Failing part's email gives, from its reason code. */
export function failingReasonOf(part: CheckedPart): FailingReason {
	const code = part.reason.code;
	switch (code) {
		case "stale":
		case "never":
		case "behind":
		case "jobQueueNewer":
		case "stuck":
		case "unwritable":
		case "full":
		case "failed":
		case "overdue":
		case "failing":
			return code;
		default:
			return "unreachable";
	}
}

export type HealthCheckDeps = {
	database: Database;
	schema: SchemaOptions;
	workers: Workers;
	storage: InstallStorage;
	disk: DiskSpace;
	backups: Backups;
	installSmtp: InstallSmtp;
	errorLog: ErrorLog;
	now: Date;
};

/** The web process answering this request: always OK, with the version it runs. */
export function webPart(): CheckedPart {
	return { status: "ok", reason: { code: "answering", data: { version: WEBCRAFT_VERSION } } };
}

/** Whether a worker checked in within 2 minutes, and with this version. */
export async function workerPart({ workers }: Pick<HealthCheckDeps, "workers">): Promise<CheckedPart> {
	const status = await workers.status();
	const latest = status.latest;
	if (!latest) return { status: "failing", reason: { code: "never" } };
	const data = { hostname: latest.hostname, lastBeatAt: latest.beatAt.toISOString(), version: latest.version };
	if (!status.working) return { status: "failing", reason: { code: "stale", data } };
	if (latest.version !== WEBCRAFT_VERSION) {
		return { status: "warning", reason: { code: "otherVersion", data: { ...data, webVersion: WEBCRAFT_VERSION } } };
	}
	return { status: "ok", reason: { code: "working", data } };
}

/** Whether the database answers and has had every migration this version expects. */
export async function databasePart({ database, schema }: Pick<HealthCheckDeps, "database" | "schema">) {
	const check = await checkSchema(database, schema);
	switch (check.state) {
		case "current":
			return { status: "ok", reason: { code: "current" } } satisfies CheckedPart;
		case "behind":
			return {
				status: "failing",
				reason: { code: "behind", data: { pending: check.pendingMigrations.length } },
			} satisfies CheckedPart;
		case "job-queue-newer":
			return { status: "failing", reason: { code: "jobQueueNewer" } } satisfies CheckedPart;
		case "unreachable":
			return { status: "failing", reason: { code: "unreachable" } } satisfies CheckedPart;
	}
}

/** One queue's failed and stuck jobs. */
export type QueueTrouble = { queue: string; failed: number; stuck: number; waiting: number; lastFailedAt: Date | null };

/** Failed jobs (kept by the queue), and jobs stuck: waiting long past their time, or running long past their expiry. */
export async function queueTrouble(database: Database, now: Date, recentOnly: boolean): Promise<QueueTrouble[]> {
	const stuckBefore = new Date(now.getTime() - HEALTH_LIMITS.stuckAfterMs);
	const recentSince = new Date(now.getTime() - HEALTH_LIMITS.recentMs);
	const { rows } = await database.pool.query<{
		queue: string;
		failed: string;
		waiting: string;
		running: string;
		last_failed_at: Date | null;
	}>(
		`SELECT name AS queue,
			count(*) FILTER (WHERE state = 'failed' AND ($3::boolean IS FALSE OR completed_on >= $2)) AS failed,
			count(*) FILTER (WHERE state IN ('created', 'retry') AND NOT blocked AND start_after < $1) AS waiting,
			count(*) FILTER (WHERE state = 'active' AND started_on + make_interval(secs => expire_seconds) < $1) AS running,
			max(completed_on) FILTER (WHERE state = 'failed') AS last_failed_at
		FROM ${JOB_QUEUE_SCHEMA}.job
		WHERE state IN ('failed', 'created', 'retry', 'active')
		GROUP BY name`,
		[stuckBefore, recentSince, recentOnly],
	);
	return rows
		.map((row) => ({
			queue: row.queue,
			failed: Number(row.failed),
			waiting: Number(row.waiting),
			stuck: Number(row.waiting) + Number(row.running),
			lastFailedAt: row.last_failed_at,
		}))
		.filter((row) => row.failed > 0 || row.stuck > 0)
		.sort((a, b) => a.queue.localeCompare(b.queue));
}

/**
 * The job queue: Failing when jobs are stuck while a worker runs (when none runs, the worker part says
 * so, and waiting jobs are only a Warning here); a Warning when jobs failed in the last day.
 */
export async function jobQueuePart(
	{ database, now }: Pick<HealthCheckDeps, "database" | "now">,
	workerRuns: boolean,
): Promise<CheckedPart> {
	const trouble = await queueTrouble(database, now, true);
	const stuck = trouble.reduce((sum, queue) => sum + queue.stuck, 0);
	const failed = trouble.reduce((sum, queue) => sum + queue.failed, 0);
	const queues = trouble.map((queue) => queue.queue);
	if (stuck > 0) {
		return workerRuns
			? { status: "failing", reason: { code: "stuck", data: { stuck, failed, queues } } }
			: { status: "warning", reason: { code: "noWorker", data: { waiting: stuck, failed, queues } } };
	}
	if (failed > 0) return { status: "warning", reason: { code: "failed", data: { failed, queues } } };
	return { status: "ok", reason: { code: "clear" } };
}

/** Storage: a small file written, read back and removed where new files go; on local disk, the room left. */
export async function storagePart({ storage, disk }: Pick<HealthCheckDeps, "storage" | "disk">): Promise<CheckedPart> {
	const settings = await storage.settings();
	const kind = settings.kind;
	try {
		await checkBucket(await storage.current());
	} catch (error) {
		const problem = (error as { code?: unknown }).code;
		return {
			status: "failing",
			reason: { code: "unwritable", data: { kind, problem: typeof problem === "string" ? problem : null } },
		};
	}
	if (kind !== "disk") return { status: "ok", reason: { code: "writable", data: { kind } } };
	const room = await disk(settings.directory);
	if (!room || room.totalBytes <= 0) return { status: "ok", reason: { code: "writable", data: { kind } } };
	const data = { kind, freeBytes: room.freeBytes, totalBytes: room.totalBytes };
	const below = (limit: { share: number; bytes: number }) =>
		room.freeBytes < limit.bytes || room.freeBytes / room.totalBytes < limit.share;
	if (below(HEALTH_LIMITS.diskFailing)) return { status: "failing", reason: { code: "full", data } };
	if (below(HEALTH_LIMITS.diskWarning)) return { status: "warning", reason: { code: "lowSpace", data } };
	return { status: "ok", reason: { code: "writable", data } };
}

/** The last Backup, against its daily schedule, and whether the last one failed. */
export async function backupsPart({ backups, now }: Pick<HealthCheckDeps, "backups" | "now">): Promise<CheckedPart> {
	const [settings, status] = await Promise.all([backups.settings(), backups.status()]);
	const lastDoneAt = status.lastDone?.finishedAt ?? status.lastDone?.startedAt ?? null;
	const data = { lastDoneAt: lastDoneAt?.toISOString() ?? null, scheduled: settings.scheduled };
	if (status.failing && status.last) {
		return {
			status: "failing",
			reason: {
				code: "failed",
				data: { ...data, failedAt: (status.last.finishedAt ?? status.last.startedAt).toISOString() },
			},
		};
	}
	if (!settings.scheduled) return { status: "warning", reason: { code: "off", data } };
	if (!lastDoneAt) return { status: "warning", reason: { code: "never", data } };
	const age = now.getTime() - lastDoneAt.getTime();
	if (age > HEALTH_LIMITS.backupOverdueMs) return { status: "failing", reason: { code: "overdue", data } };
	if (age > HEALTH_LIMITS.backupLateMs) return { status: "warning", reason: { code: "late", data } };
	return { status: "ok", reason: { code: "recent", data } };
}

/**
 * Failing SMTP: the Install SMTP Failing is Failing (System emails wait); not set yet, or Sites' own
 * servers Failing (their Owners and Staff were told), a Warning.
 */
export async function smtpPart({ database, installSmtp }: Pick<HealthCheckDeps, "database" | "installSmtp">) {
	const install = await installSmtp.health();
	const failingSites = await database.db
		.select({ id: sites.id, name: sites.name, since: smtpHealth.failingSince })
		.from(smtpHealth)
		.innerJoin(sites, sql`${smtpHealth.smtp} = 'site:' || ${sites.id}::text`)
		.where(and(like(smtpHealth.smtp, "site:%"), isNotNull(smtpHealth.failingSince)))
		.orderBy(sites.name)
		.limit(20);
	const siteList = failingSites.map((site) => ({ id: site.id, name: site.name }));
	if (install.state === "failing") {
		return {
			status: "failing",
			reason: {
				code: "failing",
				data: {
					since: install.failingSince?.toISOString() ?? null,
					lastResponse: install.lastResponse,
					sites: siteList,
				},
			},
		} satisfies CheckedPart;
	}
	if (siteList.length > 0) {
		return { status: "warning", reason: { code: "sitesFailing", data: { sites: siteList } } } satisfies CheckedPart;
	}
	if (install.state === "not-set") return { status: "warning", reason: { code: "notSet" } } satisfies CheckedPart;
	return { status: "ok", reason: { code: "working" } } satisfies CheckedPart;
}

/** Problems found by the Domain check on the Install's side: it doesn't answer, or has no certificate. */
const INSTALL_SIDE = new Set(["unreachable", "certificate-missing"]);

/**
 * Domains: Failing when a verified domain points at the Install but the Install doesn't answer for it
 * or has no certificate for it; a Warning when one points elsewhere, answers something else, or its
 * certificate runs out within 14 days (the Site's Owners were told).
 */
export async function domainsPart({ database }: Pick<HealthCheckDeps, "database">): Promise<CheckedPart> {
	const rows = await database.db
		.select({
			name: siteDomains.name,
			problem: siteDomains.lastProblem,
			siteId: sites.id,
			siteName: sites.name,
			since: siteDomains.unreachableSince,
		})
		.from(siteDomains)
		.innerJoin(sites, eq(sites.id, siteDomains.siteId))
		.where(and(isNotNull(siteDomains.verifiedAt), isNotNull(siteDomains.unreachableSince)))
		.orderBy(siteDomains.name)
		.limit(100);
	if (rows.length === 0) return { status: "ok", reason: { code: "reachable" } };
	const domains = rows.slice(0, 10).map((row) => ({
		name: row.name,
		problem: row.problem,
		site: { id: row.siteId, name: row.siteName },
	}));
	const installSide = rows.filter((row) => INSTALL_SIDE.has(row.problem ?? ""));
	if (installSide.length > 0) {
		return { status: "failing", reason: { code: "unreachable", data: { count: rows.length, domains } } };
	}
	return { status: "warning", reason: { code: "elsewhere", data: { count: rows.length, domains } } };
}

/** The Error log: a Warning while causes first seen in the last day aren't marked resolved. */
export async function errorLogPart({ errorLog, now }: Pick<HealthCheckDeps, "errorLog" | "now">) {
	const count = await errorLog.newSince(new Date(now.getTime() - HEALTH_LIMITS.recentMs));
	return (
		count > 0
			? { status: "warning", reason: { code: "newCauses", data: { count } } }
			: { status: "ok", reason: { code: "quiet" } }
	) satisfies CheckedPart;
}

/** The Module log: a Warning when Modules failed in the last day. */
export async function moduleLogPart({ database, now }: Pick<HealthCheckDeps, "database" | "now">) {
	const [row] = await database.db
		.select({
			count: sql<number>`count(*)::int`,
			modules: sql<string[]>`coalesce(array_agg(distinct ${moduleLog.moduleId}), '{}')`,
		})
		.from(moduleLog)
		.where(
			and(eq(moduleLog.level, "error"), gte(moduleLog.occurredAt, new Date(now.getTime() - HEALTH_LIMITS.recentMs))),
		);
	const count = row?.count ?? 0;
	return (
		count > 0
			? { status: "warning", reason: { code: "failures", data: { count, modules: row?.modules ?? [] } } }
			: { status: "ok", reason: { code: "quiet" } }
	) satisfies CheckedPart;
}
