import type { Database } from "@webcraft/db";

import type { Clock } from "../clock.ts";
import type { InstallConfig } from "../config.ts";
import type { Dns } from "../dns.ts";
import type { OutgoingHttp } from "../http.ts";
import type { Logger } from "../log.ts";
import type { DataLayer, SiteScope } from "../tenancy/data-layer.ts";
import type { TlsProbe } from "../tls.ts";
import { type CheckPorts, createVerificationSigner } from "./checks.ts";
import {
	addDomain,
	domainView,
	findDomain,
	listDomains,
	makePrimary,
	type NewDomain,
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

export { VERIFY_PATH } from "./checks.ts";
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
export { domainsVerify, domainsVerifyDue, domainsVerifyDueSchedule } from "./jobs.ts";
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
	 * Checks a domain now (Check now): one waiting for DNS is verified when it reaches the Install, and
	 * otherwise checked every few minutes again, as when it was added.
	 */
	check(scope: SiteScope, domainId: string): Promise<SiteDomain>;
	/**
	 * What `/_webcraft/verify/<token>` answers on a hostname: the Install's own answer for one of its
	 * domains' tokens, or null (a plain 404).
	 */
	verificationAnswer(hostname: string, token: string): Promise<string | null>;
	/** For the worker: claims the verification checks that are due across the Install. */
	claimDueVerifications(): Promise<DueDomain[]>;
	/** For the worker: one claimed verification check. */
	verifyQueued(siteId: string, domainId: string): Promise<void>;
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
	/** The key verification signs with, derived from the Master key (`domainVerificationKey`). */
	verificationKey: CryptoKey;
};

export function createDomains(options: DomainsOptions): Domains {
	const { config, database, data, clock, log } = options;
	const deps = { config };
	const signer = createVerificationSigner(options.verificationKey);
	const ports: CheckPorts & { log: Logger } = {
		config,
		http: options.http,
		dns: options.dns,
		tls: options.tls,
		signer,
		log,
	};
	return {
		list: (scope) => listDomains(deps, scope),
		add: (scope, input) => addDomain(deps, scope, input),
		makePrimary: (scope, domainId) => makePrimary(deps, scope, domainId),
		async check(scope, domainId) {
			let row = await findDomain(scope, domainId);
			if (row.verifiedAt === null) {
				row = await verifyOnce(ports, scope, row);
				if (row.verifiedAt === null) row = await restartVerification(scope, row);
			}
			return domainView(deps, row);
		},
		verificationAnswer: (hostname, token) => verificationAnswer(database, signer, hostname, token),
		claimDueVerifications: () => claimDueVerifications(database, clock.now()),
		async verifyQueued(siteId, domainId) {
			const scope = await data.background(siteId);
			const row = scope ? await findDomain(scope, domainId).catch(() => null) : null;
			if (!scope || !row || row.verifiedAt !== null) return;
			await verifyOnce(ports, scope, row);
		},
	};
}
