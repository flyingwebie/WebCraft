import type { Database } from "@webcraft/db";
import { masterKeyVersions, secrets as secretsTable } from "@webcraft/db/schema";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import { type Sealed, seal, unseal } from "./cipher.ts";
import {
	assertMasterKeyMatches,
	KEY_VERSION_LOCK,
	keyVersions,
	MasterKeyMismatchError,
	mismatchMessage,
} from "./key-versions.ts";
import type { MasterKey } from "./master-key.ts";
import {
	checkRef,
	describeRef,
	type InstallSecretOwner,
	ownerColumns,
	type SecretOwner,
	type SecretRef,
} from "./refs.ts";

/**
 * Every stored secret, encrypted under the Master key. Secrets can be written but never read back:
 * a value reaches code only inside a `useWith` callback.
 */
export type Secrets<Owner extends SecretOwner = SecretOwner> = {
	/** Stores `value` as the secret, replacing any value it had. */
	set(secret: SecretRef<Owner>, value: string): Promise<void>;
	/**
	 * Calls `use` with the secret's value and returns what it returns, such as the answer of the
	 * call the secret was filled into. The value must not leave the callback.
	 */
	useWith<Result>(secret: SecretRef<Owner>, use: (value: string) => Result | Promise<Result>): Promise<Result>;
	/** What a person may see of a secret: whether it is set, its last 4 characters and when it was set. */
	describe(secret: SecretRef<Owner>): Promise<SecretDescription>;
	/** Forgets the secret, so it is no longer set. Does nothing when it isn't. */
	remove(secret: SecretRef<Owner>): Promise<void>;
	/** The names of the owner's secrets that start with `prefix`, such as a Module's (`module:sample:`). */
	names(owner: Owner, prefix: string): Promise<string[]>;
};

/**
 * The Install's own secrets, as `services.secrets` offers them. A Workspace's or Site's secrets are
 * reached only through the data layer (`workspace.secrets`, `site.secrets`), which can't name
 * another Workspace's secret.
 */
export type InstallSecrets = Secrets<InstallSecretOwner>;

/** `store`, limited to the Install's own secrets: anything else is refused with a TypeError. */
export function installSecretsOnly(store: Secrets): InstallSecrets {
	const check = (secret: SecretRef<SecretOwner>) => {
		if (secret.owner.kind !== "install") {
			throw new TypeError(
				"Workspace and Site secrets are reached through the data layer (workspace.secrets, site.secrets), not services.secrets.",
			);
		}
	};
	return {
		async set(secret, value) {
			check(secret);
			return store.set(secret, value);
		},
		async useWith(secret, use) {
			check(secret);
			return store.useWith(secret, use);
		},
		async describe(secret) {
			check(secret);
			return store.describe(secret);
		},
		async remove(secret) {
			check(secret);
			return store.remove(secret);
		},
		async names(owner, prefix) {
			check({ owner, name: prefix });
			return store.names(owner, prefix);
		},
	};
}

/**
 * A secret as the admin shows it. `lastFour` is null for secrets shorter than 16 characters, so
 * never more than a quarter of a secret shows.
 */
export type SecretDescription = { set: false } | { set: true; lastFour: string | null; updatedAt: Date };

/** Secrets shorter than this show no characters at all. */
const SHORTEST_WITH_LAST_FOUR = 16;

/** The longest value a secret may have, in characters. */
const LONGEST_VALUE = 65_536;

/** The secret has no value. */
export class SecretNotSetError extends Error {
	override name = "SecretNotSetError";
}

/**
 * The secret's stored value can't be decrypted: it was changed outside WebCraft, or it is
 * encrypted under a Master key this process doesn't have.
 */
export class SecretUnreadableError extends Error {
	override name = "SecretUnreadableError";
}

type StoredSecret = Sealed & { keyVersion: number; updatedAt: Date };

type SecretsOptions = {
	database: Database;
	masterKey: MasterKey;
	clock: Clock;
};

/**
 * Opens the Install's secrets the way web and worker do at start-up: refuses a Master key that
 * isn't the Install's current one (`MasterKeyMismatchError`), then returns the secrets.
 */
export async function openSecrets(options: SecretsOptions): Promise<Secrets> {
	await assertMasterKeyMatches(options.database, options.masterKey);
	return createSecrets(options);
}

/**
 * The Install's secrets, without the start-up check: for code that must not touch the database
 * yet. Prefer `openSecrets`.
 */
