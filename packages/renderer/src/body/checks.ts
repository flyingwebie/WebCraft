/**
 * Checks on a body: warnings shown while it is edited, which never stop publishing. Each is about one
 * Block. The Site's list of open Checks (#95) collects them with the Checks of Templates and pages.
 */
import { type Block, blockSpec } from "./blocks.ts";
import type { InlineText } from "./inline.ts";
import { videoAt } from "./video.ts";

/**
 * What a Check is about: a heading that skips a level (an H4 right after an H2, or a body starting
 * below H2), an image whose Media item has no alt text, a link whose text says nothing about where it
 * goes ("click here", "read more"), a table without a header row, a video without a title.
 */
export const BODY_CHECKS = ["skippedHeading", "missingAlt", "vagueLink", "tableHeader", "untitledVideo"] as const;

export type BodyCheckKind = (typeof BODY_CHECKS)[number];

/** One Check: which Block (by its place and id), what it is about, and what the reader sees. */
export type BodyCheck = {
	/** The Block's place in the list, from 0. */
	index: number;
	blockId: string;
	check: BodyCheckKind;
	/** The words the Check is about: a skipped heading's levels (`H2 → H4`), a vague link's text. */
	detail?: string;
};

/** What checking a body needs to know besides its Blocks. */
export type BodyCheckContext = {
	/** The body's language, for which link texts are vague. */
	language: string;
	/** A Media item's alt text in the body's language; null when it has none, undefined for no such item. */
	altOf(mediaId: string): string | null | undefined;
};

/** Link texts that don't say where a link goes, by language (its primary subtag). */
const VAGUE_LINK_TEXTS: Readonly<Record<string, readonly string[]>> = {
	en: ["click here", "here", "click", "read more", "more", "learn more", "link", "this", "this link", "go", "details"],
	it: ["clicca qui", "qui", "clicca", "leggi di più", "leggi tutto", "di più", "scopri di più", "link", "questo"],
};

/** The Checks a body raises, in Block order. */
export function bodyChecks(blocks: readonly Block[], context: BodyCheckContext): BodyCheck[] {
	const checks: BodyCheck[] = [];
	const [primary = ""] = context.language.toLowerCase().split("-");
	const vague = new Set(VAGUE_LINK_TEXTS[primary] ?? VAGUE_LINK_TEXTS.en);
	// The page's H1 is the Entry's title, so a body's first heading is an H2.
	let previousLevel = 1;
	blocks.forEach((block, index) => {
		const raise = (check: BodyCheckKind, detail?: string) =>
			checks.push({ index, blockId: block.id, check, ...(detail === undefined ? {} : { detail }) });
		const spec = blockSpec(block);
		if (block.type === "heading" && spec.hasContent(block)) {
			if (block.level > previousLevel + 1) raise("skippedHeading", `H${previousLevel} → H${block.level}`);
			previousLevel = block.level;
		}
		if (block.type === "image" && block.media) {
			const alt = context.altOf(block.media);
			if (alt !== undefined && (alt ?? "").trim() === "") raise("missingAlt");
		}
		if (block.type === "table" && spec.hasContent(block) && !block.headerRow) raise("tableHeader");
		if (block.type === "video" && videoAt(block.url) && block.title.trim() === "") raise("untitledVideo");
		for (const text of linkTexts(spec.inlines(block))) {
			if (
				vague.has(
					text
						.toLowerCase()
						.replace(/[.…:!?]+$/u, "")
						.trim(),
				) ||
				text.trim() === ""
			) {
				raise("vagueLink", text.trim());
			}
		}
	});
	return checks;
}

/** The text of each link in formatted text (neighbouring runs with the same link are one link). */
function linkTexts(inlines: readonly InlineText[]): string[] {
	const texts: string[] = [];
	for (const inline of inlines) {
		let current = null as { link: string; text: string } | null;
		for (const run of inline) {
			if (run.link !== undefined && current?.link === run.link) {
				current.text += run.text;
				continue;
			}
			if (current) texts.push(current.text);
			current = run.link === undefined ? null : { link: run.link, text: run.text };
		}
		if (current) texts.push(current.text);
	}
	return texts;
}
