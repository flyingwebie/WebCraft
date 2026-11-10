import { createHash } from "node:crypto";

import { translationCache, translationCounts } from "@webcraft/db/schema";
import {
	type Block,
	type BlockText,
	blockSpec,
	cleanRichText,
	inlinePiece,
	newBlockId,
	richTextTranslation,
	sameMarkers,
	storedBlocks,
	TranslationMarkersError,
} from "@webcraft/renderer";
import { and, eq, inArray, sql } from "drizzle-orm";

import type { AiKeys } from "../ai/keys.ts";
import { type AiLanguage, AiProviderError, type AiProviders } from "../ai/providers.ts";
import type { ModuleComponent } from "../content/components.ts";
import type { Json } from "../content/field-types.ts";
import { blockContent, blockState, translationState } from "../content/translation-sources.ts";
import type { LanguageValue } from "../content/values.ts";
import type { Executor } from "../tenancy/data-layer.ts";
import { blockPropsPlan } from "./block-props.ts";
import { type Glossary, protectTerms, restoreTerms } from "./terms.ts";
import { leafAt, type StoredLeaf, type Unit } from "./units.ts";

/**
 * The translation engine: turns values into pieces of text (only text, with markers for formatting
 * and Protected terms), takes what the Site's translation cache already holds, sends the rest to the
 * AI provider in batches through the Workspace's AI key (its budget and cap), checks every answer
 * kept every marker, and builds the translated values back. It writes nothing: all or nothing is the
 * caller's to keep.
 */

/** One value to translate: the unit, its Default-language value, and the language's own value now. */
export type TranslationJob = { unit: Unit; source: Json; target: LanguageValue | undefined };

export type TranslateContext = {
	moduleComponents?: readonly ModuleComponent[];
	ai: AiProviders;
	keys: AiKeys;
	db: Executor;
	place: { workspaceId: string; siteId: string };
	from: AiLanguage;
	to: AiLanguage;
	glossary: Glossary;
	now: Date;
};

/** How much text goes in one call at most, and how many pieces. */
const BATCH = { characters: 6_000, pieces: 60 };

/**
 * The values of `values` that need AI translation into `language`: those the language has none of,
 * and those the AI wrote from a source that changed since. A person's value is never one of them
 * (an Outdated translation waits for a person), unless `force` asks for every value of `units`.
 */
export function pendingJobs(
	values: Record<string, unknown>,
	units: readonly Unit[],
	languages: { language: string; defaultLanguage: string },
	force = false,
): TranslationJob[] {
	const jobs: TranslationJob[] = [];
	for (const unit of units) {
		const leaf = leafAt(values, unit.path);
		const source = leaf?.[languages.defaultLanguage]?.value;
		if (source === undefined || source === null || source === "") continue;
		const target = leaf?.[languages.language];
		if (unit.kind === "body") {
			if (force || bodyPlan(storedBlocks(source), storedBlocks(target?.value), force).work) {
				jobs.push({ unit, source, target });
			}
			continue;
		}
		const state = translationState(target, source);
		if (force || state === "missing" || state === "stale") jobs.push({ unit, source, target });
	}
	return jobs;
}

/** What translating one value takes: its pieces, and how to build the new value from their translations. */
type Plan = { pieces: string[]; finish(translations: readonly string[]): LanguageValue };

function planFor(job: TranslationJob, force: boolean, components: readonly ModuleComponent[]): Plan {
	const by = { kind: "ai" } as const;
	const { source } = job;
	switch (job.unit.kind) {
		case "richText": {
			const html = typeof source === "string" ? source : "";
			const rich = richTextTranslation(html);
			return { pieces: rich.pieces, finish: (texts) => ({ value: cleanRichText(rich.rebuild(texts)), by, source }) };
		}
		case "link": {
			const link = (source && typeof source === "object" && !Array.isArray(source) ? source : {}) as Record<
				string,
				Json
			>;
			const text = typeof link.text === "string" ? link.text : "";
			if (text.trim() === "") return { pieces: [], finish: () => ({ value: source, by, source }) };
			return {
				pieces: [text],
				finish: (texts) => ({ value: { ...link, text: (texts[0] ?? text).trim() }, by, source }),
			};
		}
		case "body": {
			const plan = bodyPlan(storedBlocks(source), storedBlocks(job.target?.value), force, components);
			return { pieces: plan.pieces, finish: (texts) => ({ value: plan.finish(texts) as Json, by }) };
		}
		default: {
			const text = typeof source === "string" ? source : "";
			return { pieces: [text], finish: (texts) => ({ value: (texts[0] ?? text).trim(), by, source }) };
		}
	}
}

