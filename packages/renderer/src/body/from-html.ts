/**
 * HTML from another system as a body's Blocks (ADR 0018): an Import brings a post's HTML in as core
 * Blocks, never as HTML. The HTML is parsed the way browsers parse it (parse5, in a `<div>`'s
 * context), and only what a Block holds is kept: text with its marks and safe links, headings, lists,
 * quotes, tables, code, dividers, toggles, images and YouTube or Vimeo videos. Scripts, styles, event
 * handlers and every attribute are left behind, as the rich text cleaner leaves them.
 *
 * What no Block type matches is an **Import leftover** (GLOSSARY.md): a shortcode (`[gallery ids="1"]`),
 * page-builder layout (containers inside containers, such as rows of columns), or an embed with no
 * Block (a map's frame, a form). It is kept where it stood as a plain paragraph of its text (or of
 * its opening tag when it has none), and listed, so someone can rewrite it as Blocks or Components.
 *
 * Text the HTML gives outside any block element is read as paragraphs, a blank line starting a new
 * one and a single line break kept as one, as systems that write their posts' paragraphs that way
 * mean it.
 */
import { parseFragment } from "parse5";

import { type Block, BODY_LIMITS, type HeadingLevel, type ListItem, type ListStyle } from "./blocks.ts";
import { newBlockId, readBody } from "./body.ts";
import { canonicalInline, inlineText, isSafeLink, LINK_MAX_LENGTH, type Mark, type Run } from "./inline.ts";
import { videoAt } from "./video.ts";

/** A piece of the HTML no Block type matches, kept as the plain paragraph `blockId`. */
export type HtmlLeftover = {
	blockId: string;
	/** What was kept, as plain text. */
	text: string;
	/** What it was, shortened: the shortcode, or an element's opening tag (`<div class="row">`). */
	markup: string;
};

/** An image the HTML shows, now the image Block `blockId`, until its file is in the Media library. */
export type HtmlImage = { blockId: string; address: string; alt: string | null; caption: string | null };

/** A body read from HTML: its Blocks, its Import leftovers and the images to fetch. */
export type HtmlBody = { blocks: Block[]; leftovers: HtmlLeftover[]; images: HtmlImage[] };

type Node = {
	nodeName: string;
	tagName?: string;
	value?: string;
	attrs?: { name: string; value: string }[];
	childNodes?: Node[];
	content?: Node;
};

/** Elements whose content never comes in, not even as a leftover. */
const DROPPED: ReadonlySet<string> = new Set([
	"script",
	"style",
	"template",
	"noscript",
	"noembed",
	"noframes",
	"head",
	"title",
	"meta",
	"link",
	"base",
	"xmp",
	"plaintext",
	"param",
	"source",
	"track",
]);

/** Elements that only hold others: read through when they wrap content, a leftover when they lay it out. */
const CONTAINERS: ReadonlySet<string> = new Set([
	"div",
	"section",
	"article",
	"main",
	"header",
	"footer",
	"aside",
	"nav",
	"center",
	"hgroup",
	"address",
	"search",
	"dl",
	"dd",
	"dt",
	"body",
	"html",
	"form",
	"fieldset",
]);

/** Embeds and controls with no Block: leftovers (an iframe of YouTube or Vimeo is a video Block). */
const EMBEDS: ReadonlySet<string> = new Set([
	"iframe",
	"embed",
	"object",
	"video",
	"audio",
	"canvas",
	"svg",
	"math",
	"input",
	"button",
	"select",
	"textarea",
	"map",
	"applet",
	"frameset",
	"frame",
	"picture",
]);

const MARK_OF: Readonly<Record<string, Mark>> = {
	strong: "bold",
	b: "bold",
	em: "italic",
	i: "italic",
	s: "strike",
	del: "strike",
	strike: "strike",
	code: "code",
	kbd: "code",
	samp: "code",
	tt: "code",
};

const BLOCK_LEVEL: ReadonlySet<string> = new Set([
	"p",
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"ul",
	"ol",
	"blockquote",
	"pre",
	"hr",
	"table",
	"figure",
	"details",
	"li",
	...CONTAINERS,
]);

