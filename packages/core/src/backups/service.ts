import type { Database } from "@webcraft/db";
import { backupSettings, backups } from "@webcraft/db/schema";
import type { AnyModuleDefinition } from "@webcraft/module-sdk";
import { and, desc, eq, isNull } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import type { InstallConfig } from "../config.ts";
import type { OutgoingHttp } from "../http.ts";
import type { Logger } from "../log.ts";
import { StorageUnreachableError } from "../media/errors.ts";
import { checkBucket } from "../media/install-storage.ts";
import { type S3Settings, s3Storage } from "../media/s3-storage.ts";
import { actingPerson } from "../permissions/can.ts";
import type { SecretDescription, Secrets } from "../secrets/store.ts";
import type { InstallScope } from "../tenancy/data-layer.ts";
import { backupsToRemove, type KeptBackup } from "./keep.ts";
import type { BackupReason } from "./manifest.ts";
import { BACKUP_S3_SECRET, readBackupSettingsRow, type TakenBackup, takeBackup, targetFor } from "./take.ts";
import type { BackupTargetKind } from "./targets.ts";

/** How many scheduled Backups are kept: the newest of each of the last 7 days and of each of the last 4 weeks. */
export const BACKUP_KEEP = { daily: 7, weekly: 4 } as const;

/** Install settings › Backups. */
export type BackupSettings = {
	/** Whether the worker takes a Backup every day. */
	scheduled: boolean;
	/** Where Backups go. */
	target: "folder" | "s3";
	/** The Backups folder (`WEBCRAFT_BACKUP_DIR`). */
	folder: string;
	/** The bucket, once one was set; kept when Backups go back to the folder. */
	s3: (S3Settings & { secretAccessKey: SecretDescription }) | null;
	keep: typeof BACKUP_KEEP;
	updatedAt: Date | null;
};

/**
 * A change to Install settings › Backups. A bucket gives every setting; `secretAccessKey` absent
 * keeps the one stored.
 */
export type BackupSettingsChange = {
	scheduled: boolean;
	target: { kind: "folder" } | ({ kind: "s3"; secretAccessKey?: string } & S3Settings);
};

/** One line of the Backup log. */
export type BackupRecord = {
	id: string;
	reason: BackupReason;
	target: BackupTargetKind;
	name: string;
	location: string;
	status: "running" | "done" | "failed";
	startedAt: Date;
	finishedAt: Date | null;
	sizeBytes: number | null;
	problem: string | null;
	/** When the keep rules removed it. */
	removedAt: Date | null;
};

/**
 * How Backups are doing, for the admin's notice and the Install's health (#86): the newest Backup
 * that ended, the newest that was written, and whether the newest that ended failed.
 */
export type BackupStatus = {
	last: BackupRecord | null;
	lastDone: BackupRecord | null;
	failing: boolean;
};

/** The Install's Backups: their setting, the Backup log, taking one and the keep rules. */
export type Backups = {
	settings(): Promise<BackupSettings>;
	/**
	 * Changes Install settings › Backups. A bucket is checked first (a small file is written, read and
	 * removed). Recorded in the Audit log, never with the secret. A Sensitive action
	 * (`backups.change`): open the Install with `install.manage` and check it first.
	 */
	change(scope: InstallScope, change: BackupSettingsChange): Promise<BackupSettings>;
	/** The Backup log, newest first. */
	list(options?: { limit?: number }): Promise<BackupRecord[]>;
	status(): Promise<BackupStatus>;
	/** Takes a Backup now, where the setting says (or into `to`). */
	take(options: { reason: BackupReason; to?: string }): Promise<TakenBackup>;
	/** Removes the scheduled Backups the keep rules don't keep; answers their names. */
	prune(): Promise<string[]>;
};

type Options = {
	config: InstallConfig;
	database: Database;
	secrets: Secrets;
	http: OutgoingHttp;
	clock: Clock;
	log: Logger;
	fingerprint: string;
	modules: readonly AnyModuleDefinition[];
};

