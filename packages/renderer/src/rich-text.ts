/**
 * Rich text: short formatted text (a rich text Field), kept as HTML and cleaned against an allowlist
 * when it is saved and again when it is rendered. Cleaning never passes input through: it reads the
 * HTML into tags and text and writes a new document holding only the allowed elements, with every
 * piece of text escaped, so whatever the input, the output can't carry a script, an event handler,
 * a style or an unsafe link. Long-form text is a Body field instead, stored as Blocks (ADR 0018).
 */
import { safeUrl } from "./urls.ts";

/** The elements rich text may hold. `a` keeps its `href` when it is a safe URL; nothing keeps any other attribute. */
export const RICH_TEXT_ELEMENTS: ReadonlySet<string> = new Set([
	"p",
	"br",
	"strong",
	"b",
	"em",
	"i",
	"u",
	"s",
	"sub",
	"sup",
	"code",
	"a",
	"ul",
	"ol",
	"li",
	"blockquote",
]);

/** Elements that end an open paragraph when they start, as in HTML. */
const BLOCKS: ReadonlySet<string> = new Set(["p", "ul", "ol", "li", "blockquote"]);

/** Elements whose content is text up to their end tag, never markup. */
const RAW_TEXT: ReadonlySet<string> = new Set([
	"script",
	"style",
	"textarea",
	"title",
	"xmp",
	"iframe",
	"noembed",
	"noframes",
	"noscript",
	"plaintext",
]);

/** Elements dropped with everything inside them, not just their tags. */
const DROPPED_WITH_CONTENT: ReadonlySet<string> = new Set([
	...RAW_TEXT,
	"template",
	"object",
	"svg",
	"math",
	"select",
	"head",
	"button",
]);

type Token =
	| { type: "text"; text: string }
	| { type: "start"; name: string; attributes: Map<string, string> }
	| { type: "end"; name: string };

/**
 * Cleans rich text: keeps the allowed elements (`RICH_TEXT_ELEMENTS`) without attributes, except a
 * link's safe `href`; drops other elements but keeps their text, and drops scripts, styles, frames
 * and the like with their content. Unclosed elements are closed. A link to an unsafe URL loses its
 * link and keeps its text.
 */
export function cleanRichText(html: string): string {
	let out = "";
	/** The open elements, innermost last; a link written without its tag has `written: false`. */
	const open: { name: string; written: boolean }[] = [];
	let dropping: { name: string; depth: number } | undefined;

	const close = (index: number) => {
		while (open.length > index) {
			const element = open.pop();
			if (element?.written) out += `</${element.name}>`;
		}
	};
	const lastIndexOf = (name: string, stopAt?: ReadonlySet<string>) => {
		for (let index = open.length - 1; index >= 0; index--) {
			const element = open[index]?.name;
			if (element === name) return index;
			if (stopAt?.has(element ?? "")) return -1;
		}
		return -1;
	};

	for (const token of tokenize(html)) {
		if (dropping) {
			if (token.type === "start" && token.name === dropping.name) dropping.depth++;
			if (token.type === "end" && token.name === dropping.name && --dropping.depth === 0) dropping = undefined;
			continue;
		}
		if (token.type === "text") {
			out += escapeHtml(token.text);
			continue;
		}
		if (token.type === "start") {
			if (DROPPED_WITH_CONTENT.has(token.name)) {
				if (!RAW_TEXT.has(token.name)) dropping = { name: token.name, depth: 1 };
				continue;
			}
			if (!RICH_TEXT_ELEMENTS.has(token.name)) continue;
			if (token.name === "br") {
				out += "<br>";
				continue;
			}
			if (BLOCKS.has(token.name)) {
				const paragraph = lastIndexOf("p");
				if (paragraph !== -1) close(paragraph);
			}
			if (token.name === "li") {
				const item = lastIndexOf("li", new Set(["ul", "ol"]));
				if (item !== -1) close(item);
			}
			if (token.name === "a") {
				const link = lastIndexOf("a");
				if (link !== -1) close(link);
				const href = token.attributes.get("href")?.trim();
				const safe = href !== undefined && href !== "" && (safeUrl(href) !== "#" || href === "#");
				if (safe) out += `<a href="${escapeHtml(href).replaceAll('"', "&quot;")}">`;
				open.push({ name: "a", written: safe });
				continue;
			}
			out += `<${token.name}>`;
			open.push({ name: token.name, written: true });
			continue;
		}
		const index = lastIndexOf(token.name);
		if (index !== -1) close(index);
	}
	close(0);
	return out;
}

/**
 * The text of rich text, as people read it: tags dropped, blocks and line breaks becoming spaces,
 * runs of whitespace collapsed. Used where rich text lands in an attribute, and to count its length.
 */
