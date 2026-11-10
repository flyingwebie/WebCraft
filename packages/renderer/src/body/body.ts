/**
 * A body: one language's list of Blocks (ADR 0018). Reading one from input checks every Block and
 * answers the canonical list; rendering writes semantic HTML with no classes but WebCraft's reserved
 * hooks; the derived values Templates and Loops read (`body.excerpt`, `body.image`,
 * `body.reading_time`, `body.toc`) are worked out from the Blocks, never by parsing HTML.
 */
import { escapeAttribute } from "../escape.ts";
import type { ImagePriority, MediaReader } from "../media.ts";
import {
	BLOCK_ID,
	BLOCK_TYPE_SPECS,
	BLOCK_TYPES,
	type Block,
	type BlockSource,
	BODY_LIMITS,
	blockSpec,
	type ComponentBlock,
	type HeadingBlock,
	type HoldEmbed,
	isBodyBlockType,
} from "./blocks.ts";
import { inlineText, type Report, renderInline } from "./inline.ts";

/** A problem with a body given as input, at a path inside it (`[2].text[0].link`). */
export type BodyProblem = { at: string; message: string };

/** A new Block's id: 12 random letters and digits. */
export function newBlockId(): string {
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => alphabet[byte % alphabet.length]).join("");
}

/**
 * Reads a body from input: a list of Blocks, each `{ id, type, …its settings }`. A Block without an
 * id gets a new one; the ids given are kept, so Blocks keep theirs from save to save. Answers the
 * canonical list, or the problems that keep it from being one (each at its path).
 */
export function readBody(input: unknown): { blocks: Block[]; problems: BodyProblem[] } {
	const problems: BodyProblem[] = [];
	const report: Report = (at, message) => problems.push({ at, message });
	if (!Array.isArray(input)) {
		report("", "A body is a list of Blocks.");
		return { blocks: [], problems };
	}
	if (input.length > BODY_LIMITS.blocks) {
		report("", `A body has at most ${BODY_LIMITS.blocks} Blocks.`);
		return { blocks: [], problems };
	}
	const ids = new Set<string>();
	const blocks: Block[] = [];
	input.forEach((item: unknown, index) => {
		const here = `[${index}]`;
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			report(here, "A Block is { id, type, …its settings }.");
			return;
		}
		const { id: givenId, type, source, ...settings } = item as Record<string, unknown>;
		if (!isBodyBlockType(type)) {
			report(`${here}.type`, `A Block's type is one of ${BLOCK_TYPES.join(", ")}, or component.`);
			return;
		}
		if (givenId !== undefined && (typeof givenId !== "string" || !BLOCK_ID.test(givenId))) {
			report(`${here}.id`, "A Block's id is 1 to 64 letters, digits, dashes and underscores.");
			return;
		}
		const id = (givenId as string | undefined) ?? newBlockId();
		if (ids.has(id)) {
			report(`${here}.id`, `Two Blocks have the id ${id}.`);
			return;
		}
		ids.add(id);
		const spec = BLOCK_TYPE_SPECS[type];
		for (const key of Object.keys(settings)) {
			if (!spec.settings.includes(key)) report(`${here}.${key}`, `A ${type} Block has no ${key}.`);
		}
		const read = spec.read(settings, (at, message) => report(`${here}${at}`, message));
		const block = { id, type, ...read } as Block;
		const from = readSource(source, `${here}.source`, report);
		if (from) block.source = from;
		blocks.push(block);
	});
	const characters = blocks.reduce(
		(total, block) =>
			total +
			blockSpec(block)
				.texts(block)
				.reduce((sum, text) => sum + text.length, 0),
		0,
	);
	if (characters > BODY_LIMITS.characters) {
		report("", `A body has at most ${BODY_LIMITS.characters} characters of text.`);
	}
	return { blocks, problems };
}

