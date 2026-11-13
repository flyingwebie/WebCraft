/**
 * Rich text: short formatted text people write in a rich text Field, kept as HTML. Everything that
 * comes in is cleaned against an allowlist, on save and again on render (ADR 0017), so only these
 * elements and attributes ever reach a page.
 *
 * Cleaning parses the HTML the way browsers do (parse5, the HTML standard's parsing algorithm, in a
 * `<div>`'s context), walks the result keeping only allowed elements and attributes, and writes it
 * out again with WebCraft's own escaping. Nothing is matched with regular expressions, and the
 * output is the cleaner's own, so what a browser reads is exactly what was kept.
 */
import { defaultTreeAdapter, html as parse5Html, parseFragment } from "parse5";

import { escapeAttribute, escapeText, safeUrl } from "./escape.ts";
import { type RichTextPieces, richTextPieces } from "./translation.ts";

/** Elements rich text keeps, with the attributes each may have. */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
	p: [],
	br: [],
	strong: [],
	b: [],
	em: [],
	i: [],
	u: [],
	s: [],
	sub: [],
	sup: [],
	code: [],
	mark: [],
	small: [],
	a: ["href", "title"],
	ul: [],
	ol: [],
	li: [],
	blockquote: [],
};

/** Elements dropped with everything inside them; any other element not allowed keeps its text. */
const DROPPED_WITH_CONTENT: ReadonlySet<string> = new Set([
	"script",
	"style",
	"template",
	"noscript",
	"noembed",
	"noframes",
	"iframe",
	"object",
	"embed",
	"svg",
	"math",
	"textarea",
	"title",
	"select",
	"option",
	"head",
	"xmp",
	"plaintext",
	"canvas",
	"audio",
	"video",
	"picture",
	"img",
	"source",
	"track",
	"button",
	"input",
	"form",
	"frameset",
	"frame",
	"applet",
]);

const VOID: ReadonlySet<string> = new Set(["br"]);

/** The longest rich text value, in characters of cleaned HTML. */
export const RICH_TEXT_MAX_LENGTH = 20_000;

type Parse5Node = {
	nodeName: string;
	tagName?: string;
	namespaceURI?: string;
	value?: string;
	attrs?: { name: string; value: string }[];
	childNodes?: Parse5Node[];
};

function parse(html: string): Parse5Node[] {
	const context = defaultTreeAdapter.createElement("div", parse5Html.NS.HTML, []);
	return (parseFragment(context, html, {}) as unknown as Parse5Node).childNodes ?? [];
}

/**
 * Cleans rich text: keeps the allowed elements (paragraphs, line breaks, emphasis, links, lists,
 * quotes, code) and their allowed attributes, keeps the text of other elements, and drops scripts,
 * styles, embeds, comments and everything else. Link addresses keep only safe schemes. Cleaning
 * clean rich text gives it back unchanged.
 */
export function cleanRichText(html: string): string {
	return writeNodes(parse(html));
}

function writeNodes(nodes: readonly Parse5Node[]): string {
	let out = "";
	for (const node of nodes) out += writeNode(node);
	return out;
}

function writeNode(node: Parse5Node): string {
	if (node.nodeName === "#text") return escapeText(node.value ?? "");
	if (!node.tagName) return ""; // comments, doctypes
	const tag = node.tagName;
	if (node.namespaceURI !== parse5Html.NS.HTML || DROPPED_WITH_CONTENT.has(tag)) return "";
	const allowed = ALLOWED[tag];
	const children = writeNodes(node.childNodes ?? []);
	if (!allowed) return children;
	let attributes = "";
	for (const name of allowed) {
		const attribute = node.attrs?.find((candidate) => candidate.name === name);
		if (!attribute) continue;
		const value = name === "href" ? safeUrl(attribute.value) : attribute.value;
		attributes += ` ${name}="${escapeAttribute(value)}"`;
	}
	if (VOID.has(tag)) return `<${tag}${attributes}>`;
	return `<${tag}${attributes}>${children}</${tag}>`;
}

/** The text of rich text, without its markup, as it reads on a page. */
export function richTextToText(html: string): string {
	const collect = (nodes: readonly Parse5Node[]): string =>
		nodes
			.map((node) => {
				if (node.nodeName === "#text") return node.value ?? "";
				if (!node.tagName || DROPPED_WITH_CONTENT.has(node.tagName)) return "";
				if (node.tagName === "br") return "\n";
				return collect(node.childNodes ?? []);
			})
			.join("");
	return collect(parse(html));
}

/**
 * Rich text as AI translation sends it: one piece of text per paragraph, its emphasis, links and line
 * breaks as markers, and how to put a translation back together (clean it again afterwards).
 */
export function richTextTranslation(html: string): RichTextPieces {
	return richTextPieces(parse(html));
}