/** A shortcode in text: `[name …]` or `[/name]`. */
const SHORTCODE = /\[\/?[A-Za-z][\w-]*(?:\s[^\]]*)?\]/;

/** What inline content holds, in order: runs of text, and the images and embeds between them. */
type Segment = { runs: Run[] } | { image: Node } | { embed: Node };

type Inline = { marks: readonly Mark[]; link: string | null; preserve: boolean };

/** Reads HTML into a body's Blocks (see the module's comment). */
export function blocksFromHtml(html: string): HtmlBody {
	const reader = new Reader();
	const fragment = parseFragment(html) as unknown as Node;
	reader.blocks(fragment.childNodes ?? [], { loose: true });
	return reader.finish();
}

/** HTML as plain text: each block of it on its own line, scripts and styles left out. */
export function textFromHtml(html: string): string {
	const fragment = parseFragment(html) as unknown as Node;
	return blockText({ nodeName: "div", childNodes: fragment.childNodes ?? [] });
}

/** Whether text holds a shortcode (`[gallery ids="1,2"]`), which no Block reads; null when it holds none. */
export function shortcodeIn(text: string): string | null {
	return SHORTCODE.exec(text)?.[0] ?? null;
}

class Reader {
	private readonly out: Record<string, unknown>[] = [];
	private readonly leftovers: HtmlLeftover[] = [];
	private readonly images: HtmlImage[] = [];
	private characters = 0;

	finish(): HtmlBody {
		const { blocks } = readBody(this.out);
		const kept = new Set(blocks.map((block) => block.id));
		return {
			blocks,
			leftovers: this.leftovers.filter((leftover) => kept.has(leftover.blockId)),
			images: this.images.filter((image) => kept.has(image.blockId)),
		};
	}

	/** Adds a Block, while the body has room for it. */
	private add(block: Record<string, unknown>, text = ""): string | null {
		if (this.out.length >= BODY_LIMITS.blocks || this.characters + text.length > BODY_LIMITS.characters) return null;
		const id = newBlockId();
		this.characters += text.length;
		this.out.push({ id, ...block });
		return id;
	}

	private paragraph(runs: Run[]): void {
		const inline = canonicalInline(trimRuns(runs));
		const text = inlineText(inline);
		if (text.trim() === "") return;
		if (SHORTCODE.test(text)) {
			const shortcode = SHORTCODE.exec(text)?.[0] ?? text;
			this.leftover(text, shortcode);
			return;
		}
		for (const piece of splitRuns(inline, BODY_LIMITS.text))
			this.add({ type: "paragraph", text: piece }, inlineText(piece));
	}

	/** Keeps a piece no Block matches as a plain paragraph, and lists it. */
	private leftover(text: string, markup: string): void {
		const plain = text.trim() === "" ? markup : text.trim();
		for (const piece of splitText(plain, BODY_LIMITS.text)) {
			const blockId = this.add({ type: "paragraph", text: piece }, piece);
			if (blockId) this.leftovers.push({ blockId, text: piece, markup: shorten(markup, 120) });
		}
	}

	private image(node: Node, caption: string | null): void {
		const address = attribute(node, "src")?.trim() ?? "";
		if (!/^https?:\/\//i.test(address)) {
			const alt = attribute(node, "alt")?.trim();
			if (alt) this.leftover(alt, openingTag(node));
			return;
		}
		const blockId = this.add({ type: "image", media: null });
		if (!blockId) return;
		const alt = attribute(node, "alt");
		this.images.push({ blockId, address, alt: alt === null ? null : alt.trim(), caption });
	}

	private embed(node: Node): void {
		const name = node.nodeName;
		const address = attribute(node, "src") ?? attribute(node, "data") ?? "";
		if (name === "iframe" && videoAt(address)) {
			const title = (attribute(node, "title") ?? "").trim().slice(0, BODY_LIMITS.videoTitle);
			this.add({ type: "video", url: videoAt(address)?.watchUrl ?? address, title }, title);
			return;
		}
		this.leftover(collapse(textOf(node)), openingTag(node));
	}