export function createBackups(options: Options): Backups {
	const { config, database, secrets, http, clock, log } = options;
	const { db } = database;
	const context = {
		database,
		storageDir: config.storageDir,
		backupDir: config.backupDir,
		fingerprint: options.fingerprint,
		secrets,
		http,
		clock,
		log,
		modules: options.modules,
	};

	const settings = async (): Promise<BackupSettings> => {
		const row = await readBackupSettingsRow(database.pool);
		const [stored] = await db
			.select({ updatedAt: backupSettings.updatedAt })
			.from(backupSettings)
			.where(eq(backupSettings.id, 1));
		return {
			scheduled: row.scheduled,
			target: row.target,
			folder: config.backupDir,
			s3: row.s3 ? { ...row.s3, secretAccessKey: await secrets.describe(BACKUP_S3_SECRET) } : null,
			keep: BACKUP_KEEP,
			updatedAt: stored?.updatedAt ?? null,
		};
	};

	const list = async (listOptions: { limit?: number } = {}): Promise<BackupRecord[]> => {
		const rows = await db
			.select()
			.from(backups)
			.orderBy(desc(backups.startedAt), desc(backups.id))
			.limit(listOptions.limit ?? 50);
		return rows.map(record);
	};

	return {
		settings,
		list,

		async change(scope, change) {
			const personId = actingPerson(scope.access.actor);
			const now = clock.now();
			const values: Partial<typeof backupSettings.$inferInsert> = {
				scheduled: change.scheduled,
				target: change.target.kind,
				updatedAt: now,
				updatedBy: personId,
			};
			const { target } = change;
			let secret: string | undefined;
			if (target.kind === "s3") {
				const { kind: _, secretAccessKey, ...s3 } = target;
				secret = secretAccessKey;
				if (secret === undefined && !(await secrets.describe(BACKUP_S3_SECRET)).set) {
					throw new StorageUnreachableError("Give the bucket's secret access key.");
				}
				// The same check Media storage makes, in the folder Backups use.
				await checkBucket(
					s3Storage({
						settings: s3,
						http,
						clock,
						withSecret: (use) => (secret === undefined ? secrets.useWith(BACKUP_S3_SECRET, use) : use(secret)),
					}),
				);
				Object.assign(values, {
					s3Endpoint: s3.endpoint,
					s3Region: s3.region,
					s3Bucket: s3.bucket,
					s3Prefix: s3.prefix,
					s3PathStyle: s3.pathStyle,
					s3AccessKeyId: s3.accessKeyId,
				});
			}
			await scope.transaction(async (tx) => {
				await tx.db
					.insert(backupSettings)
					.values({ id: 1, ...values })
					.onConflictDoUpdate({ target: backupSettings.id, set: values });
				const { kind: _, ...details } = target as { kind: string; secretAccessKey?: string };
				await tx.audit("backups.change", {
					scheduled: change.scheduled,
					target: target.kind,
					...(target.kind === "s3" ? { ...details, secretAccessKey: secret === undefined ? "kept" : "replaced" } : {}),
				});
			});
			if (secret !== undefined) await secrets.set(BACKUP_S3_SECRET, secret);
			log.info("Install settings › Backups changed", { personId, scheduled: change.scheduled, target: target.kind });
			return settings();
		},

		async status() {
			const recent = await list({ limit: 200 });
			const last = recent.find((entry) => entry.status !== "running") ?? null;
			const lastDone = recent.find((entry) => entry.status === "done") ?? null;
			return { last, lastDone, failing: last?.status === "failed" };
		},

		take: (takeOptions) => takeBackup(context, takeOptions),

		async prune() {
			const kept: KeptBackup[] = (
				await db
					.select({ id: backups.id, name: backups.name, target: backups.target, at: backups.startedAt })
					.from(backups)
					.where(and(eq(backups.reason, "scheduled"), eq(backups.status, "done"), isNull(backups.removedAt)))
			).map((row) => ({ id: row.id, name: row.name, target: row.target as BackupTargetKind, at: row.at }));
			const removed: string[] = [];
			const row = await readBackupSettingsRow(database.pool);
			for (const backup of backupsToRemove(kept, BACKUP_KEEP)) {
				if (backup.target !== "folder" && backup.target !== "s3") continue;
				try {
					await targetFor(context, backup.target, row.s3).remove(backup.name);
				} catch (error) {
					log.warn("A Backup the keep rules no longer keep couldn't be removed", { name: backup.name, error });
					continue;
				}
				await db.update(backups).set({ removedAt: clock.now() }).where(eq(backups.id, backup.id));
				removed.push(backup.name);
			}
			if (removed.length > 0) log.info("Removed Backups the keep rules no longer keep", { removed });
			return removed;
		},
	};
}

function record(row: typeof backups.$inferSelect): BackupRecord {
	return {
		id: row.id,
		reason: row.reason as BackupReason,
		target: row.target as BackupTargetKind,
		name: row.name,
		location: row.location,
		status: row.status as BackupRecord["status"],
		startedAt: row.startedAt,
		finishedAt: row.finishedAt,
		sizeBytes: row.sizeBytes,
		problem: row.problem,
		removedAt: row.removedAt,
	};
}
