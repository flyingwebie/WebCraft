/**
 * Markdown as a body's Blocks (ADR 0018: Markdown is the exchange format for AI clients, the MCP
 * server and the CLI, never how a body is stored). `bodyMarkdown` (`markdown.ts`) writes the same
 * dialect, so every Block comes back as it went out:
 *
 * - CommonMark paragraphs, headings (`#` to `####`, and setext), lists (3 deep), quotes, fenced code,
 *   thematic breaks, `**bold**`, `*italic*`, `~~strike~~`, code spans, links (inline, reference and
 *   `<autolinks>`) and hard breaks (`\` or two spaces at a line's end); GitHub's pipe tables;
 * - a heading's anchor as `## Text {#anchor}`; H1 becomes H2 (the page's H1 is the Entry's title);
 * - the extensions for what Markdown has no syntax for: `:::callout{tone="warning"}` … `:::`,
 *   `:::toggle[Summary]` … `:::`, `::video[Title]{url="https://…"}`, `::image` (an image Block with
 *   no image yet) and `![alt](media:<id>)` for a Media image (its alt text and caption are the Media
 *   item's own);
 * - a Component as its tag with its Props as attributes, on a line of its own: `<PricingTable plan="pro" />`.
 *
 * **Strict** (the default: what API clients write) refuses whatever doesn't convert cleanly, each
 * problem with its line number, and nothing is saved: HTML, headings past H4, images that aren't
 * Media, unknown directives and their unknown attributes, lists nested past 3, Blocks inside a quote,
 * callout or list item, unclosed fences and directives, unknown Components and Props. **Lenient**
 * (what is pasted) refuses nothing: whatever has no Block becomes text, never HTML, and an image's
 * address becomes an image Block with no image yet (it is never fetched).
 */
import { decodeHTMLStrict as decodeEntities } from "entities";

import { type ComponentFound, isComponentInfo, isComponentTag } from "../components.ts";
import { type Block, CALLOUT_TONES, type CalloutTone, HEADING_LEVELS, type ListItem } from "./blocks.ts";
import { readBody } from "./body.ts";
import { canonicalInline, isSafeLink, type Mark, type Run } from "./inline.ts";

/** A problem with Markdown: its line (from 1) and what is wrong, in words. */
export type MarkdownProblem = { line: number; message: string };

export type MarkdownReadOptions = {
	/** Pasted text: refuse nothing, turn anything unknown into text (see the module's comment). */
	lenient?: boolean;
	/** The Components a body may place, by name; without it, a Component tag is refused (strict) or text (lenient). */
	component?: (name: string) => ComponentFound;
	/**
	 * The Blocks the Markdown replaces: a Block it holds again (the same, or changed in place) keeps
	 * its id, so translations and Co-editing follow it.
	 */
	previous?: readonly Block[];
};

/** Markdown as Blocks, or the problems that keep it from converting (each with its line). */
export function blocksFromMarkdown(
	markdown: string,
	options: MarkdownReadOptions = {},
): { blocks: Block[]; problems: MarkdownProblem[] } {
	const lines = markdown
		.replace(/\r\n?/g, "\n")
		.split("\n")
		.map((text, index) => ({ text: expandTabs(text), line: index + 1 }));
	const references = new Map<string, string>();
	const nodes = parseBlocks(lines, references);
	const converter = new Converter(options, references);
	const drafts = converter.blocks(nodes);
	const kept = keepIds(
		drafts.map((draft) => draft.block),
		options.previous ?? [],
	);
	const { blocks, problems } = readBody(kept);
	const found = [...converter.problems];
	for (const problem of problems) {
		const index = /^\[(\d+)\]/.exec(problem.at)?.[1];
		const line = index === undefined ? 1 : (drafts[Number(index)]?.line ?? 1);
		found.push({ line, message: problem.message });
	}
	if (options.lenient) return { blocks: lenientBlocks(kept), problems: [] };
	return { blocks: found.length > 0 ? [] : blocks, problems: sortProblems(found) };
}