	/** Reads nodes at the level of Blocks; `loose` reads text between them as paragraphs (see above). */
	blocks(nodes: readonly Node[], options: { loose: boolean }): void {
		let pending: Node[] = [];
		const flush = () => {
			if (pending.length === 0) return;
			this.inlineBlocks(pending, options.loose);
			pending = [];
		};
		for (const node of nodes) {
			const name = node.nodeName;
			if (name === "#comment" || DROPPED.has(name)) continue;
			if (!BLOCK_LEVEL.has(name) && !EMBEDS.has(name)) {
				pending.push(node);
				continue;
			}
			flush();
			this.block(node);
		}
		flush();
	}

	/** Inline content standing on its own: paragraphs, with the images and embeds between them. */
	private inlineBlocks(nodes: readonly Node[], loose: boolean): void {
		const segments = this.segments(nodes, { marks: [], link: null, preserve: loose });
		for (const segment of segments) {
			if ("image" in segment) this.image(segment.image, null);
			else if ("embed" in segment) this.embed(segment.embed);
			else if (loose) {
				for (const paragraph of splitParagraphs(segment.runs)) this.paragraph(paragraph);
			} else this.paragraph(segment.runs);
		}
	}

	private block(node: Node): void {
		const name = node.nodeName;
		if (EMBEDS.has(name)) {
			this.embed(node);
			return;
		}
		switch (name) {
			case "p":
				this.inlineBlocks(node.childNodes ?? [], false);
				return;
			case "h1":
			case "h2":
			case "h3":
			case "h4":
			case "h5":
			case "h6": {
				const level = Math.min(4, Math.max(2, Number(name.slice(1)))) as HeadingLevel;
				const segments = this.segments(node.childNodes ?? [], { marks: [], link: null, preserve: false });
				const runs = segments.flatMap((segment) => ("runs" in segment ? segment.runs : []));
				const text = canonicalInline(trimRuns(runs.map((run) => ({ ...run, text: run.text.replace(/\n/g, " ") }))));
				if (inlineText(text).trim() !== "") {
					if (SHORTCODE.test(inlineText(text)))
						this.leftover(inlineText(text), SHORTCODE.exec(inlineText(text))?.[0] ?? "");
					else this.add({ type: "heading", level, text: splitRuns(text, BODY_LIMITS.text)[0] }, inlineText(text));
				}
				for (const segment of segments) {
					if ("image" in segment) this.image(segment.image, null);
					else if ("embed" in segment) this.embed(segment.embed);
				}
				return;
			}
			case "ul":
			case "ol": {
				const counter = { items: 0 };
				const items = this.listItems(node, 1, counter);
				if (items.length > 0) {
					const style: ListStyle = name === "ol" ? "numbered" : "bulleted";
					this.add({ type: "list", style, items }, items.map(itemText).join(""));
				}
				return;
			}
			case "blockquote": {
				const runs = this.flowRuns(node.childNodes ?? []);
				const text = canonicalInline(trimRuns(runs));
				if (inlineText(text).trim() !== "") {
					this.add({ type: "quote", text: splitRuns(text, BODY_LIMITS.text)[0] }, inlineText(text));
				}
				return;
			}
			case "pre": {
				const code = textOf(node).replace(/^\n/, "").slice(0, BODY_LIMITS.code);
				if (code.trim() === "") return;
				const inner = (node.childNodes ?? []).find((child) => child.nodeName === "code");
				const language = languageOf(node) ?? (inner ? languageOf(inner) : null);
				this.add({ type: "code", code, language }, code);
				return;
			}
			case "hr":
				this.add({ type: "divider" });
				return;
			case "table":
				this.table(node);
				return;
			case "figure":
				this.figure(node);
				return;
			case "details": {
				const children = node.childNodes ?? [];
				const summaryNode = children.find((child) => child.nodeName === "summary");
				const summary = canonicalInline(trimRuns(summaryNode ? this.flowRuns(summaryNode.childNodes ?? []) : []));
				const text = canonicalInline(trimRuns(this.flowRuns(children.filter((child) => child !== summaryNode))));
				if (inlineText(summary).trim() !== "" || inlineText(text).trim() !== "") {
					this.add({ type: "toggle", summary, text }, inlineText(summary) + inlineText(text));
				}
				return;
			}
			case "li":
				this.inlineBlocks(node.childNodes ?? [], false);
				return;
			default:
				break;
		}
		if (CONTAINERS.has(name)) {
			if (isLayout(node)) {
				this.leftover(blockText(node), openingTag(node));
				return;
			}
			this.blocks(node.childNodes ?? [], { loose: false });
		}
	}

