/**
 * Inline styles in Template markup (`style="color: red"`). Sites never send inline styles (ADR 0009,
 * ADR 0023): the declarations become a generated Class instead. This reads the declarations strictly
 * and answers them in one canonical form, `color: red; margin: 0 auto;`, so the same style always
 * finds the same Class.
 */
import { safeUrl } from "../escape.ts";

const PROPERTY = /^(?:--[A-Za-z0-9_-]+|-?[A-Za-z][A-Za-z0-9-]*)$/;

/** Words that only ever meant script in CSS. */
const SCRIPT_IN_CSS = /expression\s*\(|javascript:|vbscript:|-moz-binding|behavior\s*:/i;

/**
 * Reads an inline style's declarations. Answers them in canonical form (empty for a style with
 * none), or why they can't become a Class.
 */
export function readInlineStyle(style: string): { declarations: string } | { problem: string } {
	const declarations: string[] = [];
	for (const declaration of splitOutside(style, ";")) {
		if (!declaration.trim()) continue;
		const colon = declaration.indexOf(":");
		if (colon < 0) return { problem: `${declaration.trim()} isn't a CSS declaration: write property: value.` };
		const rawProperty = declaration.slice(0, colon).trim();
		const value = declaration.slice(colon + 1).trim();
		if (!PROPERTY.test(rawProperty)) return { problem: `${rawProperty} isn't a CSS property name.` };
		if (!value) return { problem: `${rawProperty} has no value.` };
		if (/[{}<>\\]/.test(value)) return { problem: `The value of ${rawProperty} can't hold {, }, <, > or \\.` };
		if (SCRIPT_IN_CSS.test(value)) return { problem: `The value of ${rawProperty} isn't allowed.` };
		const unsafeUrl = urlsIn(value).find((url) => safeUrl(url) !== url);
		if (unsafeUrl !== undefined) return { problem: `${unsafeUrl} isn't an address a style may use.` };
		const property = rawProperty.startsWith("--") ? rawProperty : rawProperty.toLowerCase();
		declarations.push(`${property}: ${value};`);
	}
	return { declarations: declarations.join(" ") };
}

/** Splits text at `separator`, except inside quotes and brackets. */
function splitOutside(text: string, separator: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let quote: string | undefined;
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (quote) {
			if (char === quote) quote = undefined;
		} else if (char === '"' || char === "'") {
			quote = char;
		} else if (char === "(") {
			depth++;
		} else if (char === ")") {
			depth = Math.max(0, depth - 1);
		} else if (char === separator && depth === 0) {
			parts.push(text.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

/** The addresses in a value's `url(…)`s. */
function urlsIn(value: string): string[] {
	const urls: string[] = [];
	const pattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;
	for (const match of value.matchAll(pattern)) urls.push(match[1] ?? match[2] ?? match[3] ?? "");
	return urls;
}