export function richTextToText(html: string): string {
	let text = "";
	let dropping: { name: string; depth: number } | undefined;
	for (const token of tokenize(html)) {
		if (dropping) {
			if (token.type === "start" && token.name === dropping.name) dropping.depth++;
			if (token.type === "end" && token.name === dropping.name && --dropping.depth === 0) dropping = undefined;
			continue;
		}
		if (token.type === "text") text += token.text;
		else if (token.type === "start" && DROPPED_WITH_CONTENT.has(token.name)) {
			if (!RAW_TEXT.has(token.name)) dropping = { name: token.name, depth: 1 };
		} else if (BLOCKS.has(token.name) || token.name === "br") text += " ";
	}
	return text.replace(/\s+/g, " ").trim();
}

function escapeHtml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Reads HTML into start tags, end tags and text (with character references decoded), the way a
 * browser's tokenizer splits it. Comments, doctypes and processing instructions are dropped, and the
 * content of raw text elements such as `<script>` is skipped up to their end tag.
 */
function* tokenize(html: string): Generator<Token> {
	let index = 0;
	let text = "";
	const flush = function* (): Generator<Token> {
		if (text) yield { type: "text", text: decodeEntities(text) };
		text = "";
	};
	while (index < html.length) {
		const lt = html.indexOf("<", index);
		if (lt === -1) {
			text += html.slice(index);
			break;
		}
		text += html.slice(index, lt);
		const next = html[lt + 1] ?? "";
		if (html.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt + 4);
			index = end === -1 ? html.length : end + 3;
			continue;
		}
		if (next === "!" || next === "?") {
			const end = html.indexOf(">", lt + 2);
			index = end === -1 ? html.length : end + 1;
			continue;
		}
		if (next === "/" && /[A-Za-z]/.test(html[lt + 2] ?? "")) {
			yield* flush();
			const name = /^[^\s/>]+/.exec(html.slice(lt + 2))?.[0] ?? "";
			const end = html.indexOf(">", lt + 2 + name.length);
			index = end === -1 ? html.length : end + 1;
			yield { type: "end", name: name.toLowerCase() };
			continue;
		}
		if (/[A-Za-z]/.test(next)) {
			yield* flush();
			const tag = readStartTag(html, lt + 1);
			index = tag.end;
			yield { type: "start", name: tag.name, attributes: tag.attributes };
			if (RAW_TEXT.has(tag.name)) {
				if (tag.name === "plaintext") return;
				const closing = new RegExp(`</${tag.name}(?=[\\s/>])`, "i").exec(html.slice(index));
				if (!closing) return;
				const end = html.indexOf(">", index + closing.index);
				index = end === -1 ? html.length : end + 1;
				yield { type: "end", name: tag.name };
			}
			continue;
		}
		text += "<";
		index = lt + 1;
	}
	yield* flush();
}

/** Reads a start tag from just after its `<`: its name, its attributes, and where it ends. */
function readStartTag(html: string, start: number): { name: string; attributes: Map<string, string>; end: number } {
	const name = /^[^\s/>]+/.exec(html.slice(start))?.[0] ?? "";
	const attributes = new Map<string, string>();
	let index = start + name.length;
	while (index < html.length) {
		while (/[\s/]/.test(html[index] ?? "")) index++;
		if (index >= html.length) break;
		if (html[index] === ">") return { name: name.toLowerCase(), attributes, end: index + 1 };
		const attributeName = /^[^\s"'>/=]+/.exec(html.slice(index))?.[0] ?? html[index] ?? "";
		index += attributeName.length;
		while (/\s/.test(html[index] ?? "")) index++;
		let value = "";
		if (html[index] === "=") {
			index++;
			while (/\s/.test(html[index] ?? "")) index++;
			const quote = html[index];
			if (quote === '"' || quote === "'") {
				const end = html.indexOf(quote, index + 1);
				value = html.slice(index + 1, end === -1 ? html.length : end);
				index = end === -1 ? html.length : end + 1;
			} else {
				value = /^[^\s>]*/.exec(html.slice(index))?.[0] ?? "";
				index += value.length;
			}
		}
		const key = attributeName.toLowerCase();
		if (!attributes.has(key)) attributes.set(key, decodeEntities(value));
	}
	return { name: name.toLowerCase(), attributes, end: html.length };
}

/** The named character references people's editors write; others stay as written. */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	copy: "©",
	reg: "®",
	trade: "™",
	hellip: "…",
	mdash: "—",
	ndash: "–",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	laquo: "«",
	raquo: "»",
	euro: "€",
	pound: "£",
	deg: "°",
	times: "×",
	middot: "·",
	bull: "•",
};

function decodeEntities(text: string): string {
	return text.replace(
		/&(#[0-9]{1,8}|#[xX][0-9a-fA-F]{1,7}|[A-Za-z][A-Za-z0-9]{1,31});?/g,
		(match, reference: string) => {
			if (reference.startsWith("#")) {
				const code =
					reference[1] === "x" || reference[1] === "X"
						? Number.parseInt(reference.slice(2), 16)
						: Number.parseInt(reference.slice(1), 10);
				const valid = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff);
				return valid ? String.fromCodePoint(code) : "�";
			}
			return NAMED_ENTITIES[reference] ?? match;
		},
	);
}
