import type { Database } from "@webcraft/db";
import { masterKeyVersions, secrets as secretsTable } from "@webcraft/db/schema";
import { and, eq, isNull, type SQL, sql } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import { assertMasterKeyMatches, keyVersions, MasterKeyMismatchError, mismatchMessage } from "./key-versions.ts";
import { type MasterKey, secretsKey } from "./master-key.ts";

/**
 * Who a secret belongs to: the Install itself (Install SMTP, shared AI keys), one Workspace (its
 * AI key) or one Site of a Workspace (its SMTP, CDN token, Webhook and CAPTCHA secrets).
 */
export type SecretOwner =
	| { kind: "install" }
	| { kind: "workspace"; workspaceId: string }
	| { kind: "site"; workspaceId: string; siteId: string };

/** Names one secret: its owner and a name unique within that owner, such as `smtp.password`. */
export type SecretRef = {
	owner: SecretOwner;
	name: string;
};

/**
 * Every stored secret, encrypted under the Master key. Secrets can be written but never read back:
 * a value reaches code only inside a `useWith` callback.
 */
export type Secrets = {
	/** Stores `value` as the secret, replacing any value it had. */
	set(secret: SecretRef, value: string): Promise<void>;
	/**
	 * Calls `use` with the secret's value and returns what it returns, such as the answer of the
	 * call the secret was filled into. The value must not leave the callback.
	 */
	useWith<Result>(secret: SecretRef, use: (value: string) => Result | Promise<Result>): Promise<Result>;
	/** What a person may see of a secret: whether it is set, its last 4 characters and when it was set. */
	describe(secret: SecretRef): Promise<SecretDescription>;
	/** Forgets the secret, so it is no longer set. Does nothing when it isn't. */
	remove(secret: SecretRef): Promise<void>;
};

/**
 * A secret as the admin shows it. `lastFour` is null for secrets shorter than 16 characters, so
 * never more than a quarter of a secret shows.
 */
export type SecretDescription = { set: false } | { set: true; lastFour: string | null; updatedAt: Date };

/** Secrets shorter than this show no characters at all. */
const SHORTEST_WITH_LAST_FOUR = 16;

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

type StoredSecret = { keyVersion: number; iv: Uint8Array; ciphertext: Uint8Array; updatedAt: Date };

type SecretsOptions = {
	database: Database;
	masterKey: MasterKey;
	clock: Clock;
};

/**
 * Ties writing a secret to the current key version: `set` holds it shared while it encrypts and
 * stores, and rotating the Master key holds it alone, so no secret is written under a key that a
 * rotation running at the same moment is retiring.
 */
const KEY_VERSION_LOCK = 7_349_049;

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
				`The secret ${describeRef(secret)} is encrypted under Master key version ${stored.keyVersion}, which is not this process's Master key.`,
			);
		}
		try {
			const plaintext = await crypto.subtle.decrypt(
				{ name: "AES-GCM", iv: new Uint8Array(stored.iv), additionalData: authenticatedData(secret) },
				await secretsKey(masterKey, stored.keyVersion),
				new Uint8Array(stored.ciphertext),
			);
			return new TextDecoder().decode(plaintext);
		} catch {
			throw new SecretUnreadableError(
				`The secret ${describeRef(secret)} can't be decrypted: its stored value was changed outside WebCraft.`,
			);
		}
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
					throw new MasterKeyMismatchError(
						`${mismatchMessage(versions, fingerprint, "This process's Master key")} Restart web and worker with it.`,
					);
				}
				const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
				const ciphertext = await crypto.subtle.encrypt(
					{ name: "AES-GCM", iv, additionalData: authenticatedData(secret) },
					await secretsKey(masterKey, current.version),
					new TextEncoder().encode(value),
				);
				const now = clock.now();
				const stored = {
					keyVersion: current.version,
					iv: Buffer.from(iv),
					ciphertext: Buffer.from(ciphertext),
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
	};
}

/** AES-GCM's recommended nonce length. A random nonce per encryption is safe for this few values. */
const IV_BYTES = 12;

/**
 * The authenticated data of a secret's ciphertext: its owner and name. Decrypting with any other
 * owner or name fails, so a ciphertext copied into another row is useless there.
 */
function authenticatedData({ owner, name }: SecretRef): Uint8Array<ArrayBuffer> {
	const { workspaceId, siteId } = ownerColumns(owner);
	return new TextEncoder().encode(JSON.stringify(["webcraft secret", owner.kind, workspaceId, siteId, name]));
}

function ownerColumns(owner: SecretOwner): { workspaceId: string | null; siteId: string | null } {
	switch (owner.kind) {
		case "install":
			return { workspaceId: null, siteId: null };
		case "workspace":
			return { workspaceId: owner.workspaceId, siteId: null };
		case "site":
			return { workspaceId: owner.workspaceId, siteId: owner.siteId };
	}
}

function whereSecret(secret: SecretRef): SQL | undefined {
	const { workspaceId, siteId } = ownerColumns(secret.owner);
	return and(
		workspaceId === null ? isNull(secretsTable.workspaceId) : eq(secretsTable.workspaceId, workspaceId),
		siteId === null ? isNull(secretsTable.siteId) : eq(secretsTable.siteId, siteId),
		eq(secretsTable.name, secret.name),
	);
}

function describeRef({ owner, name }: SecretRef): string {
	switch (owner.kind) {
		case "install":
			return `"${name}" of the Install`;
		case "workspace":
			return `"${name}" of Workspace ${owner.workspaceId}`;
		case "site":
			return `"${name}" of Site ${owner.siteId} in Workspace ${owner.workspaceId}`;
	}
}

/** Secret names are chosen by WebCraft's code, such as `smtp.password` or `webhook:<id>:signing`. */
const SECRET_NAME = /^[A-Za-z0-9._:-]{1,200}$/;

/** The longest value a secret may have, in characters. */
const LONGEST_VALUE = 65_536;

function checkRef({ owner, name }: SecretRef): void {
	if (!SECRET_NAME.test(name)) {
		throw new TypeError(
			`"${name}" is not a secret name: use 1 to 200 letters, digits, dots, colons, dashes and underscores.`,
		);
	}
	if (owner.kind !== "install" && !owner.workspaceId.trim()) {
		throw new TypeError("A secret's owner needs a Workspace id.");
	}
	if (owner.kind === "site" && !owner.siteId.trim()) {
		throw new TypeError("A secret's owner needs a Site id.");
	}
}

function checkValue(value: string): void {
	if (value === "") {
		throw new TypeError("A secret's value can't be empty; remove the secret instead.");
	}
	if (value.length > LONGEST_VALUE) {
		throw new TypeError(`A secret's value can't be longer than ${LONGEST_VALUE} characters.`);
	}
}
