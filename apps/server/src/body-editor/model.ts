/**
 * The block editor's model, shared by its two faces (#79): the admin's Entry editor (React,
 * `ui/content/body/`) and Edit mode's body part on the Site (`edit-mode.ts`, bundled into a file the
 * editing bar loads). It knows what can be added, how a Block is turned into another, how a list's
 * items are edited as lines, and which Markdown shortcuts turn a paragraph into a Block. It uses no
 * framework and nothing of the page; words are message keys, under `body.` in the admin's message
 * files (the editing bar gets the same part).
 */
import {
	type Block,
	type BlockType,
	type ComponentBlock,
	type HeadingLevel,
	type InlineText,
	type ListItem,
	type ListLine,
	type ListStyle,
	newBlockId,
} from "@webcraft/renderer/body/editing";

/**
 * What the block editor offers to add (from the `/` menu and the toolbar) or turn a Block into: each
 * Block type, with headings and lists split by level and style. Its label is a message key.
 */
export type BlockChoice = {
	id: string;
	type: BlockType;
	/** Its name: `body.choices.<id>` in the message files. */
	label: `body.choices.${string}`;
	/** Words that find it in the `/` menu besides its name (`h2`, `ul`, `youtube`). */
	keywords: string;
	level?: HeadingLevel;
	style?: ListStyle;
};

export const BLOCK_CHOICES: readonly BlockChoice[] = [
	{ id: "paragraph", type: "paragraph", label: "body.choices.paragraph", keywords: "p text" },
	{ id: "heading2", type: "heading", level: 2, label: "body.choices.heading2", keywords: "h2 ##" },
	{ id: "heading3", type: "heading", level: 3, label: "body.choices.heading3", keywords: "h3 ###" },
	{ id: "heading4", type: "heading", level: 4, label: "body.choices.heading4", keywords: "h4 ####" },
	{ id: "bulleted", type: "list", style: "bulleted", label: "body.choices.bulleted", keywords: "ul - *" },
	{ id: "numbered", type: "list", style: "numbered", label: "body.choices.numbered", keywords: "ol 1." },
	{ id: "quote", type: "quote", label: "body.choices.quote", keywords: "blockquote >" },
	{ id: "image", type: "image", label: "body.choices.image", keywords: "picture photo media" },
	{ id: "video", type: "video", label: "body.choices.video", keywords: "embed youtube vimeo" },
	{ id: "table", type: "table", label: "body.choices.table", keywords: "grid rows columns" },
	{ id: "callout", type: "callout", label: "body.choices.callout", keywords: "note tip warning aside" },
	{ id: "code", type: "code", label: "body.choices.code", keywords: "pre ```" },
	{ id: "divider", type: "divider", label: "body.choices.divider", keywords: "hr line ---" },
	{ id: "toggle", type: "toggle", label: "body.choices.toggle", keywords: "details collapse" },
];

/** What making a Block of a choice needs: its type, level and style. */
export type ChoiceShape = Pick<BlockChoice, "type" | "level" | "style">;

/** The choices a Body field offers: those whose Block type it hasn't switched off. */
export function allowedChoices(blocksOff: readonly string[]): BlockChoice[] {
	return BLOCK_CHOICES.filter((choice) => !blocksOff.includes(choice.type));
}

/** The choice a Block is (its type, level or style), for its name and icon; a Component Block has none. */
export function choiceOf(block: Block): BlockChoice | undefined {
	return BLOCK_CHOICES.find(
		(choice) =>
			choice.type === block.type &&
			(block.type !== "heading" || choice.level === block.level) &&
			(block.type !== "list" || choice.style === block.style),
	);
}

/** The paragraph choice: what a new line is. */
export const PARAGRAPH = BLOCK_CHOICES[0] as BlockChoice;

export function choiceById(id: string): BlockChoice | undefined {
	return BLOCK_CHOICES.find((choice) => choice.id === id);
}

/** The Blocks whose text is one piece of formatted text, which can be turned into one another. */
const TEXT_TYPES: ReadonlySet<string> = new Set(["paragraph", "heading", "quote", "callout", "list"]);

export function isTextBlock(block: Block): boolean {
	return TEXT_TYPES.has(block.type);
}

/** Whether a choice keeps a Block's text when the Block is turned into it. */
export function keepsText(choice: ChoiceShape): boolean {
	return TEXT_TYPES.has(choice.type);
}

/** The formatted text of a text Block (a list's items joined by line breaks). */
export function textOfBlock(block: Block): InlineText {
	switch (block.type) {
		case "paragraph":
		case "heading":
		case "quote":
		case "callout":
			return block.text;
		case "list":
			return block.items.flatMap((item, index) => [...(index > 0 ? [{ text: "\n" }] : []), ...item.text]);
		case "toggle":
			return block.summary;
		default:
			return [];
	}
}