/**
 * A translation's Blocks, made from the Default language's (`defaults`) and the translation's now
 * (`current`): a Block a person wrote stays, even Outdated; a Block the AI wrote from its source as it
 * is now stays; every other Block of the source is translated (or copied, when it holds no text);
 * Blocks the AI wrote for a source Block that is gone are dropped; a person's own Blocks stay where
 * they were. `force` translates every Block again.
 */
export function bodyPlan(
	defaults: readonly Block[],
	current: readonly Block[],
	force = false,
	components: readonly ModuleComponent[] = [],
): { work: boolean; pieces: string[]; finish(translations: readonly string[]): Block[] } {
	const sourceIds = new Set(defaults.map((block) => block.id));
	const sourceOf = (block: Block) => block.source?.id ?? (sourceIds.has(block.id) ? block.id : null);
	const translations = new Map<string, Block>();
	const orphans = new Map<string | null, Block[]>();
	let after: string | null = null;
	let dropped = false;
	for (const block of current) {
		const from = sourceOf(block);
		if (from !== null && sourceIds.has(from)) {
			if (!translations.has(from)) translations.set(from, block);
			after = from;
		} else if (block.source?.by === "ai") {
			dropped = true;
		} else {
			orphans.set(after, [...(orphans.get(after) ?? []), block]);
		}
	}
	const kept = new Set<string>();
	for (const [from, block] of translations) {
		const source = defaults.find((candidate) => candidate.id === from);
		const state = blockState(block, source);
		if (!force && (state === "current" || state === "outdated")) kept.add(from);
	}
	const usedIds = new Set(
		[...current].filter((block) => kept.has(sourceOf(block) ?? "") || !sourceOf(block)).map((block) => block.id),
	);
	const pending = new Set<string>();
	const pieces: string[] = [];
	const readers: { block: Block; finish: (texts: readonly string[]) => Block }[] = [];
	for (const block of defaults) {
		if (kept.has(block.id)) continue;
		const declared = block.type === "component" ? components.find((c) => c.id === block.component) : undefined;
		// Missing or malformed declarations cannot identify human text. Retain existing translations,
		// or a plain source copy that stays Missing, so restoring the Module can translate it later.
		if (block.type === "component" && block.component.includes(":") && !declared) {
			pending.add(block.id);
			continue;
		}
		if (block.type === "component" && declared) {
			const plan = blockPropsPlan(block, declared.props);
			const start = pieces.length;
			pieces.push(...plan.pieces);
			readers.push({ block, finish: (texts) => plan.finish(texts.slice(start, start + plan.pieces.length)) });
			continue;
		}
		const parts = blockSpec(block)
			.translatable(block)
			.map((text) => {
				if ("plain" in text) {
					const index = pieces.length;
					pieces.push(text.plain);
					return (texts: readonly string[]): BlockText => ({ plain: texts[index] ?? text.plain });
				}
				const inline = inlinePiece(text.inline);
				const index = pieces.length;
				pieces.push(inline.piece);
				return (texts: readonly string[]): BlockText => ({ inline: inline.read(texts[index] ?? inline.piece) });
			});
		readers.push({
			block,
			finish: (texts) =>
				blockSpec(block).translated(
					block,
					parts.map((read) => read(texts)),
				),
		});
	}
	const work = readers.length > 0 || dropped || pending.size > 0;
	return {
		work,
		pieces,
		finish(texts) {
			const made = new Map<string, Block>();
			for (const { block, finish } of readers) {
				const translated = finish(texts);
				const id = usedIds.has(block.id) ? newBlockId() : block.id;
				usedIds.add(id);
				made.set(block.id, {
					...translated,
					id,
					source: { id: block.id, by: "ai", was: blockContent(block) },
				} as Block);
			}
			const out: Block[] = [...(orphans.get(null) ?? [])];
			for (const block of defaults) {
				const own = made.get(block.id) ?? translations.get(block.id) ?? (pending.has(block.id) ? block : undefined);
				if (own) out.push(own);
				out.push(...(orphans.get(block.id) ?? []));
			}
			return out;
		},
	};
}

/** The SHA-256 of a piece, as the cache keeps it. */
function hashOf(piece: string): string {
	return createHash("sha256").update(piece).digest("hex");
}

/**
 * Translates the jobs' values into `context.to`: answers each job's new value in that language, by
 * unit path. Throws what the AI key throws (`AiKeyMissingError`, `AiCapReachedError`) and
 * `AiProviderError` (`answer` when a translation dropped or changed a marker); then nothing is
 * answered, though the batches already paid for stay in the cache.
 */
