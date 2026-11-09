import { isIP } from "node:net";
import { isAbsolute, resolve } from "node:path";

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
	/**
	 * The folder Media and other files are kept in while the Install's storage is local disk
	 * (`WEBCRAFT_STORAGE_DIR`, `storage` in the folder the process starts in unless set). Web and
	 * worker must both see the same folder: on a server, a mounted volume.
	 */
	storageDir: string;
	/**
	 * What answers HTTPS for the Install (`WEBCRAFT_EDGE`, ADR 0015): `caddy` on a VPS (Caddy issues
	 * certificates on demand, asking the Install first), or the platform's own proxy on `coolify` and
	 * `railway`, where Staff also add each domain in the platform's panel.
	 */
	edge: Edge;
	/**
	 * The Install's public IP addresses (`WEBCRAFT_PUBLIC_ADDRESSES`), IPv4 or IPv6: where a Site's
	 * domains point their A and AAAA records. Empty when not set: the admin then offers only a CNAME
	 * record to the admin host.
	 */
	publicAddresses: readonly string[];
	/**
	 * A file of address ranges and their countries (`WEBCRAFT_COUNTRY_FILE`), which Site analytics
	 * counts visits by country with; null when not set: every country is then unknown.
	 */
	countryFile: string | null;
};

/** What answers HTTPS for an Install: Caddy on a VPS, or the platform's proxy (ADR 0015). */
export const EDGES = ["caddy", "coolify", "railway"] as const;

export type Edge = (typeof EDGES)[number];

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
		storageDir: loadStorageDir(env),
		edge: loadEdge(env),
		publicAddresses: loadPublicAddresses(env),
		countryFile: loadCountryFile(env),
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

/** Reads `WEBCRAFT_COUNTRY_FILE`, which is optional: a path, relative to the folder the process starts in or absolute. */
function loadCountryFile(env: Environment): string | null {
	const value = env.WEBCRAFT_COUNTRY_FILE?.trim();
	return value ? resolve(value) : null;
}

/**
 * Reads `WEBCRAFT_STORAGE_DIR`: an absolute folder, or `storage` in the folder the process starts in
 * when it isn't set (`bun run dev` sets it, so web and worker share one).
 */
function loadStorageDir(env: Environment): string {
	const value = env.WEBCRAFT_STORAGE_DIR?.trim();
	if (!value) return resolve(process.cwd(), "storage");
	if (!isAbsolute(value)) {
		throw new ConfigError(
			`WEBCRAFT_STORAGE_DIR must be an absolute path, such as /var/lib/webcraft/storage (got "${value}").`,
		);
	}
	return resolve(value);
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

/** Reads `WEBCRAFT_EDGE`: `caddy` unless set. */
function loadEdge(env: Environment): Edge {
	const value = env.WEBCRAFT_EDGE?.trim().toLowerCase();
	if (!value) return "caddy";
	if (!(EDGES as readonly string[]).includes(value)) {
		throw new ConfigError(`WEBCRAFT_EDGE must be one of ${EDGES.join(", ")} (got "${env.WEBCRAFT_EDGE}").`);
	}
	return value as Edge;
}

/** Reads `WEBCRAFT_PUBLIC_ADDRESSES`: IP addresses separated by commas, optional. */
function loadPublicAddresses(env: Environment): string[] {
	const value = env.WEBCRAFT_PUBLIC_ADDRESSES?.trim();
	if (!value) return [];
	const addresses = value
		.split(",")
		.map((address) => address.trim().toLowerCase())
		.filter(Boolean);
	const wrong = addresses.find((address) => isIP(address) === 0);
	if (wrong !== undefined) {
		throw new ConfigError(
			`WEBCRAFT_PUBLIC_ADDRESSES must be IP addresses separated by commas, such as 203.0.113.10,2001:db8::10 (got "${wrong}").`,
		);
	}
	return [...new Set(addresses)];
}
