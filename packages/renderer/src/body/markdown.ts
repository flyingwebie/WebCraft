/**
 * A body as Markdown (ADR 0018: Markdown is worked out from the Blocks, never by parsing HTML): each
 * Block becomes its Markdown, in order, separated by a blank line. It is the one dialect WebCraft
 * writes, for Markdown copies, the Content API and what API clients read and write
 * (`blocksFromMarkdown` reads it back, `from-markdown.ts`):
 *
 * - text escaped (`escapeMarkdown`), so it reads as written and nothing passes through as HTML; marks
 *   as `**`, `*`, `~~` and code spans; links as Markdown links; line breaks as hard breaks;
 * - headings as `##` to `####`, with a hand-written anchor as `{#anchor}`; lists nested; quotes as
 *   `>`; tables as pipe tables; code fenced; dividers as `---`;
 * - the extensions: `:::callout{tone="…"}` … `:::`, `:::toggle[Summary]` … `:::`,
 *   `::video[Title]{url="…"}`, and Components as their tag with their Props, `<PricingTable plan="pro" />`.
 *
 * The page decides where a link and an image go (`MarkdownContext`): a Markdown copy makes every
 * address absolute and shows images by their address with their caption; the exchange format keeps
 * links as written and images as `media:<id>` (`::image` for one not chosen yet).
 */
import { escapeMarkdown, escapeMarkdownLine, markdownUrl } from "../markdown.ts";
import type { Block, ComponentBlock, ListItem } from "./blocks.ts";
import { hasText, type InlineText, MARKS, type Run } from "./inline.ts";

/** What converting a body needs from the page. */
export type MarkdownContext = {
	/** A link's address as it leaves the page: absolute (a Site path or an `#anchor` completed), or as written. */
	link(url: string): string;
	/**
	 * An image Block's Media image: its address (`media:<id>` in the exchange format), alt text and
	 * caption; undefined when it shows nothing.
	 */
	image(mediaId: string): { url: string; alt: string | null; caption: string | null } | undefined;
	/**
	 * The exchange format (API clients, the MCP server, the CLI): Blocks that show nothing yet but
	 * hold a place (an image not chosen) are written too, so nothing is lost on the way back.
	 */
	exchange?: boolean;
	/** A Component Block's Component, by its id: its name as Markdown writes its tag. Without it, Components are left out. */
	component?(block: ComponentBlock): { name: string } | undefined;
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
		case "heading": {
			if (!hasText(block.text)) return "";
			// A heading ending with braces would read as an anchor: its first brace is escaped.
			const text = inlineMarkdown(block.text, context, true).replace(/\{([^{}]*)\}$/, "\\{$1}");
			return `${"#".repeat(block.level)} ${text}${block.anchor ? ` {#${block.anchor}}` : ""}`;
		}
		case "list":
			return listMarkdown(block.items, block.style === "numbered", context, "");
		case "quote":
			return hasText(block.text) ? quoted(inlineMarkdown(block.text, context)) : "";
		case "callout": {
			if (!hasText(block.text) && !context.exchange) return "";
			return directive(`:::callout{tone="${block.tone}"}`, inlineMarkdown(block.text, context));
		}
		case "image": {
			if (!block.media) return context.exchange ? "::image" : "";
			const image = context.image(block.media);
			if (!image) return context.exchange ? `![](media:${block.media})` : "";
			const picture = `![${escapeMarkdownLine(image.alt ?? "")}](${destination(image.url, context)})`;
			const caption = image.caption?.trim();
			return caption ? `${picture}\n\n*${escapeMarkdownLine(caption)}*` : picture;
		}
		case "video": {
			if (block.url === "") return "";
			return `::video[${escapeMarkdownLine(block.title)}]{url="${attributeValue(block.url)}"}`;
		}
		case "table":
			return tableMarkdown(block.rows, block.headerRow, context);
		case "code":
			return codeBlock(block.code, block.language);
		case "divider":
			return "---";
		case "toggle": {
			if (!hasText(block.summary) && !hasText(block.text)) return "";
			return directive(
				`:::toggle[${inlineMarkdown(block.summary, context, true)}]`,
				inlineMarkdown(block.text, context),
			);
		}
		case "component": {
			const found = context.component?.(block);
			if (!found) return "";
			const props = block.props.map((prop) =>
				prop.value === "" ? ` ${prop.name}` : ` ${prop.name}="${tagValue(prop.value)}"`,
			);
			return `<${found.name}${props.join("")} />`;
		}
	}
}

/** A container directive around its text: the opening line, the text, `:::`. */
function directive(open: string, text: string): string {
	return text === "" ? `${open}\n:::` : `${open}\n${text}\n:::`;
}

/** A directive's attribute value, in double quotes: `\` and `"` escaped. */
function attributeValue(value: string): string {
	return value.replace(/[\\"]/g, "\\$&");
}

/** A Component tag's attribute value, in double quotes, as HTML writes it. */
function tagValue(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/"/g, "&quot;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/\n/g, "&#10;");
}

/**
 * Formatted text as Markdown: each run's text escaped, its marks around it (spaces kept outside, as
 * Markdown needs), neighbouring runs with the same link in one link. Line breaks are hard breaks
 * (`\` at the end of the line), or spaces with `oneLine`.
 */
export function inlineMarkdown(
	inline: InlineText,
	context: Pick<MarkdownContext, "link" | "exchange">,
	oneLine = false,
): string {
	let markdown = "";
	let index = 0;
	while (index < inline.length) {
		const link = inline[index]?.link;
		let inner = "";
		while (index < inline.length && inline[index]?.link === link) {
			inner += runMarkdown(inline[index] as Run, oneLine);
			index++;
		}
		markdown +=
			link === undefined || inner.trim() === "" ? inner : `[${inner}](${destination(context.link(link), context)})`;
	}
	return markdown;
}

/**
 * A link's address as Markdown writes it: in the exchange format exactly as it is (the characters
 * that would end it backslash-escaped), in a copy percent-encoded.
 */
function destination(url: string, context: Pick<MarkdownContext, "exchange">): string {
	// An address can contain a literal entity such as &copy;: protect its ampersand from decoding.
	return context.exchange
		? url
				.replace(/[\\()<>]/g, "\\$&")
				.replace(/\s/g, "%20")
				.replace(/&/g, "&amp;")
		: markdownUrl(url);
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
	if (core === "") return text.includes("\n") && !oneLine ? text.replace(/\n/g, "\\\n") : text;
	let markdown = run.marks?.includes("code") ? codeSpan(core) : escapeMarkdown(core).replace(/\n/g, "\\\n");
	for (const mark of [...MARKS].reverse()) {
		if (mark !== "code" && run.marks?.includes(mark)) markdown = `${MARK_SYNTAX[mark]}${markdown}${MARK_SYNTAX[mark]}`;
	}
	const breaks = (spaces: string) => (oneLine ? spaces : spaces.replace(/\n/g, "\\\n"));
	return `${breaks(before)}${markdown}${breaks(after)}`;
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
