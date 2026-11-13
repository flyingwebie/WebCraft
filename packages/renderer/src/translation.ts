/**
 * Text as AI translation sends it: only text, never markup, addresses or ids. Formatted text (a
 * Block's runs, rich text's inline elements) becomes one piece per paragraph, with numbered markers
 * where its formatting goes (`Bake at ⟦1⟧220 °C⟦/1⟧ today`, `⟦B1⟧` for a line break), and comes back
 * from the translated piece with the same formatting, links and attributes, which never leave.
 *
 * A translated piece must hold exactly the markers sent (`sameMarkers`); anything else is refused.
 */

import { canonicalInline, type InlineText, type Run } from "./body/inline.ts";
import { escapeAttribute, escapeText, safeUrl } from "./escape.ts";

/** One marker: `⟦1⟧`, `⟦/1⟧`, `⟦B1⟧` (a line break) or `⟦T1⟧` (a Protected term). */
export const MARKER = /⟦(\/?)([BT]?)(\d{1,4})⟧/g;

/** The markers of a piece, sorted: what a translation of it must hold, no more and no less. */
export function markersOf(piece: string): string[] {
	return [...piece.matchAll(MARKER)].map((match) => match[0]).sort();
}

/** Whether a translation holds exactly the markers of the piece it translates. */
export function sameMarkers(piece: string, translation: string): boolean {
	const sent = markersOf(piece);
	const answered = markersOf(translation);
	return sent.length === answered.length && sent.every((marker, index) => marker === answered[index]);
}

/** A translation that can't be put back: its markers don't fit what was sent. */
export class TranslationMarkersError extends Error {
	override name = "TranslationMarkersError";
	constructor() {
		super("The translation dropped, added or changed a marker.");
	}
}

/** Text with markers, read into its pieces: plain text, opening and closing marks, line breaks. */
type Token = { kind: "text"; text: string } | { kind: "open" | "close" | "break"; n: number };

function tokens(piece: string): Token[] {
	const out: Token[] = [];
	let last = 0;
	for (const match of piece.matchAll(MARKER)) {
		const index = match.index ?? 0;
		if (index > last) out.push({ kind: "text", text: piece.slice(last, index) });
		const n = Number(match[3]);
		if (match[2] === "B") out.push({ kind: "break", n });
		else if (match[2] === "T") out.push({ kind: "text", text: match[0] });
		else out.push({ kind: match[1] ? "close" : "open", n });
		last = index + match[0].length;
	}
	if (last < piece.length) out.push({ kind: "text", text: piece.slice(last) });
	return out;
}

// ---------------------------------------------------------------------------------------------------
// A Block's formatted text

/** A piece of formatted text, and how to read its translation back into runs. */
export type InlinePiece = { piece: string; read(translation: string): InlineText };

/**
 * Formatted text as one piece: runs with marks or a link inside numbered markers, plain runs as they
 * are. Reading a translation back keeps each run's marks and link; markers out of place are refused.
 */
export function inlinePiece(text: InlineText): InlinePiece {
	const formats = new Map<number, Omit<Run, "text">>();
	let piece = "";
	for (const run of text) {
		if (!run.marks?.length && !run.link) {
			piece += run.text;
			continue;
		}
		const n = formats.size + 1;
		const { text: inner, ...format } = run;
		formats.set(n, format);
		piece += `⟦${n}⟧${inner}⟦/${n}⟧`;
	}
	return {
		piece,
		read(translation) {
			if (!sameMarkers(piece, translation)) throw new TranslationMarkersError();
			const runs: Run[] = [];
			let open: number | null = null;
			for (const token of tokens(translation)) {
				if (token.kind === "text")
					runs.push(open === null ? { text: token.text } : { text: token.text, ...formats.get(open) });
				else if (token.kind === "open" && open === null && formats.has(token.n)) open = token.n;
				else if (token.kind === "close" && open === token.n) open = null;
				else throw new TranslationMarkersError();
			}
			if (open !== null) throw new TranslationMarkersError();
			return canonicalInline(runs);
		},
	};
}

// ---------------------------------------------------------------------------------------------------
// Rich text

/** The pieces of rich text to translate, and how to put its translation back together. */
export type RichTextPieces = { pieces: string[]; rebuild(translations: readonly string[]): string };

