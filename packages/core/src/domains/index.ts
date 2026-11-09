import type { SiteScope } from "../tenancy/data-layer.ts";
import {
	addDomain,
	type DomainsDeps,
	listDomains,
	makePrimary,
	type NewDomain,
	type SiteDomain,
	type SiteDomainList,
} from "./domains.ts";

export {
	type DnsRecord,
	type DomainProblem,
	type DomainRole,
	type DomainStatus,
	type NewDomain,
	type SiteDomain,
	type SiteDomainList,
	setLanguageDomain,
} from "./domains.ts";
export {
	type DomainChangeProblem,
	DomainChangeRefusedError,
	DomainInvalidError,
	type DomainInvalidReason,
	DomainNotFoundError,
	DomainTakenError,
} from "./errors.ts";
export { displayName, domainName, isInstallName, partnerOf } from "./names.ts";

/**
 * A Site's domains (ADR 0015): Primary, Redirect and language domains, their verification and the
 * Domain check. Open the Site with `site.view` to list them and `structure.edit` to change them.
 */
export type Domains = {
	/** The Site's domains, the Primary domain first, with the DNS records to create for each. */
	list(scope: SiteScope): Promise<SiteDomainList>;
	/** Adds a domain (and its `www` or apex partner when asked); answers what was added. */
	add(scope: SiteScope, input: NewDomain): Promise<SiteDomain[]>;
	/** Makes a verified domain the Primary domain; the one before becomes a Redirect domain. */
	makePrimary(scope: SiteScope, domainId: string): Promise<SiteDomainList>;
};

export function createDomains(deps: DomainsDeps): Domains {
	return {
		list: (scope) => listDomains(deps, scope),
		add: (scope, input) => addDomain(deps, scope, input),
		makePrimary: (scope, domainId) => makePrimary(deps, scope, domainId),
	};
}
