import type { Database } from "@webcraft/db";
import { installStorage } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import type { OutgoingHttp } from "../http.ts";
import type { Logger } from "../log.ts";
import { actingPerson } from "../permissions/can.ts";
import type { SecretDescription, Secrets } from "../secrets/store.ts";
import type { InstallScope } from "../tenancy/data-layer.ts";
import { StorageUnreachableError } from "./errors.ts";
import { type S3Settings, s3Storage } from "./s3-storage.ts";
import { diskStorage, type StorageBackend, StorageError, type StorageKind } from "./storage.ts";

/** The bucket's secret access key: a secret of the Install. */
export const STORAGE_S3_SECRET = { owner: { kind: "install" }, name: "storage.s3.secretAccessKey" } as const;

/** Where Media is stored, as Install settings › Storage shows it. */
export type StorageSettings = {
	/** Where new files go. */
	kind: StorageKind;
	/** The folder files go to on local disk (`WEBCRAFT_STORAGE_DIR`). */
	directory: string;
	/** The S3-compatible bucket, once one was set; kept when the Install switches back to disk. */
	s3: (S3Settings & { secretAccessKey: SecretDescription }) | null;
	updatedAt: Date | null;
};

/**
 * A change to where Media is stored. Switching to a bucket (or changing it) gives every setting;
 * `secretAccessKey` absent keeps the one stored. Files already stored stay where they are and are
 * still served from there.
 */
export type StorageChange = { kind: "disk" } | ({ kind: "s3"; secretAccessKey?: string } & S3Settings);

/** The Install's storage: its setting, and the storage that holds each file. */
export type InstallStorage = {
	settings(): Promise<StorageSettings>;
	/**
	 * Changes where new files go. A bucket is checked first: WebCraft writes, reads and removes a small
	 * file there, refusing the change (`StorageUnreachableError`) when it can't. Recorded in the Audit
	 * log, never with the secret. A Sensitive action (`storage.change`): open the Install with
	 * `install.manage` and check it first.
	 */
	change(scope: InstallScope, change: StorageChange): Promise<StorageSettings>;
	/** The storage new files go to. */
	current(): Promise<StorageBackend>;
	/** The storage holding files stored with `kind`. */
	holding(kind: StorageKind): Promise<StorageBackend>;
};

type Options = {
	database: Database;
	secrets: Secrets;
	http: OutgoingHttp;
	clock: Clock;
	log: Logger;
	directory: string;
};

type Row = typeof installStorage.$inferSelect;

export function createInstallStorage({ database, secrets, http, clock, log, directory }: Options): InstallStorage {
	const { db } = database;
	const disk = diskStorage(directory);

	const readRow = async (): Promise<Row | undefined> => {
		const [row] = await db.select().from(installStorage).where(eq(installStorage.id, 1));
		return row;
	};

	const s3SettingsOf = (row: Row | undefined): S3Settings | null => {
		if (!row?.s3Endpoint || !row.s3Region || !row.s3Bucket || !row.s3AccessKeyId) return null;
		return {
			endpoint: row.s3Endpoint,
			region: row.s3Region,
			bucket: row.s3Bucket,
			prefix: row.s3Prefix,
			pathStyle: row.s3PathStyle,
			accessKeyId: row.s3AccessKeyId,
		};
	};

	const bucket = (
		settings: S3Settings,
		withSecret?: <Result>(use: (secret: string) => Promise<Result>) => Promise<Result>,
	) =>
		s3Storage({
			settings,
			http,
			clock,
			withSecret: withSecret ?? ((use) => secrets.useWith(STORAGE_S3_SECRET, use)),
		});

	const storedBucket = async (): Promise<StorageBackend> => {
		const settings = s3SettingsOf(await readRow());
		if (!settings) throw new StorageError("Files are kept in an S3-compatible bucket, but no bucket is set.");
		return bucket(settings);
	};

	const settings = async (): Promise<StorageSettings> => {
		const row = await readRow();
		const s3 = s3SettingsOf(row);
		return {
			kind: (row?.kind as StorageKind | undefined) ?? "disk",
			directory,
			s3: s3 ? { ...s3, secretAccessKey: await secrets.describe(STORAGE_S3_SECRET) } : null,
			updatedAt: row?.updatedAt ?? null,
		};
	};

	return {
		settings,

		async change(scope, change) {
			const now = clock.now();
			const personId = actingPerson(scope.access.actor);
			if (change.kind === "s3") {
				const { kind: _, secretAccessKey, ...s3 } = change;
				const stored = (await secrets.describe(STORAGE_S3_SECRET)).set;
				if (secretAccessKey === undefined && !stored) {
					throw new StorageUnreachableError("Give the bucket's secret access key.");
				}
				const withSecret =
					secretAccessKey === undefined
						? undefined
						: <Result>(use: (secret: string) => Promise<Result>) => use(secretAccessKey);
				await checkBucket(bucket(s3, withSecret));
				const values = {
					kind: "s3",
					s3Endpoint: s3.endpoint,
					s3Region: s3.region,
					s3Bucket: s3.bucket,
					s3Prefix: s3.prefix,
					s3PathStyle: s3.pathStyle,
					s3AccessKeyId: s3.accessKeyId,
					updatedAt: now,
					updatedBy: personId,
				};
				await scope.transaction(async (tx) => {
					await tx.db
						.insert(installStorage)
						.values({ id: 1, ...values })
						.onConflictDoUpdate({ target: installStorage.id, set: values });
					await tx.audit("storage.change", {
						kind: "s3",
						...s3,
						secretAccessKey: secretAccessKey === undefined ? "kept" : "replaced",
					});
				});
				if (secretAccessKey !== undefined) await secrets.set(STORAGE_S3_SECRET, secretAccessKey);
				log.info("The Install's storage was changed", {
					personId,
					kind: "s3",
					endpoint: s3.endpoint,
					bucket: s3.bucket,
				});
			} else {
				const values = { kind: "disk", updatedAt: now, updatedBy: personId };
				await scope.transaction(async (tx) => {
					await tx.db
						.insert(installStorage)
						.values({ id: 1, ...values })
						.onConflictDoUpdate({ target: installStorage.id, set: values });
					await tx.audit("storage.change", { kind: "disk" });
				});
				log.info("The Install's storage was changed", { personId, kind: "disk" });
			}
			return settings();
		},

		async current() {
			const row = await readRow();
			return row?.kind === "s3" ? storedBucket() : disk;
		},

		async holding(kind) {
			return kind === "s3" ? storedBucket() : disk;
		},
	};
}

/** Writes, reads back and removes a small file, refusing storage that can't do all three. */
export async function checkBucket(storage: StorageBackend): Promise<void> {
	const key = `webcraft-check/${crypto.randomUUID()}`;
	const content = new TextEncoder().encode("WebCraft checked it can use this storage.\n");
	try {
		await storage.put(key, content, "text/plain");
		const back = await storage.read(key);
		if (!back || back.length !== content.length || !back.every((byte, index) => byte === content[index])) {
			throw new StorageError("A file written there didn't read back the same.");
		}
		await storage.delete(key);
	} catch (error) {
		if (error instanceof StorageError) throw new StorageUnreachableError(error.message);
		throw error;
	}
}
