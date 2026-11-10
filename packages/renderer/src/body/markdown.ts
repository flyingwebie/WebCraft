/**
 * A body as Markdown (ADR 0018: Markdown copies are worked out from the Blocks, never by parsing
 * HTML): each Block becomes its Markdown, in order, separated by a blank line. Text is escaped
 * (`escapeMarkdown`), so it reads as written and nothing passes through as HTML; marks become `**`,
 * `*`, `~~` and code spans, links Markdown links. Every address is absolute: the page decides how a
 * path or an `#anchor` is completed (`MarkdownContext.link`), and where a Media image is.
 */
import { escapeMarkdown, escapeMarkdownLine, markdownUrl } from "../markdown.ts";
import type { Block, ListItem } from "./blocks.ts";
import { hasText, type InlineText, MARKS, type Run } from "./inline.ts";
import { videoAt } from "./video.ts";

/** What converting a body needs from the page. */
export type MarkdownContext = {
	/** A link's address as it leaves the page: absolute (a Site path or an `#anchor` completed). */
	link(url: string): string;
	/** An image Block's Media image: its absolute address, alt text and caption; undefined when it shows nothing. */
	image(mediaId: string): { url: string; alt: string | null; caption: string | null } | undefined;
};

/** A body as Markdown: its Blocks with something in them, each as Markdown, a blank line between. */
export function bodyMarkdown(blocks: readonly Block[], context: MarkdownContext): string {
	return blocks
		.map((block) => blockMarkdown(block, context))
		.filter((markdown) => markdown !== "")
		.join("\n\n");
}

function blockMarkdown(block: Block, context: MarkdownContext): string {
	switch (block.type) {
		case "paragraph":
			return inlineMarkdown(block.text, context);
		case "heading":
			return hasText(block.text) ? `${"#".repeat(block.level)} ${inlineMarkdown(block.text, context, true)}` : "";
		case "list":
			return listMarkdown(block.items, block.style === "numbered", context, "");
		case "quote":
		case "callout":
			return hasText(block.text) ? quoted(inlineMarkdown(block.text, context)) : "";
		case "image": {
			const image = block.media ? context.image(block.media) : undefined;
			if (!image) return "";
			const picture = `![${escapeMarkdownLine(image.alt ?? "")}](${markdownUrl(image.url)})`;
			const caption = image.caption?.trim();
			return caption ? `${picture}\n\n*${escapeMarkdownLine(caption)}*` : picture;
		}
		case "video": {
			const video = videoAt(block.url);
			return video ? `[${escapeMarkdownLine(block.title || video.watchUrl)}](${markdownUrl(video.watchUrl)})` : "";
		}
		case "table":
			return tableMarkdown(block.rows, block.headerRow, context);
		case "code":
			return codeBlock(block.code, block.language);
		case "divider":
			return "---";
		case "toggle": {
			if (!hasText(block.summary) && !hasText(block.text)) return "";
			const summary = `**${inlineMarkdown(block.summary, context, true)}**`;
			return hasText(block.text) ? `${summary}\n\n${inlineMarkdown(block.text, context)}` : summary;
		}
	}
}

/**
 * Formatted text as Markdown: each run's text escaped, its marks around it (spaces kept outside, as
 * Markdown needs), neighbouring runs with the same link in one link. Line breaks are hard breaks
 * (`\` at the end of the line), or spaces with `oneLine`.
 */
export function inlineMarkdown(inline: InlineText, context: Pick<MarkdownContext, "link">, oneLine = false): string {
	let markdown = "";
	let index = 0;
	while (index < inline.length) {
		const link = inline[index]?.link;
		let inner = "";
		while (index < inline.length && inline[index]?.link === link) {
			inner += runMarkdown(inline[index] as Run, oneLine);
			index++;
		}
		markdown += link === undefined || inner.trim() === "" ? inner : `[${inner}](${markdownUrl(context.link(link))})`;
	}
	return markdown;
}

const MARK_SYNTAX: Readonly<Record<Exclude<Run["marks"], undefined>[number], string>> = {
	bold: "**",
	italic: "*",
	strike: "~~",
	code: "",
};

function runMarkdown(run: Run, oneLine: boolean): string {
	const text = oneLine ? run.text.replace(/\n/g, " ") : run.text;
	const [, before = "", core = "", after = ""] = /^(\s*)([\s\S]*?)(\s*)$/.exec(text) ?? [];
	if (core === "") return text;
	let markdown = run.marks?.includes("code") ? codeSpan(core) : escapeMarkdown(core).replace(/\n/g, "\\\n");
	for (const mark of [...MARKS].reverse()) {
		if (mark !== "code" && run.marks?.includes(mark)) markdown = `${MARK_SYNTAX[mark]}${markdown}${MARK_SYNTAX[mark]}`;
	}
	return `${before}${markdown}${after}`;
}

/** Inline code: in as many backticks as it needs, padded where it starts or ends with one. */
function codeSpan(text: string): string {
	const oneLine = text.replace(/\n/g, " ");
	const longest = Math.max(0, ...[...oneLine.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = "`".repeat(longest + 1);
	const padded = oneLine.startsWith("`") || oneLine.endsWith("`") ? ` ${oneLine} ` : oneLine;
	return `${fence}${padded}${fence}`;
}

/** A code Block: fenced with more backticks than it holds in a row, its language as the info string. */
function codeBlock(code: string, language: string | null): string {
	if (code.trim() === "") return "";
	const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map((match) => match[0].length));
	const fence = "`".repeat(Math.max(3, longest + 1));
	const info = language && /^[a-z0-9][a-z0-9+#._-]*$/.test(language) ? language : "";
	return `${fence}${info}\n${code}\n${fence}`;
}

function quoted(markdown: string): string {
	return markdown
		.split("\n")
		.map((line) => (line === "" ? ">" : `> ${line}`))
		.join("\n");
}

/** A list's items, nested ones indented under their item. */
function listMarkdown(items: readonly ListItem[], numbered: boolean, context: MarkdownContext, indent: string): string {
	const lines: string[] = [];
	let number = 1;
	for (const item of items) {
		const nested = item.items ? listMarkdown(item.items, numbered, context, "") : "";
		if (!hasText(item.text) && nested === "") continue;
		const marker = numbered ? `${number++}. ` : "- ";
		const pad = " ".repeat(marker.length);
		const text = inlineMarkdown(item.text, context).replace(/\n/g, `\n${indent}${pad}`);
		lines.push(`${indent}${marker}${text}`);
		if (nested) lines.push(...nested.split("\n").map((line) => `${indent}${pad}${line}`));
	}
	return lines.join("\n");
}

/** A table as a pipe table; without a header row, an empty one heads it (pipe tables need one). */
function tableMarkdown(rows: readonly InlineText[][], headerRow: boolean, context: MarkdownContext): string {
	if (rows.length === 0) return "";
	const columns = Math.max(1, ...rows.map((row) => row.length));
	const line = (cells: readonly string[]) =>
		`| ${Array.from({ length: columns }, (_, index) => cells[index] ?? "").join(" | ")} |`;
	const cell = (inline: InlineText) => inlineMarkdown(inline, context, true);
	const [first, ...rest] = rows;
	const head = headerRow && first ? first.map(cell) : [];
	const body = headerRow ? rest : rows;
	return [
		line(head),
		line(Array.from({ length: columns }, () => "---")),
		...body.map((row) => line(row.map(cell))),
	].join("\n");
}
