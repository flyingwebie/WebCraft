import type { Database } from "@webcraft/db";
import { masterKeyVersions } from "@webcraft/db/schema";
import { desc } from "drizzle-orm";

import { ConfigError } from "../config.ts";
import { MASTER_KEY_VARIABLE, type MasterKey } from "./master-key.ts";

/** One Master key the Install's secrets have been encrypted under. */
export type KeyVersion = {
	version: number;
	fingerprint: string;
	createdAt: Date;
	/** When `webcraft admin rotate-key` replaced it; null for the current key. */
	retiredAt: Date | null;
};

type Queries = Pick<Database["db"], "select">;

/**
 * The advisory lock that ties writing a secret to the current key version. Setting a secret holds
 * it shared while it encrypts and stores; rotating the Master key holds it alone. So no secret is
 * written under a key that a rotation running at the same moment is retiring.
 */
export const KEY_VERSION_LOCK = 7_349_049;

/** Every key version the Install has had, newest (the current one) first. */
export function keyVersions(db: Queries): Promise<KeyVersion[]> {
	return db.select().from(masterKeyVersions).orderBy(desc(masterKeyVersions.version));
}

/**
 * The process was started with a Master key that can't open the Install's secrets: an unknown key,
 * or one that a rotation retired.
 */
export class MasterKeyMismatchError extends ConfigError {
	override name = "MasterKeyMismatchError";
}

/**
 * The start-up check of web and worker: refuses a Master key that isn't the Install's current
 * one. An Install that has never stored a secret accepts any key; its first secret records it.
 */
export async function assertMasterKeyMatches(database: Database, masterKey: MasterKey): Promise<void> {
	const versions = await keyVersions(database.db);
	const [current] = versions;
	if (!current) return;
	const fingerprint = await masterKey.fingerprint();
	if (current.fingerprint === fingerprint) return;
	throw new MasterKeyMismatchError(mismatchMessage(versions, fingerprint, MASTER_KEY_VARIABLE));
}

/** Why the key with `fingerprint`, read from `source`, is not the current key of `versions`. */
export function mismatchMessage(versions: KeyVersion[], fingerprint: string, source: string): string {
	const [current] = versions;
	if (!current) return `${source} is not this Install's Master key.`;
	const retired = versions.find((version) => version.fingerprint === fingerprint);
	if (retired) {
		return `${source} is the Install's old Master key (version ${retired.version}), retired when the key was rotated on ${retired.retiredAt?.toISOString() ?? "an unknown date"}. Start web and worker with the current Master key (version ${current.version}).`;
	}
	return `${source} is not this Install's Master key: its secrets are encrypted under Master key version ${current.version}, whose fingerprint starts with ${current.fingerprint.slice(0, 16)}. Start web and worker with that key. To change it, or if it is lost, run \`webcraft admin rotate-key\` (see \`webcraft --help\`).`;
}
