/**
 * A Site's outside scripts (ADR 0022): tags, pixels, tag managers and chat widgets, given as one script
 * address or pasted as a third-party snippet. They are Structure (`structure.edit`, Staff only) with no
 * Draft: a change applies at once and clears the page cache. Visitors' pages load them where Staff put
 * them (the end of `<head>` or of `<body>`); Edit mode never runs them. The hosts they load from are
 * added to the Site's allowed hosts by themselves, and code a snippet holds is served from the Site
 * as a file named by its hash, never inline (ADR 0023).
 */
import { allowedHosts, outsideScripts, sites } from "@webcraft/db/schema";
import { CONSENT_CATEGORIES, type ConsentCategory } from "@webcraft/module-sdk";
import type { PageOutsideScript } from "@webcraft/renderer";
import { SCRIPT_PATH } from "@webcraft/renderer";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

import { clearPageCache } from "../content/page-cache.ts";
import { isUuid } from "../ids.ts";
import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { OutsideScriptNotFoundError } from "./errors.ts";
import { retireScriptFiles } from "./retired.ts";
import { hostsOf, type OutsideScriptPart, outsideAddress, readSnippet, SnippetInvalidError } from "./snippets.ts";

export { CONSENT_CATEGORIES, type ConsentCategory };

/** Where an outside script loads: at the end of `<head>`, or at the end of `<body>`. */
export const OUTSIDE_SCRIPT_PLACEMENTS = ["head", "bodyEnd"] as const;

export type OutsideScriptPlacement = (typeof OUTSIDE_SCRIPT_PLACEMENTS)[number];

/** The longest name of an outside script, in characters. */
export const OUTSIDE_SCRIPT_NAME_MAX_LENGTH = 100;

/** How many outside scripts a Site holds at most. */
export const OUTSIDE_SCRIPTS_PER_SITE = 50;

/** An outside script as Staff give it: one script address, or a pasted snippet. */
export type OutsideScriptInput = {
	name: string;
	placement: OutsideScriptPlacement;
	consentCategory: ConsentCategory;
} & ({ kind: "url"; url: string } | { kind: "snippet"; snippet: string });

/** An outside script as the Outside scripts screen shows it. */
export type OutsideScript = {
	id: string;
	name: string;
	kind: "url" | "snippet";
	url: string | null;
	snippet: string | null;
	placement: OutsideScriptPlacement;
	consentCategory: ConsentCategory;
	/** What it loads, in order: addresses on other hosts, and the Site's own files for its code. */
	loads: { kind: "src" | "code"; src: string }[];
	/** The hosts it needs the policy to allow. */
	hosts: string[];
	/** Those of them the Site doesn't allow (Staff removed them): the browser blocks it there. */
	blockedHosts: string[];
	createdAt: Date;
	updatedAt: Date;
};

type Row = typeof outsideScripts.$inferSelect;

/** What an outside script's input loads, read and checked; refuses what can't be loaded. */
function partsOf(input: OutsideScriptInput): {
	parts: OutsideScriptPart[];
	url: string | null;
	snippet: string | null;
} {
	if (input.kind === "url") {
		const url = outsideAddress(input.url);
		if (!url)
			throw new SnippetInvalidError([{ line: 1, message: `${input.url.slice(0, 200)} isn't an https address.` }]);
		return {
			parts: [{ kind: "src", src: url, async: true, defer: false, module: false, attributes: [] }],
			url,
			snippet: null,
		};
	}
	return { parts: readSnippet(input.snippet), url: null, snippet: input.snippet };
}

/** The name of an outside script, as given, or refused when it is empty. */
function nameOf(input: OutsideScriptInput): string {
	const name = input.name.trim();
	if (!name) throw new SnippetInvalidError([{ line: 0, message: "Give the outside script a name." }]);
	return name.slice(0, OUTSIDE_SCRIPT_NAME_MAX_LENGTH);
}

function stored(row: Row): OutsideScriptPart[] {
	return row.parts as OutsideScriptPart[];
}

/** The Site's outside scripts, in the order they load. */
export async function listOutsideScripts(scope: SiteScope): Promise<OutsideScript[]> {
	const rows = await scope.select(outsideScripts, undefined, {
		orderBy: [asc(outsideScripts.position), asc(outsideScripts.createdAt)],
	});
	const allowed = new Set((await scope.select(allowedHosts)).map((row) => row.host));
	return rows.map((row) => view(row, allowed));
}