	private figure(node: Node): void {
		const children = node.childNodes ?? [];
		const captionNode = children.find((child) => child.nodeName === "figcaption");
		const caption = captionNode ? collapse(textOf(captionNode)).trim() || null : null;
		const image = findFirst(node, (child) => child.nodeName === "img");
		const rest = children.filter((child) => child !== captionNode);
		if (image && !findFirst(node, (child) => child.nodeName === "table")) {
			this.image(image, caption);
			// Anything else in the figure (rare) comes after the image.
			const others = rest.filter((child) => !contains(child, image));
			if (others.some((child) => collapse(textOf(child)).trim() !== "")) this.blocks(others, { loose: false });
			return;
		}
		// An embed written as its address alone (a video's page) is a video Block.
		const text = collapse(textOf({ nodeName: "figure", childNodes: rest })).trim();
		if (!findFirst(node, (child) => EMBEDS.has(child.nodeName)) && /^https?:\/\/\S+$/.test(text)) {
			const video = videoAt(text);
			if (video) {
				this.add({ type: "video", url: video.watchUrl, title: caption ?? "" }, caption ?? "");
				return;
			}
		}
		this.blocks(rest, { loose: false });
		if (caption) this.paragraph([{ text: caption }]);
	}

	private table(node: Node): void {
		const rows: Node[] = [];
		const collect = (parent: Node) => {
			for (const child of parent.childNodes ?? []) {
				if (child.nodeName === "tr") rows.push(child);
				else if (["thead", "tbody", "tfoot"].includes(child.nodeName)) collect(child);
			}
		};
		collect(node);
		const cells = rows.map((row) =>
			(row.childNodes ?? [])
				.filter((cell) => cell.nodeName === "td" || cell.nodeName === "th")
				.map((cell) => canonicalInline(trimRuns(this.flowRuns(cell.childNodes ?? [])))),
		);
		const width = Math.max(0, ...cells.map((row) => row.length));
		if (rows.length === 0 || width === 0) return;
		if (rows.length > BODY_LIMITS.tableRows || width > BODY_LIMITS.tableColumns) {
			this.leftover(blockText(node), openingTag(node));
			return;
		}
		const first = rows[0] as Node;
		const headerRow =
			(first.childNodes ?? []).some((cell) => cell.nodeName === "th") ||
			(node.childNodes ?? []).some((child) => child.nodeName === "thead");
		const filled = cells.map((row) => [...row, ...Array.from({ length: width - row.length }, () => [])]);
		this.add({ type: "table", headerRow, rows: filled }, filled.flat().map(inlineText).join(""));
	}

	private listItems(list: Node, depth: number, counter: { items: number }): ListItem[] {
		const items: ListItem[] = [];
		for (const child of list.childNodes ?? []) {
			if (child.nodeName !== "li" || counter.items >= BODY_LIMITS.listItems) continue;
			counter.items++;
			const nested = (child.childNodes ?? []).filter((inner) => inner.nodeName === "ul" || inner.nodeName === "ol");
			const own = (child.childNodes ?? []).filter((inner) => !nested.includes(inner));
			const text = canonicalInline(trimRuns(this.flowRuns(own)));
			const item: ListItem = { text: splitRuns(text, BODY_LIMITS.text)[0] ?? [] };
			const inner = nested.flatMap((sub) =>
				depth < BODY_LIMITS.listDepth
					? this.listItems(sub, depth + 1, counter)
					: // Deeper than lists go: the items' text joins this item's.
						[],
			);
			if (depth >= BODY_LIMITS.listDepth && nested.length > 0) {
				const deeper = nested.map((sub) => collapse(textOf(sub)).trim()).filter(Boolean);
				if (deeper.length > 0) item.text = canonicalInline([...item.text, { text: ` ${deeper.join(" ")}` }]);
			}
			if (inner.length > 0) item.items = inner;
			if (inlineText(item.text).trim() !== "" || inner.length > 0) items.push(item);
		}
		return items;
	}