function readSource(input: unknown, at: string, report: Report): BlockSource | undefined {
	if (input === undefined || input === null) return undefined;
	const { id, by, was } = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<
		string,
		unknown
	>;
	const wasRecord = was === undefined || (was !== null && typeof was === "object" && !Array.isArray(was));
	if (typeof id !== "string" || !BLOCK_ID.test(id) || (by !== "person" && by !== "ai") || !wasRecord) {
		report(at, "A translated Block's source is { id: the Block it translates, by: person or ai, was? }.");
		return undefined;
	}
	return was === undefined ? { id, by } : { id, by, was: was as Record<string, unknown> };
}

/** Reads stored Blocks: the canonical list as saved, or an empty one when it isn't a list. */
export function storedBlocks(value: unknown): Block[] {
	return Array.isArray(value) ? (value as Block[]) : [];
}

/** Whether a body shows anything: some Block with content (dividers alone don't count). */
export function bodyHasContent(blocks: readonly Block[]): boolean {
	return blocks.some((block) => blockSpec(block).hasContent(block));
}

// ---------------------------------------------------------------------------------------------------
// Anchors and the table of contents

/** One heading as the table of contents lists it. */
export type TocHeading = { level: 2 | 3 | 4; text: string; anchor: string };

/** An anchor made from a heading's text: lower-case letters and digits joined by dashes. */
export function anchorFromText(text: string): string {
	const words = text
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.match(/[\p{L}\p{N}]+/gu);
	let anchor = (words ?? []).join("-").slice(0, 64).replace(/-+$/, "");
	if (anchor === "") anchor = "section";
	// `wc-` ids are WebCraft's own (the main content's, the skip link's target).
	if (anchor.startsWith("wc-")) anchor = `h-${anchor}`.slice(0, 64);
	return anchor;
}

/**
 * Each heading's anchor, by Block id: the one written by hand, else made from its text; a later
 * heading with an anchor already taken gets `-2`, `-3`, … so every anchor on the body is its own.
 */
export function headingAnchors(blocks: readonly Block[]): Map<string, string> {
	const anchors = new Map<string, string>();
	const taken = new Set<string>();
	for (const block of blocks) {
		if (block.type !== "heading" || !blockSpec(block).hasContent(block)) continue;
		const stem = block.anchor ?? anchorFromText(inlineText(block.text));
		let anchor = stem;
		for (let attempt = 2; taken.has(anchor.toLowerCase()); attempt++) anchor = `${stem}-${attempt}`;
		taken.add(anchor.toLowerCase());
		anchors.set(block.id, anchor);
	}
	return anchors;
}

/** The body's headings, in order, with their anchors: `body.toc`. */
export function bodyToc(blocks: readonly Block[]): TocHeading[] {
	const anchors = headingAnchors(blocks);
	return blocks.flatMap((block) => {
		const anchor = block.type === "heading" ? anchors.get(block.id) : undefined;
		return block.type === "heading" && anchor
			? [{ level: block.level, text: inlineText(block.text).trim(), anchor }]
			: [];
	});
}

/**
 * A table of contents as HTML: a numbered list of links to the headings, each heading's list holding
 * the headings under it (an H3 under the H2 before it). Nothing when the body has no headings.
 */
export function renderToc(headings: readonly TocHeading[]): string {
	let index = 0;
	const level = (parent: number): string => {
		const items: string[] = [];
		while (index < headings.length && (headings[index] as TocHeading).level > parent) {
			const heading = headings[index] as TocHeading;
			index++;
			const link = `<a href="#${escapeAttribute(heading.anchor)}">${renderInline([{ text: heading.text }])}</a>`;
			items.push(`<li>${link}${level(heading.level)}</li>`);
		}
		return items.length > 0 ? `<ol>${items.join("")}</ol>` : "";
	};
	return level(1);
}

// ---------------------------------------------------------------------------------------------------
// Derived values

