import { type Block, storedBlocks } from "@webcraft/renderer";

import type { Json } from "../content/field-types.ts";
import type { StoredValues } from "../content/field-values.ts";
import { sameJson } from "../content/json.ts";
import { blockState, translationState } from "../content/translation-sources.ts";
import type { LanguageValue } from "../content/values.ts";
import { apiPath, blockText, leafAt, readableText, type Unit } from "./units.ts";

/**
 * Where an item's translations stand in one language, from its Draft: which values a person wrote
 * and are Outdated translations (with the old and the new source), which the AI wrote and wait for a
 * person to publish (To review), and which have no translation yet.
 */

/** A translation a person wrote whose source changed since: shown next to the old and the new source. */
export type OutdatedTranslation = {
	/** The value's place (`fields.summary`, `title`, `seo.description`). */
	at: string;
	/** In a Body field, the Block of the translation; null for any other value. */
	block: string | null;
	/** What its Fields are called (`Team`, `Role`). */
	labels: string[];
	/** The translation, as people read it. */
	translation: string;
	/** Its source when the translation was written, and now. */
	oldSource: string;
	newSource: string;
};

/** An item's translations in one language. */
export type ItemTranslation = {
	outdated: OutdatedTranslation[];
	/** The places of values the AI wrote (in a body, Blocks the AI wrote are listed as `fields.body#<id>`). */
	aiWritten: string[];
	/** The places of values the AI wrote that aren't published yet. */
	toReview: string[];
	/** The places of values with no translation of their own. */
	missing: string[];
	/** How many values there are to translate. */
	total: number;
};

/** The translations of an item's Draft in `language`, against its published version. */
export function itemTranslation(
	draft: StoredValues,
	published: StoredValues | null,
	units: readonly Unit[],
	languages: { language: string; defaultLanguage: string },
): ItemTranslation {
	const out: ItemTranslation = { outdated: [], aiWritten: [], toReview: [], missing: [], total: 0 };
	if (languages.language === languages.defaultLanguage) return out;
	for (const unit of units) {
		const leaf = leafAt(draft, unit.path);
		const source = leaf?.[languages.defaultLanguage]?.value;
		if (source === undefined || source === null || source === "" || (Array.isArray(source) && source.length === 0)) {
			continue;
		}
		out.total++;
		const own = leaf?.[languages.language];
		const at = apiPath(unit.path);
		if (own?.by?.kind === "ai") {
			out.aiWritten.push(at);
			const live = published ? leafAt(published, unit.path)?.[languages.language] : undefined;
			if (!sameJson(own, live)) out.toReview.push(at);
		}
		if (unit.kind === "body") {
			const defaults = storedBlocks(source);
			const blocks = storedBlocks(own?.value);
			if (blocks.length === 0) out.missing.push(at);
			for (const block of blocks) outdatedBlock(out, unit, at, block, defaults);
			continue;
		}
		const state = translationState(own, source);
		if (state === "missing") out.missing.push(at);
		if (state === "outdated" && own) {
			out.outdated.push({
				at,
				block: null,
				labels: unit.labels,
				translation: readableText(unit.kind, own.value),
				oldSource: readableText(unit.kind, own.source as Json),
				newSource: readableText(unit.kind, source),
			});
		}
	}
	return out;
}

function outdatedBlock(out: ItemTranslation, unit: Unit, at: string, block: Block, defaults: readonly Block[]): void {
	if (block.source?.by === "ai") out.aiWritten.push(`${at}#${block.id}`);
	const source = defaults.find((candidate) => candidate.id === (block.source?.id ?? block.id));
	if (!source || blockState(block, source) !== "outdated" || !block.source?.was) return;
	out.outdated.push({
		at,
		block: block.id,
		labels: unit.labels,
		translation: blockText(block),
		oldSource: blockText(block.source.was),
		newSource: blockText(source),
	});
}

/** Whether a language value is one the AI wrote. */
export function byAi(value: LanguageValue | undefined): boolean {
	return value?.by?.kind === "ai";
}
