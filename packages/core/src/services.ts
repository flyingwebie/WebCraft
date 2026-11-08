import type { Auth } from "@webcraft/auth";
import type { Database } from "@webcraft/db";

import type { Clock } from "./clock.ts";
import type { InstallConfig } from "./config.ts";
import type { OutgoingHttp } from "./http.ts";
import type { InstallSettings } from "./install-settings.ts";
import type { JobQueue } from "./jobs/define.ts";
import type { Logger } from "./log.ts";
import type { Mailer } from "./mailer.ts";
import type { MasterKeyBackup } from "./master-key-backup.ts";
import type { People } from "./people.ts";
import type { Secrets } from "./secrets/store.ts";
import type { InstallSetup } from "./setup.ts";

/**
 * The edges of a running Install: real adapters in the processes, fakes in tests. Everything else
 * in `InstallServices` is built on top of them by `createInstallServices`.
 */
export type InstallPorts = {
	config: InstallConfig;
	database: Database;
	jobs: JobQueue;
	mailer: Mailer;
	http: OutgoingHttp;
	clock: Clock;
	log: Logger;
};

/**
 * Everything a running Install's code works with. The web process, the worker and the test
 * harness each build one with `createInstallServices`: real adapters in the processes, fakes at the
 * edges in tests.
 */
export type InstallServices = InstallPorts & {
	/** Every stored secret, encrypted under the Master key; write-only. */
	secrets: Secrets;
	/** Signing in and out, and sessions. */
	auth: Auth;
	/** People with an account, and their admin preferences. */
	people: People;
	/** The setup wizard and its token. */
	setup: InstallSetup;
	/** Install settings › General. */
	settings: InstallSettings;
	/** Whether the Superadmin has stored the Master key outside the server. */
	masterKey: MasterKeyBackup;
};
