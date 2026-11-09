import type { Database } from "@webcraft/db";
import { membershipSites, memberships, siteDomains } from "@webcraft/db/schema";
import { and, eq, isNotNull, isNull, or } from "drizzle-orm";

import type { Email } from "../email/index.ts";
import type { Logger } from "../log.ts";
import { roleDefinition } from "../permissions/roles.ts";
import { type CheckPorts, checkCertificate, checkReaches } from "./checks.ts";
import type { DomainProblem, DomainRow } from "./domains.ts";
import { displayName } from "./names.ts";
import type { DomainScope } from "./verification.ts";

/**
 * The Domain check (ADR 0015): every hour, each verified domain is checked again, the way it was
 * verified, plus its certificate. A domain whose DNS moved, whose certificate is missing or runs out
 * within 14 days, or which answers something other than the Install is marked Unreachable (it keeps
 * serving: Caddy keeps renewing its certificate, and it may come back), and the Site's Owners get the
 * `domain-unreachable` email once, when it turns Unreachable. It is active again once a check passes.
 */

/** The verified domains of the Install, for the hourly Domain check to check one by one. */
export async function liveDomains(database: Database): Promise<{ siteId: string; domainId: string }[]> {
	return database.db
		.select({ siteId: siteDomains.siteId, domainId: siteDomains.id })
		.from(siteDomains)
		.where(isNotNull(siteDomains.verifiedAt));
}

export type LiveCheckPorts = CheckPorts & { log: Logger; email: Email };

/** Checks a verified domain once, and records what was found; answers the domain as it is now. */
export async function checkLiveDomain(ports: LiveCheckPorts, scope: DomainScope, row: DomainRow): Promise<DomainRow> {
	const now = scope.now();
	const reached = await checkReaches(ports, row);
	const certificate = reached.problem ? null : await checkCertificate(ports, row.name, reached.addresses, now);
	const problem: DomainProblem | null = reached.problem ?? certificate?.problem ?? null;
	const checked = { lastCheckedAt: now, lastProblem: problem };
	const known = certificate?.expiresAt ? { certificateExpiresAt: certificate.expiresAt } : {};
	const live = and(eq(siteDomains.id, row.id), isNotNull(siteDomains.verifiedAt));
	if (!problem) {
		const [updated] = await scope.update(siteDomains, { ...checked, ...known, unreachableSince: null }, live);
		return updated ?? row;
	}
	// Only the check that turns it Unreachable sends the email, however many run at once.
	const [turned] = await scope.update(
		siteDomains,
		{ ...checked, ...known, unreachableSince: now },
		and(live, isNull(siteDomains.unreachableSince)),
	);
	if (!turned) {
		const [updated] = await scope.update(siteDomains, { ...checked, ...known }, live);
		return updated ?? row;
	}
	ports.log.warn("A domain is unreachable", { siteId: scope.site.id, domain: row.name, problem });
	await tellOwners(ports, scope, row);
	return turned;
}

/** Sends the Site's Owners the `domain-unreachable` email about a domain. */
async function tellOwners(ports: LiveCheckPorts, scope: DomainScope, row: DomainRow): Promise<void> {
	const owners = await siteOwners(scope);
	if (owners.length === 0) {
		ports.log.warn("No Owner to tell that a domain is unreachable", { siteId: scope.site.id, domain: row.name });
		return;
	}
	await ports.email.send({
		type: "domain-unreachable",
		to: owners.map((personId) => ({ personId })),
		data: {
			domain: displayName(row.name),
			siteName: scope.site.name,
			domainsPath: `/sites/${scope.site.id}/domains`,
		},
		related: { kind: "site", id: scope.site.id },
	});
}

/**
 * The Site's Owners: the Members of its Workspace who reach the Site and whose role manages the
 * Workspace's Members (`member.manage`, which only Owners hold in v1). Checked by Permission, never
 * by role name (ADR 0028).
 */
async function siteOwners(scope: Pick<DomainScope, "db" | "site" | "workspace">): Promise<string[]> {
	const rows = await scope.db
		.selectDistinct({ personId: memberships.personId, role: memberships.role })
		.from(memberships)
		.leftJoin(
			membershipSites,
			and(eq(membershipSites.membershipId, memberships.id), eq(membershipSites.siteId, scope.site.id)),
		)
		.where(
			and(
				eq(memberships.workspaceId, scope.workspace.id),
				or(eq(memberships.allSites, true), isNotNull(membershipSites.siteId)),
			),
		);
	return rows
		.filter((row) => roleDefinition(row.role)?.permissions.includes("member.manage") ?? false)
		.map((row) => row.personId);
}
