import { people, protectedTerms, sites } from "@webcraft/db/schema";
import { contentHash } from "@webcraft/renderer";
import { and, asc, eq, inArray, isNull, or } from "drizzle-orm";

import { actingPerson } from "../permissions/can.ts";
import type { Executor, WorkspaceScope } from "../tenancy/data-layer.ts";
import { SiteNotFoundError } from "../tenancy/errors.ts";

/**
 * Protected terms (GLOSSARY.md): words AI translation leaves exactly as written, such as a brand or
 * product name. A Workspace keeps a list for all its Sites, and each Site its own. Before text is sent
 * each occurrence is swapped for a placeholder (`⟦T1⟧`), and put back exactly as it was written after;
 * an answer that drops or changes a placeholder is refused.
 */

/** The longest term, and how many a Workspace (with its Sites) keeps. */
export const PROTECTED_TERM_LIMITS = { length: 200, count: 2_000 } as const;

export type ProtectedTerm = {
	id: string;
	term: string;
	/** Null: the Workspace's, for every Site. */
	site: { id: string; name: string } | null;
	matchCase: boolean;
	addedBy: { id: string; name: string } | null;
	addedAt: Date;
};

export type NewProtectedTerm = { term: string; matchCase: boolean };

/** A term that can't be kept: empty, too long, holding a marker character, or one too many. */
export class ProtectedTermInvalidError extends Error {
	override name = "ProtectedTermInvalidError";
	readonly index: number;
	readonly reason: "empty" | "length" | "characters" | "count";
	constructor(index: number, reason: ProtectedTermInvalidError["reason"]) {
		super(
			reason === "count"
				? `A Workspace keeps at most ${PROTECTED_TERM_LIMITS.count} Protected terms.`
				: reason === "length"
					? `A Protected term has at most ${PROTECTED_TERM_LIMITS.length} characters.`
					: reason === "characters"
						? "A Protected term can't hold ⟦ or ⟧, or a line break."
						: "Give the Protected term.",
		);
		this.index = index;
		this.reason = reason;
	}
}

/** No Protected term with this id in the Workspace. */
export class ProtectedTermNotFoundError extends Error {
	override name = "ProtectedTermNotFoundError";
	constructor() {
		super("There is no Protected term with this id.");
	}
}

/** Every Protected term of the Workspace, its own and its Sites', or only those that apply to one Site. */
export async function listProtectedTerms(scope: WorkspaceScope, siteIds?: readonly string[]): Promise<ProtectedTerm[]> {
	const rows = await scope.db
		.select({
			id: protectedTerms.id,
			term: protectedTerms.term,
			siteId: protectedTerms.siteId,
			siteName: sites.name,
			matchCase: protectedTerms.matchCase,
			addedById: protectedTerms.createdBy,
			addedByName: people.name,
			addedAt: protectedTerms.createdAt,
		})
		.from(protectedTerms)
		.leftJoin(sites, eq(sites.id, protectedTerms.siteId))
		.leftJoin(people, eq(people.id, protectedTerms.createdBy))
		.where(
			scope.where(
				protectedTerms,
				siteIds === undefined
					? undefined
					: or(
							isNull(protectedTerms.siteId),
							siteIds.length > 0 ? inArray(protectedTerms.siteId, [...siteIds]) : undefined,
						),
			),
		)
		.orderBy(asc(protectedTerms.term));
	return rows.map((row) => ({
		id: row.id,
		term: row.term,
		site: row.siteId ? { id: row.siteId, name: row.siteName ?? "" } : null,
		matchCase: row.matchCase,
		addedBy: row.addedById ? { id: row.addedById, name: row.addedByName ?? "" } : null,
		addedAt: row.addedAt,
	}));
}

/**
 * Adds terms to the Workspace's list (`siteId` null) or a Site's (open the Workspace with
 * `protectedTerms.edit` on that level). A term the list already holds is skipped. Answers how many
 * were added.
 */
export async function addProtectedTerms(
	scope: WorkspaceScope,
	siteId: string | null,
	terms: readonly NewProtectedTerm[],
): Promise<number> {
	const cleaned = terms.map((term, index) => ({ term: checkTerm(term.term, index), matchCase: term.matchCase }));
	return scope.transaction(async (tx) => {
		if (siteId !== null) {
			const [site] = await tx.db
				.select({ id: sites.id })
				.from(sites)
				.where(and(eq(sites.id, siteId), eq(sites.workspaceId, tx.workspace.id)));
			if (!site) throw new SiteNotFoundError();
		}
		const existing = await tx.count(protectedTerms);
		if (existing + cleaned.length > PROTECTED_TERM_LIMITS.count) {
			throw new ProtectedTermInvalidError(cleaned.length - 1, "count");
		}
		const now = tx.now();
		const by = actingPerson(tx.access.actor);
		let added = 0;
		for (const term of cleaned) {
			const rows = await tx.db
				.insert(protectedTerms)
				.values({
					workspaceId: tx.workspace.id,
					siteId,
					term: term.term,
					matchCase: term.matchCase,
					createdBy: by,
					createdAt: now,
				})
				.onConflictDoNothing()
				.returning({ id: protectedTerms.id });
			added += rows.length;
		}
		if (added > 0) {
			await tx.audit(
				"protectedTerm.add",
				{ terms: cleaned.map((term) => term.term), count: added },
				siteId ? { siteId } : undefined,
			);
		}
		return added;
	});
}

