import { normaliseHostname } from "./hostnames.ts";

/** Settings every WebCraft process reads from its environment. */
export type InstallConfig = {
	/** Connection string for the Install's one Postgres database. */
	databaseUrl: string;
	/**
	 * The reserved hostname of the admin. It serves the admin, the APIs, `/healthz` and
	 * `/readyz`; every other hostname is resolved to a Site.
	 */
	adminHost: string;
};

export type Environment = Record<string, string | undefined>;

/** A setting is missing or malformed. The message names the variable and how to fix it. */
export class ConfigError extends Error {
	override name = "ConfigError";
}

/** Reads the settings every process needs, refusing to go on when one is missing or wrong. */
export function loadInstallConfig(env: Environment): InstallConfig {
	return {
		databaseUrl: loadDatabaseUrl(env),
		adminHost: loadAdminHost(env),
	};
}

/** Reads `DATABASE_URL`, the only setting the `migrate` step needs. */
export function loadDatabaseUrl(env: Environment): string {
	const value = env.DATABASE_URL?.trim();
	if (!value) {
		throw new ConfigError(
			"DATABASE_URL is not set. Set it to the Install's Postgres connection string, for example postgres://user:password@host:5432/webcraft.",
		);
	}
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new ConfigError("DATABASE_URL is not a valid URL.");
	}
	if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
		throw new ConfigError("DATABASE_URL must start with postgres:// or postgresql://.");
	}
	return value;
}

function loadAdminHost(env: Environment): string {
	const value = env.WEBCRAFT_ADMIN_HOST?.trim();
	if (!value) {
		throw new ConfigError(
			"WEBCRAFT_ADMIN_HOST is not set. Set it to the hostname of the admin, for example admin.example.com.",
		);
	}
	const host = normaliseHostname(value);
	if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(host)) {
		throw new ConfigError(
			`WEBCRAFT_ADMIN_HOST must be a hostname only, without a scheme, port or path (got "${value}").`,
		);
	}
	return host;
}
