import { siteDomains } from "@webcraft/db/schema";
import { and, asc, eq, sql } from "drizzle-orm";

import type { Edge, InstallConfig } from "../config.ts";
import { askConfirmation, type Confirmation, useConfirmation } from "../confirmations.ts";
import { siteLanguages } from "../content/languages.ts";
import { clearPageCache } from "../content/page-cache.ts";
import { isUniqueViolation } from "../db-errors.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { DomainChangeRefusedError, DomainInvalidError, DomainNotFoundError, DomainTakenError } from "./errors.ts";
import { displayName, domainName, isInstallName, partnerOf } from "./names.ts";

/**
 * A Site's domains (ADR 0015), Site settings: Staff change them (`structure.edit`), everyone who sees
 * the Site sees them. Each change applies at once and is recorded in the Audit log.
 *
 * - The **Primary domain** serves the Site; there is at most one. The first domain a Site gets
 *   becomes it; a verified domain can take over later (`makePrimary`).
 * - **Redirect domains** send visitors to the same path on the Primary domain (301).
 * - **Language domains** serve one language without a prefix (ADR 0010); they are set in Languages and
 *   listed here, so they are verified and checked like the rest.
 *
 * A domain serves nothing until it is verified: the Install fetches a path on it and must get back
 * an answer only it can make (see `verification.ts`).
 */

export type DomainRole = "primary" | "redirect" | "language";

/** Whether a domain waits for DNS (not verified yet), is live, or is live but failed its last Domain check. */
export type DomainStatus = "waiting" | "active" | "unreachable";

/**
 * What a check found wrong:
 * - `dns`: the domain doesn't resolve, or points somewhere other than the Install;
 * - `unreachable`: nothing answered at the domain;
 * - `response`: something answered, but not the Install;
 * - `certificate-missing`: no valid certificate answers for the domain over HTTPS;
 * - `certificate-expiring`: its certificate runs out within 14 days.
 */
export type DomainProblem = "dns" | "unreachable" | "response" | "certificate-missing" | "certificate-expiring";

/** A DNS record to create at the domain's registrar. */
export type DnsRecord = { type: "A" | "AAAA" | "CNAME"; name: string; value: string };

/**
 * One of a Site's domains, as the admin shows it, with the DNS records that point it at the Install:
 * A and AAAA records to the Install's addresses (`address`, none when the Install doesn't name them),
 * or, for a subdomain such as `www`, a CNAME record to the admin host (`alias`).
 */
export type SiteDomain = {
	id: string;
	/** The domain in lower case and its ASCII form. */
	name: string;
	/** The domain as people read it (international names in their own letters). */
	displayName: string;
	role: DomainRole;
	/** For a language's domain, the language's code. */
	language: string | null;
	status: DomainStatus;
	verifiedAt: Date | null;
	lastCheckedAt: Date | null;
	/** When the next automatic verification check is due; null when it is verified or checked only on demand. */
	nextCheckAt: Date | null;
	/** What the last check found wrong; null when it passed or there was none yet. */
	problem: DomainProblem | null;
	certificateExpiresAt: Date | null;
	records: { address: DnsRecord[]; alias: DnsRecord };
};

/** A Site's domains, the Primary domain first, then the Redirect domains, then the languages' domains. */
export type SiteDomainList = {
	/** What answers HTTPS for the Install, which decides the steps Staff take (ADR 0015). */
	edge: Edge;
	domains: SiteDomain[];
};

export type DomainsDeps = { config: Pick<InstallConfig, "adminHost" | "sitesDomain" | "edge" | "publicAddresses"> };

export type DomainRow = typeof siteDomains.$inferSelect;

