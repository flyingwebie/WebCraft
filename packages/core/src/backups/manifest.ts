import { z } from "zod";

/** The first file of every Backup archive. */
export const MANIFEST_PATH = "manifest.json";

/** What the format field of a Backup's manifest says. */
export const BACKUP_FORMAT = "webcraft-backup";

/** The version of the archive's layout this build writes and reads. */
export const BACKUP_FORMAT_VERSION = 1;

/** Why a Backup was taken: every day, by `webcraft admin backup`, or by the migrate step before it changed anything. */
export const BACKUP_REASONS = ["scheduled", "command", "before-migrations"] as const;

export type BackupReason = (typeof BACKUP_REASONS)[number];

const tableSchema = z.object({
	/** `<schema>.<table>`, such as `public.entries` or `m_forms.submissions`. */
	name: z.string(),
	/** The columns the data holds, in its order (generated columns are left out: Postgres makes them again). */
	columns: z.array(z.string()),
	rows: z.number().int().nonnegative(),
	/** The archive file holding its rows: Postgres's COPY text format, gzip-compressed. */
	file: z.string(),
});

/**
 * A Backup's manifest (ADR 0032): what the archive holds and what it was taken from. It carries the
 * Master key's fingerprint, never the key or anything derived from it that opens a secret.
 */
export const backupManifestSchema = z.object({
	format: z.literal(BACKUP_FORMAT),
	formatVersion: z.number().int().positive(),
	createdAt: z.iso.datetime(),
	reason: z.enum(BACKUP_REASONS),
	webcraft: z.object({
		/** The WebCraft version the data was written by: the one that last ran the migrate step. */
		version: z.string(),
		/** The WebCraft version that took the Backup. */
		takenBy: z.string(),
	}),
	/** The Module SDK version of the build that took it. */
	sdk: z.string(),
	/** The Modules of that build, with their versions. */
	modules: z.array(z.object({ id: z.string(), version: z.string() })),
	/** The migration level: every migration the database had (WebCraft's and each Module's) and the job queue's schema version. */
	migrations: z.object({
		core: z.array(z.string()),
		modules: z.record(z.string(), z.array(z.string())),
		jobQueue: z.number().int().nullable(),
	}),
	masterKey: z.object({ fingerprint: z.string().regex(/^[0-9a-f]{64}$/) }),
	database: z.object({
		/** In the order a restore loads them: tables first, the tables pointing at them after. */
		tables: z.array(tableSchema),
		sequences: z.array(z.object({ name: z.string(), value: z.string(), called: z.boolean() })),
		/** The partitions of partitioned tables (a Module's monthly partitions), made before rows are loaded. */
		partitions: z.array(z.object({ parent: z.string(), name: z.string(), bound: z.string() })),
	}),
	/**
	 * Files: where the Install stored new files then, the files of local storage the archive holds
	 * (`files/<key>`), and how many files are in an S3-compatible bucket, which the archive doesn't copy.
	 */
	files: z.object({
		storage: z.enum(["disk", "s3"]),
		local: z.object({ count: z.number().int().nonnegative(), bytes: z.number().int().nonnegative() }),
		bucket: z
			.object({
				endpoint: z.string(),
				bucket: z.string(),
				prefix: z.string(),
				files: z.number().int().nonnegative(),
			})
			.nullable(),
	}),
});

export type BackupManifest = z.infer<typeof backupManifestSchema>;