export async function translateValues(
	context: TranslateContext,
	jobs: readonly TranslationJob[],
	force = false,
): Promise<Map<string, LanguageValue>> {
	const plans = jobs.map((job) => planFor(job, force, context.moduleComponents ?? []));
	const unique = [...new Set(plans.flatMap((plan) => plan.pieces).filter((piece) => piece.trim() !== ""))];
	const done = new Map<string, string>();
	if (unique.length > 0) {
		const hashes = new Map(unique.map((piece) => [piece, hashOf(piece)]));
		const cached = await context.db
			.select({ hash: translationCache.sourceHash, translation: translationCache.translation })
			.from(translationCache)
			.where(
				and(
					eq(translationCache.siteId, context.place.siteId),
					eq(translationCache.language, context.to.code),
					eq(translationCache.glossary, context.glossary.version),
					inArray(translationCache.sourceHash, [...hashes.values()]),
				),
			);
		const byHash = new Map(cached.map((row) => [row.hash, row.translation]));
		const missing: string[] = [];
		for (const piece of unique) {
			const hit = byHash.get(hashes.get(piece) ?? "");
			if (hit !== undefined) done.set(piece, hit);
			else missing.push(piece);
		}
		await count(context, unique.length - missing.length, missing.length);
		for (const batch of batches(missing)) {
			const translated = await translateBatch(context, batch);
			for (const [piece, translation] of translated) done.set(piece, translation);
			await context.db
				.insert(translationCache)
				.values(
					[...translated].map(([piece, translation]) => ({
						workspaceId: context.place.workspaceId,
						siteId: context.place.siteId,
						language: context.to.code,
						glossary: context.glossary.version,
						sourceHash: hashes.get(piece) ?? hashOf(piece),
						translation,
						createdAt: context.now,
					})),
				)
				.onConflictDoNothing();
		}
	}
	const values = new Map<string, LanguageValue>();
	jobs.forEach((job, index) => {
		const plan = plans[index];
		if (!plan) return;
		try {
			values.set(job.unit.path, plan.finish(plan.pieces.map((piece) => done.get(piece) ?? piece)));
		} catch (error) {
			if (error instanceof TranslationMarkersError) {
				throw new AiProviderError("answer", "A translation dropped, added or changed a marker.", { cause: error });
			}
			throw error;
		}
	});
	return values;
}

function* batches(pieces: readonly string[]): Generator<string[]> {
	let batch: string[] = [];
	let size = 0;
	for (const piece of pieces) {
		if (batch.length > 0 && (size + piece.length > BATCH.characters || batch.length >= BATCH.pieces)) {
			yield batch;
			batch = [];
			size = 0;
		}
		batch.push(piece);
		size += piece.length;
	}
	if (batch.length > 0) yield batch;
}

/** One call: the pieces with their Protected terms swapped out, checked and put back. */
async function translateBatch(context: TranslateContext, pieces: readonly string[]): Promise<Map<string, string>> {
	const protectedPieces = pieces.map((piece) => protectTerms(piece, context.glossary));
	const characters = protectedPieces.reduce((total, piece) => total + piece.text.length, 0);
	const estimate = { inputTokens: Math.ceil(characters / 2) + 600, outputTokens: characters + 600 };
	const answers = await context.keys.call(context.place, "translation", estimate, async (connection) => {
		const answer = await context.ai.translate({
			connection,
			purpose: "translation",
			from: context.from,
			to: context.to,
			texts: protectedPieces.map((piece) => piece.text),
		});
		return { value: answer.texts, usage: answer.usage };
	});
	if (answers.length !== pieces.length) {
		throw new AiProviderError("answer", `The AI provider didn't answer ${pieces.length} translations.`);
	}
	const translated = new Map<string, string>();
	pieces.forEach((piece, index) => {
		const sent = protectedPieces[index];
		const answer = answers[index] ?? "";
		// Every marker sent must come back exactly once: a Protected term or formatting the answer lost is refused.
		if (!sent || !sameMarkers(sent.text, answer)) {
			throw new AiProviderError("answer", "A translation dropped, added or changed a marker.");
		}
		translated.set(piece, restoreTerms(answer, sent.terms));
	});
	return translated;
}

/** Counts this month's pieces taken from the cache and sent to a provider, for the Site's usage. */
async function count(context: TranslateContext, cached: number, sent: number): Promise<void> {
	if (cached === 0 && sent === 0) return;
	const month = context.now.toISOString().slice(0, 7);
	await context.db
		.insert(translationCounts)
		.values({ workspaceId: context.place.workspaceId, siteId: context.place.siteId, month, cached, sent })
		.onConflictDoUpdate({
			target: [translationCounts.siteId, translationCounts.month],
			set: {
				cached: sql`${translationCounts.cached} + ${cached}`,
				sent: sql`${translationCounts.sent} + ${sent}`,
			},
		});
}

/** A unit's stored value with a language's value set (or kept as it is when `value` is undefined). */
export function withLanguage(leaf: StoredLeaf | undefined, language: string, value: LanguageValue): StoredLeaf {
	return { ...(leaf ?? {}), [language]: value };
}
