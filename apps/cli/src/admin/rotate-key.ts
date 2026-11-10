import { readFile } from "node:fs/promises";
import {
	CONFIRM_FINGERPRINT_LENGTH,
	ConfigError,
	FIRST_PARTY_MODULES,
	loadDatabaseUrl,
	loadMasterKey,
	MASTER_KEY_MIN_LENGTH,
	type MasterKey,
	moduleSchemas,
	OLD_MASTER_KEY_VARIABLE,
	parseMasterKey,
	replaceLostMasterKey,
	rotateMasterKey,
	systemClock,
} from "@webcraft/core";
import { assertSchemaCurrent, openDatabase } from "@webcraft/db";

export type RotateKeyOptions = { oldKeyFile?: string; oldKeyLost: boolean; confirmFingerprint?: string };

/**
 * Reads `[--old-key-file <path> | --old-key-lost [--confirm-fingerprint <hex>]]`; null for
 * anything else.
 */
export function parseRotateKeyOptions(args: string[]): RotateKeyOptions | null {
	const options: RotateKeyOptions = { oldKeyLost: false };
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		const value = (name: string): string | undefined => {
			if (arg === name && args[index + 1]) return args[++index];
			if (arg.startsWith(`${name}=`) && arg.length > name.length + 1) return arg.slice(name.length + 1);
			return undefined;
		};
		if (arg === "--old-key-lost") {
			options.oldKeyLost = true;
			continue;
		}
		const oldKeyFile = value("--old-key-file");
		if (oldKeyFile !== undefined) {
			options.oldKeyFile = oldKeyFile;
			continue;
		}
		const confirmFingerprint = value("--confirm-fingerprint");
		if (confirmFingerprint !== undefined) {
			options.confirmFingerprint = confirmFingerprint;
			continue;
		}
		return null;
	}
	return options.confirmFingerprint !== undefined && !options.oldKeyLost ? null : options;
}

export async function rotateKey(options: RotateKeyOptions): Promise<number> {
	const databaseUrl = loadDatabaseUrl(process.env);
	const newKey = loadMasterKey(process.env);
	if (options.oldKeyLost) {
		if (options.oldKeyFile !== undefined || process.env[OLD_MASTER_KEY_VARIABLE]) {
			throw new ConfigError("--old-key-lost is for when the old key is lost; don't pass the old key with it.");
		}
		return replaceLostKey(databaseUrl, newKey, options.confirmFingerprint);
	}
	const oldKey = await loadOldKey(options);

	const database = openDatabase(databaseUrl, { maxConnections: 1, applicationName: "webcraft-rotate-key" });
	try {
		await assertSchemaCurrent(database, { modules: moduleSchemas(FIRST_PARTY_MODULES) });
		const report = await rotateMasterKey({
			database,
			from: oldKey.key,
			to: newKey,
			clock: systemClock,
			sources: { from: oldKey.source, to: "WEBCRAFT_SECRET_KEY" },
		});
		if (report.outcome === "already-current") {
			process.stdout.write(
				`The Install already uses this Master key (version ${report.version}); nothing was re-encrypted.\n`,
			);
			return 0;
		}
		process.stdout.write(
			`Re-encrypted ${countSecrets(report.reencrypted)} under Master key version ${report.version}.\n` +
				`Fingerprint of the new Master key: ${report.fingerprint}\n` +
				"Start web and worker with the new key in WEBCRAFT_SECRET_KEY, and keep a copy of it outside the server. The old key no longer opens anything.\n",
		);
		return 0;
	} finally {
		await database.close();
	}
}

async function replaceLostKey(
	databaseUrl: string,
	newKey: MasterKey,
	confirmFingerprint: string | undefined,
): Promise<number> {
	const database = openDatabase(databaseUrl, { maxConnections: 1, applicationName: "webcraft-rotate-key" });
	try {
		await assertSchemaCurrent(database, { modules: moduleSchemas(FIRST_PARTY_MODULES) });
		const report = await replaceLostMasterKey({ database, to: newKey, clock: systemClock, confirmFingerprint });
		const list = (secrets: string[]) => secrets.map((secret) => `  ${secret}\n`).join("");
		if (report.outcome === "needs-confirmation") {
			const confirm = report.lostFingerprint.slice(0, CONFIRM_FINGERPRINT_LENGTH);
			process.stdout.write(
				`Without the old Master key ${countSecrets(report.secrets.length, "these")} can't be decrypted, so they would be deleted:\n` +
					list(report.secrets) +
					`The Install's current Master key is version ${report.lostVersion}, fingerprint ${report.lostFingerprint}.\n` +
					"WEBCRAFT_SECRET_KEY is not that key. If you still have it, or mistyped the new key, stop here: use rotate-key with the old key instead.\n" +
					`If it is lost, run again with --confirm-fingerprint ${confirm} to delete these secrets and use the new key. Then set them again.\n`,
			);
			return 1;
		}
		process.stdout.write(
			`Deleted ${countSecrets(report.deleted.length)}. The Install now uses Master key version ${report.version}.\n` +
				`Fingerprint of the new Master key: ${report.fingerprint}\n` +
				(report.deleted.length > 0 ? `Set these secrets again:\n${list(report.deleted)}` : "") +
				"Start web and worker with the new key in WEBCRAFT_SECRET_KEY, and keep a copy of it outside the server.\n",
		);
		return 0;
	} finally {
		await database.close();
	}
}

/** "3 secrets", "1 secret", or with a word before the number: "these 3 secrets". */
function countSecrets(count: number, before?: string): string {
	const counted = `${count} secret${count === 1 ? "" : "s"}`;
	return before ? `${count === 1 ? "this" : before} ${counted}` : counted;
}

/** The key being replaced, from `--old-key-file` or `WEBCRAFT_OLD_SECRET_KEY` (not both). */
async function loadOldKey({ oldKeyFile }: RotateKeyOptions): Promise<{ key: MasterKey; source: string }> {
	const fromEnvironment = process.env[OLD_MASTER_KEY_VARIABLE];
	if (oldKeyFile !== undefined && fromEnvironment) {
		throw new ConfigError(
			`Give the key being replaced once: either in ${OLD_MASTER_KEY_VARIABLE} or with --old-key-file, not both.`,
		);
	}
	const source = oldKeyFile === undefined ? OLD_MASTER_KEY_VARIABLE : `the file ${oldKeyFile}`;
	let value = fromEnvironment;
	if (oldKeyFile !== undefined) {
		try {
			value = await readFile(oldKeyFile, "utf8");
		} catch (error) {
			throw new ConfigError(`Cannot read ${source}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	if (!value?.trim()) {
		throw new ConfigError(
			`Pass the Install's current Master key, the one being replaced, in ${OLD_MASTER_KEY_VARIABLE} or with --old-key-file <path>. WEBCRAFT_SECRET_KEY holds the new key.`,
		);
	}
	try {
		return { key: parseMasterKey(value, source), source };
	} catch {
		throw new ConfigError(`${source} can't be a Master key: it is shorter than ${MASTER_KEY_MIN_LENGTH} characters.`);
	}
}
