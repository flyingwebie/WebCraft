import {
	and,
	eq,
	inArray,
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

/** How many rules a chain may go through; the Site pipeline stops at the same number. */
export const MAX_HOPS = 5;

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

/** The rule matching a Site path: one for the path itself, else the wildcard rule starting nearest to it. */
export async function ruleFor(context: ModuleContext, path: string): Promise<RuleRow | undefined> {
	const exact = await context.data.first(rules, and(eq(rules.fromPath, path), eq(rules.wildcard, false)));
	if (exact) return exact;
	const bases = wildcardBases(path);
	const found = await context.data.select(rules, and(eq(rules.wildcard, true), inArray(rules.fromPath, bases)));
	return found.sort((a, b) => b.fromPath.length - a.fromPath.length)[0];
}

/** Where the rules send a request for a Site path (the Site pipeline asks, through `redirectRules`). */
export async function findTarget(context: ModuleContext, path: string): Promise<RedirectTarget | null> {
	const rule = await ruleFor(context, path);
	if (!rule) return null;
	return {
		to: targetFor({ path: rule.fromPath, wildcard: rule.wildcard, target: rule.target }, path),
		status: rule.status === 302 ? 302 : 301,
		whereNoPage: rule.automatic,
	};
}

/** What a person types for a rule. */
export type RuleInput = { from: string; to: string; status: 301 | 302 };

/**
 * Refuses a rule that would send visitors in a circle, or through more rules than the Site follows:
 * its target (where it starts) followed through the Site's rules, with this one in place.
 */
async function checkNoLoop(context: ModuleContext, from: RuleFrom, target: string, ruleId: string | null) {
	const loop = () => {
		throw new ModuleError(
			"RULE_LOOP",
			`Visitors would go round in a circle, or through more than ${MAX_HOPS} rules: change where it sends them.`,
			409,
		);
	};
	let next = sitePathOf(target);
	const seen = new Set<string>();
	for (let hop = 0; next !== null; hop++) {
		if (covers(from, next) || seen.has(next) || hop >= MAX_HOPS) loop();
		seen.add(next);
		const rule = await ruleFor(context, next);
		if (!rule || rule.id === ruleId) return;
		next = sitePathOf(targetFor({ path: rule.fromPath, wildcard: rule.wildcard, target: rule.target }, next));
	}
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
 *   a rule that would then send a path to itself goes, as its path has a page again;
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
			const retargeted = await tx.data.update(
				rules,
				{ target: change.to, updatedAt: at },
				and(eq(rules.target, change.from), lte(rules.updatedAt, at)),
			);
			counts.changed += retargeted.length;
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
		if (counts.added + counts.changed + counts.removed > 0) {
			await tx.audit("rules.follow", { reason, ...counts });
		}
	});
}
