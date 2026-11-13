import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Database, lastMigratedVersion, readMigrationLevel } from "@webcraft/db";
import { type AnyModuleDefinition, SDK_VERSION } from "@webcraft/module-sdk";
import type pg from "pg";

import type { Clock } from "../clock.ts";
import type { OutgoingHttp } from "../http.ts";
import type { Logger } from "../log.ts";
import type { S3Settings } from "../media/s3-storage.ts";
import type { Secrets } from "../secrets/store.ts";
import { WEBCRAFT_VERSION } from "../version.ts";
import { dumpDatabase, readDumpFile } from "./dump.ts";
import { FILES_FOLDER, listLocalFiles, localVariantKeys, openLocalFile } from "./files.ts";
import {
	BACKUP_FORMAT,
	BACKUP_FORMAT_VERSION,
	type BackupManifest,
	type BackupReason,
	MANIFEST_PATH,
} from "./manifest.ts";
import { type TarInput, writeTar } from "./tar.ts";
import { type BackupTarget, type BackupTargetKind, fileTarget, folderTarget, s3Target } from "./targets.ts";

/** The bucket's secret access key for Backups: a secret of the Install. */
export const BACKUP_S3_SECRET = { owner: { kind: "install" }, name: "backups.s3.secretAccessKey" } as const;

/**
 * What taking a Backup needs. Built by the worker (the scheduled Backup), `webcraft admin backup`
 * and the migrate step, which takes one on a database a newer WebCraft hasn't migrated yet: so a
 * Backup reads the database through its catalog, never through tables this build added.
 */
export type BackupContext = {
	database: Database;
	/** Local storage (`WEBCRAFT_STORAGE_DIR`). */
	storageDir: string;
	/** The Backups folder (`WEBCRAFT_BACKUP_DIR`). */
	backupDir: string;
	/** The running Master key's fingerprint (ADR 0032): the Install's current key. */
	fingerprint: string;
	/** The Install's secrets, for the bucket's secret access key. */
	secrets: Pick<Secrets, "useWith">;
	http: OutgoingHttp;
	clock: Clock;
	log: Logger;
	/** The Modules of this build, whose versions the manifest lists. */
	modules: readonly AnyModuleDefinition[];
};

/** A Backup that was written. */
export type TakenBackup = {
	/** Its line in the Backup log, or null when the database has no log yet (before migrations). */
	id: string | null;
	name: string;
	target: BackupTargetKind;
	location: string;
	sizeBytes: number;
	manifest: BackupManifest;
};

/** Another Backup is being taken right now. */
export class BackupBusyError extends Error {
	override name = "BackupBusyError";
}

/** A Backup failed; the Backup log says why. */
export class BackupFailedError extends Error {
	override name = "BackupFailedError";
}

/** Install settings › Backups, as a Backup reads them: defaults on a database without the setting yet. */
export type BackupSettingsRow = {
	scheduled: boolean;
	target: "folder" | "s3";
	s3: S3Settings | null;
};

/** Only one Backup is taken at a time, in every process. */
const BACKUP_LOCK = "webcraft backup";

/**
 * Takes a Backup (ADR 0032): one archive holding a consistent dump of the database, the files of
 * local storage but Media variants, and a manifest with versions and the Master key's fingerprint.
 * It goes where Install settings › Backups says, or to `to` (a file or folder) when given, and is
 * recorded in the Backup log, a failure with why.
 */
export async function takeBackup(
	context: BackupContext,
	options: { reason: BackupReason; to?: string },
): Promise<TakenBackup> {
	const { database, clock, log } = context;
	const lock = await database.pool.connect();
	try {
		const { rows } = await lock.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [
			BACKUP_LOCK,
		]);
		if (!rows[0]?.locked) throw new BackupBusyError("Another Backup is being taken right now. Try again once it ends.");
		try {
			const target = options.to ? await fileTarget(options.to) : await configuredTarget(context);
			const name = archiveName(clock.now(), options.reason);
			const id = await logStart(database.pool, { reason: options.reason, target, name, at: clock.now() });
			try {
				const { sizeBytes, manifest } = await writeBackup(context, options.reason, target, name);
				await logEnd(database.pool, id, { status: "done", at: clock.now(), sizeBytes });
				log.info("Took a Backup", {
					reason: options.reason,
					location: target.location(name),
					sizeBytes,
					tables: manifest.database.tables.length,
					files: manifest.files.local.count,
				});
				return { id, name, target: target.kind, location: target.location(name), sizeBytes, manifest };
			} catch (error) {
				const problem = error instanceof Error ? error.message : String(error);
				await logEnd(database.pool, id, { status: "failed", at: clock.now(), problem }).catch(() => {});
				log.error("A Backup failed", { reason: options.reason, location: target.location(name), error });
				throw new BackupFailedError(`The Backup failed: ${problem}`, { cause: error });
			}
		} finally {
			await lock.query("SELECT pg_advisory_unlock(hashtext($1))", [BACKUP_LOCK]).catch(() => {});
		}
	} finally {
		lock.release();
	}
}

