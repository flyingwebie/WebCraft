import { createAuth } from "@webcraft/auth";

import { listAuditEntries } from "./audit.ts";
import { createInstallSettings } from "./install-settings.ts";
import { createMasterKeyBackup } from "./master-key-backup.ts";
import { createPeople } from "./people.ts";
import { loadPersonActor } from "./permissions/actors.ts";
import { type MasterKey, sessionSigningSecret } from "./secrets/master-key.ts";
import { createSecrets, installSecretsOnly, openSecrets } from "./secrets/store.ts";
import type { InstallPorts, InstallServices } from "./services.ts";
import { createInstallSetup } from "./setup.ts";
import { createDataLayer } from "./tenancy/data-layer.ts";
import { createSite, listSites } from "./tenancy/sites.ts";
import { createStaffServices } from "./tenancy/staff.ts";
import { createWorkspace, listWorkspaces } from "./tenancy/workspaces.ts";

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
	// Every secret; the data layer hands out a Workspace's or a Site's, `services.secrets` the Install's.
	const store = options.checkMasterKey === false ? createSecrets(secretsOptions) : await openSecrets(secretsOptions);
	const auth = createAuth({
		database,
		clock,
		adminOrigin: config.adminOrigin,
		secret: await sessionSigningSecret(masterKey),
		log,
	});
	const settings = createInstallSettings(database);
	return {
		...ports,
		secrets: installSecretsOnly(store),
		auth,
		people: createPeople({ database, clock }),
		setup: createInstallSetup({ database, auth, config, clock, log }),
		settings,
		masterKey: createMasterKeyBackup({ database, clock, log, fingerprint: await masterKey.fingerprint() }),
		data: createDataLayer({ database, clock, secrets: store }),
		actors: { person: (personId) => loadPersonActor(database.db, personId) },
		workspaces: {
			list: (access) => listWorkspaces(database, access),
			create: createWorkspace,
		},
		sites: { list: listSites, create: createSite },
		...createStaffServices({ database, auth, mailer: ports.mailer, settings, config, clock }),
		audit: { list: (scope, options) => listAuditEntries(scope.db, options) },
	};
}
