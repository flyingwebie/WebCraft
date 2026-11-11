/** What a piece of CSS is, for highlighting: "" for plain text. */
export type CssTokenKind = "" | "comment" | "string" | "keyword" | "variable" | "number" | "property" | "selector";

/**
 * CSS split into highlighted pieces, as Code mode's editors split Template markup and JavaScript:
 * comments, strings, at-rules, custom properties, numbers, property names (before a `:` that isn't a
 * selector's) and selectors (`.class`, `&…`). Joined, the pieces are the text exactly.
 */
export function cssTokens(text: string): [CssTokenKind, string][] {
	const tokens: [CssTokenKind, string][] = [];
	const pattern =
		/\/\*[\s\S]*?(?:\*\/|$)|"[^"\n]*"?|'[^'\n]*'?|@[\w-]+|--[\w-]+|#[0-9a-fA-F]{3,8}\b|-?\d*\.?\d+(?:[a-z%]+)?|[\w-]+(?=\s*:(?![^{;}]*\{))|[{};:()]|[^\s"'/@#{};:()\d-]+|\s+|[\s\S]/g;
	for (const match of text.matchAll(pattern)) {
		const part = match[0];
		if (part.startsWith("/*")) tokens.push(["comment", part]);
		else if (part.startsWith('"') || part.startsWith("'")) tokens.push(["string", part]);
		else if (part.startsWith("@")) tokens.push(["keyword", part]);
		else if (part.startsWith("--")) tokens.push(["variable", part]);
		else if (/^(#|-?\d|-?\.\d)/.test(part)) tokens.push(["number", part]);
		else if (/^[\w-]+$/.test(part) && /^\s*:(?![^{;}]*\{)/.test(text.slice((match.index ?? 0) + part.length))) {
			tokens.push(["property", part]);
		} else if (/^[.&:][\w-]*/.test(part) || /^[\w-]+$/.test(part))
			tokens.push([part.startsWith(".") || part.startsWith("&") ? "selector" : "", part]);
		else tokens.push(["", part]);
	}
	return tokens;
}

/** The highlighted pieces of each line, in order: a piece spanning lines is split at its line breaks. */
export function cssLines(text: string): [CssTokenKind, string][][] {
	const lines: [CssTokenKind, string][][] = [[]];
	for (const [kind, part] of cssTokens(text)) {
		for (const [index, piece] of part.split("\n").entries()) {
			if (index > 0) lines.push([]);
			if (piece) lines[lines.length - 1]?.push([kind, piece]);
		}
	}
	return lines;
}