/** The first paragraph with text, as plain text (line breaks as spaces): `body.excerpt`. Null when there is none. */
export function bodyExcerpt(blocks: readonly Block[]): string | null {
	for (const block of blocks) {
		if (block.type === "paragraph" && blockSpec(block).hasContent(block)) {
			return inlineText(block.text).replace(/\s+/g, " ").trim();
		}
	}
	return null;
}

/** The Media id of the first image chosen: `body.image`, which Templates read as `media:<id>`. Null when there is none. */
export function bodyImage(blocks: readonly Block[]): string | null {
	for (const block of blocks) if (block.type === "image" && block.media) return block.media;
	return null;
}

/** Words read a minute, for `body.reading_time`. */
export const WORDS_PER_MINUTE = 200;

/** How many words the body's text has. */
export function bodyWords(blocks: readonly Block[]): number {
	return bodyText(blocks).match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
}

/** The minutes reading the body takes, rounded up (`body.reading_time`); 0 for a body with no text. */
export function bodyReadingTime(blocks: readonly Block[]): number {
	const words = bodyWords(blocks);
	return words === 0 ? 0 : Math.ceil(words / WORDS_PER_MINUTE);
}

/** The body as plain text: each Block's text, Blocks apart by a blank line. */
export function bodyText(blocks: readonly Block[]): string {
	return blocks
		.flatMap((block) => blockSpec(block).texts(block))
		.map((text) => text.trim())
		.filter((text) => text !== "")
		.join("\n\n");
}

// ---------------------------------------------------------------------------------------------------
// Rendering

/** What rendering a body needs from the page. */
export type RenderBodyOptions = {
	media?: MediaReader;
	priorityImage?: ImagePriority;
	/** WebCraft's own words in the page's language. */
	words: { playVideo: string; video: string };
	/** Counts the videos rendered, so the page links the embed script only when it shows one. */
	shown?: { videos: number };
	/** Holds embeds back until visitors accept their Consent category (see `HoldEmbed`). */
	held?: HoldEmbed;
	/** Edit mode's tags for an image Block's image, by the Block's id (see `BodyRenderContext.imageRegion`). */
	imageRegion?: (blockId: string) => readonly (readonly [string, string])[] | undefined;
	/** What a Component Block shows (see `BodyRenderContext.component`). */
	component?: (block: ComponentBlock) => string;
	/**
	 * Edit mode: marks each Block with HTML comments (`<!--wc-block <id>-->` … `<!--/wc-block-->`), so
	 * the block editor finds what each one shows (a Component's elements included) without changing
	 * the page's layout. Absent for the pages visitors get.
	 */
	markBlocks?: boolean;
	/** Diagnostic rendering only: associates a Check with its Block in the editor. */
	checkPath?: string;
};

/**
 * A body as semantic HTML: each Block that shows something, in order. Headings carry their anchors
 * as ids; the only classes are WebCraft's reserved hooks, `wc-callout` and `wc-embed`, which the
 * Design system styles. Every text is escaped, and nothing from Content is ever written as HTML.
 */
export function renderBody(blocks: readonly Block[], options: RenderBodyOptions): string {
	const context = { ...options, anchors: headingAnchors(blocks) };
	let html = "";
	for (const block of blocks) {
		const spec = blockSpec(block);
		// In Edit mode an image Block with no image yet is still there, to choose one in.
		const regionOnly = block.type === "image" && options.imageRegion !== undefined;
		if (block.type !== "divider" && !spec.hasContent(block) && !regionOnly) continue;
		let shown = spec.render(block, context);
		if (options.checkPath && block.type !== "component")
			shown = shown.replace(
				/^<([a-z][a-z0-9]*)/,
				`<$1 data-wc-check-at="${escapeAttribute(options.checkPath)}[${blocks.indexOf(block)}]"`,
			);
		html += options.markBlocks ? `<!--wc-block ${block.id}-->${shown}<!--/wc-block-->` : shown;
	}
	return html;
}

export type { HeadingBlock };
