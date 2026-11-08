import {
	assertMasterKeyMatches,
	createLogger,
	type InstallServices,
	loadInstallConfig,
	loadMasterKey,
	openInstall,
} from "@webcraft/core";
import { assertSchemaCurrent, openDatabase } from "@webcraft/db";

type Cache = { webcraftWebServices?: Promise<InstallServices> };

/**
 * Builds the web process's services from the environment, refusing to start when a setting is
 * missing or the database is behind (ADR 0031). `vite dev` re-runs the server entry after every
 * change, so the services are kept on `globalThis` and opened only once per process.
 */
export function startWebServices(env: Record<string, string | undefined> = process.env): Promise<InstallServices> {
	const cache = globalThis as Cache;
	cache.webcraftWebServices ??= openWebServices(env).catch((error: unknown) => {
		cache.webcraftWebServices = undefined;
		throw error;
	});
	return cache.webcraftWebServices;
}

/**
 * What the production entry checks before it loads the server bundle: the settings, that the
 * database is current, and that the Master key is the one the Install's secrets are encrypted
 * under. A wrong setting is then reported first, in plain words.
 */
export async function checkWebSettings(env: Record<string, string | undefined>): Promise<void> {
	const config = loadInstallConfig(env);
	const masterKey = loadMasterKey(env);
	const database = openDatabase(config.databaseUrl, { maxConnections: 1, applicationName: "webcraft-web" });
	try {
		await assertSchemaCurrent(database);
		await assertMasterKeyMatches(database, masterKey);
	} finally {
		await database.close();
	}
}

async function openWebServices(env: Record<string, string | undefined>): Promise<InstallServices> {
	const log = createLogger({ fields: { process: "web" } });
	const { services } = await openInstall({ env, processName: "web", log });
	return services;
}