type Node = {
	nodeName: string;
	tagName?: string;
	value?: string;
	attrs?: { name: string; value: string }[];
	childNodes?: Node[];
};

/** Elements that hold paragraphs of their own; everything else inside them is inline. */
const BLOCKS = new Set(["p", "ul", "ol", "li", "blockquote"]);

type Part = { kind: "block"; node: Node; children: Part[] } | { kind: "run"; nodes: Node[]; piece: number | null };

/**
 * Rich text (cleaned HTML, see `rich-text.ts`) as pieces: each paragraph's inline content (its text,
 * with its emphasis, links and line breaks as markers) is one piece; the elements around them and
 * every attribute stay behind. `parse` reads the HTML the way the cleaner does.
 */
export function richTextPieces(nodes: readonly Node[]): RichTextPieces {
	const pieces: string[] = [];
	const marks: Map<number, Node>[] = [];
	const encode = (run: readonly Node[], found: Map<number, Node>): string =>
		run
			.map((node) => {
				if (node.nodeName === "#text") return node.value ?? "";
				if (!node.tagName) return "";
				const n = found.size + 1;
				found.set(n, node);
				if (node.tagName === "br") return `⟦B${n}⟧`;
				return `⟦${n}⟧${encode(node.childNodes ?? [], found)}⟦/${n}⟧`;
			})
			.join("");
	const parts = (children: readonly Node[]): Part[] => {
		const out: Part[] = [];
		let run: Node[] = [];
		const flush = () => {
			if (run.length === 0) return;
			const found = new Map<number, Node>();
			const piece = encode(run, found);
			if (piece.replace(MARKER, "").trim() === "") {
				out.push({ kind: "run", nodes: run, piece: null });
			} else {
				out.push({ kind: "run", nodes: run, piece: pieces.length });
				pieces.push(piece);
				marks.push(found);
			}
			run = [];
		};
		for (const node of children) {
			if (node.tagName && BLOCKS.has(node.tagName)) {
				flush();
				out.push({ kind: "block", node, children: parts(node.childNodes ?? []) });
			} else if (node.nodeName === "#text" || node.tagName) {
				run.push(node);
			}
		}
		flush();
		return out;
	};
	const structure = parts(nodes);
	return {
		pieces,
		rebuild(translations) {
			const write = (part: Part): string => {
				if (part.kind === "block") {
					const tag = part.node.tagName ?? "p";
					return `<${tag}${attributes(part.node)}>${part.children.map(write).join("")}</${tag}>`;
				}
				if (part.piece === null) return part.nodes.map(original).join("");
				const translation = translations[part.piece];
				const found = marks[part.piece];
				const piece = pieces[part.piece] ?? "";
				if (translation === undefined || !found || !sameMarkers(piece, translation)) {
					throw new TranslationMarkersError();
				}
				return markedHtml(translation, found);
			};
			return structure.map(write).join("");
		},
	};
}

/** The attributes of an element as the cleaner keeps them (an `href` only with a safe address). */
function attributes(node: Node): string {
	return (node.attrs ?? [])
		.map(({ name, value }) => ` ${name}="${escapeAttribute(name === "href" ? safeUrl(value) : value)}"`)
		.join("");
}

function original(node: Node): string {
	if (node.nodeName === "#text") return escapeText(node.value ?? "");
	if (!node.tagName) return "";
	if (node.tagName === "br") return "<br>";
	return `<${node.tagName}${attributes(node)}>${(node.childNodes ?? []).map(original).join("")}</${node.tagName}>`;
}

/** A translated piece as HTML, each marker back as the element it stood for; markers out of place are refused. */
function markedHtml(translation: string, found: ReadonlyMap<number, Node>): string {
	const open: number[] = [];
	let html = "";
	for (const token of tokens(translation)) {
		if (token.kind === "text") {
			html += escapeText(token.text);
			continue;
		}
		const node = found.get(token.n);
		if (!node?.tagName) throw new TranslationMarkersError();
		if (token.kind === "break") {
			if (node.tagName !== "br") throw new TranslationMarkersError();
			html += "<br>";
		} else if (token.kind === "open") {
			open.push(token.n);
			html += `<${node.tagName}${attributes(node)}>`;
		} else {
			if (open.pop() !== token.n) throw new TranslationMarkersError();
			html += `</${node.tagName}>`;
		}
	}
	if (open.length > 0) throw new TranslationMarkersError();
	return html;
}
