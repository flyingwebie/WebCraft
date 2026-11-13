import { pausedDomains, siteLanguages } from "@webcraft/db/schema";
import { and, asc, eq } from "drizzle-orm";

import { isUuid } from "../ids.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { addDomain, type DomainsDeps, setLanguageDomain } from "./domains.ts";
import { DomainNotFoundError, DomainTakenError } from "./errors.ts";
import { displayName } from "./names.ts";

/**
 * Paused domains (GLOSSARY.md): the domains a Site import brought (ADR 0033). They serve nothing and
 * are never checked until Staff switch one on, when it is added like any domain (waiting for DNS, then
 * verified): the Site it came from may still have it, and its DNS may not point here yet.
 */
export type PausedDomain = {
	id: string;
	name: string;
	displayName: string;
	/** What it was on the Site it came from. */
	role: "primary" | "redirect" | "language";
	language: string | null;
	createdAt: Date;
};

type Row = typeof pausedDomains.$inferSelect;

function view(row: Row): PausedDomain {
	return {
		id: row.id,
		name: row.name,
		displayName: displayName(row.name),
		role: row.role as PausedDomain["role"],
		language: row.language,
		createdAt: row.createdAt,
	};
}

/** The Site's paused domains, by name. */
export async function listPausedDomains(scope: Pick<SiteScope, "select">): Promise<PausedDomain[]> {
	return (await scope.select(pausedDomains, undefined, { orderBy: [asc(pausedDomains.name)] })).map(view);
}

async function findPaused(scope: Pick<SiteScope, "first">, pausedId: string): Promise<Row> {
	const row = isUuid(pausedId) ? await scope.first(pausedDomains, eq(pausedDomains.id, pausedId)) : undefined;
	if (!row) throw new DomainNotFoundError();
	return row;
}

/**
 * Switches a paused domain on: a language's becomes that language's domain again (while the Site has
 * the language), any other is added to the domain list (the Primary domain when the Site has none).
 * Refused while another Site of the Install has it (`DomainTakenError`): it stays paused.
 */
export async function switchOnPausedDomain(deps: DomainsDeps, scope: SiteScope, pausedId: string): Promise<void> {
	const row = await findPaused(scope, pausedId);
	if (row.role === "language" && row.language) {
		const language = row.language;
		await scope.transaction(async (tx) => {
			const [has] = await tx.select(siteLanguages, eq(siteLanguages.code, language));
			if (!has) throw new DomainNotFoundError();
			if (!(await setLanguageDomain(tx, language, row.name))) throw new DomainTakenError(row.name);
			await tx.update(siteLanguages, { domain: row.name }, eq(siteLanguages.code, language));
			await tx.delete(pausedDomains, eq(pausedDomains.id, row.id));
			await tx.audit("domain.add", { names: [row.name], language, from: "paused" });
		});
		return;
	}
	await addDomain(deps, scope, { name: row.name });
	await scope.delete(pausedDomains, and(eq(pausedDomains.id, row.id)));
}

/** Forgets a paused domain, for a Site that won't use it here. */
export async function discardPausedDomain(scope: SiteScope, pausedId: string): Promise<void> {
	const row = await findPaused(scope, pausedId);
	await scope.transaction(async (tx) => {
		await tx.delete(pausedDomains, eq(pausedDomains.id, row.id));
		await tx.audit("pausedDomain.discard", { name: row.name, role: row.role });
	});
}