/** `webcraft-backup-20260302-090000-scheduled-3fa2.tar`: when, why, and four random hex digits. */
export function archiveName(at: Date, reason: BackupReason): string {
	const stamp = at
		.toISOString()
		.replace(/\.\d{3}Z$/, "")
		.replace(/[-:]/g, "")
		.replace("T", "-");
	const random = Array.from(crypto.getRandomValues(new Uint8Array(2)), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
	return `webcraft-backup-${stamp}-${reason}-${random}.tar`;
}

async function writeBackup(context: BackupContext, reason: BackupReason, target: BackupTarget, name: string) {
	const { database, clock } = context;
	const folder = await mkdtemp(join(tmpdir(), "webcraft-backup-"));
	try {
		// One snapshot: every table is read as of the same moment, as the variant keys are.
		const client = await database.pool.connect();
		let dump: Awaited<ReturnType<typeof dumpDatabase>>;
		let variants: Set<string>;
		let level: Awaited<ReturnType<typeof readMigrationLevel>>;
		let version: string | null;
		let storage: { kind: "disk" | "s3"; bucket: BackupManifest["files"]["bucket"] };
		try {
			await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
			level = await readMigrationLevel(client);
			version = await lastMigratedVersion(client);
			dump = await dumpDatabase(client, folder);
			variants = await localVariantKeys(client);
			storage = await storageInUse(client);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK").catch(() => {});
			throw error;
		} finally {
			client.release();
		}
		const files = await listLocalFiles(context.storageDir, variants);
		const manifest: BackupManifest = {
			format: BACKUP_FORMAT,
			formatVersion: BACKUP_FORMAT_VERSION,
			name,
			createdAt: clock.now().toISOString(),
			reason,
			webcraft: { version: version ?? WEBCRAFT_VERSION, takenBy: WEBCRAFT_VERSION },
			sdk: SDK_VERSION,
			modules: context.modules.map((module) => ({ id: module.manifest.id, version: module.manifest.version })),
			migrations: level,
			masterKey: { fingerprint: context.fingerprint },
			database: dump.database,
			files: {
				storage: storage.kind,
				local: { count: files.length, bytes: files.reduce((sum, file) => sum + file.size, 0) },
				bucket: storage.bucket,
			},
		};
		const manifestBytes = new TextEncoder().encode(`${JSON.stringify(manifest, null, "\t")}\n`);
		async function* entries(): AsyncGenerator<TarInput> {
			yield { path: MANIFEST_PATH, size: manifestBytes.length, body: manifestBytes };
			for (const file of dump.files) yield { path: file.file, size: file.size, body: readDumpFile(file.path) };
			for (const file of files) {
				const opened = await openLocalFile(file);
				if (opened) yield { path: `${FILES_FOLDER}${file.key}`, size: opened.size, body: opened.body };
			}
		}
		const sizeBytes = await target.write(name, writeTar(entries()));
		return { sizeBytes, manifest };
	} finally {
		await rm(folder, { recursive: true, force: true });
	}
}

/** Where new files went when the Backup was taken, and the bucket's files the archive doesn't copy. */
async function storageInUse(
	client: pg.PoolClient,
): Promise<{ kind: "disk" | "s3"; bucket: BackupManifest["files"]["bucket"] }> {
	const exists = await client.query<{ found: string | null }>("SELECT to_regclass('public.install_storage') AS found");
	if (!exists.rows[0]?.found) return { kind: "disk", bucket: null };
	const { rows } = await client.query<{
		kind: string;
		s3_endpoint: string | null;
		s3_bucket: string | null;
		s3_prefix: string | null;
	}>("SELECT kind, s3_endpoint, s3_bucket, s3_prefix FROM public.install_storage WHERE id = 1");
	const [row] = rows;
	const counted = await client.query<{ files: string }>(
		"SELECT count(DISTINCT key)::text AS files FROM public.media_files WHERE storage = 's3'",
	);
	const files = Number(counted.rows[0]?.files ?? 0);
	const bucket =
		row?.s3_endpoint && row.s3_bucket
			? { endpoint: row.s3_endpoint, bucket: row.s3_bucket, prefix: row.s3_prefix ?? "", files }
			: null;
	return { kind: row?.kind === "s3" ? "s3" : "disk", bucket: files > 0 || row?.kind === "s3" ? bucket : null };
}

/** Install settings › Backups, read through the catalog so a database a newer WebCraft hasn't migrated yet reads too. */
export async function readBackupSettingsRow(pool: pg.Pool | pg.PoolClient): Promise<BackupSettingsRow> {
	const defaults: BackupSettingsRow = { scheduled: true, target: "folder", s3: null };
	const exists = await pool.query<{ found: string | null }>("SELECT to_regclass('public.backup_settings') AS found");
	if (!exists.rows[0]?.found) return defaults;
	const { rows } = await pool.query<{
		scheduled: boolean;
		target: string;
		s3_endpoint: string | null;
		s3_region: string | null;
		s3_bucket: string | null;
		s3_prefix: string;
		s3_path_style: boolean;
		s3_access_key_id: string | null;
	}>(
		"SELECT scheduled, target, s3_endpoint, s3_region, s3_bucket, s3_prefix, s3_path_style, s3_access_key_id FROM public.backup_settings WHERE id = 1",
	);
	const [row] = rows;
	if (!row) return defaults;
	const s3 =
		row.s3_endpoint && row.s3_region && row.s3_bucket && row.s3_access_key_id
			? {
					endpoint: row.s3_endpoint,
					region: row.s3_region,
					bucket: row.s3_bucket,
					prefix: row.s3_prefix,
					pathStyle: row.s3_path_style,
					accessKeyId: row.s3_access_key_id,
				}
			: null;
	return { scheduled: row.scheduled, target: row.target === "s3" ? "s3" : "folder", s3 };
}

/** The target Install settings › Backups names. */
async function configuredTarget(context: BackupContext): Promise<BackupTarget> {
	const settings = await readBackupSettingsRow(context.database.pool);
	return targetFor(context, settings.target, settings.s3);
}

/** A target of a kind, for writing or (the keep rules) removing. */
export function targetFor(
	context: Pick<BackupContext, "backupDir" | "http" | "clock" | "secrets">,
	kind: "folder" | "s3",
	s3: S3Settings | null,
): BackupTarget {
	if (kind === "folder") return folderTarget(context.backupDir);
	if (!s3) throw new BackupFailedError("Backups go to an S3-compatible bucket, but no bucket is set.");
	return s3Target({
		settings: s3,
		http: context.http,
		clock: context.clock,
		withSecret: (use) => context.secrets.useWith(BACKUP_S3_SECRET, use),
	});
}

/** Records a Backup that started in the log, when the database has the log (not before the migrations that make it). */
async function logStart(
	pool: pg.Pool,
	entry: { reason: BackupReason; target: BackupTarget; name: string; at: Date },
): Promise<string | null> {
	const exists = await pool.query<{ found: string | null }>("SELECT to_regclass('public.backups') AS found");
	if (!exists.rows[0]?.found) return null;
	const { rows } = await pool.query<{ id: string }>(
		`INSERT INTO public.backups (reason, target, name, location, status, started_at)
			VALUES ($1, $2, $3, $4, 'running', $5) RETURNING id`,
		[entry.reason, entry.target.kind, entry.name, entry.target.location(entry.name), entry.at],
	);
	return rows[0]?.id ?? null;
}

async function logEnd(
	pool: pg.Pool,
	id: string | null,
	end: { status: "done" | "failed"; at: Date; sizeBytes?: number; problem?: string },
): Promise<void> {
	if (id === null) return;
	await pool.query(
		"UPDATE public.backups SET status = $2, finished_at = $3, size_bytes = $4, problem = $5 WHERE id = $1",
		[id, end.status, end.at, end.sizeBytes ?? null, end.problem?.slice(0, 1000) ?? null],
	);
}
