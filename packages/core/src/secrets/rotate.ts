import type { Database } from "@webcraft/db";
import { masterKeyVersions, secrets as secretsTable } from "@webcraft/db/schema";
import { eq, sql } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import { seal, unseal } from "./cipher.ts";
import { KEY_VERSION_LOCK, type KeyVersion, keyVersions } from "./key-versions.ts";
import { MASTER_KEY_VARIABLE, type MasterKey } from "./master-key.ts";
import { describeRef, refFromColumns } from "./refs.ts";

export type KeyRotationOptions = {
	database: Database;
	/** The Install's current Master key, the one being replaced. */
	from: MasterKey;
	/** The new Master key. It must be one the Install has never used. */
	to: MasterKey;
	clock: Clock;
	/** Where each key came from, named in error messages. */
	sources?: { from: string; to: string };
};

export type KeyRotationReport =
	| {
			outcome: "rotated";
			/** The new key's version. */
			version: number;
			/** How many secrets were re-encrypted under it. */
			reencrypted: number;
			/** The new key's fingerprint. */
			fingerprint: string;
	  }
	| {
			/** The Install already runs on the new key, as after a rotation that finished before. */
			outcome: "already-current";
			version: number;
			fingerprint: string;
	  };

/** The rotation was refused. Nothing was changed. */
export class KeyRotationError extends Error {
	override name = "KeyRotationError";
}

/** The environment variable `webcraft admin rotate-key` reads the key being replaced from. */
export const OLD_MASTER_KEY_VARIABLE = "WEBCRAFT_OLD_SECRET_KEY";

const MAKE_ONE = "Make a new key with `openssl rand -base64 32`.";

/**
 * Rotates the Master key (`webcraft admin rotate-key`): in one transaction, decrypts every secret
 * with the old key and encrypts it again under the new key as the next key version, which becomes
 * the current one. When any secret can't be decrypted, nothing is changed.
 *
 * Web and worker should be stopped first. Ones still running with the old key can no longer write
 * or read secrets, and refuse to start again until they get the new key.
 */
export async function rotateMasterKey({
	database,
	from,
	to,
	clock,
	sources = { from: OLD_MASTER_KEY_VARIABLE, to: MASTER_KEY_VARIABLE },
}: KeyRotationOptions): Promise<KeyRotationReport> {
	const oldFingerprint = await from.fingerprint();
	const newFingerprint = await to.fingerprint();
	if (oldFingerprint === newFingerprint) {
		throw new KeyRotationError(`${sources.to} and ${sources.from} hold the same key. ${MAKE_ONE}`);
	}

	return database.db.transaction(async (tx) => {
		// Waits for secrets being set right now, and holds new ones back until the rotation is done.
		await tx.execute(sql`select pg_advisory_xact_lock(${KEY_VERSION_LOCK})`);
		const versions = await keyVersions(tx);
		const [current] = versions;
		if (current?.fingerprint === newFingerprint) {
			return { outcome: "already-current", version: current.version, fingerprint: newFingerprint };
		}
		const usedBefore = versions.find((version) => version.fingerprint === newFingerprint);
		if (usedBefore) {
			throw new KeyRotationError(
				`${sources.to} is a key this Install used before (version ${usedBefore.version}). A new Master key must never have been used. ${MAKE_ONE}`,
			);
		}
		if (current && current.fingerprint !== oldFingerprint) {
			throw new KeyRotationError(notTheCurrentKey(versions, current, oldFingerprint, sources.from));
		}

		const version = (current?.version ?? 0) + 1;
		const now = clock.now();
		if (current) {
			await tx.update(masterKeyVersions).set({ retiredAt: now }).where(eq(masterKeyVersions.version, current.version));
		}
		await tx.insert(masterKeyVersions).values({ version, fingerprint: newFingerprint, createdAt: now });

		const rows = await tx.select().from(secretsTable).orderBy(secretsTable.id).for("update");
		const unreadable: string[] = [];
		for (const row of rows) {
			const secret = refFromColumns(row);
			const value = await unseal(from, row.keyVersion, secret, row);
			if (value === null) {
				unreadable.push(describeRef(secret));
				continue;
			}
			const sealed = await seal(to, version, secret, value);
			// The value didn't change, so neither does when it was set.
			await tx
				.update(secretsTable)
				.set({ keyVersion: version, iv: Buffer.from(sealed.iv), ciphertext: Buffer.from(sealed.ciphertext) })
				.where(eq(secretsTable.id, row.id));
		}
		if (unreadable.length > 0) {
			throw new KeyRotationError(
				`${unreadable.length} of the ${rows.length} secrets can't be decrypted with ${sources.from}, so nothing was changed: ${unreadable.join(", ")}. They were changed outside WebCraft; remove them or set them again, then rotate.`,
			);
		}
		return { outcome: "rotated", version, reencrypted: rows.length, fingerprint: newFingerprint };
	});
}

function notTheCurrentKey(versions: KeyVersion[], current: KeyVersion, fingerprint: string, source: string): string {
	const retired = versions.find((version) => version.fingerprint === fingerprint);
	if (retired) {
		return `${source} is the Install's old Master key (version ${retired.version}). Pass the current one (version ${current.version}). Nothing was changed.`;
	}
	return `${source} is not the Install's current Master key (version ${current.version}, whose fingerprint starts with ${current.fingerprint.slice(0, 16)}). Nothing was changed.`;
}
