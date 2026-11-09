/**
 * Printing an element tree as Template markup (ADR 0017). Printing is exact: the markup holds every
 * setting of the tree and no whitespace the tree doesn't, so reading it back gives the same tree.
 *
 * - Elements print with their attributes, `class` (the Classes' names) first and `data-wc-id` last.
 * - Text is escaped (`&amp;`, `&lt;`, `&gt;`), `{{` in text prints as `\{{`, and a `{` or `\` at the
 *   end of text prints as a character reference, so it can't run into a following `{{`.
 * - Values print as `{{ path }}` or `{{ path | formatter }}`, comments as `<!--text-->`, Template
 *   commands as `{{@name …}} … {{/name}}`.
 * - Fixed text with values in other languages prints as `{{ "Read more" fr: "Lire la suite" }}`.
 */
import { commandForNode } from "../commands.ts";
import { writeFormat } from "../formatters.ts";
import {
	type Attribute,
	type AttributePart,
	type ElementTree,
	type TextNode,
	type TreeNode,
	VOID_ELEMENTS,
} from "../tree.ts";
import { ID_ATTRIBUTE } from "./parse.ts";

export type PrintMarkupOptions = {
	/** The name of the Site's Class with this id. */
	className?: (classId: string) => string | undefined;
};

/** Attributes that print without a value when their value is empty (`hidden`, not `hidden=""`). */
const BOOLEAN_ATTRIBUTES: ReadonlySet<string> = new Set([
	"hidden",
	"open",
	"controls",
	"autoplay",
	"loop",
	"muted",
	"playsinline",
	"reversed",
	"default",
	"itemscope",
	"inert",
	"ismap",
]);

/** Prints a tree as Template markup. */
export function printTemplateMarkup(tree: ElementTree, options: PrintMarkupOptions = {}): string {
	return printNodes(tree.nodes, options);
}

function printNodes(nodes: readonly TreeNode[], options: PrintMarkupOptions): string {
	let markup = "";
	for (const node of nodes) markup += printNode(node, options);
	return markup;
}

function printNode(node: TreeNode, options: PrintMarkupOptions): string {
	switch (node.type) {
		case "text":
			return node.translations ? translatedText(node) : markupText(node.text, false);
		case "value":
			return `{{ ${node.path}${node.format ? ` | ${writeFormat(node.format)}` : ""} }}`;
		case "comment":
			return `<!--${node.text}-->`;
		case "element": {
			let attributes = "";
			if (node.classes.length > 0) {
				const names = node.classes.map((classId) => options.className?.(classId) ?? classId);
				attributes += ` class="${markupText(names.join(" "), true)}"`;
			}
			for (const attribute of node.attributes) attributes += printAttribute(attribute);
			attributes += ` ${ID_ATTRIBUTE}="${markupText(node.id, true)}"`;
			if (VOID_ELEMENTS.has(node.tag)) return `<${node.tag}${attributes}>`;
			let children = printNodes(node.children, options);
			// An HTML parser drops a newline right after <pre>; repeat it so the content stays as written.
			if (node.tag === "pre" && children.startsWith("\n")) children = `\n${children}`;
			return `<${node.tag}${attributes}>${children}</${node.tag}>`;
		}
	}
	const command = commandForNode(node.type);
	if (!command) return "";
	const sections = command.toMarkup(node);
	let markup = "";
	for (const section of sections) {
		markup += `{{@${section.keyword}${section.argument ? ` ${section.argument}` : ""}}}`;
		markup += printNodes(section.children, options);
	}
	return command.block ? `${markup}{{/${command.name}}}` : markup;
}

function printAttribute(attribute: Attribute): string {
	if (attribute.value.length === 0 && BOOLEAN_ATTRIBUTES.has(attribute.name)) return ` ${attribute.name}`;
	return ` ${attribute.name}="${attribute.value.map(printPart).join("")}"`;
}

function printPart(part: AttributePart): string {
	if (part.type === "text") return part.translations ? translatedText(part) : markupText(part.text, true);
	return `{{ ${part.path}${part.format ? ` | ${writeFormat(part.format)}` : ""} }}`;
}

/**
 * Fixed text with values in other languages: `{{ "Read more" fr: "Lire la suite" }}`, the languages
 * in alphabetical order. The same in text and in attribute values.
 */
function translatedText(node: TextNode): string {
	const languages = Object.entries(node.translations ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return `{{ ${quoted(node.text)}${languages.map(([language, text]) => ` ${language}: ${quoted(text)}`).join("")} }}`;
}

/** Text in double quotes: `\"` for a quote, `\\` for a backslash, `\r` for a carriage return. */
function quoted(text: string): string {
	return `"${text.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("\r", "\\r")}"`;
}

/**
 * Text as Template markup writes it, so it reads back exactly: `&`, `<` and `>` (and `"` in an
 * attribute) as character references, a carriage return as `&#13;` (HTML would make it a newline),
 * `{{` as `\{{`, and a lone `{` or a `\` at the end as a reference, since a `{{` may follow.
 */
function markupText(text: string, inAttribute: boolean): string {
	let markup = "";
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		const last = index === text.length - 1;
		if (char === "&") markup += "&amp;";
		else if (char === "<") markup += "&lt;";
		else if (char === ">") markup += "&gt;";
		else if (char === '"' && inAttribute) markup += "&quot;";
		else if (char === "\r") markup += "&#13;";
		else if (char === "{" && text[index + 1] === "{") {
			markup += "\\{{";
			index++;
		} else if (char === "{" && last) markup += "&#123;";
		else if (char === "\\" && last) markup += "&#92;";
		else markup += char;
	}
	return markup;
}
