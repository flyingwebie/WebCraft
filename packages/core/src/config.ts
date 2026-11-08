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
	/**
	 * Where people reach the admin, such as `https://admin.example.com`: always HTTPS, except for a
	 * development hostname under `.localhost`, which is plain HTTP on `PORT`.
	 */
	adminOrigin: string;
	/**
	 * The domain Staging addresses sit under (`WEBCRAFT_SITES_DOMAIN`): each Site answers on
	 * `<site slug>.<sites domain>`. Null when it isn't set: Sites then have no Staging address.
	 */
	sitesDomain: string | null;
};

export type Environment = Record<string, string | undefined>;

/** A setting is missing or malformed. The message names the variable and how to fix it. */
export class ConfigError extends Error {
	override name = "ConfigError";
}

/** Reads the settings every process needs, refusing to go on when one is missing or wrong. */
export function loadInstallConfig(env: Environment): InstallConfig {
	const adminHost = loadAdminHost(env);
	return {
		databaseUrl: loadDatabaseUrl(env),
		adminHost,
		adminOrigin: adminOriginFor(adminHost, env.PORT),
		sitesDomain: loadSitesDomain(env),
	};
}

/** Development hostnames: the browser reaches them over plain HTTP on this machine. */
export function isDevelopmentHostname(hostname: string): boolean {
	return hostname === "localhost" || hostname.endsWith(".localhost");
}

/** The admin's origin: HTTPS, or plain HTTP on `port` (default 3000) for a `.localhost` hostname. */
export function adminOriginFor(adminHost: string, port?: string): string {
	return isDevelopmentHostname(adminHost) ? `http://${adminHost}:${port?.trim() || "3000"}` : `https://${adminHost}`;
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

/** A hostname: dot-separated DNS labels, lower case. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

function loadAdminHost(env: Environment): string {
	const value = env.WEBCRAFT_ADMIN_HOST?.trim();
	if (!value) {
		throw new ConfigError(
			"WEBCRAFT_ADMIN_HOST is not set. Set it to the hostname of the admin, for example admin.example.com.",
		);
	}
	const host = normaliseHostname(value);
	if (!HOSTNAME.test(host)) {
		throw new ConfigError(
			`WEBCRAFT_ADMIN_HOST must be a hostname only, without a scheme, port or path (got "${value}").`,
		);
	}
	return host;
}

/** Reads `WEBCRAFT_SITES_DOMAIN`, which is optional: without it Sites have no Staging address. */
function loadSitesDomain(env: Environment): string | null {
	const value = env.WEBCRAFT_SITES_DOMAIN?.trim();
	if (!value) return null;
	const domain = normaliseHostname(value);
	if (!HOSTNAME.test(domain)) {
		throw new ConfigError(
			`WEBCRAFT_SITES_DOMAIN must be a domain only, without a scheme, port or path, such as sites.example.com (got "${value}").`,
		);
	}
	return domain;
}
