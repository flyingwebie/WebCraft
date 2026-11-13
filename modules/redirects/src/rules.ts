import {
	type AddedRule,
	and,
	eq,
	type ImportedRule,
	type ImportedRuleResult,
	inArray,
	isModuleError,
	like,
	lt,
	lte,
	type ModuleContext,
	ModuleError,
	or,
	type RedirectTarget,
} from "@webcraft/module-sdk";

import {
	covers,
	likeText,
	parseFrom,
	parseTarget,
	type RuleFrom,
	sitePathOf,
	targetFor,
	wildcardBases,
	writtenFrom,
} from "./paths.ts";
import { misses, rules } from "./tables.ts";

type RuleRow = typeof rules.$inferSelect;

/**
 * How far a rule's target is followed through the other rules when it is saved, looking for a circle.
 * A chain may be longer than the Site pipeline goes in one answer (5 rules): visitors are sent on from
 * there and the browser carries on. A chain longer than this is refused as if it were a circle.
 */
export const MAX_CHAIN = 50;

/** A Redirect rule as the Module's procedures answer it. */
export type RuleView = {
	id: string;
	/** As people write it: `/old`, `/old/*`. */
	from: string;
	to: string;
	status: 301 | 302;
	/** Added by the Module when a published path changed, rather than by a person. */
	automatic: boolean;
	createdAt: Date;
	updatedAt: Date;
};

export function ruleView(row: RuleRow): RuleView {
	return {
		id: row.id,
		from: writtenFrom({ path: row.fromPath, wildcard: row.wildcard }),
		to: row.target,
		status: row.status === 302 ? 302 : 301,
		automatic: row.automatic,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
	};
}

/**
 * The exact rule wins; failing that, the wildcard rule among `wildcards` whose `fromPath` is one of
 * `bases` (the path's own wildcard bases) with the longest `fromPath`: the wildcard starting nearest
 * to the path. `ruleFor` and `findTargets` both pick a path's rule this way.
 */
function nearestRule(
	exact: RuleRow | undefined,
	wildcards: readonly RuleRow[],
	bases: readonly string[],
): RuleRow | undefined {
	if (exact) return exact;
	return wildcards
		.filter((candidate) => bases.includes(candidate.fromPath))
		.sort((a, b) => b.fromPath.length - a.fromPath.length)[0];
}

/** The rule matching a Site path: one for the path itself, else the wildcard rule starting nearest to it. */
export async function ruleFor(context: ModuleContext, path: string): Promise<RuleRow | undefined> {
	const exact = await context.data.first(rules, and(eq(rules.fromPath, path), eq(rules.wildcard, false)));
	if (exact) return exact;
	const bases = wildcardBases(path);
	const wildcards = await context.data.select(rules, and(eq(rules.wildcard, true), inArray(rules.fromPath, bases)));
	return nearestRule(undefined, wildcards, bases);
}

/**
 * Where the rules send each of many Site paths, in order (`redirectRules.findMany`, SDK 1.10): two
 * reads for the whole list, the paths' own rules and the wildcard rules above any of them.
 */
export async function findTargets(
	context: ModuleContext,
	paths: readonly string[],
): Promise<(RedirectTarget | null)[]> {
	if (paths.length === 0) return [];
	const unique = [...new Set(paths)];
	const exact = await context.data.select(rules, and(eq(rules.wildcard, false), inArray(rules.fromPath, unique)));
	const bases = [...new Set(unique.flatMap(wildcardBases))];
	const wildcards = await context.data.select(rules, and(eq(rules.wildcard, true), inArray(rules.fromPath, bases)));
	return paths.map((path) => {
		const own = exact.find((rule) => rule.fromPath === path);
		const rule = nearestRule(own, wildcards, wildcardBases(path));
		return rule ? targetOf(rule, path) : null;
	});
}