export function createSecrets({ database, masterKey, clock }: SecretsOptions): Secrets {
	const { db } = database;
	let ownVersion: number | undefined;

	/** The key version whose fingerprint is this process's Master key, if the Install has one. */
	async function versionOfOwnKey(): Promise<number | undefined> {
		if (ownVersion !== undefined) return ownVersion;
		const fingerprint = await masterKey.fingerprint();
		const [row] = await db
			.select({ version: masterKeyVersions.version })
			.from(masterKeyVersions)
			.where(eq(masterKeyVersions.fingerprint, fingerprint));
		// A key's version never changes, so once found it is kept.
		ownVersion = row?.version;
		return ownVersion;
	}

	async function read(secret: SecretRef): Promise<StoredSecret | undefined> {
		const [row] = await db
			.select({
				keyVersion: secretsTable.keyVersion,
				iv: secretsTable.iv,
				ciphertext: secretsTable.ciphertext,
				updatedAt: secretsTable.updatedAt,
			})
			.from(secretsTable)
			.where(whereSecret(secret));
		return row;
	}

	async function decrypt(secret: SecretRef, stored: StoredSecret): Promise<string> {
		if ((await versionOfOwnKey()) !== stored.keyVersion) {
			throw new SecretUnreadableError(
				`The secret ${describeRef(secret)} is encrypted under Master key version ${stored.keyVersion}, which is not this process's Master key. Restart web and worker with the Install's current Master key.`,
			);
		}
		const value = await unseal(masterKey, stored.keyVersion, secret, stored);
		if (value === null) {
			throw new SecretUnreadableError(
				`The secret ${describeRef(secret)} can't be decrypted: its stored value was changed outside WebCraft.`,
			);
		}
		return value;
	}

	return {
		async set(secret, value) {
			checkRef(secret);
			checkValue(value);
			const fingerprint = await masterKey.fingerprint();
			await db.transaction(async (tx) => {
				await tx.execute(sql`select pg_advisory_xact_lock_shared(${KEY_VERSION_LOCK})`);
				let versions = await keyVersions(tx);
				if (versions.length === 0) {
					// The Install's first secret: this Master key becomes key version 1.
					await tx
						.insert(masterKeyVersions)
						.values({ version: 1, fingerprint, createdAt: clock.now() })
						.onConflictDoNothing();
					versions = await keyVersions(tx);
				}
				const [current] = versions;
				if (!current || current.fingerprint !== fingerprint) {
					// Most likely the key was rotated while this process kept running with the old one.
					throw new MasterKeyMismatchError(mismatchMessage(versions, fingerprint, "This process's Master key"));
				}
				const sealed = await seal(masterKey, current.version, secret, value);
				const now = clock.now();
				const stored = {
					keyVersion: current.version,
					iv: Buffer.from(sealed.iv),
					ciphertext: Buffer.from(sealed.ciphertext),
					updatedAt: now,
				};
				await tx
					.insert(secretsTable)
					.values({ ...ownerColumns(secret.owner), name: secret.name, ...stored, createdAt: now })
					.onConflictDoUpdate({
						target: [secretsTable.workspaceId, secretsTable.siteId, secretsTable.name],
						set: stored,
					});
			});
		},

		async useWith(secret, use) {
			checkRef(secret);
			const stored = await read(secret);
			if (!stored) {
				throw new SecretNotSetError(`The secret ${describeRef(secret)} is not set.`);
			}
			const value = await decrypt(secret, stored);
			const result = await use(value);
			// Catches the plain mistakes of handing the value out, such as `(value) => value` or a
			// header line built from it.
			if (typeof result === "string" && result.includes(value)) {
				throw new TypeError(
					`The useWith callback for the secret ${describeRef(secret)} returned the secret's value. A secret's value must not leave the callback.`,
				);
			}
			return result;
		},

		async describe(secret) {
			checkRef(secret);
			const stored = await read(secret);
			if (!stored) return { set: false };
			const characters = Array.from(await decrypt(secret, stored));
			return {
				set: true,
				lastFour: characters.length >= SHORTEST_WITH_LAST_FOUR ? characters.slice(-4).join("") : null,
				updatedAt: stored.updatedAt,
			};
		},

		async remove(secret) {
			checkRef(secret);
			await db.delete(secretsTable).where(whereSecret(secret));
		},

		async names(owner, prefix) {
			const { workspaceId, siteId } = ownerColumns(owner);
			const rows = await db
				.select({ name: secretsTable.name })
				.from(secretsTable)
				.where(
					and(
						workspaceId === null ? isNull(secretsTable.workspaceId) : eq(secretsTable.workspaceId, workspaceId),
						siteId === null ? isNull(secretsTable.siteId) : eq(secretsTable.siteId, siteId),
						sql`starts_with(${secretsTable.name}, ${prefix})`,
					),
				)
				.orderBy(secretsTable.name);
			return rows.map((row) => row.name);
		},
	};
}

function whereSecret(secret: SecretRef): SQL | undefined {
	const { workspaceId, siteId } = ownerColumns(secret.owner);
	return and(
		workspaceId === null ? isNull(secretsTable.workspaceId) : eq(secretsTable.workspaceId, workspaceId),
		siteId === null ? isNull(secretsTable.siteId) : eq(secretsTable.siteId, siteId),
		eq(secretsTable.name, secret.name),
	);
}

function checkValue(value: string): void {
	if (value === "") {
		throw new TypeError("A secret's value can't be empty; remove the secret instead.");
	}
	if (value.length > LONGEST_VALUE) {
		throw new TypeError(`A secret's value can't be longer than ${LONGEST_VALUE} characters.`);
	}
}
