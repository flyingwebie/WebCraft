import type { Database } from "@webcraft/db";
import { siteDomains, sites } from "@webcraft/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Clock } from "../clock.ts";
import type { InstallConfig } from "../config.ts";
import type { Dns } from "../dns.ts";
import type { Email } from "../email/index.ts";
import type { OutgoingHttp } from "../http.ts";
import type { Logger } from "../log.ts";
import { SHARE_LINK_LABEL } from "../reports/share-links.ts";
import { slugOfStagingHostname } from "../site-pages/addresses.ts";
import type { DataLayer, SiteScope } from "../tenancy/data-layer.ts";
import type { TlsProbe } from "../tls.ts";
import { createVerificationSigner } from "./checks.ts";
import { checkLiveDomain, type LiveCheckPorts, liveDomains } from "./domain-check.ts";
import {
	addDomain,
	type DomainRemoval,
	domainView,
	findDomain,
	listDomains,
	makePrimary,
	type NewDomain,
	removeDomain,
	type SiteDomain,
	type SiteDomainList,
} from "./domains.ts";
import {
	claimDueVerifications,
	type DueDomain,
	restartVerification,
	verificationAnswer,
	verifyOnce,
} from "./verification.ts";

export { domainOrigin, placeOf, type SiteAddresses, siteAddresses } from "./addresses.ts";
export { VERIFY_PATH } from "./checks.ts";
export {
	type DnsRecord,
	type DomainProblem,
	type DomainRemoval,
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
export {
	domainsCheck,
	domainsCheckAll,
	domainsCheckAllSchedule,
	domainsVerify,
	domainsVerifyDue,
	domainsVerifyDueSchedule,
} from "./jobs.ts";
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
	/**
	 * Removes a domain in two steps: without `confirmation` it answers what it would remove and a
	 * confirmation id; with it, the domain is removed and stops working at once.
	 */
	remove(scope: SiteScope, domainId: string, confirmation?: string): Promise<DomainRemoval>;
	/**
	 * Checks a domain now (Check now): one waiting for DNS is verified when it reaches the Install, and
	 * otherwise checked every few minutes again, as when it was added; a live one gets its Domain check.
	 */
	check(scope: SiteScope, domainId: string): Promise<SiteDomain>;
	/**
	 * What `/_webcraft/verify/<token>` answers on a hostname: the Install's own answer for one of its
	 * domains' tokens, or null (a plain 404).
	 */
	verificationAnswer(hostname: string, token: string): Promise<string | null>;
	/**
	 * Whether a certificate may be issued for a hostname (Caddy's ask, ADR 0015): the admin host, the
	 * Staging address of a Site, or a verified domain. Reads at most one row, and writes nothing.
	 */
	approvesCertificate(hostname: string): Promise<boolean>;
	/** For the worker: claims the verification checks that are due across the Install. */
	claimDueVerifications(): Promise<DueDomain[]>;
	/** For the worker: one claimed verification check. */
	verifyQueued(siteId: string, domainId: string): Promise<void>;
	/** For the worker: the verified domains of the Install, for the hourly Domain check. */
	liveDomains(): Promise<DueDomain[]>;
	/** For the worker: the Domain check of one verified domain. */
	checkQueued(siteId: string, domainId: string): Promise<void>;
};

export type DomainsOptions = {
	config: InstallConfig;
	database: Database;
	data: DataLayer;
	http: OutgoingHttp;
	dns: Dns;
	tls: TlsProbe;
	clock: Clock;
	log: Logger;
	/** System emails, for the `domain-unreachable` email to the Site's Owners. */
	email: Email;
	/** The key verification signs with, derived from the Master key (`domainVerificationKey`). */
	verificationKey: CryptoKey;
};

export function createDomains(options: DomainsOptions): Domains {
	const { config, database, data, clock, log } = options;
	const deps = { config };
	const signer = createVerificationSigner(options.verificationKey);
	const ports: LiveCheckPorts = {
		config,
		http: options.http,
		dns: options.dns,
		tls: options.tls,
		signer,
		log,
		email: options.email,
	};
	return {
		list: (scope) => listDomains(deps, scope),
		add: (scope, input) => addDomain(deps, scope, input),
		makePrimary: (scope, domainId) => makePrimary(deps, scope, domainId),
		remove: (scope, domainId, confirmation) => removeDomain(deps, scope, domainId, confirmation),
		async check(scope, domainId) {
			let row = await findDomain(scope, domainId);
			if (row.verifiedAt !== null) return domainView(deps, await checkLiveDomain(ports, scope, row));
			row = await verifyOnce(ports, scope, row);
			if (row.verifiedAt === null) row = await restartVerification(scope, row);
			return domainView(deps, row);
		},
		verificationAnswer: (hostname, token) => verificationAnswer(database, signer, hostname, token),
		async approvesCertificate(hostname) {
			if (hostname === config.adminHost) return true;
			const slug = slugOfStagingHostname(config, hostname);
			// The Share link address (`share.<sites domain>`) answers whether any Share link exists.
			if (slug === SHARE_LINK_LABEL) return true;
			if (slug) {
				const [site] = await database.db.select({ id: sites.id }).from(sites).where(eq(sites.slug, slug));
				return site !== undefined;
			}
			const [domain] = await database.db
				.select({ id: siteDomains.id })
				.from(siteDomains)
				.where(and(eq(siteDomains.name, hostname), isNotNull(siteDomains.verifiedAt)));
			return domain !== undefined;
		},
		claimDueVerifications: () => claimDueVerifications(database, clock.now()),
		async verifyQueued(siteId, domainId) {
			const scope = await data.background(siteId);
			const row = scope ? await findDomain(scope, domainId).catch(() => null) : null;
			if (!scope || !row || row.verifiedAt !== null) return;
			await verifyOnce(ports, scope, row);
		},
		liveDomains: () => liveDomains(database),
		async checkQueued(siteId, domainId) {
			const scope = await data.background(siteId);
			const row = scope ? await findDomain(scope, domainId).catch(() => null) : null;
			if (!scope || !row || row.verifiedAt === null) return;
			await checkLiveDomain(ports, scope, row);
		},
	};
}
