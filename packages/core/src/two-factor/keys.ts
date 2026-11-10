import type { SecondFactorKeys, SecretSlot } from "@webcraft/auth";
import type { Database } from "@webcraft/db";
import { sql } from "drizzle-orm";

import { SecretNotSetError, type Secrets } from "../secrets/store.ts";

/** The Install secret holding the key backup codes are hashed with. */
const BACKUP_CODE_KEY = { owner: { kind: "install" }, name: "auth.backup-code-key" } as const;

/** Serialises making that key, across processes, so two first-ever backup codes never get two keys. */
const BACKUP_CODE_KEY_LOCK = 0x2fa_0001;

/**
 * Second factors' secrets, kept in WebCraft's secret store under the Master key, so rotating the
 * Master key carries them over:
 *
 * - each person's authenticator secret is an Install secret named `person:<person id>:authenticator`
 *   (and `…:authenticator-pending` while one is being added), bound to that name by the encryption;
 * - backup codes are hashed with HMAC-SHA256 under a random key that is itself an Install secret
 *   (`auth.backup-code-key`, made the first time a person gets backup codes). A key derived from
 *   the Master key would end every backup code when the Master key is rotated; this one is carried over.
 */
export function createSecondFactorKeys({
	database,
	secrets,
}: {
	database: Database;
	secrets: Secrets;
}): SecondFactorKeys {
	const authenticatorRef = (personId: string, slot: SecretSlot) =>
		({
			owner: { kind: "install" },
			name: `person:${personId}:authenticator${slot === "pending" ? "-pending" : ""}`,
		}) as const;

	let hashKey: Promise<CryptoKey> | undefined;
	const loadHashKey = async (): Promise<CryptoKey> => {
		if (!(await secrets.describe(BACKUP_CODE_KEY)).set) {
			await database.db.transaction(async (tx) => {
				await tx.execute(sql`select pg_advisory_xact_lock(${BACKUP_CODE_KEY_LOCK})`);
				if ((await secrets.describe(BACKUP_CODE_KEY)).set) return;
				const bytes = crypto.getRandomValues(new Uint8Array(32));
				await secrets.set(BACKUP_CODE_KEY, Buffer.from(bytes).toString("base64"));
			});
		}
		return secrets.useWith(BACKUP_CODE_KEY, (value) =>
			crypto.subtle.importKey("raw", Buffer.from(value, "base64"), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]),
		);
	};

	return {
		authenticatorSecret: {
			set: (personId, slot, secret) => secrets.set(authenticatorRef(personId, slot), secret),
			async useWith(personId, slot, use) {
				try {
					return await secrets.useWith(authenticatorRef(personId, slot), use);
				} catch (error) {
					if (error instanceof SecretNotSetError) return null;
					throw error;
				}
			},
			remove: (personId, slot) => secrets.remove(authenticatorRef(personId, slot)),
		},
		async hashBackupCode(code) {
			// Kept once loaded: the key never changes while the process runs (a new Master key carries
			// it over, and a lost one means starting web and worker again).
			hashKey ??= loadHashKey().catch((error: unknown) => {
				hashKey = undefined;
				throw error;
			});
			const mac = await crypto.subtle.sign("HMAC", await hashKey, new TextEncoder().encode(code));
			return Buffer.from(mac).toString("base64url");
		},
	};
}
