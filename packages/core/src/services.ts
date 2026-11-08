import type { Database } from "@webcraft/db";

import type { Clock } from "./clock.ts";
import type { InstallConfig } from "./config.ts";
import type { OutgoingHttp } from "./http.ts";
import type { JobQueue } from "./jobs/define.ts";
import type { Logger } from "./log.ts";
import type { Mailer } from "./mailer.ts";
import type { Secrets } from "./secrets/store.ts";

/**
 * Everything a running Install's code works with. The web process, the worker and the test
 * harness each build one: real adapters in the processes, fakes at the edges in tests.
 */
export type InstallServices = {
	config: InstallConfig;
	database: Database;
	jobs: JobQueue;
	mailer: Mailer;
	/** Every stored secret, encrypted under the Master key; write-only. */
	secrets: Secrets;
	http: OutgoingHttp;
	clock: Clock;
	log: Logger;
};
