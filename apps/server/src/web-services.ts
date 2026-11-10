import {
	assertMasterKeyMatches,
	createLogger,
	FIRST_PARTY_MODULES,
	type InstallServices,
	loadInstallConfig,
	loadMasterKey,
	logSettings,
	moduleSchemas,
	openInstall,
} from "@webcraft/core";
import { assertSchemaCurrent, openDatabase } from "@webcraft/db";
import type { ModuleDefinition } from "@webcraft/module-sdk";
import { createBunHttp } from "./outgoing-http.ts";

type Cache = { webcraftWebServices?: Promise<InstallServices> };

/**
 * The Modules the web process loads: this build's first-party Modules, unless the program that
 * starts the web process in its own process hands it others first, in `globalThis.webcraftModules`
 * (the browser tests' entry does, to show the sample Modules' screens). Nothing sets it in
 * production; only code already running in the process could.
 */
export function webModules(): readonly ModuleDefinition[] {
	return (globalThis as { webcraftModules?: readonly ModuleDefinition[] }).webcraftModules ?? FIRST_PARTY_MODULES;
}

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
		await assertSchemaCurrent(database, { modules: moduleSchemas(webModules()) });
		await assertMasterKeyMatches(database, masterKey);
	} finally {
		await database.close();
	}
}

async function openWebServices(env: Record<string, string | undefined>): Promise<InstallServices> {
	const log = createLogger({ fields: { process: "web" }, ...logSettings(env) });
	const { services } = await openInstall({
		env,
		processName: "web",
		log,
		modules: webModules(),
		http: createBunHttp(),
	});
	// On an Install with no Superadmin, prints the setup token that unlocks the setup wizard.
	await services.setup.announce();
	// The 404 log's misses wait here a few seconds, then go to the job queue together.
	const handOver = setInterval(() => {
		services.modules.flushMisses().catch((error: unknown) => {
			log.warn("Misses for the 404 log couldn't be handed over", { error });
		});
	}, MISS_HAND_OVER_MS);
	handOver.unref();
	// The worker works Install health out every minute; when its checks stop (it is down), the web
	// process does, so the Health alert that the worker is failing still goes out.
	const standIn = setInterval(() => {
		services.health.checkIfStale().catch((error: unknown) => {
			log.warn("Install health couldn't be worked out", { error });
		});
	}, HEALTH_STAND_IN_MS);
	standIn.unref();
	return services;
}

/** How often the web process looks whether the worker's Install health checks stopped. */
const HEALTH_STAND_IN_MS = 60_000;

/** How often the web process hands the misses it gathered for the 404 log to the job queue. */
const MISS_HAND_OVER_MS = 5000;