/** What a rule answers for a path it matches. */
function targetOf(rule: RuleRow, path: string): RedirectTarget {
	return {
		to: targetFor({ path: rule.fromPath, wildcard: rule.wildcard, target: rule.target }, path),
		status: rule.status === 302 ? 302 : 301,
		whereNoPage: rule.automatic,
	};
}

/** Where the rules send a request for a Site path (the Site pipeline asks, through `redirectRules`). */
export async function findTarget(context: ModuleContext, path: string): Promise<RedirectTarget | null> {
	const rule = await ruleFor(context, path);
	return rule ? targetOf(rule, path) : null;
}

/** What a person types for a rule. */
export type RuleInput = { from: string; to: string; status: 301 | 302 };

/**
 * Refuses a rule that would send visitors in a circle, or through more rules than the Site follows:
 * its target (where it starts) followed through the Site's rules, with this one in place.
 */
async function checkNoLoop(context: ModuleContext, from: RuleFrom, target: string, ruleId: string | null) {
	if (await wouldLoop(context, from, target, ruleId)) {
		throw new ModuleError(
			"RULE_LOOP",
			`Visitors would go round in a circle, or through more than ${MAX_CHAIN} rules: change where it sends them.`,
			409,
		);
	}
}

/** Whether a rule from `from` to `target` (rule `ruleId`, when it exists) would be refused as a circle. */
async function wouldLoop(context: ModuleContext, from: RuleFrom, target: string, ruleId: string | null) {
	let next = sitePathOf(target);
	const seen = new Set<string>();
	for (let hop = 0; next !== null; hop++) {
		if (covers(from, next) || seen.has(next) || hop >= MAX_CHAIN) return true;
		seen.add(next);
		const rule = await ruleFor(context, next);
		if (!rule || rule.id === ruleId) return false;
		next = sitePathOf(targetFor({ path: rule.fromPath, wildcard: rule.wildcard, target: rule.target }, next));
	}
	return false;
}

/** The rule's `from` and target, checked: a path no other rule has, a target that doesn't loop. */
async function checkedRule(context: ModuleContext, input: RuleInput, ruleId: string | null) {
	const from = parseFrom(input.from);
	const target = parseTarget(input.to, from);
	const taken = await context.data.first(rules, and(eq(rules.fromPath, from.path), eq(rules.wildcard, from.wildcard)));
	if (taken && taken.id !== ruleId) {
		throw new ModuleError("RULE_TAKEN", `Another rule already sends ${writtenFrom(from)} elsewhere.`, 409);
	}
	await checkNoLoop(context, from, target, ruleId);
	return { from, target, taken };
}

/** The 404 log's paths a rule now answers: they no longer miss. */
async function clearMisses(context: ModuleContext, from: RuleFrom) {
	if (!from.wildcard) {
		await context.data.delete(misses, eq(misses.path, from.path));
		return;
	}
	if (from.path === "/") {
		await context.data.delete(misses);
		return;
	}
	await context.data.delete(misses, or(eq(misses.path, from.path), like(misses.path, `${likeText(from.path)}/%`)));
}

/** Adds a rule a person made. Its path leaves the 404 log. */
export async function addRule(context: ModuleContext, input: RuleInput): Promise<RuleView> {
	return context.transaction(async (tx) => {
		const { from, target } = await checkedRule(tx, input, null);
		const now = tx.now();
		const row = await tx.data.insert(rules, {
			fromPath: from.path,
			wildcard: from.wildcard,
			target,
			status: input.status,
			automatic: false,
			entryId: null,
			createdAt: now,
			updatedAt: now,
		});
		await clearMisses(tx, from);
		await tx.audit("rule.add", { ruleId: row.id, from: writtenFrom(from), to: target, status: input.status });
		return ruleView(row);
	});
}

async function existing(context: ModuleContext, ruleId: string): Promise<RuleRow> {
	const row = await context.data.first(rules, eq(rules.id, ruleId));
	if (!row) throw new ModuleError("RULE_NOT_FOUND", "There is no such Redirect rule on this Site.", 404);
	return row;
}