/** The scope's Site's domains, the Primary domain first, then the Redirect domains, then the languages'. */
export async function listDomains(
	deps: DomainsDeps,
	scope: Pick<SiteScope, "select" | "db" | "site">,
): Promise<SiteDomainList> {
	const rows = await scope.select(siteDomains, undefined, { orderBy: [asc(siteDomains.name)] });
	const languages = (await siteLanguages(scope)).languages.map((language) => language.code);
	const rank = (row: DomainRow) =>
		row.role === "primary" ? -2 : row.role === "redirect" ? -1 : languages.indexOf(row.language ?? "");
	const ordered = [...rows].sort((a, b) => rank(a) - rank(b));
	return { edge: deps.config.edge, domains: ordered.map((row) => domainView(deps, row)) };
}

/** What adding a domain takes: the domain as typed, and whether to add its `www` (or apex) partner too. */
export type NewDomain = { name: string; withPartner?: boolean };

/**
 * Adds a domain to the scope's Site, and its partner when asked (`bakery.ie` and `www.bakery.ie`
 * together; one the Site has already is left as it is). The first domain of a Site without a Primary
 * domain becomes it; the rest are Redirect domains. Each waits for DNS and is checked from now on.
 * Refuses what isn't a domain or is the Install's own (`DomainInvalidError`), and a domain the Install
 * has on any Site (`DomainTakenError`), adding nothing then.
 */
export async function addDomain(deps: DomainsDeps, scope: SiteScope, input: NewDomain): Promise<SiteDomain[]> {
	const name = domainName(input.name);
	if (!name) throw new DomainInvalidError("format");
	if (isInstallName(deps.config, name)) throw new DomainInvalidError("install");
	const partner = input.withPartner ? partnerOf(name) : null;
	return scope.transaction(async (tx) => {
		await lockSiteDomains(tx);
		const current = await tx.select(siteDomains);
		const has = (candidate: string) => current.some((row) => row.name === candidate);
		if (has(name)) throw new DomainTakenError(name);
		const wanted = [name, ...(partner && !has(partner) && !isInstallName(deps.config, partner) ? [partner] : [])];
		let primary = current.some((row) => row.role === "primary");
		const added: DomainRow[] = [];
		for (const candidate of wanted) {
			added.push(await insertDomain(tx, { name: candidate, role: primary ? "redirect" : "primary", language: null }));
			primary = true;
		}
		await tx.audit("domain.add", { names: added.map((row) => row.name) });
		return added.map((row) => domainView(deps, row));
	});
}

/**
 * Makes a verified domain of the Site its Primary domain; the Primary domain before it becomes a
 * Redirect domain, so its links keep working. A language's domain stays the language's.
 */
export async function makePrimary(deps: DomainsDeps, scope: SiteScope, domainId: string): Promise<SiteDomainList> {
	await scope.transaction(async (tx) => {
		await lockSiteDomains(tx);
		const row = await tx.first(siteDomains, eq(siteDomains.id, domainId));
		if (!row) throw new DomainNotFoundError();
		if (row.role === "primary") return;
		if (row.role === "language") throw new DomainChangeRefusedError("language");
		if (!row.verifiedAt) throw new DomainChangeRefusedError("not-verified");
		const [before] = await tx.update(siteDomains, { role: "redirect" }, eq(siteDomains.role, "primary"));
		await tx.update(siteDomains, { role: "primary" }, eq(siteDomains.id, row.id));
		await clearPageCache(tx);
		await tx.audit("domain.makePrimary", { name: row.name, before: before?.name ?? null });
	});
	return listDomains(deps, scope);
}

/** What removing a domain would do (the first step), or did. */
export type DomainRemoval =
	| { removed: false; preview: { name: string; role: DomainRole; live: boolean }; confirmation: Confirmation }
	| { removed: true; domains: SiteDomainList };

/**
 * Removes a domain from the Site, in two steps: without `confirmation` it removes nothing and answers
 * what it would remove (its name, role, and whether it serves visitors now) with a confirmation id;
 * with the id, it removes it. A removed domain stops working at once (Caddy is refused a certificate
 * for it from then on); to move it to another Site, add it there and verify it again. A language's
 * domain is changed in Languages.
 */
