/**
 * Blocks (ADR 0018): the units of a Body field, kept as a JSON list of typed Blocks with stable ids,
 * never as HTML or Markdown. Every Block type is one entry in `BLOCK_TYPES`, the registry the renderer,
 * the admin's block editor and the Checks read from: what a Block of the type holds (read from input
 * into its canonical form), its text (for excerpts, reading time and translation) and the semantic
 * HTML it renders as. Module Block types (#110) and Components in a body (#79) join the registry.
 *
 * Each language keeps its own Block list. A Block in a translation names the Block it translates
 * and whether a person or the AI wrote it (`source`), so translations follow the Default language
 * one Block at a time.
 */
import { escapeAttribute, escapeText } from "../escape.ts";
import { type ImagePriority, type MediaReader, renderMediaImage } from "../media.ts";
import { hasText, type InlineText, inlineText, type Report, readInline, renderInline } from "./inline.ts";
import { videoAt } from "./video.ts";

export type { InlineText, Mark, Run } from "./inline.ts";

/** The Block types core has, in the order the block editor offers them. */
export const BLOCK_TYPES = [
	"paragraph",
	"heading",
	"list",
	"quote",
	"image",
	"video",
	"table",
	"callout",
	"code",
	"divider",
	"toggle",
] as const;

export type BlockType = (typeof BLOCK_TYPES)[number];

/**
 * Every type a Block can have: core's Block types, and `component`, a Component Staff allow in the
 * Body field, placed with its Prop values (#79). Components aren't switched off with `blocksOff`:
 * each Body field lists the Components it allows (empty by default).
 */
export type BodyBlockType = BlockType | "component";

/** Block types Staff can't switch off: a body always has paragraphs. */
export const ALWAYS_ON_BLOCKS: readonly BlockType[] = ["paragraph"];

/** The heading levels a body has: the page's H1 is the Entry's title. */
export const HEADING_LEVELS = [2, 3, 4] as const;
export type HeadingLevel = (typeof HEADING_LEVELS)[number];

export const LIST_STYLES = ["bulleted", "numbered"] as const;
export type ListStyle = (typeof LIST_STYLES)[number];

/** A callout's tone, which the Design system styles (`data-tone`). */
export const CALLOUT_TONES = ["info", "success", "warning", "danger"] as const;
export type CalloutTone = (typeof CALLOUT_TONES)[number];

/** The limits a body keeps. */
export const BODY_LIMITS = {
	/** Blocks in one language's list. */
	blocks: 2_000,
	/** Characters of text in all the Blocks of one list. */
	characters: 500_000,
	/** Characters of text in one piece of formatted text (a paragraph, an item, a cell). */
	text: 20_000,
	/** Characters in a code Block. */
	code: 50_000,
	/** Items in one list, counting nested ones. */
	listItems: 1_000,
	/** How deep list items nest. */
	listDepth: 3,
	tableRows: 500,
	tableColumns: 20,
	/** Characters of a video's address and title. */
	videoUrl: 2_000,
	videoTitle: 300,
} as const;

/** A Block's id: 1 to 64 letters, digits, dashes and underscores; it never changes. */
export const BLOCK_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * On a Block of a translation: the Block it translates (by id), who wrote the translation, and what
 * that Block held when it was translated (`was`: its settings, without id), so a translation a person
 * wrote becomes an Outdated translation once the Block it translates changes.
 */
export type BlockSource = { id: string; by: "person" | "ai"; was?: Record<string, unknown> };

/** A Block's text as AI translation reads and writes it: formatted text, or plain text (a video's title). */
export type BlockText = { inline: InlineText } | { plain: string };

type BlockBase = { id: string; source?: BlockSource };