/** Removes a term (the caller checked `protectedTerms.edit` where the term applies). */
export async function removeProtectedTerm(scope: WorkspaceScope, termId: string): Promise<void> {
	const term = await findProtectedTerm(scope, termId);
	await scope.transaction(async (tx) => {
		await tx.delete(protectedTerms, eq(protectedTerms.id, term.id));
		await tx.audit("protectedTerm.remove", { term: term.term }, term.siteId ? { siteId: term.siteId } : undefined);
	});
}

/** One term of the Workspace, with the Site it applies to (null: the Workspace's). */
export async function findProtectedTerm(scope: WorkspaceScope, termId: string) {
	const row = /^[0-9a-f-]{36}$/i.test(termId)
		? await scope.first(protectedTerms, eq(protectedTerms.id, termId))
		: undefined;
	if (!row) throw new ProtectedTermNotFoundError();
	return row;
}

function checkTerm(text: string, index: number): string {
	const term = text.trim().replace(/\s+/g, " ");
	if (term === "") throw new ProtectedTermInvalidError(index, "empty");
	if (term.length > PROTECTED_TERM_LIMITS.length) throw new ProtectedTermInvalidError(index, "length");
	if (/[⟦⟧\r\n]/.test(term)) throw new ProtectedTermInvalidError(index, "characters");
	return term;
}

/** The terms that apply on a Site: the Workspace's and the Site's own. */
export type Glossary = {
	terms: { term: string; matchCase: boolean }[];
	/** Which set of terms this is, so cached translations made under another set are never used. */
	version: string;
};

export async function glossaryOf(db: Executor, workspaceId: string, siteId: string): Promise<Glossary> {
	const rows = await db
		.select({ term: protectedTerms.term, matchCase: protectedTerms.matchCase })
		.from(protectedTerms)
		.where(
			and(
				eq(protectedTerms.workspaceId, workspaceId),
				or(isNull(protectedTerms.siteId), eq(protectedTerms.siteId, siteId)),
			),
		);
	// Longer terms first, so "Acme Sourdough Loaf" is kept whole before "Acme" is looked for.
	const terms = rows.sort((a, b) => b.term.length - a.term.length || a.term.localeCompare(b.term));
	const version = contentHash(terms.map((term) => `${term.matchCase ? "1" : "0"}${term.term}`).join("\n"));
	return { terms, version };
}

/** A piece with its Protected terms swapped for placeholders, and the text each placeholder stands for. */
export type Protected = { text: string; terms: string[] };

/** Letters and digits: a term matches only where neither comes right before or after it. */
const WORD = /[\p{L}\p{N}]/u;

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Swaps each occurrence of a term for a placeholder (`⟦T1⟧`, `⟦T2⟧`, …), never inside a marker. A
 * term matching any case keeps the occurrence as it was written there.
 */
export function protectTerms(piece: string, glossary: Glossary): Protected {
	const found: string[] = [];
	let text = piece;
	for (const { term, matchCase } of glossary.terms) {
		const pattern = new RegExp(escapeRegExp(term), matchCase ? "gu" : "giu");
		text = text.replace(pattern, (match, offset: number, whole: string) => {
			const before = whole[offset - 1] ?? "";
			const after = whole[offset + match.length] ?? "";
			if (WORD.test(before) || WORD.test(after)) return match;
			if (insideMarker(whole, offset)) return match;
			found.push(match);
			return `⟦T${found.length}⟧`;
		});
	}
	return { text, terms: found };
}

/** Whether `offset` falls inside a marker such as `⟦T1⟧`. */
function insideMarker(text: string, offset: number): boolean {
	const open = text.lastIndexOf("⟦", offset);
	return open !== -1 && open > text.lastIndexOf("⟧", offset - 1);
}

/** Puts each term back where its placeholder is, exactly as it was written. */
export function restoreTerms(translation: string, terms: readonly string[]): string {
	return translation.replace(/⟦T(\d{1,4})⟧/g, (marker, n: string) => terms[Number(n) - 1] ?? marker);
}