export async function removeDomain(
	deps: DomainsDeps,
	scope: SiteScope,
	domainId: string,
	confirmation?: string,
): Promise<DomainRemoval> {
	const asked = await scope.transaction(async (tx) => {
		await lockSiteDomains(tx);
		const row = await findDomain(tx, domainId);
		if (row.role === "language") throw new DomainChangeRefusedError("language");
		const preview = { name: row.name, role: row.role as DomainRole, live: row.verifiedAt !== null };
		const request = { action: "domain.remove", target: row.id, preview };
		if (confirmation === undefined) {
			return { removed: false as const, preview, confirmation: await askConfirmation(tx, request) };
		}
		await useConfirmation(tx, confirmation, request);
		await tx.delete(siteDomains, eq(siteDomains.id, row.id));
		if (preview.live) await clearPageCache(tx);
		await tx.audit("domain.remove", { name: row.name, role: row.role });
		return null;
	});
	return asked ?? { removed: true, domains: await listDomains(deps, scope) };
}

/** The Site's domain with this id, or `DomainNotFoundError`. */
export async function findDomain(scope: Pick<SiteScope, "first">, domainId: string): Promise<DomainRow> {
	const row = await scope.first(siteDomains, eq(siteDomains.id, domainId));
	if (!row) throw new DomainNotFoundError();
	return row;
}

/** A new domain row, waiting for DNS, due for its first check now. */
export async function insertDomain(
	scope: Pick<SiteScope, "insert" | "now">,
	domain: { name: string; role: DomainRole; language: string | null },
): Promise<DomainRow> {
	const now = scope.now();
	try {
		return await scope.insert(siteDomains, {
			...domain,
			verifyStartedAt: now,
			nextCheckAt: now,
			createdAt: now,
		});
	} catch (error) {
		if (isUniqueViolation(error, "site_domains_name_unique")) throw new DomainTakenError(domain.name);
		throw error;
	}
}

/**
 * Keeps a language's domain on the Site's domain list, inside the scope's transaction: removes the
 * domain it had (if any) and adds the new one (if any), which waits for DNS. Answers false when
 * another Site of the Install has the domain.
 */
export async function setLanguageDomain(
	scope: Pick<SiteScope, "insert" | "delete" | "now">,
	language: string,
	domain: string | null,
): Promise<boolean> {
	await scope.delete(siteDomains, and(eq(siteDomains.role, "language"), eq(siteDomains.language, language)));
	if (domain === null) return true;
	try {
		await insertDomain(scope, { name: domain, role: "language", language });
		return true;
	} catch (error) {
		if (error instanceof DomainTakenError) return false;
		throw error;
	}
}

/** Serialises changes to one Site's domains (which one is Primary), across processes. */
async function lockSiteDomains(scope: Pick<SiteScope, "db" | "site">): Promise<void> {
	await scope.db.execute(
		sql`select pg_advisory_xact_lock(hashtextextended(${`webcraft:site-domains:${scope.site.id}`}, 0))`,
	);
}

export function domainView(deps: DomainsDeps, row: DomainRow): SiteDomain {
	return {
		id: row.id,
		name: row.name,
		displayName: displayName(row.name),
		role: row.role as DomainRole,
		language: row.language,
		status: row.verifiedAt === null ? "waiting" : row.unreachableSince === null ? "active" : "unreachable",
		verifiedAt: row.verifiedAt,
		lastCheckedAt: row.lastCheckedAt,
		nextCheckAt: row.verifiedAt === null ? row.nextCheckAt : null,
		problem: (row.lastProblem as DomainProblem | null) ?? null,
		certificateExpiresAt: row.certificateExpiresAt,
		records: dnsRecords(deps, row.name),
	};
}

/** The DNS records that point a domain at the Install. */
function dnsRecords(deps: DomainsDeps, name: string): SiteDomain["records"] {
	return {
		address: deps.config.publicAddresses.map((value) => ({
			type: value.includes(":") ? ("AAAA" as const) : ("A" as const),
			name,
			value,
		})),
		alias: { type: "CNAME", name, value: deps.config.adminHost },
	};
}