export type ParagraphBlock = BlockBase & { type: "paragraph"; text: InlineText };
/** A heading. `anchor` is the id visitors link to, made from its text unless given. */
export type HeadingBlock = BlockBase & { type: "heading"; level: HeadingLevel; text: InlineText; anchor?: string };
/** An item of a list, with the items nested under it. */
export type ListItem = { text: InlineText; items?: ListItem[] };
export type ListBlock = BlockBase & { type: "list"; style: ListStyle; items: ListItem[] };
export type QuoteBlock = BlockBase & { type: "quote"; text: InlineText };
/** A Media image; its alt text and caption come from the (translatable) Media item. Null until one is chosen. */
export type ImageBlock = BlockBase & { type: "image"; media: string | null; decorative?: boolean };
/** A YouTube or Vimeo video, by its address, with a title for people who can't see it. */
export type VideoBlock = BlockBase & { type: "video"; url: string; title: string };
/** A table: rows of cells, the first row its header when `headerRow`. */
export type TableBlock = BlockBase & { type: "table"; headerRow: boolean; rows: InlineText[][] };
export type CalloutBlock = BlockBase & { type: "callout"; tone: CalloutTone; text: InlineText };
/** Code, kept exactly as written; `language` names its language for highlighting (`js`), or null. */
export type CodeBlock = BlockBase & { type: "code"; code: string; language: string | null };
export type DividerBlock = BlockBase & { type: "divider" };
/** Text shown and hidden by its summary (`<details>`). */
export type ToggleBlock = BlockBase & { type: "toggle"; summary: InlineText; text: InlineText };
/**
 * One Prop's value in a Component placed in a body: fixed text, read through the Prop's Field type as
 * a Placement's fixed text is (`media:<id>`, `true`, JSON for a Group). Members fill it; nothing in it
 * is a binding.
 */
export type BlockProp = { name: string; value: string };
/**
 * A Component placed in a body (a Placement, GLOSSARY.md): the Component's id (a UUID, or
 * `<module id>:<Name>` for a Module's) and its Prop values. It renders as the Component's published
 * tree, as a Placement in a Template does; nothing inside it is edited in the body.
 */
export type ComponentBlock = BlockBase & { type: "component"; component: string; props: BlockProp[] };

export type Block =
	| ParagraphBlock
	| HeadingBlock
	| ListBlock
	| QuoteBlock
	| ImageBlock
	| VideoBlock
	| TableBlock
	| CalloutBlock
	| CodeBlock
	| DividerBlock
	| ToggleBlock
	| ComponentBlock;

/** What rendering a body needs from the page. */
export type BodyRenderContext = {
	/** The Site's Media items an image Block shows. Without it, images render nothing. */
	media?: MediaReader;
	/** The page's first-image marker in `<main>`: the first Media image loads eagerly. */
	priorityImage?: ImagePriority;
	/** Each heading's anchor, by Block id (`headingAnchors`). */
	anchors: ReadonlyMap<string, string>;
	/** WebCraft's own words in the page's language: what a video's link says. */
	words: { playVideo: string; video: string };
	/** Counts the videos rendered, so the page links the embed script only when it shows one. */
	shown?: { videos: number };
	/**
	 * Holds an embed back until visitors accept its Consent category (ADR 0020): answers the
	 * placeholder it shows meanwhile. Absent where nothing is held back (no banner, Edit mode).
	 */
	held?: HoldEmbed;
	/**
	 * Edit mode's tags for an image Block's image, by the Block's id: the image region's attributes, or
	 * undefined when it isn't editable. Absent for the pages visitors get. An image Block with no image
	 * to show is still rendered then, as an empty region to choose one in.
	 */
	imageRegion?: (blockId: string) => readonly (readonly [string, string])[] | undefined;
	/**
	 * What a Component Block shows: its Component's published tree with its Prop values, rendered as
	 * a Placement is (`PlacementRenderer`). Without it, Components in a body render nothing.
	 */
	component?: (block: ComponentBlock) => string;
};

/**
 * Holds back one embed (content from another site, such as a video's player) on a page asking for
 * consent: its Consent category, what it is (`label`) and where it comes from (`source`, a host
 * name). Answers the placeholder to show until the category is accepted, or the visitor loads it.
 */
export type HoldEmbed = (embed: { category: string; label: string; source: string }) => { placeholder: string };