function view(row: Row, allowed: ReadonlySet<string>): OutsideScript {
	const parts = stored(row);
	const hosts = hostsOf(parts);
	return {
		id: row.id,
		name: row.name,
		kind: row.kind as OutsideScript["kind"],
		url: row.url,
		snippet: row.snippet,
		placement: row.placement as OutsideScriptPlacement,
		consentCategory: row.consentCategory as ConsentCategory,
		loads: parts.map((part) => ({ kind: part.kind, src: part.kind === "src" ? part.src : codeSrc(part.hash) })),
		hosts,
		blockedHosts: hosts.filter((host) => !allowed.has(host)),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/** Where the Site serves an outside script's code: `/_wc/js/<hash>.js`. */
function codeSrc(hash: string): string {
	return `${SCRIPT_PATH}${hash}.js`;
}

/**
 * Adds an outside script at the end of the Site's list (open the Site with `structure.edit`). Its
 * hosts are added to the Site's allowed hosts. Refuses an address that isn't https on another host,
 * and a snippet that isn't only scripts (`SnippetInvalidError`, with each problem's line).
 */
export async function addOutsideScript(scope: SiteScope, input: OutsideScriptInput): Promise<OutsideScript> {
	const name = nameOf(input);
	const read = partsOf(input);
	return scope.transaction(async (tx) => {
		await lockOutsideScripts(tx);
		if ((await tx.count(outsideScripts)) >= OUTSIDE_SCRIPTS_PER_SITE) {
			throw new SnippetInvalidError([
				{ line: 0, message: `A Site holds at most ${OUTSIDE_SCRIPTS_PER_SITE} outside scripts.` },
			]);
		}
		const [last] = await tx.select(outsideScripts, undefined, {
			orderBy: [sql`${outsideScripts.position} desc`],
			limit: 1,
		});
		const now = tx.now();
		const row = await tx.insert(outsideScripts, {
			name,
			kind: input.kind,
			url: read.url,
			snippet: read.snippet,
			parts: read.parts,
			placement: input.placement,
			consentCategory: input.consentCategory,
			position: (last?.position ?? -1) + 1,
			createdAt: now,
			updatedAt: now,
		});
		await allowNewHosts(tx, [], read.parts);
		await clearPageCache(tx);
		await tx.audit("outsideScript.add", { outsideScriptId: row.id, name, hosts: hostsOf(read.parts) });
		return view(row, await allowedSet(tx));
	});
}

/** Changes an outside script: its name, what it loads, where, and its Consent category. */
export async function updateOutsideScript(
	scope: SiteScope,
	outsideScriptId: string,
	input: OutsideScriptInput,
): Promise<OutsideScript> {
	const name = nameOf(input);
	const read = partsOf(input);
	return scope.transaction(async (tx) => {
		await lockOutsideScripts(tx);
		const current = await findRow(tx, outsideScriptId);
		const [row] = await tx.update(
			outsideScripts,
			{
				name,
				kind: input.kind,
				url: read.url,
				snippet: read.snippet,
				parts: read.parts,
				placement: input.placement,
				consentCategory: input.consentCategory,
				updatedAt: tx.now(),
			},
			eq(outsideScripts.id, current.id),
		);
		await retireCode(tx, stored(current), read.parts);
		await allowNewHosts(tx, stored(current), read.parts);
		await clearPageCache(tx);
		await tx.audit("outsideScript.update", { outsideScriptId: current.id, name, hosts: hostsOf(read.parts) });
		return view(row as Row, await allowedSet(tx));
	});
}

/** Removes an outside script; the hosts only it needed leave the allowed hosts with it. */
export async function removeOutsideScript(scope: SiteScope, outsideScriptId: string): Promise<void> {
	await scope.transaction(async (tx) => {
		await lockOutsideScripts(tx);
		const current = await findRow(tx, outsideScriptId);
		await tx.delete(outsideScripts, eq(outsideScripts.id, current.id));
		await retireCode(tx, stored(current), []);
		await pruneAutomaticHosts(tx);
		await clearPageCache(tx);
		await tx.audit("outsideScript.remove", { outsideScriptId: current.id, name: current.name });
	});
}

async function findRow(scope: SiteScope, outsideScriptId: string): Promise<Row> {
	const row = isUuid(outsideScriptId)
		? await scope.first(outsideScripts, eq(outsideScripts.id, outsideScriptId))
		: undefined;
	if (!row) throw new OutsideScriptNotFoundError();
	return row;
}

/**
 * Takes the Site's lock on its outside scripts and allowed hosts, so two changes at once take turns
 * (each reads the hosts the other left). The Site's own row is the lock.
 */
async function lockOutsideScripts(scope: SiteScope): Promise<void> {
	await scope.db
		.select({ id: sites.id })
		.from(sites)
		.where(and(eq(sites.id, scope.site.id), eq(sites.workspaceId, scope.site.workspaceId)))
		.for("update");
}

async function allowedSet(scope: SiteScope): Promise<Set<string>> {
	return new Set((await scope.select(allowedHosts)).map((row) => row.host));
}

/**
 * Adds the hosts an outside script needs now and didn't before to the allowed hosts, marked as added
 * by themselves; hosts Staff removed while the script kept them stay removed. Then forgets automatic
 * hosts no outside script needs any more.
 */
async function allowNewHosts(
	scope: SiteScope,
	before: readonly OutsideScriptPart[],
	after: readonly OutsideScriptPart[],
): Promise<void> {
	const had = new Set(hostsOf(before));
	const allowed = await allowedSet(scope);
	for (const host of hostsOf(after)) {
		if (had.has(host) || allowed.has(host)) continue;
		await scope.insert(allowedHosts, { host, source: "auto", createdAt: scope.now() });
	}
	await pruneAutomaticHosts(scope);
}

/** Removes the automatic hosts no outside script needs any more; hosts Staff added stay. */
export async function pruneAutomaticHosts(scope: SiteScope): Promise<void> {
	const needed = new Set((await scope.select(outsideScripts)).flatMap((row) => hostsOf(stored(row))));
	const automatic = await scope.select(allowedHosts, eq(allowedHosts.source, "auto"));
	const unused = automatic.filter((row) => !needed.has(row.host)).map((row) => row.id);
	if (unused.length > 0) await scope.delete(allowedHosts, inArray(allowedHosts.id, unused));
}

/** Keeps the files of code an outside script no longer has, for pages loaded before the change. */
async function retireCode(
	scope: SiteScope,
	before: readonly OutsideScriptPart[],
	after: readonly OutsideScriptPart[],
): Promise<void> {
	const kept = new Set(after.flatMap((part) => (part.kind === "code" ? [part.hash] : [])));
	await retireScriptFiles(
		scope,
		before.flatMap((part) =>
			part.kind === "code" && !kept.has(part.hash) ? [{ hash: part.hash, code: part.code }] : [],
		),
	);
}

/** Which outside scripts' hosts each allowed host is there for, by host. */
export async function hostUses(scope: SiteScope): Promise<Map<string, { id: string; name: string }[]>> {
	const uses = new Map<string, { id: string; name: string }[]>();
	const rows = await scope.select(outsideScripts, undefined, { orderBy: [asc(outsideScripts.position)] });
	for (const row of rows) {
		for (const host of hostsOf(stored(row)))
			uses.set(host, [...(uses.get(host) ?? []), { id: row.id, name: row.name }]);
	}
	return uses;
}

/** The Site's outside scripts as a page loads them, in order. */
export async function pageOutsideScripts(scope: Pick<VisitorScope, "select">): Promise<PageOutsideScript[]> {
	const rows = await scope.select(outsideScripts, undefined, {
		orderBy: [asc(outsideScripts.position), asc(outsideScripts.createdAt)],
	});
	return rows.map((row) => ({
		id: row.id,
		name: row.name,
		placement: row.placement as OutsideScriptPlacement,
		consentCategory: row.consentCategory,
		tags: stored(row).map((part) =>
			part.kind === "src"
				? { src: part.src, async: part.async, defer: part.defer, module: part.module, attributes: part.attributes }
				: { src: codeSrc(part.hash), module: part.module },
		),
	}));
}

/** The code of one of the Site's outside scripts by its hash, or null when none holds it. */
export async function outsideScriptCode(scope: Pick<VisitorScope, "first">, hash: string): Promise<string | null> {
	const row = await scope.first(
		outsideScripts,
		sql`${outsideScripts.parts} @> ${JSON.stringify([{ kind: "code", hash }])}::jsonb`,
	);
	if (!row) return null;
	const part = stored(row).find((candidate) => candidate.kind === "code" && candidate.hash === hash);
	return part?.kind === "code" ? part.code : null;
}