/** Changes a rule; one the Module added becomes a person's, kept as they left it. */
export async function updateRule(
	context: ModuleContext,
	ruleId: string,
	change: Partial<RuleInput>,
): Promise<RuleView> {
	return context.transaction(async (tx) => {
		const row = await existing(tx, ruleId);
		const input: RuleInput = {
			from: change.from ?? writtenFrom({ path: row.fromPath, wildcard: row.wildcard }),
			to: change.to ?? row.target,
			status: change.status ?? (row.status === 302 ? 302 : 301),
		};
		const { from, target } = await checkedRule(tx, input, row.id);
		const [updated] = await tx.data.update(
			rules,
			{
				fromPath: from.path,
				wildcard: from.wildcard,
				target,
				status: input.status,
				automatic: false,
				updatedAt: tx.now(),
			},
			eq(rules.id, row.id),
		);
		if (!updated) throw new ModuleError("RULE_NOT_FOUND", "There is no such Redirect rule on this Site.", 404);
		await clearMisses(tx, from);
		await tx.audit("rule.update", { ruleId: row.id, from: writtenFrom(from), to: target, status: input.status });
		return ruleView(updated);
	});
}

export async function removeRule(context: ModuleContext, ruleId: string): Promise<void> {
	await context.transaction(async (tx) => {
		const row = await existing(tx, ruleId);
		await tx.data.delete(rules, eq(rules.id, row.id));
		await tx.audit("rule.remove", {
			ruleId: row.id,
			from: writtenFrom({ path: row.fromPath, wildcard: row.wildcard }),
			to: row.target,
		});
	});
}

/** A published path that changed, as WebCraft's events say. */
export type PathChange = { entryId: string; language: string; from: string; to: string };

/**
 * Follows published paths that changed at `at` (a new slug, a Page that moved with the Pages under
 * it, a URL pattern or the Default language that changed), so old links keep working:
 *
 * - a rule sending visitors to an old path now sends them to the new one (A→B, then B→C, is A→C);
 *   a rule that would then send a path to itself goes, as its path has a page again; one that would
 *   then go round in a circle through other rules stays as it was, as a person couldn't change it
 *   so either, and the Audit log entry lists it (`looping`);
 * - the old path gets a rule of the Module's own (301) to the new one, unless another page is now
 *   published there (a new path of the same change), or a person's rule has the path;
 * - rules of the Module's own from a path that has a page again (`live`, the new paths) go: they
 *   would only step aside.
 *
 * Events can arrive late and out of order, so each change is stamped with when it happened (`at`)
 * and never undoes a rule changed after it. Rules the Module adds step aside wherever a page is
 * published later (`whereNoPage`), so they never hide one. One Audit log entry tells what changed.
 */
