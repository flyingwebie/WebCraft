/**
 * Attribute text as the visual builder's attribute and Prop fields show it: the text between an
 * attribute's quotes in Template markup, written by the printer and read by the parser (ADR 0017), so
 * what a field shows reads back as the same parts. `{{ path | formatter }}` is a value, `\{{` a literal
 * `{{`, `&amp;` and the other character references what they stand for; a `"` typed as it is stays one.
 */
import type { AttributePart } from "../tree.ts";
import { type ParseMarkupOptions, parseTemplateMarkup } from "./parse.ts";
import { printAttributeText } from "./print.ts";
import { TemplateMarkupInvalidError } from "./problems.ts";

export { printAttributeText };

/** Reads attribute text into its parts, or answers the first problem in the parser's own words. */
export function parseAttributeText(
	text: string,
	options: ParseMarkupOptions = {},
): { parts: AttributePart[] } | { problem: string } {
	try {
		const { tree } = parseTemplateMarkup(`<span title="${text.replaceAll('"', "&quot;")}"></span>`, options);
		const [span] = tree.nodes;
		const attribute = span?.type === "element" ? span.attributes.find((each) => each.name === "title") : undefined;
		return { parts: attribute?.value ?? [] };
	} catch (error) {
		if (error instanceof TemplateMarkupInvalidError) return { problem: error.problems[0]?.message ?? error.message };
		throw error;
	}
}
