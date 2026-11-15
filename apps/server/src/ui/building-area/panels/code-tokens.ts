import { type CssTokenKind, cssLines } from "../../editor/css-tokens.ts";

/**
 * The code panes' highlighting (BA-11): Template markup, CSS and JavaScript split into pieces of the
 * kinds the CSS highlighter already draws, so every code box on the chrome uses one palette. Joined,
 * a line's pieces are the line exactly.
 *
 * - Markup: tags (`keyword`), a Component's tag (`selector`), attribute names (`property`), quoted
 *   values (`string`), values and Template commands (`{{ … }}`, `{{@ … }}`: `variable`), comments.
 * - JavaScript: keywords, strings and template literals, comments, numbers.
 */

export type CodeLanguage = "html" | "css" | "js";
export type Piece = [CssTokenKind, string];

const JS_KEYWORDS = new Set(
	"const let var function return if else for while do switch case break continue new class extends import export from async await try catch finally throw typeof instanceof in of this null undefined true false default delete void yield".split(
		" ",
	),
);

/** Template markup in pieces. */
export function markupTokens(text: string): Piece[] {
	const pieces: Piece[] = [];
	const pattern =
		/<!--[\s\S]*?(?:-->|$)|\{\{[\s\S]*?(?:\}\}|$)|<\/?[A-Za-z][\w.-]*|\/?>|"[^"]*"?|'[^']*'?|[^<{"'>/]+|[\s\S]/g;
	let inTag = false;
	for (const match of text.matchAll(pattern)) {
		const part = match[0];
		if (part.startsWith("<!--")) pieces.push(["comment", part]);
		else if (part.startsWith("{{")) pieces.push(["variable", part]);
		else if (/^<\/?[A-Za-z]/.test(part)) {
			inTag = true;
			const name = part.replace(/^<\/?/, "");
			pieces.push([/^[A-Z]/.test(name) ? "selector" : "keyword", part]);
		} else if (part === ">" || part === "/>") {
			pieces.push([inTag ? "keyword" : "", part]);
			inTag = false;
		} else if (inTag && (part.startsWith('"') || part.startsWith("'"))) pieces.push(["string", part]);
		else if (inTag) {
			// Attribute names in a tag; `=` and spaces plain.
			for (const bit of part.matchAll(/[^\s=]+|[\s=]+/g))
				pieces.push([/^[^\s=]/.test(bit[0]) ? "property" : "", bit[0]]);
		} else pieces.push(["", part]);
	}
	return pieces;
}

/** JavaScript in pieces. */
export function jsTokens(text: string): Piece[] {
	const pieces: Piece[] = [];
	const pattern =
		/\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\.|[^"\\\n])*"?|'(?:\\.|[^'\\\n])*'?|`(?:\\.|[^`\\])*`?|\b\d+(?:\.\d+)?\b|[A-Za-z_$][\w$]*|[\s\S]/g;
	for (const match of text.matchAll(pattern)) {
		const part = match[0];
		if (part.startsWith("//") || part.startsWith("/*")) pieces.push(["comment", part]);
		else if (/^["'`]/.test(part)) pieces.push(["string", part]);
		else if (/^\d/.test(part)) pieces.push(["number", part]);
		else if (JS_KEYWORDS.has(part)) pieces.push(["keyword", part]);
		else pieces.push(["", part]);
	}
	return pieces;
}

/** Pieces split at their line breaks: one list per line. */
function byLine(pieces: readonly Piece[]): Piece[][] {
	const lines: Piece[][] = [[]];
	for (const [kind, part] of pieces) {
		const bits = part.split("\n");
		bits.forEach((bit, index) => {
			if (index > 0) lines.push([]);
			if (bit) lines[lines.length - 1]?.push([kind, bit]);
		});
	}
	return lines;
}

/** Each line of a box's text in highlighted pieces. */
export function codeLines(language: CodeLanguage, text: string): Piece[][] {
	if (language === "css") return cssLines(text);
	return byLine(language === "html" ? markupTokens(text) : jsTokens(text));
}