	/** The text of block content, as one piece of formatted text: blocks joined by line breaks. */
	private flowRuns(nodes: readonly Node[]): Run[] {
		const runs: Run[] = [];
		const separate = () => {
			const last = runs.at(-1);
			if (last && !last.text.endsWith("\n")) runs.push({ text: "\n" });
		};
		for (const node of nodes) {
			if (BLOCK_LEVEL.has(node.nodeName)) {
				separate();
				runs.push(...trimRuns(this.flowRuns(node.childNodes ?? [])));
				separate();
				continue;
			}
			for (const segment of this.segments([node], { marks: [], link: null, preserve: false })) {
				if ("runs" in segment) runs.push(...segment.runs);
			}
		}
		return runs;
	}

	/** Inline content as runs of text, split where an image or an embed stands. */
	private segments(nodes: readonly Node[], inline: Inline): Segment[] {
		const out: Segment[] = [];
		const push = (run: Run) => {
			const last = out.at(-1);
			if (last && "runs" in last) last.runs.push(run);
			else out.push({ runs: [run] });
		};
		const walk = (node: Node, context: Inline) => {
			const name = node.nodeName;
			if (name === "#text") {
				const value = node.value ?? "";
				const text = context.preserve ? value.replace(/\r\n?/g, "\n").replace(/[ \t\f]+/g, " ") : collapse(value);
				push({
					text,
					...(context.marks.length > 0 ? { marks: [...context.marks] } : {}),
					...(context.link ? { link: context.link } : {}),
				});
				return;
			}
			if (name === "#comment" || DROPPED.has(name)) return;
			if (name === "br") {
				push({ text: "\n" });
				return;
			}
			if (name === "img") {
				out.push({ image: node });
				return;
			}
			if (EMBEDS.has(name)) {
				out.push({ embed: node });
				return;
			}
			let next = context;
			const mark = MARK_OF[name];
			if (mark) next = { ...context, marks: [...context.marks, mark] };
			else if (name === "a") {
				const href = (attribute(node, "href") ?? "").trim();
				next = { ...context, link: href !== "" && href.length <= LINK_MAX_LENGTH && isSafeLink(href) ? href : null };
			}
			// Any other element inside text (a span, an underline) keeps its text as it stands.
			for (const child of node.childNodes ?? []) walk(child, next);
		};
		for (const node of nodes) walk(node, inline);
		return out;
	}
}

/** Containers laying content out (a container holding a container that holds elements): page-builder layout. */
function isLayout(node: Node): boolean {
	return (node.childNodes ?? []).some(
		(child) =>
			CONTAINERS.has(child.nodeName) &&
			(child.childNodes ?? []).some((inner) => inner.nodeName !== "#text" && inner.nodeName !== "#comment"),
	);
}

function attribute(node: Node, name: string): string | null {
	return node.attrs?.find((attr) => attr.name === name)?.value ?? null;
}

/** An element's opening tag, as a leftover names it: its name and attributes, shortened. */
function openingTag(node: Node): string {
	const attrs = (node.attrs ?? [])
		.filter((attr) => !/^on/i.test(attr.name) && attr.name !== "style")
		.map((attr) => `${attr.name}="${attr.value}"`)
		.join(" ");
	return shorten(`<${node.nodeName}${attrs ? ` ${attrs}` : ""}>`, 120);
}

function shorten(text: string, length: number): string {
	return text.length > length ? `${text.slice(0, length - 1)}…` : text;
}

function textOf(node: Node): string {
	if (node.nodeName === "#text") return node.value ?? "";
	if (DROPPED.has(node.nodeName) || node.nodeName === "#comment") return "";
	if (node.nodeName === "br") return "\n";
	return (node.childNodes ?? []).map(textOf).join("");
}