/** Everything WebCraft knows about one Block type. */
export type BlockTypeSpec<Kind extends Block = Block> = {
	/**
	 * Reads what a Block of the type holds from input (its `id`, `type` and `source` are read
	 * already), in its canonical form, reporting each problem at a path below the Block (`.text[1]`).
	 */
	read(input: Record<string, unknown>, report: Report): Omit<Kind, "id" | "type" | "source">;
	/** The settings `read` takes, besides `id`, `type` and `source`; any other is refused. */
	settings: readonly string[];
	/** Its formatted text, in reading order (where links and marks are). */
	inlines(block: Kind): InlineText[];
	/** Its text as plain text pieces, in reading order: for excerpts and reading time. */
	texts(block: Kind): string[];
	/** The text AI translation translates, in reading order (never code, addresses or Media). */
	translatable(block: Kind): BlockText[];
	/** The Block with its translatable text replaced, in the same order as `translatable` gave it. */
	translated(block: Kind, texts: readonly BlockText[]): Kind;
	/** Whether it shows anything: an empty paragraph or an image with none chosen doesn't render. */
	hasContent(block: Kind): boolean;
	/** Its semantic HTML. Only `wc-callout` and `wc-embed` are ever written as classes. */
	render(block: Kind, context: BodyRenderContext): string;
};

const TEXT = { maxLength: BODY_LIMITS.text };

/** The formatted text at `index` of a translation, or what the Block held when there is none. */
function inlineAt(texts: readonly BlockText[], index: number, fallback: InlineText): InlineText {
	const text = texts[index];
	return text && "inline" in text ? text.inline : fallback;
}

/** One piece of formatted text, translated as one. */
const oneText = {
	translatable: (block: { text: InlineText }): BlockText[] => [{ inline: block.text }],
	translated: <Kind extends { text: InlineText }>(block: Kind, texts: readonly BlockText[]): Kind => ({
		...block,
		text: inlineAt(texts, 0, block.text),
	}),
};

/** Nothing to translate: images, code and dividers stay as they are. */
const noText = { translatable: (): BlockText[] => [], translated: <Kind>(block: Kind): Kind => block };

function oneOf<Value extends string | number>(
	values: readonly Value[],
	input: unknown,
	fallback: Value | undefined,
	at: string,
	report: Report,
	what: string,
): Value {
	if (input === undefined && fallback !== undefined) return fallback;
	if ((values as readonly unknown[]).includes(input)) return input as Value;
	report(at, `${what} is ${values.join(", ")}.`);
	return values[0] as Value;
}

function plainText(input: unknown, at: string, report: Report, maxLength: number, what: string): string {
	if (input === undefined || input === null) return "";
	if (typeof input !== "string") {
		report(at, `${what} is text.`);
		return "";
	}
	const text = input.trim();
	if (text.length > maxLength) report(at, `${what} has at most ${maxLength} characters.`);
	return text;
}

const paragraph: BlockTypeSpec<ParagraphBlock> = {
	settings: ["text"],
	read: (input, report) => ({ text: readInline(input.text, ".text", report, TEXT) }),
	inlines: (block) => [block.text],
	texts: (block) => [inlineText(block.text)],
	...oneText,
	hasContent: (block) => hasText(block.text),
	render: (block) => `<p>${renderInline(block.text)}</p>`,
};

/** An anchor written by hand: letters, digits, dashes and underscores, never starting with `wc-`. */
const ANCHOR = /^[\p{L}\p{N}][\p{L}\p{N}_-]{0,63}$/u;

const heading: BlockTypeSpec<HeadingBlock> = {
	settings: ["level", "text", "anchor"],
	read(input, report) {
		const read: Omit<HeadingBlock, "id" | "type" | "source"> = {
			level: oneOf(HEADING_LEVELS, input.level, undefined, ".level", report, "A heading's level"),
			text: readInline(input.text, ".text", report, { ...TEXT, oneLine: true }),
		};
		if (input.anchor !== undefined && input.anchor !== null && input.anchor !== "") {
			if (typeof input.anchor !== "string" || !ANCHOR.test(input.anchor) || /^wc-/i.test(input.anchor)) {
				report(
					".anchor",
					"An anchor is letters, digits, dashes and underscores (at most 64), and doesn't start with wc-.",
				);
			} else {
				read.anchor = input.anchor;
			}
		}
		return read;
	},
	inlines: (block) => [block.text],
	texts: (block) => [inlineText(block.text)],
	...oneText,
	hasContent: (block) => hasText(block.text),
	render: (block, context) => {
		const anchor = context.anchors.get(block.id);
		const id = anchor ? ` id="${escapeAttribute(anchor)}"` : "";
		return `<h${block.level}${id}>${renderInline(block.text)}</h${block.level}>`;
	},
};

