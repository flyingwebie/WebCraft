import { createAuth } from "@webcraft/auth";

import { createInstallSettings } from "./install-settings.ts";
import { createMasterKeyBackup } from "./master-key-backup.ts";
import { createPeople } from "./people.ts";
import { type MasterKey, sessionSigningSecret } from "./secrets/master-key.ts";
import { createSecrets, openSecrets } from "./secrets/store.ts";
import type { InstallPorts, InstallServices } from "./services.ts";
import { createInstallSetup } from "./setup.ts";

export type CreateServicesOptions = {
	/**
	 * Refuse a Master key that isn't the Install's current one, as web and worker do when they
	 * start (default). Only code that must not read the database yet turns this off.
	 */
	checkMasterKey?: boolean;
};

/**
 * Builds an Install's services on top of its ports and Master key. Web, worker and the test harness
 * all build them here, so they work the same way everywhere.
 */
export async function createInstallServices(
	ports: InstallPorts,
	masterKey: MasterKey,
	options: CreateServicesOptions = {},
): Promise<InstallServices> {
	const { database, clock, log, config } = ports;
	const secretsOptions = { database, masterKey, clock };
	const secrets = options.checkMasterKey === false ? createSecrets(secretsOptions) : await openSecrets(secretsOptions);
	const auth = createAuth({
		database,
		clock,
		adminOrigin: config.adminOrigin,
		secret: await sessionSigningSecret(masterKey),
		log,
	});
	return {
		...ports,
		secrets,
		auth,
		people: createPeople({ database, clock }),
		setup: createInstallSetup({ database, auth, config, clock, log }),
		settings: createInstallSettings(database),
		masterKey: createMasterKeyBackup({ database, clock, log, fingerprint: await masterKey.fingerprint() }),
	};
}