/** A block's text with its parts on their own lines (a leftover's plain text). */
function blockText(node: Node): string {
	const lines: string[] = [];
	let line = "";
	const walk = (current: Node) => {
		const name = current.nodeName;
		if (name === "#text") {
			line += collapse(current.value ?? "");
			return;
		}
		if (name === "#comment" || DROPPED.has(name)) return;
		if (name === "br") {
			lines.push(line);
			line = "";
			return;
		}
		const block = BLOCK_LEVEL.has(name) || name === "tr" || name === "td" || name === "th";
		if (block && line.trim() !== "") {
			lines.push(line);
			line = "";
		}
		for (const child of current.childNodes ?? []) walk(child);
		if (block && line.trim() !== "") {
			lines.push(line);
			line = "";
		}
	};
	walk(node);
	if (line.trim() !== "") lines.push(line);
	return lines
		.map((each) => each.trim())
		.filter(Boolean)
		.join("\n");
}

function collapse(text: string): string {
	return text.replace(/[ \t\n\r\f]+/g, " ");
}

/** Runs without the spaces and line breaks at their two ends. */
function trimRuns(runs: readonly Run[]): Run[] {
	const out = runs.map((run) => ({ ...run }));
	while (out.length > 0 && (out[0] as Run).text.replace(/^[\s]+/, "") === "") out.shift();
	while (out.length > 0 && (out.at(-1) as Run).text.replace(/[\s]+$/, "") === "") out.pop();
	if (out[0]) out[0].text = out[0].text.replace(/^\s+/, "");
	const last = out.at(-1);
	if (last) last.text = last.text.replace(/\s+$/, "");
	// Spaces around a line break are the HTML's layout, not text.
	for (const run of out) run.text = run.text.replace(/ *\n */g, "\n");
	return out;
}

/** Loose text's paragraphs: a blank line starts a new one. */
function splitParagraphs(runs: readonly Run[]): Run[][] {
	const paragraphs: Run[][] = [[]];
	for (const run of runs) {
		const parts = run.text.split(/\n[ \t]*\n\s*/);
		parts.forEach((part, index) => {
			if (index > 0) paragraphs.push([]);
			if (part !== "") (paragraphs.at(-1) as Run[]).push({ ...run, text: part });
		});
	}
	return paragraphs.filter((paragraph) => inlineText(paragraph).trim() !== "");
}

/** Formatted text cut into pieces of at most `length` characters. */
function splitRuns(runs: readonly Run[], length: number): Run[][] {
	const pieces: Run[][] = [[]];
	let size = 0;
	for (const run of runs) {
		let rest = run.text;
		while (rest.length > 0) {
			const room = length - size;
			if (room <= 0) {
				pieces.push([]);
				size = 0;
				continue;
			}
			const part = rest.slice(0, room);
			(pieces.at(-1) as Run[]).push({ ...run, text: part });
			size += part.length;
			rest = rest.slice(part.length);
		}
	}
	return pieces.filter((piece) => piece.length > 0).map((piece) => canonicalInline(piece));
}

function splitText(text: string, length: number): string[] {
	const pieces: string[] = [];
	for (let start = 0; start < text.length; start += length) pieces.push(text.slice(start, start + length));
	return pieces.length > 0 ? pieces : [""];
}

function itemText(item: ListItem): string {
	return inlineText(item.text) + (item.items ?? []).map(itemText).join("");
}

function languageOf(node: Node): string | null {
	const classes = attribute(node, "class") ?? "";
	const match = /(?:^|\s)(?:language|lang)-([A-Za-z0-9+#_-]{1,30})(?:\s|$)/.exec(classes);
	return match?.[1]?.toLowerCase() ?? null;
}

function findFirst(node: Node, test: (node: Node) => boolean): Node | null {
	for (const child of node.childNodes ?? []) {
		if (test(child)) return child;
		const found = findFirst(child, test);
		if (found) return found;
	}
	return null;
}

function contains(node: Node, target: Node): boolean {
	return node === target || (node.childNodes ?? []).some((child) => contains(child, target));
}
