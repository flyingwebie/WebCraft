/**
 * A Site's Content Security Policy settings (ADR 0023): its mode and its allowed hosts. They are
 * Structure (`structure.edit`, Staff only) with no Draft: a change applies at once, clears the page
 * cache (pages keep their policy with them) and is recorded in the Audit log.
 */
import { allowedHosts, sites } from "@webcraft/db/schema";
import { and, asc, eq } from "drizzle-orm";

import { clearPageCache } from "../content/page-cache.ts";
import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { TooManyHostsError } from "./errors.ts";
import { hostUses } from "./outside-scripts.ts";
import { ALLOWED_HOSTS_PER_SITE, type CspMode, isCspMode, readHost } from "./policy.ts";
import { lockSite } from "./site-lock.ts";

/** One of a Site's allowed hosts: how it got there, and the outside scripts that need it. */
export type AllowedHost = { host: string; source: "hand" | "auto"; usedBy: { id: string; name: string }[] };

/** A host a Module running on the Site may be called at, which its policy allows too. */
export type ModuleOutsideHost = { host: string; moduleId: string; module: string };

/** A Site's policy as the Outside scripts screen shows it. */
export type CspSettings = { mode: CspMode; hosts: AllowedHost[]; moduleHosts: ModuleOutsideHost[] };

/** The Site's policy settings; `moduleHosts` are the hosts of the Modules running on it. */
export async function getCsp(scope: SiteScope, moduleHosts: readonly ModuleOutsideHost[]): Promise<CspSettings> {
	const [site] = await scope.db
		.select({ cspMode: sites.cspMode })
		.from(sites)
		.where(and(eq(sites.id, scope.site.id), eq(sites.workspaceId, scope.site.workspaceId)));
	const uses = await hostUses(scope);
	const rows = await scope.select(allowedHosts, undefined, { orderBy: [asc(allowedHosts.host)] });
	return {
		mode: site && isCspMode(site.cspMode) ? site.cspMode : "strict",
		hosts: rows.map((row) => ({
			host: row.host,
			source: row.source === "auto" ? "auto" : "hand",
			usedBy: uses.get(row.host) ?? [],
		})),
		moduleHosts: [...moduleHosts],
	};
}

/** Changes how the Site's policy applies: Strict, Relaxed or Report only. */
export async function setCspMode(scope: SiteScope, mode: CspMode): Promise<void> {
	await scope.transaction(async (tx) => {
		const [site] = await tx.db
			.select({ cspMode: sites.cspMode })
			.from(sites)
			.where(and(eq(sites.id, tx.site.id), eq(sites.workspaceId, tx.site.workspaceId)))
			.for("update");
		const from = site?.cspMode ?? "strict";
		if (from === mode) return;
		await tx.db
			.update(sites)
			.set({ cspMode: mode })
			.where(and(eq(sites.id, tx.site.id), eq(sites.workspaceId, tx.site.workspaceId)));
		await clearPageCache(tx);
		await tx.audit("csp.change", { from, to: mode });
	});
}

/**
 * Adds a host to the Site's allowed hosts by hand (a host a tag manager loads from, say). Refuses
 * anything that isn't a host (`HostInvalidError`). A host the Site allows already becomes one added
 * by hand, so it stays when the outside scripts needing it go.
 */
export async function addAllowedHost(scope: SiteScope, input: string): Promise<void> {
	const host = readHost(input);
	await scope.transaction(async (tx) => {
		await lockSite(tx);
		const current = await tx.first(allowedHosts, eq(allowedHosts.host, host));
		if (current?.source === "hand") return;
		if (current) {
			await tx.update(allowedHosts, { source: "hand" }, eq(allowedHosts.id, current.id));
		} else {
			if ((await tx.count(allowedHosts)) >= ALLOWED_HOSTS_PER_SITE) throw new TooManyHostsError();
			await tx.insert(allowedHosts, { host, source: "hand", createdAt: tx.now() });
		}
		await clearPageCache(tx);
		await tx.audit("allowedHost.add", { host });
	});
}

/** Removes a host from the Site's allowed hosts, whoever added it; outside scripts needing it are then blocked there. */
export async function removeAllowedHost(scope: SiteScope, input: string): Promise<void> {
	const host = input.trim().toLowerCase();
	await scope.transaction(async (tx) => {
		await lockSite(tx);
		const removed = await tx.delete(allowedHosts, eq(allowedHosts.host, host));
		if (removed === 0) return;
		await clearPageCache(tx);
		await tx.audit("allowedHost.remove", { host });
	});
}

/** The Site's allowed hosts as its policy names them. */
export async function siteAllowedHosts(scope: Pick<VisitorScope, "select">): Promise<string[]> {
	return (await scope.select(allowedHosts)).map((row) => row.host);
}