function readItems(input: unknown, at: string, report: Report, depth: number, count: { items: number }): ListItem[] {
	if (!Array.isArray(input)) {
		report(at, "A list's items are a list.");
		return [];
	}
	if (depth > BODY_LIMITS.listDepth) {
		report(at, `List items nest at most ${BODY_LIMITS.listDepth} deep.`);
		return [];
	}
	return input.flatMap((item: unknown, index) => {
		const here = `${at}[${index}]`;
		count.items++;
		if (count.items === BODY_LIMITS.listItems + 1) report(at, `A list has at most ${BODY_LIMITS.listItems} items.`);
		if (typeof item === "string") return [{ text: readInline(item, `${here}.text`, report, TEXT) }];
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			report(here, "A list item is { text, items } or text alone.");
			return [];
		}
		const { text, items, ...rest } = item as Record<string, unknown>;
		for (const key of Object.keys(rest)) report(`${here}.${key}`, `A list item has no ${key}.`);
		const read: ListItem = { text: readInline(text, `${here}.text`, report, TEXT) };
		if (items !== undefined && items !== null) {
			const nested = readItems(items, `${here}.items`, report, depth + 1, count);
			if (nested.length > 0) read.items = nested;
		}
		return [read];
	});
}

function itemTexts(items: readonly ListItem[]): InlineText[] {
	return items.flatMap((item) => [item.text, ...itemTexts(item.items ?? [])]);
}

/** List items with their texts replaced from `texts`, in the order `itemTexts` reads them. */
function translatedItems(items: readonly ListItem[], texts: readonly BlockText[], at: { index: number }): ListItem[] {
	return items.map((item) => {
		const text = inlineAt(texts, at.index++, item.text);
		const nested = item.items ? translatedItems(item.items, texts, at) : undefined;
		return nested ? { text, items: nested } : { text };
	});
}

function renderItems(items: readonly ListItem[], style: ListStyle): string {
	const tag = style === "numbered" ? "ol" : "ul";
	const shown = items.filter((item) => hasText(item.text) || itemTexts(item.items ?? []).some(hasText));
	if (shown.length === 0) return "";
	const rendered = shown.map((item) => `<li>${renderInline(item.text)}${renderItems(item.items ?? [], style)}</li>`);
	return `<${tag}>${rendered.join("")}</${tag}>`;
}

const list: BlockTypeSpec<ListBlock> = {
	settings: ["style", "items"],
	read: (input, report) => ({
		style: oneOf(LIST_STYLES, input.style, "bulleted", ".style", report, "A list's style"),
		items: readItems(input.items ?? [], ".items", report, 1, { items: 0 }),
	}),
	inlines: (block) => itemTexts(block.items),
	texts: (block) => itemTexts(block.items).map(inlineText),
	translatable: (block) => itemTexts(block.items).map((inline) => ({ inline })),
	translated: (block, texts) => ({ ...block, items: translatedItems(block.items, texts, { index: 0 }) }),
	hasContent: (block) => itemTexts(block.items).some(hasText),
	render: (block) => renderItems(block.items, block.style),
};

const quote: BlockTypeSpec<QuoteBlock> = {
	settings: ["text"],
	read: (input, report) => ({ text: readInline(input.text, ".text", report, TEXT) }),
	inlines: (block) => [block.text],
	texts: (block) => [inlineText(block.text)],
	...oneText,
	hasContent: (block) => hasText(block.text),
	render: (block) => `<blockquote><p>${renderInline(block.text)}</p></blockquote>`,
};