export async function followPathChanges(
	context: ModuleContext,
	changes: readonly PathChange[],
	live: readonly string[],
	reason: string,
	at: Date,
): Promise<void> {
	if (changes.length === 0 && live.length === 0) return;
	await context.transaction(async (tx) => {
		const counts = { added: 0, changed: 0, removed: 0 };
		const looping: { from: string; to: string }[] = [];
		const livePaths = new Set([...live, ...changes.map((change) => change.to)]);
		for (const path of livePaths) {
			counts.removed += await tx.data.delete(
				rules,
				and(eq(rules.fromPath, path), eq(rules.wildcard, false), eq(rules.automatic, true), lt(rules.updatedAt, at)),
			);
			await tx.data.delete(misses, and(eq(misses.path, path), lt(misses.lastSeen, at)));
		}
		const seen = new Set<string>();
		for (const change of changes) {
			if (change.from === change.to || seen.has(change.from)) continue;
			seen.add(change.from);
			for (const rule of await tx.data.select(rules, and(eq(rules.target, change.from), lte(rules.updatedAt, at)))) {
				const from = { path: rule.fromPath, wildcard: rule.wildcard };
				// One that now sends its own path to itself goes below.
				const toItself = !rule.wildcard && rule.fromPath === change.to;
				if (!toItself && (await wouldLoop(tx, from, change.to, rule.id))) {
					looping.push({ from: writtenFrom(from), to: change.to });
					continue;
				}
				await tx.data.update(rules, { target: change.to, updatedAt: at }, eq(rules.id, rule.id));
				counts.changed++;
			}
			counts.removed += await tx.data.delete(
				rules,
				and(eq(rules.fromPath, change.to), eq(rules.wildcard, false), eq(rules.target, change.to)),
			);
			if (livePaths.has(change.from)) continue;
			const own = await tx.data.first(rules, and(eq(rules.fromPath, change.from), eq(rules.wildcard, false)));
			if (own && (!own.automatic || own.updatedAt > at)) continue;
			if (own) {
				await tx.data.update(
					rules,
					{ target: change.to, status: 301, entryId: change.entryId, updatedAt: at },
					eq(rules.id, own.id),
				);
				counts.changed++;
				continue;
			}
			await tx.data.insert(rules, {
				fromPath: change.from,
				wildcard: false,
				target: change.to,
				status: 301,
				automatic: true,
				entryId: change.entryId,
				createdAt: at,
				updatedAt: at,
			});
			await tx.data.delete(misses, eq(misses.path, change.from));
			counts.added++;
		}
		if (counts.added + counts.changed + counts.removed + looping.length > 0) {
			await tx.audit("rules.follow", { reason, ...counts, ...(looping.length > 0 ? { looping } : {}) });
		}
	});
}

/**
 * Adds the rules an Import run asks for (SDK 1.7): from where an item was on the old site to its new
 * path or its Media file. They are the Module's own (`automatic`), so they step aside where a page
 * answers their path and never hide a live page; a path that already has a rule keeps it. One Audit
 * log entry says how many were added.
 */
export async function addImportedRules(
	context: ModuleContext,
	asked: readonly ImportedRule[],
): Promise<ImportedRuleResult[]> {
	return context.transaction(async (tx) => {
		const results: ImportedRuleResult[] = [];
		const now = tx.now();
		for (const rule of asked) {
			let from: RuleFrom;
			let target: string;
			try {
				from = parseFrom(rule.from);
				target = parseTarget(rule.to, from);
				if (from.wildcard || sitePathOf(target) === from.path) throw new ModuleError("TO_INVALID", "No rule.", 400);
				await checkNoLoop(tx, from, target, null);
			} catch (error) {
				if (!isModuleError(error)) throw error;
				results.push({ skipped: "invalid" });
				continue;
			}
			const taken = await tx.data.first(rules, and(eq(rules.fromPath, from.path), eq(rules.wildcard, false)));
			if (taken) {
				results.push({ skipped: "taken" });
				continue;
			}
			const row = await tx.data.insert(rules, {
				fromPath: from.path,
				wildcard: false,
				target,
				status: 301,
				automatic: true,
				entryId: null,
				createdAt: now,
				updatedAt: now,
			});
			await tx.data.delete(misses, eq(misses.path, from.path));
			results.push({ ruleId: row.id });
		}
		const added = results.filter((result) => "ruleId" in result).length;
		if (added > 0) await tx.audit("rules.import", { added });
		return results;
	});
}

/** Removes rules an Import run added (its Undo), each only while it is as the run left it. */
export async function removeImportedRules(context: ModuleContext, added: readonly AddedRule[]): Promise<number> {
	return context.transaction(async (tx) => {
		let removed = 0;
		for (const rule of added) {
			let from: RuleFrom;
			try {
				from = parseFrom(rule.from);
			} catch (error) {
				if (isModuleError(error)) continue;
				throw error;
			}
			removed += await tx.data.delete(
				rules,
				and(
					eq(rules.id, rule.ruleId),
					eq(rules.fromPath, from.path),
					eq(rules.wildcard, false),
					eq(rules.target, rule.to),
					eq(rules.automatic, true),
				),
			);
		}
		if (removed > 0) await tx.audit("rules.undoImport", { removed });
		return removed;
	});
}