function sortProblems(problems: MarkdownProblem[]): MarkdownProblem[] {
	const seen = new Set<string>();
	return problems
		.toSorted((a, b) => a.line - b.line)
		.filter((problem) => {
			const key = `${problem.line} ${problem.message}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
}

/** Pasted Blocks: each one the body can hold as it is; anything else as its text, or left out. */
function lenientBlocks(blocks: readonly Record<string, unknown>[]): Block[] {
	const out: Record<string, unknown>[] = [];
	for (const block of blocks) {
		if (readBody([block]).problems.length === 0) out.push(block);
	}
	return readBody(out).blocks;
}

// ---------------------------------------------------------------------------------------------------
// Block structure

type Line = { text: string; line: number };

type Node =
	| { kind: "paragraph"; lines: Line[]; line: number }
	| { kind: "heading"; level: number; text: string; line: number; anchor?: string }
	| { kind: "code"; info: string; code: string; line: number; closed: boolean }
	| { kind: "quote"; children: Node[]; line: number; nested: boolean }
	| { kind: "list"; ordered: boolean; items: { children: Node[]; line: number }[]; line: number }
	| { kind: "table"; rows: string[][]; line: number }
	| { kind: "hr"; line: number }
	| { kind: "container"; name: string; rest: string; children: Node[]; line: number; closed: boolean }
	| { kind: "leaf"; name: string; rest: string; line: number }
	| { kind: "html"; text: string; line: number }
	| { kind: "component"; name: string; attributes: string; closes: boolean; line: number };

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const CONTAINER = /^ {0,3}(:{3,})\s*([A-Za-z][\w-]*)(.*)$/;
const CONTAINER_END = /^ {0,3}:{3,}\s*$/;
const LEAF = /^ {0,3}::([A-Za-z][\w-]*)(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const THEMATIC = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const LIST_ITEM = /^( {0,3})([-+*]|\d{1,9}[.)])(?:( {1,4})(.*)|[ \t]*)$/;
const SETEXT_1 = /^ {0,3}=+[ \t]*$/;
const SETEXT_2 = /^ {0,3}-+[ \t]*$/;
const TABLE_DELIMITER = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const HTML_START = /^ {0,3}<(?:[A-Za-z][A-Za-z0-9-]*(?=[\s/>]|$)|\/[A-Za-z]|!--)/;
const COMPONENT_TAG = /^ {0,3}<([A-Z][A-Za-z0-9]*)((?:\s[^<>]*?)?)\s*(\/?)>\s*$/;
const DEFINITION = /^ {0,3}\[((?:[^\]\\]|\\.)+)\]:[ \t]*(<[^>]*>|\S+)(?:[ \t]+(?:"[^"]*"|'[^']*'|\([^)]*\)))?[ \t]*$/;

function expandTabs(text: string): string {
	return text.replace(/^\t+/, (tabs) => "    ".repeat(tabs.length));
}

function indentOf(text: string): number {
	return /^ */.exec(text)?.[0].length ?? 0;
}

function isBlank(text: string): boolean {
	return text.trim() === "";
}

type ListMarker = { indent: number; marker: string; content: string; contentIndent: number; ordered: boolean };

function listMarker(text: string): ListMarker | null {
	const match = LIST_ITEM.exec(text);
	if (!match) return null;
	const indent = match[1]?.length ?? 0;
	const marker = match[2] ?? "";
	const spaces = match[3] ?? "";
	const content = match[4] ?? "";
	// Five spaces or more after the marker start indented content: the item's own text starts after one.
	const gap = spaces.length === 0 ? 1 : spaces.length > 4 ? 1 : spaces.length;
	return {
		indent,
		marker,
		content: spaces.length > 4 ? `${" ".repeat(spaces.length - 1)}${content}` : content,
		contentIndent: indent + marker.length + gap,
		ordered: /\d/.test(marker),
	};
}

/** Whether a line starts a Block of its own (it ends a paragraph before it). */
function startsBlock(text: string): boolean {
	if (isBlank(text)) return true;
	if (FENCE.test(text) || ATX.test(text) || THEMATIC.test(text) || QUOTE.test(text)) return true;
	if (CONTAINER.test(text) || CONTAINER_END.test(text) || LEAF.test(text) || HTML_START.test(text)) return true;
	const marker = listMarker(text);
	// A numbered list interrupts a paragraph only when it starts at 1, as CommonMark has it.
	return marker !== null && marker.content.trim() !== "" && (!marker.ordered || /^1[.)]$/.test(marker.marker));
}

function sameList(a: ListMarker, b: ListMarker): boolean {
	if (a.ordered !== b.ordered) return false;
	return a.ordered ? a.marker.at(-1) === b.marker.at(-1) : a.marker === b.marker;
}

function parseBlocks(lines: readonly Line[], references: Map<string, string>): Node[] {
	const nodes: Node[] = [];
	let index = 0;
	while (index < lines.length) {
		const current = lines[index] as Line;
		const text = current.text;
		if (isBlank(text)) {
			index++;
			continue;
		}
		const fence = FENCE.exec(text);
		if (fence && !(fence[1]?.startsWith("`") && fence[2]?.includes("`"))) {
			const open = fence[1] ?? "```";
			const indent = indentOf(text);
			const code: string[] = [];
			let closed = false;
			index++;
			while (index < lines.length) {
				const inner = (lines[index] as Line).text;
				const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(inner);
				if (close && close[1]?.[0] === open[0] && (close[1]?.length ?? 0) >= open.length) {
					closed = true;
					index++;
					break;
				}
				code.push(inner.slice(Math.min(indent, indentOf(inner))));
				index++;
			}
			nodes.push({ kind: "code", info: (fence[2] ?? "").trim(), code: code.join("\n"), line: current.line, closed });
			continue;
		}
		const container = CONTAINER.exec(text);
		if (container) {
			const inner: Line[] = [];
			let depth = 1;
			let closed = false;
			index++;
			while (index < lines.length) {
				const each = lines[index] as Line;
				if (CONTAINER.test(each.text)) depth++;
				else if (CONTAINER_END.test(each.text)) {
					depth--;
					if (depth === 0) {
						closed = true;
						index++;
						break;
					}
				}
				inner.push(each);
				index++;
			}
			nodes.push({
				kind: "container",
				name: container[2] ?? "",
				rest: (container[3] ?? "").trim(),
				children: parseBlocks(inner, references),
				line: current.line,
				closed,
			});
			continue;
		}
		const leaf = LEAF.exec(text);
		if (leaf) {
			nodes.push({ kind: "leaf", name: leaf[1] ?? "", rest: (leaf[2] ?? "").trim(), line: current.line });
			index++;
			continue;
		}
		const atx = ATX.exec(text);
		if (atx) {
			let heading = (atx[2] ?? "").trim();
			let anchor: string | undefined;
			const anchored = /^(.*?)[ \t]*\{#([^}\s]+)\}$/.exec(heading);
			if (anchored && !anchored[1]?.endsWith("\\")) {
				heading = anchored[1] ?? "";
				anchor = anchored[2];
			}
			nodes.push({ kind: "heading", level: atx[1]?.length ?? 2, text: heading, line: current.line, anchor });
			index++;
			continue;
		}
		if (THEMATIC.test(text)) {
			nodes.push({ kind: "hr", line: current.line });
			index++;
			continue;
		}
		if (QUOTE.test(text)) {
			const inner: Line[] = [];
			let nested = false;
			while (index < lines.length) {
				const each = lines[index] as Line;
				const quoted = QUOTE.exec(each.text);
				if (quoted) {
					const rest = quoted[1] ?? "";
					if (QUOTE.test(rest)) nested = true;
					inner.push({ text: rest, line: each.line });
				} else if (
					!isBlank(each.text) &&
					inner.length > 0 &&
					!isBlank(inner.at(-1)?.text ?? "") &&
					!startsBlock(each.text)
				) {
					// A lazy line goes on the quote's paragraph.
					inner.push(each);
				} else break;
				index++;
			}
			nodes.push({ kind: "quote", children: parseBlocks(inner, references), line: current.line, nested });
			continue;
		}
		const marker = listMarker(text);
		if (marker && !(marker.content.trim() === "" && isBlank(lines[index + 1]?.text ?? ""))) {
			const items: { children: Node[]; line: number }[] = [];
			let first: ListMarker | null = marker;
			while (first && index < lines.length) {
				const itemLines: Line[] = [{ text: first.content, line: (lines[index] as Line).line }];
				const itemLine = (lines[index] as Line).line;
				index++;
				while (index < lines.length) {
					const each = lines[index] as Line;
					if (isBlank(each.text)) {
						const next = lines.slice(index + 1).find((later) => !isBlank(later.text));
						if (next && indentOf(next.text) >= first.contentIndent) {
							itemLines.push({ text: "", line: each.line });
							index++;
							continue;
						}
						break;
					}
					if (indentOf(each.text) >= first.contentIndent) {
						itemLines.push({ text: each.text.slice(first.contentIndent), line: each.line });
						index++;
						continue;
					}
					const previous = itemLines.at(-1)?.text ?? "";
					if (!isBlank(previous) && !startsBlock(each.text) && !listMarker(each.text)) {
						itemLines.push({ text: each.text.trimStart(), line: each.line });
						index++;
						continue;
					}
					break;
				}
				items.push({ children: parseBlocks(itemLines, references), line: itemLine });
				// The list goes on with the next item of its kind, blank lines between them allowed.
				let next = index;
				while (next < lines.length && isBlank((lines[next] as Line).text)) next++;
				const following = next < lines.length ? listMarker((lines[next] as Line).text) : null;
				if (following && sameList(following, marker) && following.indent < marker.contentIndent) {
					index = next;
					first = following;
				} else first = null;
			}
			nodes.push({ kind: "list", ordered: marker.ordered, items, line: current.line });
			continue;
		}
		const component = COMPONENT_TAG.exec(text);
		if (component && isComponentTag(component[1] ?? "")) {
			nodes.push({
				kind: "component",
				name: component[1] ?? "",
				attributes: (component[2] ?? "").trim(),
				closes: component[3] === "/",
				line: current.line,
			});
			index++;
			continue;
		}
		if (HTML_START.test(text)) {
			const html: string[] = [];
			while (index < lines.length && !isBlank((lines[index] as Line).text)) {
				html.push((lines[index] as Line).text);
				index++;
			}
			nodes.push({ kind: "html", text: html.join("\n"), line: current.line });
			continue;
		}
		if (text.includes("|") && TABLE_DELIMITER.test(lines[index + 1]?.text ?? "")) {
			const rows = [splitRow(text)];
			index += 2;
			while (index < lines.length) {
				const each = (lines[index] as Line).text;
				if (isBlank(each) || (startsBlock(each) && !each.includes("|"))) break;
				rows.push(splitRow(each));
				index++;
			}
			nodes.push({ kind: "table", rows, line: current.line });
			continue;
		}
		const definition = DEFINITION.exec(text);
		if (definition) {
			const label = normalizeLabel(definition[1] ?? "");
			const destination = (definition[2] ?? "").replace(/^<(.*)>$/, "$1");
			if (!references.has(label)) references.set(label, unescapeMarkdown(destination));
			index++;
			continue;
		}
		// A paragraph: lines until a blank one or the start of another Block. A line of `=` or `-`
		// under it makes it a heading instead (setext).
		const paragraph: Line[] = [current];
		index++;
		let setext = 0;
		while (index < lines.length) {
			const each = lines[index] as Line;
			if (SETEXT_1.test(each.text)) {
				setext = 1;
				index++;
				break;
			}
			if (SETEXT_2.test(each.text)) {
				setext = 2;
				index++;
				break;
			}
			if (startsBlock(each.text)) break;
			if (each.text.includes("|") && TABLE_DELIMITER.test(lines[index + 1]?.text ?? "")) break;
			paragraph.push(each);
			index++;
		}
		if (setext > 0) {
			nodes.push({
				kind: "heading",
				level: setext,
				text: paragraph.map((each) => each.text.trim()).join(" "),
				line: current.line,
			});
		} else nodes.push({ kind: "paragraph", lines: paragraph, line: current.line });
	}
	return nodes;
}

/** A table row's cells: split at pipes that aren't escaped or inside a code span, the outer ones dropped. */
function splitRow(text: string): string[] {
	let row = text.trim();
	if (row.startsWith("|")) row = row.slice(1);
	if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
	const cells: string[] = [];
	let cell = "";
	let index = 0;
	while (index < row.length) {
		const character = row[index] as string;
		if (character === "\\" && index + 1 < row.length) {
			cell += row.slice(index, index + 2);
			index += 2;
			continue;
		}
		if (character === "`") {
			const run = /^`+/.exec(row.slice(index))?.[0] ?? "`";
			const close = row.indexOf(run, index + run.length);
			if (close !== -1) {
				cell += row.slice(index, close + run.length);
				index = close + run.length;
				continue;
			}
		}
		if (character === "|") {
			cells.push(cell.trim());
			cell = "";
			index++;
			continue;
		}
		cell += character;
		index++;
	}
	cells.push(cell.trim());
	// An escaped pipe in a cell is the cell's text.
	return cells.map((each) => each.replace(/\\\|/g, "|"));
}

function normalizeLabel(label: string): string {
	return label.trim().replace(/\s+/g, " ").toLowerCase();
}

// ---------------------------------------------------------------------------------------------------
// Blocks

type Draft = { block: Record<string, unknown>; line: number };

/** The extensions' attributes: `{key="value" other='value' bare=word}`. */
function readAttributes(text: string): Map<string, string> | null {
	const attributes = new Map<string, string>();
	let rest = text.trim();
	if (!rest.startsWith("{") || !rest.endsWith("}")) return null;
	rest = rest.slice(1, -1).trim();
	const pattern = /^([A-Za-z][\w-]*)(?:=(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^\s"'}]+)))?\s*/;
	while (rest !== "") {
		const match = pattern.exec(rest);
		if (!match) return null;
		const value = match[2] ?? match[3] ?? match[4] ?? "";
		attributes.set(match[1] ?? "", value.replace(/\\(.)/g, "$1"));
		rest = rest.slice(match[0].length);
	}
	return attributes;
}

/** A directive's `[label]` and `{attributes}`, in that order, each optional. */
function readDirective(rest: string): { label: string | null; attributes: Map<string, string> | null; ok: boolean } {
	let label: string | null = null;
	let remaining = rest.trim();
	if (remaining.startsWith("[")) {
		let depth = 0;
		let end = -1;
		for (let index = 0; index < remaining.length; index++) {
			const character = remaining[index];
			if (character === "\\") {
				index++;
				continue;
			}
			if (character === "[") depth++;
			else if (character === "]") {
				depth--;
				if (depth === 0) {
					end = index;
					break;
				}
			}
		}
		if (end === -1) return { label: null, attributes: null, ok: false };
		label = remaining.slice(1, end);
		remaining = remaining.slice(end + 1).trim();
	}
	if (remaining === "") return { label, attributes: new Map(), ok: true };
	const attributes = readAttributes(remaining);
	return { label, attributes, ok: attributes !== null };
}

/** A Component tag's attributes: `name="value"`, `name='value'`, or `name` alone (an empty value). */
function readTagAttributes(text: string): [string, string][] | null {
	const out: [string, string][] = [];
	let rest = text.trim();
	const pattern = /^([A-Za-z_][\w-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'))?\s*/;
	while (rest !== "") {
		const match = pattern.exec(rest);
		if (!match) return null;
		out.push([match[1] ?? "", decodeEntities(match[2] ?? match[3] ?? "")]);
		rest = rest.slice(match[0].length);
	}
	return out;
}

const CODE_LANGUAGE = /^[a-z0-9][a-z0-9+#._-]{0,31}$/;

class Converter {
	readonly problems: MarkdownProblem[] = [];
	private readonly options: MarkdownReadOptions;
	private readonly references: ReadonlyMap<string, string>;

	constructor(options: MarkdownReadOptions, references: ReadonlyMap<string, string>) {
		this.options = options;
		this.references = references;
	}

	private refuse(line: number, message: string): void {
		if (!this.options.lenient) this.problems.push({ line, message });
	}

	private get lenient(): boolean {
		return this.options.lenient === true;
	}

	blocks(nodes: readonly Node[]): Draft[] {
		return nodes.flatMap((node) => this.block(node));
	}

	private inline(text: string, line: number, oneLine = false): InlinePiece[] {
		const parsed = parseInline(text, this.references);
		if (parsed.html)
			this.refuse(line, "HTML isn't read in a body: write Markdown (a Component as <Name … /> on a line of its own).");
		for (const url of parsed.unsafe) {
			this.refuse(line, `A link goes to an http, https, mailto or tel address, a path or an #anchor, not ${url}.`);
		}
		return oneLine
			? parsed.pieces.map((piece) => ("text" in piece ? { ...piece, text: piece.text.replace(/\n/g, " ") } : piece))
			: parsed.pieces;
	}

	/** Formatted text alone: an image inside it is refused (strict) or its alt text (lenient). */
	private text(text: string, line: number, oneLine = false): Run[] {
		const pieces = this.inline(text, line, oneLine);
		const runs: Run[] = [];
		for (const piece of pieces) {
			if ("image" in piece) {
				this.refuse(line, "An image stands on a line of its own: ![alt](media:<id>).");
				if (piece.image.alt) runs.push({ text: piece.image.alt });
			} else runs.push(piece);
		}
		return canonicalInline(trimRuns(runs));
	}

	/** Paragraphs, joined by line breaks, from Blocks that may hold only text (a quote, a callout, a toggle, a list item). */
	private textOf(nodes: readonly Node[], what: string, line: number): Run[] {
		const runs: Run[] = [];
		for (const node of nodes) {
			let piece: Run[] = [];
			if (node.kind === "paragraph") piece = this.text(joinLines(node.lines), node.line);
			else {
				this.refuse(node.line, `${what} holds text only.`);
				piece = this.blocks([node]).flatMap((draft) => blockText(draft.block));
			}
			if (piece.length === 0) continue;
			if (runs.length > 0) runs.push({ text: "\n" });
			runs.push(...piece);
		}
		return line > 0 ? canonicalInline(runs) : [];
	}

	private block(node: Node): Draft[] {
		const at = (block: Record<string, unknown>): Draft => ({ block, line: node.line });
		switch (node.kind) {
			case "paragraph": {
				const pieces = this.inline(joinLines(node.lines), node.line);
				const images = pieces.filter((piece) => "image" in piece);
				const texts = pieces.filter((piece): piece is Run => "text" in piece);
				if (images.length === 1 && texts.every((run) => run.text.trim() === "")) {
					const image = (images[0] as { image: InlineImage }).image;
					return [at(this.image(image.url, node.line))];
				}
				if (images.length === 0) {
					const text = canonicalInline(trimRuns(texts));
					return text.length > 0 ? [at({ type: "paragraph", text })] : [];
				}
				// Text and images together: strict refuses it, a paste keeps each in its place.
				if (!this.lenient) {
					this.refuse(node.line, "An image stands on a line of its own: ![alt](media:<id>).");
					return [];
				}
				const out: Draft[] = [];
				let runs: Run[] = [];
				const flush = () => {
					const text = canonicalInline(trimRuns(runs));
					if (text.length > 0) out.push(at({ type: "paragraph", text }));
					runs = [];
				};
				for (const piece of pieces) {
					if ("image" in piece) {
						flush();
						out.push(at(this.image(piece.image.url, node.line)));
					} else runs.push(piece);
				}
				flush();
				return out;
			}
			case "heading": {
				let level = node.level;
				if (level === 1) level = 2;
				if (level > 4) {
					this.refuse(node.line, "A body's headings are H2 to H4 (## to ####); the page's H1 is the Entry's title.");
					level = 4;
				}
				const text = this.text(node.text, node.line, true);
				if (text.length === 0) return [];
				const block: Record<string, unknown> = {
					type: "heading",
					level: HEADING_LEVELS.includes(level as 2) ? level : 2,
					text,
				};
				if (node.anchor) block.anchor = node.anchor;
				return [at(block)];
			}
			case "code": {
				if (!node.closed) this.refuse(node.line, "This code block isn't closed: end it with the fence it starts with.");
				const word = node.info.split(/\s+/)[0]?.toLowerCase() ?? "";
				const language = CODE_LANGUAGE.test(word) ? word : null;
				if (word !== "" && language === null) this.refuse(node.line, `${word} isn't a code language WebCraft keeps.`);
				return [at({ type: "code", code: node.code, language })];
			}
			case "quote": {
				if (node.nested) this.refuse(node.line, "A quote can't hold another quote.");
				// A quote inside it (refused above) gives its text.
				const flat = (nodes: readonly Node[]): Node[] =>
					nodes.flatMap((child) => (child.kind === "quote" ? flat(child.children) : [child]));
				const text = this.textOf(flat(node.children), "A quote", node.line);
				return text.length > 0 ? [at({ type: "quote", text })] : [];
			}
			case "list": {
				const items = this.listItems(node, 1);
				return items.length > 0 ? [at({ type: "list", style: node.ordered ? "numbered" : "bulleted", items })] : [];
			}
			case "table": {
				const width = Math.max(...node.rows.map((row) => row.length));
				const cells = node.rows.map((row) =>
					Array.from({ length: width }, (_, column) => this.text(row[column] ?? "", node.line, true)),
				);
				const [head, ...body] = cells;
				const headerRow = (head ?? []).some((cell) => cell.length > 0);
				return [at({ type: "table", headerRow, rows: headerRow ? cells : body })];
			}
			case "hr":
				return [at({ type: "divider" })];
			case "container":
				return this.container(node);
			case "leaf":
				return this.leaf(node);
			case "html": {
				this.refuse(
					node.line,
					"HTML isn't read in a body: write Markdown (a Component as <Name … /> on a line of its own).",
				);
				const text = decodeEntities(node.text.replace(/<[^>]*>/g, " "))
					.replace(/[ \t]+/g, " ")
					.trim();
				return text ? [at({ type: "paragraph", text })] : [];
			}
			case "component":
				return this.component(node);
		}
	}

	private image(url: string, line: number): Record<string, unknown> {
		const media = /^media:([0-9a-f-]{36})$/i.exec(url.trim())?.[1];
		if (media) return { type: "image", media };
		this.refuse(
			line,
			"An image in a body is a file of the Site's Media library: upload it, then write ![alt](media:<id>).",
		);
		// A pasted image's address is never fetched: the Block waits for an image to be chosen.
		return { type: "image", media: null };
	}

	private listItems(list: Extract<Node, { kind: "list" }>, depth: number): ListItem[] {
		return list.items.map((item) => {
			const own: Node[] = [];
			const nested: Extract<Node, { kind: "list" }>[] = [];
			for (const child of item.children) {
				if (child.kind === "list") nested.push(child);
				else own.push(child);
			}
			const out: ListItem = { text: this.textOf(own, "A list item", item.line) };
			const inner: ListItem[] = [];
			for (const child of nested) {
				if (depth >= 3) {
					this.refuse(child.line, "Lists nest at most 3 deep.");
					// A paste keeps the deeper items' text in the item.
					const deeper = this.listItems(child, depth + 1).flatMap(flattenItem);
					if (deeper.length > 0) out.text = canonicalInline([...out.text, { text: " " }, ...deeper]);
				} else inner.push(...this.listItems(child, depth + 1));
			}
			if (inner.length > 0) out.items = inner;
			return out;
		});
	}

	private container(node: Extract<Node, { kind: "container" }>): Draft[] {
		const at = (block: Record<string, unknown>): Draft => ({ block, line: node.line });
		if (!node.closed) this.refuse(node.line, `:::${node.name} isn't closed: end it with ::: on a line of its own.`);
		const { label, attributes, ok } = readDirective(node.rest);
		if (node.name === "callout") {
			let tone: CalloutTone = "info";
			if (!ok || label !== null) this.refuse(node.line, 'A callout is written :::callout{tone="info"}.');
			for (const [key, value] of attributes ?? []) {
				if (key !== "tone") this.refuse(node.line, `A callout has no ${key}; it has a tone.`);
				else if ((CALLOUT_TONES as readonly string[]).includes(value)) tone = value as CalloutTone;
				else this.refuse(node.line, `A callout's tone is ${CALLOUT_TONES.join(", ")}.`);
			}
			return [at({ type: "callout", tone, text: this.textOf(node.children, "A callout", node.line) })];
		}
		if (node.name === "toggle") {
			if (!ok || (attributes?.size ?? 0) > 0) this.refuse(node.line, "A toggle is written :::toggle[Its summary].");
			const summary = label === null ? [] : this.text(label, node.line, true);
			return [at({ type: "toggle", summary, text: this.textOf(node.children, "A toggle", node.line) })];
		}
		this.refuse(node.line, `There is no :::${node.name}: a body has :::callout and :::toggle.`);
		return this.blocks(node.children);
	}

	private leaf(node: Extract<Node, { kind: "leaf" }>): Draft[] {
		const at = (block: Record<string, unknown>): Draft => ({ block, line: node.line });
		const { label, attributes, ok } = readDirective(node.rest);
		if (node.name === "image") {
			if (!ok || label !== null)
				this.refuse(node.line, 'An image with none chosen yet is ::image (or ::image{media="<id>"}).');
			for (const key of attributes?.keys() ?? []) {
				if (key !== "media" && key !== "decorative") this.refuse(node.line, `An image has no ${key}.`);
			}
			const media = attributes?.get("media");
			const decorative = attributes?.get("decorative");
			if (decorative !== undefined && decorative !== "true" && decorative !== "false")
				this.refuse(node.line, "Decorative is true or false.");
			return [
				at({
					...(media ? this.image(`media:${media}`, node.line) : { type: "image", media: null }),
					...(decorative === "true" ? { decorative: true } : {}),
				}),
			];
		}
		if (node.name === "video") {
			if (!ok) this.refuse(node.line, 'A video is written ::video[Its title]{url="https://…"}.');
			for (const key of attributes?.keys() ?? []) {
				if (key !== "url") this.refuse(node.line, `A video has no ${key}; it has a url and a title.`);
			}
			const url = attributes?.get("url") ?? "";
			if (url === "") this.refuse(node.line, 'A video needs its address: ::video[Its title]{url="https://…"}.');
			const title =
				label === null
					? ""
					: this.text(label, node.line, true)
							.map((run) => run.text)
							.join("");
			return url ? [at({ type: "video", url, title })] : [];
		}
		this.refuse(node.line, `There is no ::${node.name}: a body has ::image and ::video.`);
		return node.rest ? [at({ type: "paragraph", text: `::${node.name}${node.rest}` })] : [];
	}

	private component(node: Extract<Node, { kind: "component" }>): Draft[] {
		const tag = `<${node.name}${node.attributes ? ` ${node.attributes}` : ""}${node.closes ? " /" : ""}>`;
		const asText = (): Draft[] => [{ block: { type: "paragraph", text: tag }, line: node.line }];
		const found = this.options.component?.(node.name);
		if (!this.options.component || found === undefined) {
			this.refuse(node.line, `There is no Component ${node.name} for this body.`);
			return asText();
		}
		if (!isComponentInfo(found)) {
			this.refuse(node.line, found.refused);
			return asText();
		}
		if (!node.closes) this.refuse(node.line, `<${node.name}> holds nothing: write <${node.name} … />.`);
		const attributes = readTagAttributes(node.attributes);
		if (attributes === null) {
			this.refuse(node.line, `<${node.name}>'s Props are written name="value".`);
			return [];
		}
		const props: { name: string; value: string }[] = [];
		for (const [name, value] of attributes) {
			const prop = found.props.find((each) => each.key === name);
			if (!prop) {
				this.refuse(node.line, `${node.name} has no Prop ${name}.`);
				continue;
			}
			if (props.some((each) => each.name === name)) {
				this.refuse(node.line, `${node.name}'s Prop ${name} is given twice.`);
				continue;
			}
			const problem = prop.check(value);
			if (problem) this.refuse(node.line, `${node.name}'s Prop ${name}: ${problem}`);
			props.push({ name, value });
		}
		for (const prop of found.props) {
			if (prop.required && !props.some((each) => each.name === prop.key)) {
				this.refuse(node.line, `${node.name} needs its Prop ${prop.key}.`);
			}
		}
		return [{ block: { type: "component", component: found.id, props }, line: node.line }];
	}
}

function flattenItem(item: ListItem): Run[] {
	return [...item.text, ...(item.items ?? []).flatMap((inner) => [{ text: " " }, ...flattenItem(inner)])];
}

/** The text of a Block made where only text may go (a paste flattening a list into a quote). */
function blockText(block: Record<string, unknown>): Run[] {
	if (Array.isArray(block.text)) return block.text as Run[];
	if (typeof block.text === "string") return [{ text: block.text }];
	if (Array.isArray(block.items)) return (block.items as ListItem[]).flatMap(flattenItem);
	if (typeof block.code === "string") return [{ text: block.code }];
	return [];
}

/** A paragraph's lines as one piece of text: each line's leading spaces dropped, line ends kept. */
function joinLines(lines: readonly Line[]): string {
	return lines.map((line) => line.text.replace(/^[ \t]+/, "")).join("\n");
}

/** Runs without the spaces at their two ends. */
function trimRuns(runs: readonly Run[]): Run[] {
	const out = runs.map((run) => ({ ...run }));
	while (out.length > 0 && (out[0] as Run).text.trim() === "" && !(out[0] as Run).marks?.includes("code")) out.shift();
	while (out.length > 0 && (out.at(-1) as Run).text.trim() === "" && !(out.at(-1) as Run).marks?.includes("code"))
		out.pop();
	if (out[0] && !out[0].marks?.includes("code")) out[0].text = out[0].text.replace(/^[ \t]+/, "");
	const last = out.at(-1);
	if (last && !last.marks?.includes("code")) last.text = last.text.replace(/[ \t]+$/, "");
	return out;
}

/**
 * Keeps the ids of the Blocks Markdown replaces: a Block the same as one before takes its id; then a
 * Block of the same type at the same place takes that one's (it was changed in place).
 */
function keepIds(blocks: readonly Record<string, unknown>[], previous: readonly Block[]): Record<string, unknown>[] {
	if (previous.length === 0) return [...blocks];
	const content = (block: Record<string, unknown>) => {
		const { id: _, source: __, ...rest } = block;
		return JSON.stringify(readBody([rest]).blocks.map(({ id: ___, ...kept }) => kept));
	};
	const used = new Set<number>();
	const ids: (string | undefined)[] = blocks.map(() => undefined);
	const before = previous.map((block) => content(block as unknown as Record<string, unknown>));
	blocks.forEach((block, index) => {
		const text = content(block);
		const match = before.findIndex((each, at) => !used.has(at) && each === text);
		if (match !== -1) {
			used.add(match);
			ids[index] = previous[match]?.id;
		}
	});
	blocks.forEach((block, index) => {
		if (ids[index] !== undefined) return;
		const there = previous[index];
		if (there && !used.has(index) && there.type === block.type) {
			used.add(index);
			ids[index] = there.id;
		}
	});
	return blocks.map((block, index) => (ids[index] ? { id: ids[index], ...block } : { ...block }));
}

// ---------------------------------------------------------------------------------------------------
// Inline text

type InlineImage = { url: string; alt: string };
type InlinePiece = Run | { image: InlineImage };

type INode =
	| { k: "text"; s: string }
	| { k: "code"; s: string }
	| { k: "br" }
	| { k: "delim"; ch: "*" | "_" | "~"; n: number; length: number; open: boolean; close: boolean }
	| { k: "bracket"; image: boolean; active: boolean }
	| { k: "link"; url: string; children: INode[] }
	| { k: "image"; url: string; children: INode[] }
	| { k: "mark"; mark: Mark; children: INode[] }
	| { k: "html"; s: string };

const PUNCTUATION = /[!-/:-@[-`{-~\p{P}\p{S}]/u;
const ESCAPABLE = /[!-/:-@[-`{-~]/;

function unescapeMarkdown(text: string): string {
	return decodeEntities(text.replace(/\\([!-/:-@[-`{-~])/g, "$1"));
}

const RAW_HTML =
	/^(?:<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][\w.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>|<\/[A-Za-z][A-Za-z0-9-]*\s*>|<!--[\s\S]*?-->)/;
const AUTOLINK = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*)>/;
const EMAIL_AUTOLINK =
	/^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*)>/;

/** Inline Markdown as runs of text and the images between them; `html` says raw HTML was met. */
function parseInline(
	text: string,
	references: ReadonlyMap<string, string>,
): { pieces: InlinePiece[]; html: boolean; unsafe: string[] } {
	const state = { html: false, unsafe: [] as string[] };
	const nodes = tokenize(text, references, state);
	processEmphasis(nodes, 0);
	const pieces: InlinePiece[] = [];
	flatten(nodes, [], undefined, pieces, state);
	const merged: InlinePiece[] = [];
	let runs: Run[] = [];
	for (const piece of pieces) {
		if ("image" in piece) {
			merged.push(...canonicalInline(runs), piece);
			runs = [];
		} else runs.push(piece);
	}
	merged.push(...canonicalInline(runs));
	return { pieces: merged, html: state.html, unsafe: state.unsafe };
}

function tokenize(
	text: string,
	references: ReadonlyMap<string, string>,
	state: { html: boolean; unsafe: string[] },
): INode[] {
	const nodes: INode[] = [];
	const brackets: number[] = [];
	let plain = "";
	const flushText = () => {
		if (plain !== "") nodes.push({ k: "text", s: plain });
		plain = "";
	};
	let index = 0;
	while (index < text.length) {
		const character = text[index] as string;
		const rest = text.slice(index);
		if (character === "\\") {
			const next = text[index + 1];
			if (next === "\n") {
				flushText();
				nodes.push({ k: "br" });
				index += 2;
				continue;
			}
			if (next !== undefined && ESCAPABLE.test(next)) {
				plain += next;
				index += 2;
				continue;
			}
			plain += "\\";
			index++;
			continue;
		}
		if (character === "\n") {
			// Two spaces or more before a line end make a hard break; otherwise it is a space.
			const hard = / {2,}$/.test(plain);
			plain = plain.replace(/ +$/, "");
			if (hard) {
				flushText();
				nodes.push({ k: "br" });
			} else plain += " ";
			index++;
			while (text[index] === " ") index++;
			continue;
		}
		if (character === "&") {
			const entity = /^&(?:#x[0-9a-f]{1,6}|#\d{1,7}|[a-z][a-z0-9]*);/i.exec(rest);
			const decoded = entity ? decodeEntities(entity[0]) : null;
			if (entity && decoded !== null) {
				plain += decoded;
				index += entity[0].length;
				continue;
			}
			plain += "&";
			index++;
			continue;
		}
		if (character === "`") {
			const run = /^`+/.exec(rest)?.[0] ?? "`";
			let search = index + run.length;
			let close = -1;
			while (search < text.length) {
				const found = text.indexOf("`", search);
				if (found === -1) break;
				const other = /^`+/.exec(text.slice(found))?.[0] ?? "";
				if (other.length === run.length) {
					close = found;
					break;
				}
				search = found + other.length;
			}
			if (close === -1) {
				plain += run;
				index += run.length;
				continue;
			}
			let code = text.slice(index + run.length, close).replace(/\n/g, " ");
			if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") code = code.slice(1, -1);
			flushText();
			nodes.push({ k: "code", s: code });
			index = close + run.length;
			continue;
		}
		if (character === "<") {
			const auto = AUTOLINK.exec(rest);
			if (auto) {
				flushText();
				const url = auto[1] ?? "";
				if (isSafeLink(url)) nodes.push({ k: "link", url, children: [{ k: "text", s: url }] });
				else {
					state.unsafe.push(url);
					nodes.push({ k: "text", s: url });
				}
				index += auto[0].length;
				continue;
			}
			const email = EMAIL_AUTOLINK.exec(rest);
			if (email) {
				flushText();
				nodes.push({ k: "link", url: `mailto:${email[1]}`, children: [{ k: "text", s: email[1] ?? "" }] });
				index += email[0].length;
				continue;
			}
			const html = RAW_HTML.exec(rest);
			if (html) {
				flushText();
				state.html = true;
				nodes.push({ k: "html", s: html[0] });
				index += html[0].length;
				continue;
			}
			plain += "<";
			index++;
			continue;
		}
		if (character === "*" || character === "_" || character === "~") {
			const run = new RegExp(`^\\${character}+`).exec(rest)?.[0] ?? character;
			const before = index === 0 ? " " : (text[index - 1] as string);
			const after = text[index + run.length] ?? " ";
			const left = !/\s/.test(after) && (!PUNCTUATION.test(after) || /\s/.test(before) || PUNCTUATION.test(before));
			const right = !/\s/.test(before) && (!PUNCTUATION.test(before) || /\s/.test(after) || PUNCTUATION.test(after));
			let open = left;
			let close = right;
			if (character === "_") {
				open = left && (!right || PUNCTUATION.test(before));
				close = right && (!left || PUNCTUATION.test(after));
			}
			flushText();
			nodes.push({ k: "delim", ch: character, n: run.length, length: run.length, open, close });
			index += run.length;
			continue;
		}
		if (character === "!" && text[index + 1] === "[") {
			flushText();
			brackets.push(nodes.length);
			nodes.push({ k: "bracket", image: true, active: true });
			index += 2;
			continue;
		}
		if (character === "[") {
			flushText();
			brackets.push(nodes.length);
			nodes.push({ k: "bracket", image: false, active: true });
			index++;
			continue;
		}
		if (character === "]") {
			flushText();
			const opener = brackets.pop();
			const bracket = opener === undefined ? undefined : (nodes[opener] as Extract<INode, { k: "bracket" }>);
			if (opener === undefined || !bracket?.active) {
				plain += "]";
				index++;
				continue;
			}
			const target = linkTarget(text, index + 1, references, nodes.slice(opener + 1));
			if (!target) {
				plain += "]";
				index++;
				continue;
			}
			const children = nodes.splice(opener + 1);
			nodes.pop();
			processEmphasis(children, 0);
			if (bracket.image) nodes.push({ k: "image", url: target.url, children });
			else {
				if (!isSafeLink(target.url)) {
					state.unsafe.push(target.url);
					nodes.push(...children);
				} else nodes.push({ k: "link", url: target.url, children });
				// Links can't hold links: the brackets before this one are text now.
				for (const at of brackets) {
					const earlier = nodes[at];
					if (earlier?.k === "bracket" && !earlier.image) earlier.active = false;
				}
			}
			index = target.end;
			continue;
		}
		plain += character;
		index++;
	}
	flushText();
	return nodes;
}

/** Where a link's `](…)` or `][ref]` goes, read from just after its `]`; null when it is none. */
function linkTarget(
	text: string,
	from: number,
	references: ReadonlyMap<string, string>,
	inner: readonly INode[],
): { url: string; end: number } | null {
	if (text[from] === "(") {
		let index = from + 1;
		while (text[index] === " " || text[index] === "\n") index++;
		let url = "";
		if (text[index] === "<") {
			const close = text.indexOf(">", index);
			if (close === -1) return null;
			url = text.slice(index + 1, close);
			index = close + 1;
		} else {
			let depth = 0;
			const start = index;
			while (index < text.length) {
				const character = text[index] as string;
				if (character === "\\" && index + 1 < text.length) {
					index += 2;
					continue;
				}
				if (/\s/.test(character)) break;
				if (character === "(") depth++;
				if (character === ")") {
					if (depth === 0) break;
					depth--;
				}
				index++;
			}
			url = text.slice(start, index);
		}
		while (text[index] === " " || text[index] === "\n") index++;
		const title = /^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^)\\]|\\.)*\))/.exec(text.slice(index));
		if (title) index += title[0].length;
		while (text[index] === " " || text[index] === "\n") index++;
		if (text[index] !== ")") return null;
		return { url: unescapeMarkdown(url), end: index + 1 };
	}
	const label = (raw: string) => references.get(normalizeLabel(raw));
	const full = /^\[((?:[^\]\\]|\\.)*)\]/.exec(text.slice(from));
	if (full) {
		const named = full[1] === "" ? inlineSource(inner) : (full[1] ?? "");
		const url = label(named);
		return url === undefined ? null : { url, end: from + full[0].length };
	}
	const url = label(inlineSource(inner));
	return url === undefined ? null : { url, end: from };
}

/** The text of inline nodes, as a reference's label reads it. */
function inlineSource(nodes: readonly INode[]): string {
	return nodes
		.map((node) => {
			switch (node.k) {
				case "text":
				case "code":
				case "html":
					return node.s;
				case "delim":
					return node.ch.repeat(node.n);
				case "bracket":
					return node.image ? "![" : "[";
				case "br":
					return " ";
				default:
					return inlineSource(node.children);
			}
		})
		.join("");
}

/** CommonMark's emphasis: matches delimiter runs into bold, italic and strikethrough, from `bottom` on. */
function processEmphasis(nodes: INode[], bottom: number): void {
	let closerIndex = bottom;
	while (closerIndex < nodes.length) {
		const closer = nodes[closerIndex];
		if (closer?.k !== "delim" || !closer.close || closer.n === 0) {
			closerIndex++;
			continue;
		}
		let openerIndex = closerIndex - 1;
		let found = false;
		while (openerIndex >= bottom) {
			const opener = nodes[openerIndex];
			if (opener?.k === "delim" && opener.ch === closer.ch && opener.open && opener.n > 0) {
				if (closer.ch === "~") {
					if (opener.n === closer.n && closer.n === 2) {
						found = true;
						break;
					}
				} else {
					const oddMatch =
						(opener.close || closer.open) &&
						(opener.length + closer.length) % 3 === 0 &&
						!(opener.length % 3 === 0 && closer.length % 3 === 0);
					if (!oddMatch) {
						found = true;
						break;
					}
				}
			}
			openerIndex--;
		}
		if (!found) {
			closerIndex++;
			continue;
		}
		const opener = nodes[openerIndex] as Extract<INode, { k: "delim" }>;
		const use = closer.ch === "~" ? 2 : opener.n >= 2 && closer.n >= 2 ? 2 : 1;
		const mark: Mark = closer.ch === "~" ? "strike" : use === 2 ? "bold" : "italic";
		const inner = nodes.splice(openerIndex + 1, closerIndex - openerIndex - 1);
		const wrapped: INode = { k: "mark", mark, children: inner };
		nodes.splice(openerIndex + 1, 0, wrapped);
		opener.n -= use;
		closer.n -= use;
		closerIndex = openerIndex + 2;
		if (opener.n === 0) {
			nodes.splice(openerIndex, 1);
			closerIndex--;
		}
		if (closer.n === 0) nodes.splice(closerIndex, 1);
	}
}

function flatten(
	nodes: readonly INode[],
	marks: readonly Mark[],
	link: string | undefined,
	out: InlinePiece[],
	state: { html: boolean },
): void {
	const push = (text: string, extra: readonly Mark[] = []) => {
		if (text === "") return;
		const all = [...marks, ...extra];
		out.push({ text, ...(all.length > 0 ? { marks: all } : {}), ...(link ? { link } : {}) });
	};
	for (const node of nodes) {
		switch (node.k) {
			case "text":
				push(node.s);
				break;
			case "code":
				push(node.s, ["code"]);
				break;
			case "br":
				push("\n");
				break;
			case "delim":
				push(node.ch.repeat(node.n));
				break;
			case "bracket":
				push(node.image ? "![" : "[");
				break;
			case "html":
				// Never HTML: its tags are left out; strict mode refuses it.
				state.html = true;
				break;
			case "mark":
				flatten(node.children, [...marks, node.mark], link, out, state);
				break;
			case "link":
				flatten(node.children, marks, node.url, out, state);
				break;
			case "image":
				out.push({ image: { url: node.url, alt: inlineSource(node.children) } });
				break;
		}
	}
}
