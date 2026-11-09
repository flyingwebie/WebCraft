import type { Database } from "@webcraft/db";
import { siteDomains } from "@webcraft/db/schema";
import { and, eq, isNull, lte } from "drizzle-orm";

import { clearPageCache } from "../content/page-cache.ts";
import type { Logger } from "../log.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { type CheckPorts, checkCertificate, checkReaches, sameText } from "./checks.ts";
import type { DomainRow } from "./domains.ts";

/**
 * Verifying a domain (ADR 0015): until the Install has seen the domain reach it, the domain waits for
 * DNS and is checked again by itself, every few minutes for the first hour, hourly for 7 days, then
 * only when Staff press Check now (which starts the round again). A worker job runs every minute and
 * hands each domain that is due to a check job of its own.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** How the checks of a domain waiting for DNS are spaced. */
export const VERIFY_SCHEDULE = {
	/** Within the first hour of a round, a check every 5 minutes. */
	soon: 5 * MINUTE,
	firstPhase: HOUR,
	/** Then hourly, until the round is 7 days old; after that, only on demand. */
	later: HOUR,
	round: 7 * 24 * HOUR,
};

/** When the next automatic check of a domain waiting for DNS is due, after one now; null for none (only on demand). */
export function nextVerification(startedAt: Date | null, now: Date): Date | null {
	const age = now.getTime() - (startedAt ?? now).getTime();
	if (age < VERIFY_SCHEDULE.firstPhase) return new Date(now.getTime() + VERIFY_SCHEDULE.soon);
	if (age < VERIFY_SCHEDULE.round) return new Date(now.getTime() + VERIFY_SCHEDULE.later);
	return null;
}

/** A domain whose verification check is due, for the check job. */
export type DueDomain = { siteId: string; domainId: string };

/** How many due domains one run of the scheduled job hands on at most; the rest wait a minute. */
const DUE_BATCH = 200;

/**
 * Claims the domains waiting for DNS whose check is due, across the Install, moving each one's next
 * check on first (so two runs never claim the same check), and answers them for the check jobs. It
 * reads only which domains are due; each check then opens its Site on its own.
 */
export async function claimDueVerifications(database: Database, now: Date): Promise<DueDomain[]> {
	const due = await database.db
		.select({
			id: siteDomains.id,
			siteId: siteDomains.siteId,
			verifyStartedAt: siteDomains.verifyStartedAt,
			nextCheckAt: siteDomains.nextCheckAt,
		})
		.from(siteDomains)
		.where(and(isNull(siteDomains.verifiedAt), lte(siteDomains.nextCheckAt, now)))
		.orderBy(siteDomains.nextCheckAt)
		.limit(DUE_BATCH);
	const claimed: DueDomain[] = [];
	for (const row of due) {
		if (!row.nextCheckAt) continue;
		const [moved] = await database.db
			.update(siteDomains)
			.set({ nextCheckAt: nextVerification(row.verifyStartedAt, now) })
			.where(
				and(eq(siteDomains.id, row.id), isNull(siteDomains.verifiedAt), eq(siteDomains.nextCheckAt, row.nextCheckAt)),
			)
			.returning({ id: siteDomains.id });
		if (moved) claimed.push({ siteId: row.siteId, domainId: row.id });
	}
	return claimed;
}

/** What verifying works on: a Site opened by Staff (Check now) or for WebCraft's own work (a job). */
export type DomainScope = Pick<SiteScope, "first" | "update" | "now" | "db" | "site">;

/**
 * Checks once whether a domain waiting for DNS reaches the Install, and records what was found. A
 * domain that does is verified at once: it starts serving (the Site's page cache is cleared, as its
 * addresses changed), and its certificate is looked at, which also starts an on-demand one.
 */
export async function verifyOnce(
	ports: CheckPorts & { log: Logger },
	scope: DomainScope,
	row: DomainRow,
): Promise<DomainRow> {
	const reached = await checkReaches(ports, row);
	const now = scope.now();
	if (reached.problem) {
		const [updated] = await scope.update(
			siteDomains,
			{ lastCheckedAt: now, lastProblem: reached.problem },
			and(eq(siteDomains.id, row.id), isNull(siteDomains.verifiedAt)),
		);
		return updated ?? row;
	}
	const certificate = await checkCertificate(ports, row.name, reached.addresses, now);
	const [updated] = await scope.update(
		siteDomains,
		{
			verifiedAt: now,
			nextCheckAt: null,
			lastCheckedAt: now,
			lastProblem: null,
			unreachableSince: null,
			certificateExpiresAt: certificate.expiresAt,
		},
		and(eq(siteDomains.id, row.id), isNull(siteDomains.verifiedAt)),
	);
	if (updated) {
		await clearPageCache(scope);
		ports.log.info("A domain was verified", { siteId: scope.site.id, domain: row.name, role: row.role });
	}
	return updated ?? row;
}

/** Starts a new round of automatic checks for a domain waiting for DNS: Staff pressed Check now. */
export async function restartVerification(scope: DomainScope, row: DomainRow): Promise<DomainRow> {
	const now = scope.now();
	const [updated] = await scope.update(
		siteDomains,
		{ verifyStartedAt: now, nextCheckAt: nextVerification(now, now) },
		and(eq(siteDomains.id, row.id), isNull(siteDomains.verifiedAt)),
	);
	return updated ?? row;
}

/**
 * What `/_webcraft/verify/<token>` answers on a hostname: the answer only this Install makes for the
 * token, when the hostname is one of the Install's domains (waiting or verified) and the token is
 * that domain's own; null otherwise (a plain 404).
 */
export async function verificationAnswer(
	database: Database,
	signer: CheckPorts["signer"],
	hostname: string,
	token: string,
): Promise<string | null> {
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(token)) return null;
	const [row] = await database.db
		.select({ id: siteDomains.id, name: siteDomains.name })
		.from(siteDomains)
		.where(eq(siteDomains.name, hostname));
	if (!row || !sameText(await signer.token(row), token)) return null;
	return signer.answer(row.name, token);
}
