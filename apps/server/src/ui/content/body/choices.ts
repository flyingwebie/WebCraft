import {
	type Block,
	type BlockType,
	type HeadingLevel,
	type InlineText,
	type ListItem,
	type ListStyle,
	newBlockId,
} from "@webcraft/renderer/body";
import {
	ChevronRightIcon,
	CodeIcon,
	Heading2Icon,
	Heading3Icon,
	Heading4Icon,
	ImageIcon,
	InfoIcon,
	ListIcon,
	ListOrderedIcon,
	type LucideIcon,
	MinusIcon,
	PilcrowIcon,
	QuoteIcon,
	TableIcon,
	VideoIcon,
} from "lucide-react";

import type { MessageKey } from "../../i18n.tsx";

/**
 * What the block editor offers to add (from the `/` menu and the toolbar) or turn a Block into: each
 * Block type, with headings and lists split by level and style. Their words are in the message files
 * under `body.choices`.
 */
export type BlockChoice = {
	id: string;
	type: BlockType;
	label: MessageKey;
	icon: LucideIcon;
	/** Words that find it in the `/` menu besides its name (`h2`, `ul`, `youtube`). */
	keywords: string;
	level?: HeadingLevel;
	style?: ListStyle;
};

export const BLOCK_CHOICES: readonly BlockChoice[] = [
	{ id: "paragraph", type: "paragraph", label: "body.choices.paragraph", icon: PilcrowIcon, keywords: "p text" },
	{ id: "heading2", type: "heading", level: 2, label: "body.choices.heading2", icon: Heading2Icon, keywords: "h2 ##" },
	{ id: "heading3", type: "heading", level: 3, label: "body.choices.heading3", icon: Heading3Icon, keywords: "h3 ###" },
	{
		id: "heading4",
		type: "heading",
		level: 4,
		label: "body.choices.heading4",
		icon: Heading4Icon,
		keywords: "h4 ####",
	},
	{
		id: "bulleted",
		type: "list",
		style: "bulleted",
		label: "body.choices.bulleted",
		icon: ListIcon,
		keywords: "ul - *",
	},
	{
		id: "numbered",
		type: "list",
		style: "numbered",
		label: "body.choices.numbered",
		icon: ListOrderedIcon,
		keywords: "ol 1.",
	},
	{ id: "quote", type: "quote", label: "body.choices.quote", icon: QuoteIcon, keywords: "blockquote >" },
	{ id: "image", type: "image", label: "body.choices.image", icon: ImageIcon, keywords: "picture photo media" },
	{ id: "video", type: "video", label: "body.choices.video", icon: VideoIcon, keywords: "embed youtube vimeo" },
	{ id: "table", type: "table", label: "body.choices.table", icon: TableIcon, keywords: "grid rows columns" },
	{ id: "callout", type: "callout", label: "body.choices.callout", icon: InfoIcon, keywords: "note tip warning aside" },
	{ id: "code", type: "code", label: "body.choices.code", icon: CodeIcon, keywords: "pre ```" },
	{ id: "divider", type: "divider", label: "body.choices.divider", icon: MinusIcon, keywords: "hr line ---" },
	{ id: "toggle", type: "toggle", label: "body.choices.toggle", icon: ChevronRightIcon, keywords: "details collapse" },
];

/** The choice a Block is (its type, level or style), for its name and icon. */
export function choiceOf(block: Block): BlockChoice {
	const found = BLOCK_CHOICES.find(
		(choice) =>
			choice.type === block.type &&
			(block.type !== "heading" || choice.level === block.level) &&
			(block.type !== "list" || choice.style === block.style),
	);
	return found ?? (BLOCK_CHOICES[0] as BlockChoice);
}

/** The Blocks whose text is one piece of formatted text, which can be turned into one another. */
const TEXT_TYPES: ReadonlySet<BlockType> = new Set(["paragraph", "heading", "quote", "callout", "list"]);

export function isTextBlock(block: Block): boolean {
	return TEXT_TYPES.has(block.type);
}

/** Whether a choice keeps a Block's text when the Block is turned into it. */
export function keepsText(choice: BlockChoice): boolean {
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
export function newBlock(choice: BlockChoice, text: InlineText = [], id = newBlockId()): Block {
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

/** A Block turned into another choice: the same id, and its text kept where the new Block holds text. */
export function turnInto(block: Block, choice: BlockChoice): Block {
	return newBlock(choice, keepsText(choice) || choice.type === "code" ? textOfBlock(block) : [], block.id);
}

/** Whether a choice matches what is typed in the `/` menu. */
export function matches(choice: BlockChoice, name: string, query: string): boolean {
	const words = query.trim().toLowerCase();
	if (!words) return true;
	return `${name} ${choice.keywords} ${choice.type}`.toLowerCase().includes(words);
}
