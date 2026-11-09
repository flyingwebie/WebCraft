import { siteDomains } from "@webcraft/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";

import { type InstallConfig, isDevelopmentHostname } from "../config.ts";
import type { Languages } from "../content/field-values.ts";
import { prefixOf } from "../content/languages.ts";
import { stagingUrl } from "../site-pages/addresses.ts";
import type { Executor, Site } from "../tenancy/data-layer.ts";

/**
 * Where a Site's pages are for visitors (ADR 0015, ADR 0010): the Default language's pages, and every
 * other language's under its prefix, on the Site's main address (its verified Primary domain, else its
 * Staging address); a language with a verified domain of its own, there without a prefix. Absolute
 * addresses on pages come from here: `hreflang` alternates and the Language switcher's links between
 * domains now, and canonical URLs, sitemaps and Media URLs that leave the page later.
 */
export type SiteAddresses = {
	/** The origin of the Default language's pages and of every language without a domain of its own. */
	main: string;
	/** The origin of each language with a verified domain of its own, by code. */
	languages: Readonly<Record<string, string>>;
};

/** A domain's origin: `https://<domain>`, or plain HTTP on the web process's port for a development name under `.localhost`. */
export function domainOrigin(config: Pick<InstallConfig, "adminHost" | "adminOrigin">, name: string): string {
	if (!isDevelopmentHostname(name)) return `https://${name}`;
	const port = isDevelopmentHostname(config.adminHost) ? new URL(config.adminOrigin).port : "";
	return `http://${name}:${port || "3000"}`;
}

/** A Site's verified domains: the Primary domain (or none) and the languages' own. */
export async function verifiedDomains(
	executor: Executor,
	site: Pick<Site, "id" | "workspaceId">,
): Promise<{ primary: string | null; languages: { name: string; language: string }[] }> {
	const rows = await executor
		.select({ name: siteDomains.name, role: siteDomains.role, language: siteDomains.language })
		.from(siteDomains)
		.where(
			and(
				eq(siteDomains.workspaceId, site.workspaceId),
				eq(siteDomains.siteId, site.id),
				isNotNull(siteDomains.verifiedAt),
			),
		);
	return {
		primary: rows.find((row) => row.role === "primary")?.name ?? null,
		languages: rows.flatMap((row) =>
			row.role === "language" && row.language ? [{ name: row.name, language: row.language }] : [],
		),
	};
}

/**
 * Where a Site's pages are for visitors: on its verified Primary domain and its languages' verified
 * domains; on its Staging address while it has no verified Primary domain. Null when it has neither.
 */
export async function siteAddresses(
	executor: Executor,
	config: InstallConfig,
	site: Pick<Site, "id" | "workspaceId" | "slug">,
): Promise<SiteAddresses | null> {
	const verified = await verifiedDomains(executor, site);
	const main = verified.primary ? domainOrigin(config, verified.primary) : stagingUrl(config, site.slug);
	if (!main) return null;
	const languages = Object.fromEntries(
		verified.languages.map(({ name, language }) => [language, domainOrigin(config, name)]),
	);
	return { main, languages };
}

/**
 * Where a path in a language is (the path as the Site writes it there, under the language's prefix):
 * on the language's own domain without the prefix, else on the main address as it is.
 */
export function placeOf(
	addresses: SiteAddresses,
	languages: Languages,
	path: string,
): { origin: string; path: string } {
	const own = addresses.languages[languages.language];
	if (!own) return { origin: addresses.main, path };
	if (languages.language === languages.defaultLanguage) return { origin: own, path };
	const prefix = `/${prefixOf(languages.language)}`;
	const rest = path === prefix ? "/" : path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
	return { origin: own, path: rest };
}
