/**
 * CSS declarations as rows of a property and a value, as the visual builder's Class editor and the
 * Design system screen edit them, and the properties both suggest first.
 */
import { readInlineStyle } from "@webcraft/renderer/builder";

/** One declaration of a Class's styles, as the editor shows it. */
export type Declaration = { property: string; value: string };

/** CSS declarations as rows: `padding: var(--space-m);` gives one row. */
export function declarationsOf(css: string): Declaration[] {
	const read = readInlineStyle(css);
	if ("problem" in read || !read.declarations) return [];
	const rows: Declaration[] = [];
	let depth = 0;
	let quote = "";
	let start = 0;
	const text = read.declarations;
	for (let index = 0; index <= text.length; index++) {
		const char = text[index];
		if (quote) {
			if (char === quote) quote = "";
		} else if (char === '"' || char === "'") quote = char;
		else if (char === "(") depth++;
		else if (char === ")") depth = Math.max(0, depth - 1);
		else if ((char === ";" && depth === 0) || char === undefined) {
			const declaration = text.slice(start, index).trim();
			const colon = declaration.indexOf(":");
			if (colon > 0)
				rows.push({ property: declaration.slice(0, colon).trim(), value: declaration.slice(colon + 1).trim() });
			start = index + 1;
		}
	}
	return rows;
}

export function cssOf(rows: readonly Declaration[]): string {
	return rows
		.filter((row) => row.property.trim() && row.value.trim())
		.map((row) => `${row.property.trim()}: ${row.value.trim()};`)
		.join(" ");
}

/** Properties the editor suggests first; any CSS property can be typed. */
export const PROPERTIES = [
	"display",
	"gap",
	"padding",
	"padding-block",
	"padding-inline",
	"margin",
	"margin-block",
	"margin-inline",
	"color",
	"background-color",
	"border",
	"border-radius",
	"box-shadow",
	"font-family",
	"font-size",
	"font-weight",
	"line-height",
	"text-align",
	"max-inline-size",
	"inline-size",
	"block-size",
	"flex-direction",
	"flex-wrap",
	"justify-content",
	"align-items",
	"grid-template-columns",
	"object-fit",
	"aspect-ratio",
];