const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const image: BlockTypeSpec<ImageBlock> = {
	settings: ["media", "decorative"],
	read(input, report) {
		if (input.decorative !== undefined && typeof input.decorative !== "boolean")
			report(".decorative", "Decorative is true or false.");
		const decorative = input.decorative === true ? { decorative: true } : {};
		if (input.media === undefined || input.media === null || input.media === "") return { media: null, ...decorative };
		if (typeof input.media !== "string" || !MEDIA_ID.test(input.media.trim())) {
			report(".media", "An image is the id of a file in the Site's Media library.");
			return { media: null };
		}
		return { media: input.media.trim().toLowerCase(), ...decorative };
	},
	inlines: () => [],
	texts: () => [],
	...noText,
	hasContent: (block) => block.media !== null,
	render(block, context) {
		const found = block.media ? context.media?.(block.media) : undefined;
		const region = context.imageRegion?.(block.id);
		if (found?.kind !== "image") {
			if (!region) return "";
			const tags = region.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("");
			return `<figure><span${tags}></span></figure>`;
		}
		const own: [string, string][] = region
			? [...region.map(([name, value]): [string, string] => [name, value]), ["data-wc-media", block.media ?? ""]]
			: [];
		if (block.decorative) own.push(["alt", ""]);
		if (region && block.decorative) own.push(["data-wc-image-decorative", "true"]);
		const caption = found.caption?.trim() ? `<figcaption>${escapeText(found.caption.trim())}</figcaption>` : "";
		return `<figure>${renderMediaImage(found, own, context.priorityImage)}${caption}</figure>`;
	},
};

const video: BlockTypeSpec<VideoBlock> = {
	settings: ["url", "title"],
	read: (input, report) => ({
		url: plainText(input.url, ".url", report, BODY_LIMITS.videoUrl, "A video's address"),
		title: plainText(input.title, ".title", report, BODY_LIMITS.videoTitle, "A video's title"),
	}),
	inlines: () => [],
	texts: (block) => (block.title ? [block.title] : []),
	// Its address is never sent; its title is text people read.
	translatable: (block) => (block.title ? [{ plain: block.title }] : []),
	translated: (block, texts) => {
		const text = texts[0];
		return text && "plain" in text ? { ...block, title: text.plain.trim().slice(0, BODY_LIMITS.videoTitle) } : block;
	},
	hasContent: (block) => block.url !== "",
	render(block, context) {
		const found = videoAt(block.url);
		if (!found) return "";
		const title = block.title || context.words.video;
		const label = block.title ? `${context.words.playVideo}: ${block.title}` : context.words.playVideo;
		if (context.shown) context.shown.videos++;
		const link = `<a href="${escapeAttribute(found.watchUrl)}" data-wc-embed="${escapeAttribute(found.playerUrl)}" data-wc-title="${escapeAttribute(title)}">${escapeText(label)}</a>`;
		// A video plays from another site: held back as Media until visitors accept it, or load it.
		const held = context.held?.({ category: "media", label: title, source: new URL(found.watchUrl).hostname });
		if (!held) return `<figure class="wc-embed">${link}</figure>`;
		return `<figure class="wc-embed" data-wc-consent="media">${link}${held.placeholder}</figure>`;
	},
};

