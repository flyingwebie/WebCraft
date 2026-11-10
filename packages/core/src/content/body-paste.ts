/**
 * Pasting into a body (#79, spec story 84): what someone pasted into a block editor (the admin's or
 * Edit mode's) as Blocks of the existing types, never HTML. A document's or web page's HTML is read
 * the way an Import reads a post (`blocksFromHtml` with `paste`), Markdown with its extensions
 * (`blocksFromMarkdown`, lenient: what has no Block becomes text), plain text as paragraphs. An H1
 * becomes an H2, an image's address an image Block with none chosen yet (never fetched), and a Block
 * of a type the Field switched off its text. Pasted image files go to the Media library through the
 * editors' own upload, with its checks and quotas.
 */
import {
	type Block,
	BODY_LIMITS,
	blockSpec,
	blocksFromHtml,
	blocksFromMarkdown,
	inlineText,
	type ListItem,
	readBody,
} from "@webcraft/renderer";

import type { SiteScope } from "../tenancy/data-layer.ts";
import type { BodyField } from "./field-types.ts";
import { getPostType } from "./post-types.ts";

/** What was pasted: the clipboard's HTML when it has some, and its plain text. */
export type Pasted = { html?: string; text?: string };

/** The most characters of HTML (and of text) a paste may hold. */
export const PASTE_MAX_LENGTH = 2_000_000;

/** Whether pasted text reads as Markdown: Markdown's own block syntax, or its inline syntax, somewhere in it. */
function looksLikeMarkdown(text: string): boolean {
	const blockSyntax =
		/^(?:#{1,6}[ \t]|[ ]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+\S|[ ]{0,3}>|[ ]{0,3}(?:```|~~~)|[ ]{0,3}:{2,3}[A-Za-z]|[ ]{0,3}\|.*\|[ \t]*$)/m;
	if (blockSyntax.test(text)) return true;
	return /\*\*[^*\n]+\*\*|__[^_\n]+__|!?\[[^\]\n]+\]\([^)\s]+\)|`[^`\n]+`|~~[^~\n]+~~/.test(text);
}

/** Plain text as paragraphs: a blank line starts a new one, a single line break stays a line break. */
function paragraphs(text: string): Record<string, unknown>[] {
	return text
		.replace(/\r\n?/g, "\n")
		.split(/\n[ \t]*\n/)
		.map((paragraph) => paragraph.replace(/^\n+|\s+$/g, "").replace(/^[ \t]+/, ""))
		.filter((paragraph) => paragraph.trim() !== "")
		.flatMap((paragraph) => pieces(paragraph).map((piece) => ({ type: "paragraph", text: piece })));
}

/** Text cut into pieces a Block holds. */
function pieces(text: string): string[] {
	const out: string[] = [];
	for (let start = 0; start < text.length; start += BODY_LIMITS.text)
		out.push(text.slice(start, start + BODY_LIMITS.text));
	return out;
}

function itemLines(items: readonly ListItem[]): string[] {
	return items.flatMap((item) => [inlineText(item.text), ...itemLines(item.items ?? [])]);
}

/** A Block the Field switched off, as the paragraphs of its text (nothing for an image or a divider). */
function asText(block: Block): Record<string, unknown>[] {
	let text: string;
	switch (block.type) {
		case "table":
			text = block.rows.map((row) => row.map(inlineText).join(" ")).join("\n");
			break;
		case "list":
			text = itemLines(block.items).join("\n");
			break;
		case "paragraph":
		case "heading":
		case "quote":
		case "callout":
			return [{ type: "paragraph", text: block.text }];
		case "video":
			text = [block.title, block.url].filter(Boolean).join("\n");
			break;
		default:
			text = blockSpec(block).texts(block).join("\n");
	}
	return text.trim() === "" ? [] : pieces(text).map((piece) => ({ type: "paragraph", text: piece }));
}

/** What was pasted, as Blocks the Body field holds (see the module's comment). */
export function pastedBlocks(pasted: Pasted, field: BodyField | undefined): Block[] {
	let blocks: Block[] = [];
	if (pasted.html && pasted.html.trim() !== "") blocks = blocksFromHtml(pasted.html, { paste: true }).blocks;
	const text = pasted.text ?? "";
	if (blocks.length === 0 && text.trim() !== "") {
		// Recognise an image address without ever requesting it (query/fragment needn't end in the suffix).
		let imageAddress = false;
		try {
			const url = new URL(text.trim());
			imageAddress =
				/^https?:$/.test(url.protocol) && /\.(?:avif|webp|png|jpe?g|gif|svg|heic|heif|bmp|tiff?)$/i.test(url.pathname);
		} catch {
			/* Ordinary text is not an address. */
		}
		blocks = imageAddress
			? readBody([{ type: "image", media: null }]).blocks
			: looksLikeMarkdown(text)
				? blocksFromMarkdown(text, { lenient: true }).blocks
				: readBody(paragraphs(text)).blocks;
	}
	const off = field?.blocksOff ?? [];
	if (off.length === 0) return blocks;
	const kept = blocks.flatMap((block) =>
		block.type !== "component" && off.includes(block.type)
			? asText(block)
			: [block as unknown as Record<string, unknown>],
	);
	return readBody(kept.map(({ id: _, ...rest }) => rest)).blocks;
}

/** What was pasted into a Post Type's body, as Blocks. */
export async function pasteBody(scope: SiteScope, postTypeId: string, pasted: Pasted): Promise<Block[]> {
	const postType = await getPostType(scope, postTypeId);
	return pastedBlocks(
		pasted,
		postType.fields.find((each): each is BodyField => each.type === "body"),
	);
}
