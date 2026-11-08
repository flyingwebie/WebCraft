import type { Database, Transaction } from "@webcraft/db";
import { masterKeyVersions, secrets as secretsTable, sites, workspaces } from "@webcraft/db/schema";
import { eq, sql } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import { seal, unseal } from "./cipher.ts";
import { KEY_VERSION_LOCK, type KeyVersion, keyVersions } from "./key-versions.ts";
import { MASTER_KEY_VARIABLE, type MasterKey } from "./master-key.ts";
import { type OwnerColumns, refFromColumns } from "./refs.ts";

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

		const rows = await tx
			.select()
			.from(secretsTable)
			.orderBy(...OWNER_ORDER)
			.for("update");
		const unreadable: string[] = [];
		const describe = await describerFor(tx);
		for (const row of rows) {
			const secret = refFromColumns(row);
			const value = await unseal(from, row.keyVersion, secret, row);
			if (value === null) {
				unreadable.push(describe(row));
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

export type LostKeyReport =
	| {
			/**
			 * Nothing was changed: these secrets would be deleted. Confirm by passing the start of
			 * `lostFingerprint` (at least `CONFIRM_FINGERPRINT_LENGTH` characters).
			 */
			outcome: "needs-confirmation";
			secrets: string[];
			/** The fingerprint of the key being given up: the Install's current key version. */
			lostFingerprint: string;
			lostVersion: number;
	  }
	| {
			outcome: "replaced";
			/** The new key's version. */
			version: number;
			/** The secrets that were deleted, to be set again. */
			deleted: string[];
			fingerprint: string;
	  };

/**
 * Replaces a Master key that was lost (`webcraft admin rotate-key --old-key-lost`). Without the
 * old key no secret can be decrypted, so every secret is deleted and the new key becomes the next
 * key version; the secrets must be set again. It only lists what it would delete unless
 * `confirmFingerprint` starts the current key version's fingerprint, which proves the operator
 * read that listing for this Install. An Install with no secrets needs no confirmation.
 */
export async function replaceLostMasterKey({
	database,
	to,
	clock,
	confirmFingerprint,
	source = MASTER_KEY_VARIABLE,
}: {
	database: Database;
	to: MasterKey;
	clock: Clock;
	confirmFingerprint?: string;
	source?: string;
}): Promise<LostKeyReport> {
	const newFingerprint = await to.fingerprint();
	return database.db.transaction(async (tx) => {
		await tx.execute(sql`select pg_advisory_xact_lock(${KEY_VERSION_LOCK})`);
		const versions = await keyVersions(tx);
		const [current] = versions;
		if (current?.fingerprint === newFingerprint) {
			throw new KeyRotationError(
				`${source} is the Install's current Master key (version ${current.version}), so it isn't lost and nothing was deleted.`,
			);
		}
		const usedBefore = versions.find((version) => version.fingerprint === newFingerprint);
		if (usedBefore) {
			throw new KeyRotationError(
				`${source} is a key this Install used before (version ${usedBefore.version}). A new Master key must never have been used. ${MAKE_ONE}`,
			);
		}
		const rows = await tx
			.select({ workspaceId: secretsTable.workspaceId, siteId: secretsTable.siteId, name: secretsTable.name })
			.from(secretsTable)
			.orderBy(...OWNER_ORDER)
			.for("update");
		const describe = await describerFor(tx);
		const secrets = rows.map(describe);
		if (secrets.length > 0 && current) {
			if (confirmFingerprint === undefined) {
				return {
					outcome: "needs-confirmation",
					secrets,
					lostFingerprint: current.fingerprint,
					lostVersion: current.version,
				};
			}
			if (!confirmsFingerprint(confirmFingerprint, current.fingerprint)) {
				throw new KeyRotationError(
					`That doesn't confirm the Install's current Master key (version ${current.version}): give at least the first ${CONFIRM_FINGERPRINT_LENGTH} characters of its fingerprint, as listed without the confirmation. Nothing was deleted.`,
				);
			}
		}
		await tx.delete(secretsTable);
		const version = (current?.version ?? 0) + 1;
		const now = clock.now();
		if (current) {
			await tx.update(masterKeyVersions).set({ retiredAt: now }).where(eq(masterKeyVersions.version, current.version));
		}
		await tx.insert(masterKeyVersions).values({ version, fingerprint: newFingerprint, createdAt: now });
		return { outcome: "replaced", version, deleted: secrets, fingerprint: newFingerprint };
	});
}

/** How much of the lost key's fingerprint an operator types to confirm deleting every secret. */
export const CONFIRM_FINGERPRINT_LENGTH = 12;

function confirmsFingerprint(given: string, fingerprint: string): boolean {
	const typed = given.trim().toLowerCase();
	return typed.length >= CONFIRM_FINGERPRINT_LENGTH && fingerprint.toLowerCase().startsWith(typed);
}

/**
 * Names stored secrets for the person running the command: by Workspace name and Site slug, such
 * as `"cdn.token" of Site shop in Workspace Acme Ltd`. Never shows a value.
 */
async function describerFor(tx: Transaction): Promise<(row: OwnerColumns & { name: string }) => string> {
	const [workspaceRows, siteRows] = await Promise.all([
		tx.select({ id: workspaces.id, name: workspaces.name }).from(workspaces),
		tx.select({ id: sites.id, slug: sites.slug }).from(sites),
	]);
	const workspaceNames = new Map(workspaceRows.map((row) => [row.id, row.name]));
	const siteSlugs = new Map(siteRows.map((row) => [row.id, row.slug]));
	return ({ workspaceId, siteId, name }) => {
		if (workspaceId === null) return `"${name}" of the Install`;
		const workspace = `Workspace ${workspaceNames.get(workspaceId) ?? workspaceId}`;
		if (siteId === null) return `"${name}" of ${workspace}`;
		return `"${name}" of Site ${siteSlugs.get(siteId) ?? siteId} in ${workspace}`;
	};
}

/** Secrets in the order people read them: the Install's first, then by Workspace, Site and name. */
const OWNER_ORDER = [
	sql`${secretsTable.workspaceId} asc nulls first`,
	sql`${secretsTable.siteId} asc nulls first`,
	sql`${secretsTable.name} asc`,
];

function notTheCurrentKey(versions: KeyVersion[], current: KeyVersion, fingerprint: string, source: string): string {
	const retired = versions.find((version) => version.fingerprint === fingerprint);
	if (retired) {
		return `${source} is the Install's old Master key (version ${retired.version}). Pass the current one (version ${current.version}). Nothing was changed.`;
	}
	return `${source} is not the Install's current Master key (version ${current.version}, whose fingerprint starts with ${current.fingerprint.slice(0, 16)}). Nothing was changed.`;
}
