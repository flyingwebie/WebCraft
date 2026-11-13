import { openDatabase } from "@webcraft/db";
import type { AnyModuleDefinition } from "@webcraft/module-sdk";

import { systemClock } from "../clock.ts";
import { type Environment, loadInstallConfig } from "../config.ts";
import type { OutgoingHttp } from "../http.ts";
import type { Logger } from "../log.ts";
import { FIRST_PARTY_MODULES } from "../modules/first-party.ts";
import { assertMasterKeyMatches } from "../secrets/key-versions.ts";
import { loadMasterKey } from "../secrets/master-key.ts";
import { createSecrets } from "../secrets/store.ts";
import type { BackupContext } from "./take.ts";

/**
 * What a server command needs to take a Backup (`webcraft admin backup`, and the migrate step before
 * it changes anything), from the Install's environment. It works on a database that is behind this
 * version, but refuses a Master key that isn't the Install's: a Backup must name the key its
 * secrets open with. Close it when done.
 */
export async function openBackupForCommand(options: {
	env: Environment;
	log: Logger;
	http: OutgoingHttp;
	modules?: readonly AnyModuleDefinition[];
}): Promise<{ context: BackupContext; close(): Promise<void> }> {
	const config = loadInstallConfig(options.env);
	const masterKey = loadMasterKey(options.env);
	const database = openDatabase(config.databaseUrl, { maxConnections: 3, applicationName: "webcraft-backup" });
	try {
		await assertMasterKeyMatches(database, masterKey);
	} catch (error) {
		await database.close();
		throw error;
	}
	return {
		context: {
			database,
			storageDir: config.storageDir,
			backupDir: config.backupDir,
			fingerprint: await masterKey.fingerprint(),
			secrets: createSecrets({ database, masterKey, clock: systemClock }),
			http: options.http,
			clock: systemClock,
			log: options.log,
			modules: options.modules ?? FIRST_PARTY_MODULES,
		},
		close: () => database.close(),
	};
}