/** A list's items from formatted text, one per line. */
function itemsFrom(text: InlineText): ListItem[] {
	const items: ListItem[] = [{ text: [] }];
	for (const run of text) {
		const lines = run.text.split("\n");
		lines.forEach((line, index) => {
			if (index > 0) items.push({ text: [] });
			if (line) (items.at(-1) as ListItem).text.push({ ...run, text: line });
		});
	}
	return items;
}

/** A new Block of a choice, holding `text` when it is a text Block. */
export function newBlock(choice: ChoiceShape, text: InlineText = [], id = newBlockId()): Block {
	switch (choice.type) {
		case "paragraph":
			return { id, type: "paragraph", text };
		case "heading":
			return {
				id,
				type: "heading",
				level: choice.level ?? 2,
				text: text.map((run) => ({ ...run, text: run.text.replace(/\n/g, " ") })),
			};
		case "list":
			return { id, type: "list", style: choice.style ?? "bulleted", items: itemsFrom(text) };
		case "quote":
			return { id, type: "quote", text };
		case "image":
			return { id, type: "image", media: null };
		case "video":
			return { id, type: "video", url: "", title: "" };
		case "table":
			return {
				id,
				type: "table",
				headerRow: true,
				rows: [
					[[], []],
					[[], []],
				],
			};
		case "callout":
			return { id, type: "callout", tone: "info", text };
		case "code":
			return { id, type: "code", code: text.map((run) => run.text).join(""), language: null };
		case "divider":
			return { id, type: "divider" };
		case "toggle":
			return { id, type: "toggle", summary: text, text: [] };
	}
}

/** A Component Block placing a Component, with the Prop values filled in its form. */
export function newComponentBlock(
	component: string,
	props: readonly { name: string; value: string }[],
	id = newBlockId(),
): ComponentBlock {
	return { id, type: "component", component, props: props.map((prop) => ({ ...prop })) };
}

/** A Block turned into another choice: the same id, and its text kept where the new Block holds text. */
export function turnInto(block: Block, choice: ChoiceShape): Block {
	return newBlock(choice, keepsText(choice) || choice.type === "code" ? textOfBlock(block) : [], block.id);
}

/** Whether a choice (named `name` in the person's language) matches what is typed in the `/` menu. */
export function matches(choice: Pick<BlockChoice, "keywords" | "type">, name: string, query: string): boolean {
	const words = query.trim().toLowerCase();
	if (!words) return true;
	return `${name} ${choice.keywords} ${choice.type}`.toLowerCase().includes(words);
}

/** The Markdown a paragraph can start with, and the Block it turns into (`## ` gives a heading). */
export const SHORTCUTS: Readonly<Record<string, string>> = {
	"##": "heading2",
	"###": "heading3",
	"####": "heading4",
	"-": "bulleted",
	"*": "bulleted",
	"1.": "numbered",
	">": "quote",
};

/** The Markdown that turns a paragraph into a Block as soon as it is the whole paragraph. */
export const WHOLE_SHORTCUTS: Readonly<Record<string, string>> = { "```": "code", "---": "divider" };

/** One line of a list as the editors show it: its depth (0 at the top) and its text. */
export type Line = ListLine;

export function linesOf(items: readonly ListItem[], depth = 0): Line[] {
	return items.flatMap((item) => [{ depth, text: item.text }, ...linesOf(item.items ?? [], depth + 1)]);
}

export { listItemsFromLines as itemsOf } from "@webcraft/renderer/body/editing";

/** The deepest a list line may go: one deeper than the line before it, and 3 deep in all. */
export function maxDepth(lines: readonly Line[], index: number): number {
	return index === 0 ? 0 : Math.min(2, (lines[index - 1] as Line).depth + 1);
}

/** Moves one item of a list to another place. */
export function moveItem<Item>(items: readonly Item[], from: number, to: number): Item[] {
	const next = [...items];
	const [moved] = next.splice(from, 1);
	if (moved !== undefined) next.splice(to, 0, moved);
	return next;
}

/** A Prop of a Component, as the editors' Props form shows it (a Field definition, loosely). */
export type PropField = {
	key: string;
	label: string;
	type: string;
	help?: string;
	required?: boolean;
	default?: unknown;
	multiple?: boolean;
	options?: { value: string; label: string }[];
	mode?: string;
};

/** A Component a body allows, as `body/get` and `entries.bodyComponents` give it. */
export type BodyComponentChoice = { id: string; name: string; props: PropField[] };

/** A Prop's default as the fixed text a Component Block holds, or "" for none. */
export function propDefaultText(prop: PropField): string {
	if (prop.default === null || prop.default === undefined) return "";
	if (typeof prop.default === "string") return prop.default;
	if (typeof prop.default === "boolean") return prop.default ? "true" : "false";
	if (typeof prop.default === "number") return String(prop.default);
	if (Array.isArray(prop.default)) return prop.default.join(",");
	return JSON.stringify(prop.default);
}

/** Whether a Prop must be filled before the Entry is published: required, without a default (true/false never). */
export function propNeeded(prop: PropField): boolean {
	return Boolean(prop.required) && (prop.default === null || prop.default === undefined) && prop.type !== "boolean";
}
