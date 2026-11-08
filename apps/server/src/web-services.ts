import {
	createLogger,
	type InstallConfig,
	type InstallServices,
	loadInstallConfig,
	loadMasterKey,
	type MasterKey,
	openInstall,
} from "@webcraft/core";

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
 * Reads and checks the web process's settings, refusing to go on when one is missing or malformed
 * (including a Master key shorter than 32 characters). The production entry calls it before it
 * loads the server bundle, so a bad setting is reported first.
 */
export function loadWebSettings(env: Record<string, string | undefined>): {
	config: InstallConfig;
	masterKey: MasterKey;
} {
	return { config: loadInstallConfig(env), masterKey: loadMasterKey(env) };
}

async function openWebServices(env: Record<string, string | undefined>): Promise<InstallServices> {
	const log = createLogger({ fields: { process: "web" } });
	const { services } = await openInstall({ env, processName: "web", log });
	return services;
}
