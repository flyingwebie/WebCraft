import { type Block, storedBlocks } from "@webcraft/renderer";

import type { Json } from "./field-types.ts";
import { sameJson } from "./json.ts";
import type { LanguageValue, Writer } from "./values.ts";

/**
 * Where a translated value came from (ADR 0003, ADR 0018): each value in a language other than the
 * Default language remembers who wrote it (`by`: a person or the AI) and the Default-language value it
 * translates (`source`), so a value a person wrote becomes an Outdated translation once its source
 * changes, and AI translation never overwrites it. A Body field keeps this per Block instead: each
 * Block of a translation names the Block it translates, who wrote it and what that Block held.
 */

/** A Block without its id and source: what it holds, to compare two Blocks by. */
export function blockContent(block: Block): Record<string, unknown> {
	const { id: _id, source: _source, ...content } = block;
	return content;
}

/**
 * The value a person writes in a language: in the Default language, as it is (a Block there has no
 * source); in another language, with the Default-language value it translates as its source, and for
 * a body each Block's source worked out (see `personBlocks`).
 */
export function personValue(
	stored: Readonly<Record<string, LanguageValue | undefined>>,
	languages: { language: string; defaultLanguage: string },
	type: string,
	value: Json,
	by: Writer,
): LanguageValue {
	const source = stored[languages.defaultLanguage]?.value;
	if (type === "body") {
		const blocks = storedBlocks(value);
		if (languages.language === languages.defaultLanguage) {
			return { value: blocks.map(({ source: _source, ...block }) => block) as Json, by };
		}
		return {
			value: personBlocks(blocks, storedBlocks(stored[languages.language]?.value), storedBlocks(source)) as Json,
			by,
		};
	}
	if (languages.language === languages.defaultLanguage || source === undefined || by.kind !== "person") {
		return { value, by };
	}
	return { value, by, source };
}

/**
 * A translation's Blocks as a person saved them: a Block that didn't change keeps its source; a Block
 * the person changed translates the Default-language Block it names (or shares its id with), as it
 * is now; a Block still holding exactly its source's content is a copy waiting for translation (no
 * source); a Block of the person's own (no Default-language Block) has none.
 */
export function personBlocks(
	blocks: readonly Block[],
	previous: readonly Block[],
	defaults: readonly Block[],
): Block[] {
	const before = new Map(previous.map((block) => [block.id, block]));
	const sources = new Map(defaults.map((block) => [block.id, block]));
	return blocks.map((block) => {
		const { source: given, ...plain } = block;
		const content = blockContent(block);
		const earlier = before.get(block.id);
		if (earlier && sameJson(blockContent(earlier), content)) {
			return (earlier.source ? { ...plain, source: earlier.source } : plain) as Block;
		}
		const from = sources.get(given?.id ?? block.id);
		if (!from) return plain as Block;
		const was = blockContent(from);
		if (sameJson(was, content)) return plain as Block;
		return { ...plain, source: { id: from.id, by: "person", was } } as Block;
	});
}

/** A value's state in a language against the Default language's (its source). */
export type TranslationState =
	/** No value of its own: it falls back to the Default language. */
	| "missing"
	/** Written by the AI from the source as it is now, or by a person (or of unknown source) and still current. */
	| "current"
	/** Written by the AI from a source that has changed since: AI translation writes it again. */
	| "stale"
	/** Written by a person, and its source changed since: an Outdated translation, never overwritten. */
	| "outdated";

/** Where a language's own value stands against its source (`source`: the Default language's value now). */
export function translationState(own: LanguageValue | undefined, source: Json | undefined): TranslationState {
	if (!own || own.value === null || own.value === "") return "missing";
	if (own.by?.kind === "ai") return sameJson(own.source, source) ? "current" : "stale";
	if (own.source !== undefined && !sameJson(own.source, source)) return "outdated";
	return "current";
}

/** Where a Block of a translation stands against the Block it translates (`source`, as it is now). */
export function blockState(block: Block, source: Block | undefined): TranslationState {
	if (!source) return "current";
	if (!block.source) return sameJson(blockContent(block), blockContent(source)) ? "missing" : "current";
	const changed = !sameJson(block.source.was, blockContent(source));
	if (block.source.by === "ai") return changed ? "stale" : "current";
	return block.source.was !== undefined && changed ? "outdated" : "current";
}