const table: BlockTypeSpec<TableBlock> = {
	settings: ["headerRow", "rows"],
	read(input, report) {
		let headerRow = true;
		if (input.headerRow !== undefined) {
			if (typeof input.headerRow === "boolean") headerRow = input.headerRow;
			else report(".headerRow", "Whether the first row is the header: true or false.");
		}
		const rows: InlineText[][] = [];
		if (!Array.isArray(input.rows)) {
			report(".rows", "A table's rows are a list of rows, each a list of cells.");
			return { headerRow, rows };
		}
		if (input.rows.length > BODY_LIMITS.tableRows)
			report(".rows", `A table has at most ${BODY_LIMITS.tableRows} rows.`);
		input.rows.slice(0, BODY_LIMITS.tableRows).forEach((row: unknown, index) => {
			if (!Array.isArray(row)) {
				report(`.rows[${index}]`, "A row is a list of cells.");
				return;
			}
			if (row.length > BODY_LIMITS.tableColumns) {
				report(`.rows[${index}]`, `A table has at most ${BODY_LIMITS.tableColumns} columns.`);
			}
			rows.push(
				row
					.slice(0, BODY_LIMITS.tableColumns)
					.map((cell: unknown, column) => readInline(cell, `.rows[${index}][${column}]`, report, TEXT)),
			);
		});
		// Every row has as many cells as the widest.
		const columns = Math.max(0, ...rows.map((row) => row.length));
		return { headerRow, rows: rows.map((row) => [...row, ...Array.from({ length: columns - row.length }, () => [])]) };
	},
	inlines: (block) => block.rows.flat(),
	texts: (block) => block.rows.flat().map(inlineText),
	translatable: (block) => block.rows.flat().map((inline) => ({ inline })),
	translated: (block, texts) => {
		let index = 0;
		return { ...block, rows: block.rows.map((row) => row.map((cell) => inlineAt(texts, index++, cell))) };
	},
	hasContent: (block) => block.rows.flat().some(hasText),
	render(block) {
		const [first, ...rest] = block.rows;
		const head =
			block.headerRow && first
				? `<thead><tr>${first.map((cell) => `<th scope="col">${renderInline(cell)}</th>`).join("")}</tr></thead>`
				: "";
		const bodyRows = block.headerRow ? rest : block.rows;
		const body =
			bodyRows.length > 0
				? `<tbody>${bodyRows.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`
				: "";
		return `<table>${head}${body}</table>`;
	},
};

const callout: BlockTypeSpec<CalloutBlock> = {
	settings: ["tone", "text"],
	read: (input, report) => ({
		tone: oneOf(CALLOUT_TONES, input.tone, "info", ".tone", report, "A callout's tone"),
		text: readInline(input.text, ".text", report, TEXT),
	}),
	inlines: (block) => [block.text],
	texts: (block) => [inlineText(block.text)],
	...oneText,
	hasContent: (block) => hasText(block.text),
	render: (block) => `<aside class="wc-callout" data-tone="${block.tone}"><p>${renderInline(block.text)}</p></aside>`,
};

const CODE_LANGUAGE = /^[a-z0-9][a-z0-9+#._-]{0,31}$/;

const code: BlockTypeSpec<CodeBlock> = {
	settings: ["code", "language"],
	read(input, report) {
		let text = "";
		if (typeof input.code === "string") text = input.code.replace(/\r\n?/g, "\n").replaceAll("\u0000", "");
		else if (input.code !== undefined && input.code !== null) report(".code", "Code is text.");
		if (text.length > BODY_LIMITS.code) report(".code", `A code Block has at most ${BODY_LIMITS.code} characters.`);
		let language: string | null = null;
		if (input.language !== undefined && input.language !== null && input.language !== "") {
			const given = typeof input.language === "string" ? input.language.trim().toLowerCase() : "";
			if (CODE_LANGUAGE.test(given)) language = given;
			else
				report(".language", "A code language is a short name: lower-case letters, digits and + # . _ - (at most 32).");
		}
		return { code: text, language };
	},
	inlines: () => [],
	texts: (block) => [block.code],
	// Code is never translated.
	...noText,
	hasContent: (block) => block.code.trim() !== "",
	render(block) {
		// An HTML parser drops a newline right after <pre>; repeat it so the code stays as written.
		const text = block.code.startsWith("\n") ? `\n${block.code}` : block.code;
		const language = block.language ? ` data-language="${escapeAttribute(block.language)}"` : "";
		return `<pre><code${language}>${escapeText(text)}</code></pre>`;
	},
};

const divider: BlockTypeSpec<DividerBlock> = {
	settings: [],
	read: () => ({}),
	inlines: () => [],
	texts: () => [],
	...noText,
	hasContent: () => false,
	render: () => "<hr>",
};

const toggle: BlockTypeSpec<ToggleBlock> = {
	settings: ["summary", "text"],
	read: (input, report) => ({
		summary: readInline(input.summary, ".summary", report, { ...TEXT, oneLine: true }),
		text: readInline(input.text, ".text", report, TEXT),
	}),
	inlines: (block) => [block.summary, block.text],
	texts: (block) => [inlineText(block.summary), inlineText(block.text)],
	translatable: (block) => [{ inline: block.summary }, { inline: block.text }],
	translated: (block, texts) => ({
		...block,
		summary: inlineAt(texts, 0, block.summary),
		text: inlineAt(texts, 1, block.text),
	}),
	hasContent: (block) => hasText(block.summary) || hasText(block.text),
	render: (block) =>
		`<details><summary>${renderInline(block.summary)}</summary>${hasText(block.text) ? `<p>${renderInline(block.text)}</p>` : ""}</details>`,
};

/** A Component's id: a UUID, or `<module id>:<Name>` for a Module's. */
const COMPONENT_ID =
	/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z][a-z0-9-]{0,63}:[A-Z][A-Za-z0-9]{0,63})$/;

