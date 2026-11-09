import { isIP } from "node:net";
import { domainToASCII, domainToUnicode } from "node:url";

import type { InstallConfig } from "../config.ts";
import { normaliseHostname } from "../hostnames.ts";
import { wwwPartnerOf } from "./partner.ts";

/**
 * A domain as WebCraft keeps it: DNS labels of letters, digits and dashes, separated by dots, ending in
 * a name that starts with a letter (so never an IP address), at most 253 characters. International
 * names are kept in their ASCII form (`xn--…`).
 */
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * A domain as typed (`Bäckerei.example.`, `WWW.Bakery.ie`) in the form WebCraft keeps and compares it
 * in: lower case, without the trailing dot, international names in their ASCII form. Null when it
 * isn't a domain: an address with a scheme, a path or a port, an IP address, a wildcard, a single
 * name without a dot.
 */
export function domainName(input: string): string | null {
	const typed = normaliseHostname(input);
	if (!typed || /[\s/:@?#*\\[\]]/.test(typed) || isIP(typed) !== 0) return null;
	const ascii = domainToASCII(typed);
	return ascii && DOMAIN.test(ascii) ? ascii : null;
}

/** A domain kept in its ASCII form, as people read it: `xn--bckerei-mller-wib2w.example` is `bäckerei-müller.example`. */
export function displayName(name: string): string {
	return domainToUnicode(name) || name;
}

/**
 * Whether a domain is one of the Install's own names, which no Site may take: the admin host, the
 * sites domain and every name under it (the Staging addresses).
 */
export function isInstallName(config: Pick<InstallConfig, "adminHost" | "sitesDomain">, name: string): boolean {
	const { adminHost, sitesDomain } = config;
	return name === adminHost || (sitesDomain !== null && (name === sitesDomain || name.endsWith(`.${sitesDomain}`)));
}

/** The domain offered with another, apex and `www` together: `www.bakery.ie` for `bakery.ie`, and back. */
export function partnerOf(name: string): string | null {
	const partner = wwwPartnerOf(name);
	return partner !== null && DOMAIN.test(partner) ? partner : null;
}
