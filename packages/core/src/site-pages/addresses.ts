import { type InstallConfig, isDevelopmentHostname } from "../config.ts";
import { RESERVED_SITE_SLUGS } from "../tenancy/sites.ts";

/**
 * A Site's Staging address: `<site slug>.<sites domain>` (`WEBCRAFT_SITES_DOMAIN`). Null when the
 * Install has no sites domain, or when the address would be the admin's own hostname (the admin host
 * is reserved: it never resolves to a Site).
 */
export function stagingHostname(config: Pick<InstallConfig, "sitesDomain" | "adminHost">, slug: string): string | null {
	if (!config.sitesDomain) return null;
	const hostname = `${slug}.${config.sitesDomain}`;
	return hostname === config.adminHost ? null : hostname;
}

/**
 * Where visitors reach a Site's Staging address, such as `https://bakery.sites.example.com`: HTTPS,
 * or plain HTTP on the web process's port for a development hostname under `.localhost` (the port
 * the admin is on: one web process serves both).
 */
export function stagingUrl(config: InstallConfig, slug: string): string | null {
	const hostname = stagingHostname(config, slug);
	if (!hostname) return null;
	if (!isDevelopmentHostname(hostname)) return `https://${hostname}`;
	const port = isDevelopmentHostname(config.adminHost) ? new URL(config.adminOrigin).port : "";
	return `http://${hostname}:${port || "3000"}`;
}

/**
 * The slug a Staging address hostname names, or undefined when the hostname isn't one: exactly one
 * label in front of the sites domain, and never the admin host.
 */
export function slugOfStagingHostname(
	config: Pick<InstallConfig, "sitesDomain" | "adminHost">,
	hostname: string,
): string | undefined {
	const { sitesDomain } = config;
	if (!sitesDomain || hostname === config.adminHost || !hostname.endsWith(`.${sitesDomain}`)) return undefined;
	const label = hostname.slice(0, -(sitesDomain.length + 1));
	return label && !label.includes(".") ? label : undefined;
}

/**
 * The slugs no Site may take on this Install: the ones kept everywhere (`admin`, `www`) and, when
 * the admin host sits right under the sites domain (`cms.example.com` under `example.com`), its first
 * label, so no Staging address can ever be the admin's hostname.
 */
export function reservedSlugs(config: Pick<InstallConfig, "sitesDomain" | "adminHost">): string[] {
	const { sitesDomain, adminHost } = config;
	const adminLabel =
		sitesDomain && adminHost.endsWith(`.${sitesDomain}`) ? adminHost.slice(0, -(sitesDomain.length + 1)) : undefined;
	return adminLabel && !adminLabel.includes(".") ? [...RESERVED_SITE_SLUGS, adminLabel] : [...RESERVED_SITE_SLUGS];
}
