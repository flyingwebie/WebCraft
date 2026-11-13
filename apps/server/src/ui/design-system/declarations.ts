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

/** Rows as CSS declarations, joined by `separator` (one line by default; the CSS panel puts each on its own). */
export function cssOf(rows: readonly Declaration[], separator = " "): string {
	return rows
		.filter((row) => row.property.trim() && row.value.trim())
		.map((row) => `${row.property.trim()}: ${row.value.trim()};`)
		.join(separator);
}

/** The value one property has in CSS declarations, read as `declarationsOf` reads them (the last one wins). */
export function declarationOf(css: string, property: string): string | undefined {
	return declarationsOf(css).findLast((row) => row.property.toLowerCase() === property)?.value;
}

/**
 * CSS declarations with one property set: replaced where it is, else added at the end, each
 * declaration on its own line. Text that doesn't read as declarations (unfinished typing) keeps
 * what was typed, with the declaration added on a line of its own.
 */
export function withDeclarationOf(css: string, property: string, value: string): string {
	const rows = declarationsOf(css);
	if (css.trim() && rows.length === 0) return `${css}${css.endsWith("\n") ? "" : "\n"}${property}: ${value};`;
	const at = rows.findIndex((row) => row.property.toLowerCase() === property);
	const next =
		at < 0 ? [...rows, { property, value }] : rows.map((row, index) => (index === at ? { property, value } : row));
	return cssOf(next, "\n");
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

/** Every property the code editors suggest: those suggested first, then the rest most used first. */
export const CSS_PROPERTIES: readonly string[] = [
	...PROPERTIES,
	"background",
	"row-gap",
	"column-gap",
	"width",
	"max-width",
	"min-width",
	"height",
	"max-height",
	"min-height",
	"font-style",
	"letter-spacing",
	"text-decoration",
	"text-transform",
	"text-wrap",
	"border-color",
	"border-width",
	"border-style",
	"flex",
	"flex-grow",
	"flex-shrink",
	"flex-basis",
	"justify-items",
	"align-content",
	"align-self",
	"grid-template-rows",
	"grid-column",
	"grid-row",
	"grid-area",
	"place-items",
	"place-content",
	"position",
	"inset",
	"top",
	"right",
	"bottom",
	"left",
	"z-index",
	"overflow",
	"opacity",
	"transform",
	"transition",
	"animation",
	"object-position",
	"list-style",
	"white-space",
	"cursor",
	"outline",
	"outline-offset",
	"visibility",
	"content",
	"container-type",
	"scroll-margin-top",
	"accent-color",
];