/** A Prop's key, as Template markup writes it. */
const PROP_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;

/** The most Prop values a Component Block holds. */
const MAX_BLOCK_PROPS = 100;

const component: BlockTypeSpec<ComponentBlock> = {
	settings: ["component", "props"],
	read(input, report) {
		let id = "";
		if (typeof input.component === "string" && COMPONENT_ID.test(input.component.trim())) {
			id = input.component.trim();
		} else {
			report(".component", "A Component Block names its Component: its id, or <module id>:<Name> for a Module's.");
		}
		const props: BlockProp[] = [];
		const given = input.props ?? [];
		if (!Array.isArray(given)) {
			report(".props", "A Component Block's Props are a list of { name, value }.");
			return { component: id, props };
		}
		if (given.length > MAX_BLOCK_PROPS) report(".props", `A Component Block has at most ${MAX_BLOCK_PROPS} Props.`);
		given.slice(0, MAX_BLOCK_PROPS).forEach((item: unknown, index) => {
			const here = `.props[${index}]`;
			const { name, value, ...rest } = (item && typeof item === "object" && !Array.isArray(item) ? item : {}) as Record<
				string,
				unknown
			>;
			for (const key of Object.keys(rest)) report(`${here}.${key}`, `A Prop's value has no ${key}.`);
			if (typeof name !== "string" || !PROP_NAME.test(name)) {
				report(`${here}.name`, "A Prop is named by its key.");
				return;
			}
			if (props.some((prop) => prop.name === name)) {
				report(`${here}.name`, `The Prop ${name} is given twice.`);
				return;
			}
			const text = value === undefined || value === null ? "" : value;
			if (typeof text !== "string") {
				report(`${here}.value`, "A Prop's value is text, as Template markup writes it.");
				return;
			}
			if (text.length > BODY_LIMITS.text)
				report(`${here}.value`, `A Prop's value has at most ${BODY_LIMITS.text} characters.`);
			props.push({ name, value: text });
		});
		return { component: id, props };
	},
	inlines: () => [],
	texts: () => [],
	...noText,
	hasContent: () => true,
	render: (block, context) => context.component?.(block) ?? "",
};

/** The registry: every Block type core has. */
export const BLOCK_TYPE_SPECS: { readonly [Type in BodyBlockType]: BlockTypeSpec<Extract<Block, { type: Type }>> } = {
	paragraph,
	heading,
	list,
	quote,
	image,
	video,
	table,
	callout,
	code,
	divider,
	toggle,
	component,
};

/** The spec of a Block's type. */
export function blockSpec<Kind extends Block>(block: Kind): BlockTypeSpec<Kind> {
	return BLOCK_TYPE_SPECS[block.type] as unknown as BlockTypeSpec<Kind>;
}

export function isBlockType(type: unknown): type is BlockType {
	return typeof type === "string" && (BLOCK_TYPES as readonly string[]).includes(type);
}

/** Whether a type is one a Block can have: core's Block types, or `component`. */
export function isBodyBlockType(type: unknown): type is BodyBlockType {
	return type === "component" || isBlockType(type);
}
