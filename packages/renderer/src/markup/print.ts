/**
 * Printing an element tree as Template markup (ADR 0017). Printing is exact: the markup holds every
 * setting of the tree and no whitespace the tree doesn't, so reading it back gives the same tree.
 *
 * - Elements print with their attributes, `class` (the Classes' names) first, then the rest, then
 *   their layer label as `data-wc-label` and their id as `data-wc-id`, last.
 * - Text is escaped (`&amp;`, `&lt;`, `&gt;`), `{{` in text prints as `\{{`, and a `{` or `\` at the
 *   end of text prints as a character reference, so it can't run into a following `{{`.
 * - Values print as `{{ path }}` or `{{ path | formatter }}`, comments as `<!--text-->`, Template
 *   commands as `{{@name …}} … {{/name}}`.
 * - Fixed text with values in other languages prints as `{{ "Read more" fr: "Lire la suite" }}`.
 * - Placements print as their Component's PascalCase tag with their Prop values as attributes, in
 *   order, then `data-wc-id`, closing themselves: `<PostCard heading="{{ title }}" featured data-wc-id="…" />`.
 */
import { commandForNode } from "../commands.ts";
import { writeFormat } from "../formatters.ts";
import { BINDINGS_ATTRIBUTE } from "../prop-bindings.ts";
import {
	type Attribute,
	type AttributePart,
	type ElementTree,
	type TextNode,
	type TreeNode,
	VOID_ELEMENTS,
} from "../tree.ts";
import { ID_ATTRIBUTE, LABEL_ATTRIBUTE } from "./parse.ts";

export type PrintMarkupOptions = {
	/** The name of the Site's Class with this id. */
	className?: (classId: string) => string | undefined;
	/** The name (PascalCase tag) of the Component with this id. */
	componentName?: (componentId: string) => string | undefined;
	/** The key of the Form with this id (`{{@form <key>}}`). */
	formKey?: (formId: string) => string | undefined;
	popupKey?: (id: string) => string | undefined;
	/** The name of the Filter with this id (`{{@filter <name> for="…"}}`). */
	filterName?: (filterId: string) => string | undefined;
	/**
	 * A one-off style an element has that isn't a Class yet (canonical declarations, `color: red;`),
	 * printed as its inline `style`, which reading the markup turns into a generated Class: the visual
	 * builder's one-off styles before they are saved. None when absent.
	 */
	inlineStyle?: (elementId: string) => string | undefined;
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
			const style = options.inlineStyle?.(node.id);
			if (style) attributes += ` style="${markupText(style, true)}"`;
			if (node.decorative) attributes += ' data-wc-decorative="true"';
			if (node.label !== undefined) attributes += ` ${LABEL_ATTRIBUTE}="${markupText(node.label, true)}"`;
			attributes += ` ${ID_ATTRIBUTE}="${markupText(node.id, true)}"`;
			if (VOID_ELEMENTS.has(node.tag)) return `<${node.tag}${attributes}>`;
			let children = printNodes(node.children, options);
			// An HTML parser drops a newline right after <pre>; repeat it so the content stays as written.
			if (node.tag === "pre" && children.startsWith("\n")) children = `\n${children}`;
			return `<${node.tag}${attributes}>${children}</${node.tag}>`;
		}
		case "component": {
			// A Prop with an empty value prints as its name alone: `featured`.
			let props = "";
			for (const prop of node.props) {
				props += prop.value.length === 0 ? ` ${prop.name}` : ` ${prop.name}="${prop.value.map(printPart).join("")}"`;
			}
			const bindings = Object.fromEntries(
				node.props
					.filter((p) => p.binding)
					.sort((a, b) => a.name.localeCompare(b.name))
					.map((p) => [
						p.name,
						{
							root: p.binding?.root,
							paths: Object.fromEntries(Object.entries(p.binding?.paths ?? {}).sort(([a], [b]) => a.localeCompare(b))),
						},
					]),
			);
			if (Object.keys(bindings).length)
				props += ` ${BINDINGS_ATTRIBUTE}="${markupText(JSON.stringify(bindings), true)}"`;
			const name = options.componentName?.(node.component) ?? node.component;
			return `<${name}${props} ${ID_ATTRIBUTE}="${markupText(node.id, true)}" />`;
		}
	}
	const command = commandForNode(node.type);
	if (!command) return "";
	const sections = command.toMarkup(node, {
		formKey: (formId) => options.formKey?.(formId),
		popupKey: (id) => options.popupKey?.(id),
		filterName: (filterId) => options.filterName?.(filterId),
	});
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

/**
 * An attribute's value as Template markup writes it between the quotes: text escaped as in markup,
 * values as `{{ path }}`, fixed text with other languages as `{{ "…" fr: "…" }}`.
 */
export function printAttributeText(parts: readonly AttributePart[]): string {
	return parts.map(printPart).join("");
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
