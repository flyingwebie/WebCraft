import { commandForNode } from "./commands.ts";
import { escapeAttribute, escapeText, safeAttributeValue } from "./escape.ts";
import { applyFormat } from "./formatters.ts";
import { cleanRichText } from "./rich-text.ts";
import {
	type Attribute,
	type ElementNode,
	type ElementTree,
	type TreeNode,
	type ValueNode,
	VOID_ELEMENTS,
} from "./tree.ts";
import { type TemplateValue, textOf, type ValueReader } from "./values.ts";

export { escapeAttribute, escapeText, safeUrl } from "./escape.ts";

/** Options for rendering a tree. */
export type RenderOptions = {
	/** Reads the value a binding names. */
	values: ValueReader;
	/** The page's language, a BCP 47 tag such as `en`, for formatters; English when absent. */
	language?: string;
	/** The class name of a Class id; Class references it doesn't know are left out. */
	className?: (classId: string) => string | undefined;
	/** What `{{@outlet}}` shows: the page's content, already rendered. Nothing when absent. */
	outlet?: () => string;
	/**
	 * Attributes WebCraft adds to an element, written after the element's own (such as the id of
	 * the page's <main>, which the skip link points at); their values are escaped.
	 */
	extraAttributes?: (element: ElementNode) => readonly (readonly [name: string, value: string])[];
};

/**
 * Renders a tree's nodes as HTML. Every value is escaped for where it lands (text, an attribute, a
 * URL), rich text is cleaned against its allowlist, comments are left out, and Conditions render
 * the branch whose test passes.
 */
export function renderTree(tree: ElementTree, options: RenderOptions): string {
	return renderNodes(tree.nodes, options);
}

function renderNodes(nodes: readonly TreeNode[], options: RenderOptions): string {
	let html = "";
	for (const node of nodes) html += renderNode(node, options);
	return html;
}

function renderNode(node: TreeNode, options: RenderOptions): string {
	switch (node.type) {
		case "text":
			return escapeText(node.text);
		case "comment":
			return "";
		case "value": {
			const value = options.values(node.path);
			if (!node.format && isRichText(value)) return cleanRichText(value.html);
			return escapeText(valueText(node, value, options));
		}
		case "element": {
			const classNames = node.classes.map((classId) => options.className?.(classId)).filter(Boolean);
			let attributes = classNames.length > 0 ? ` class="${escapeAttribute(classNames.join(" "))}"` : "";
			for (const attribute of node.attributes) attributes += renderAttribute(attribute, options);
			for (const [name, value] of options.extraAttributes?.(node) ?? []) {
				attributes += ` ${name}="${escapeAttribute(value)}"`;
			}
			if (VOID_ELEMENTS.has(node.tag)) return `<${node.tag}${attributes}>`;
			let children = renderNodes(node.children, options);
			// An HTML parser drops a newline right after <pre>; repeat it so the content stays as written.
			if (node.tag === "pre" && children.startsWith("\n")) children = `\n${children}`;
			return `<${node.tag}${attributes}>${children}</${node.tag}>`;
		}
	}
	const command = commandForNode(node.type);
	if (!command) return "";
	return command.render(node, {
		read: options.values,
		nodes: (children) => renderNodes(children, options),
		outlet: () => options.outlet?.() ?? "",
	});
}

function isRichText(value: TemplateValue): value is { type: "richText"; html: string } {
	return typeof value === "object" && value !== null && !(value instanceof Date);
}

/** A value as text, through its formatter when it has one. */
function valueText(node: ValueNode, value: TemplateValue, options: RenderOptions): string {
	return node.format ? applyFormat(value, node.format, options.language ?? "en") : textOf(value);
}

function renderAttribute(attribute: Attribute, options: RenderOptions): string {
	let value = "";
	for (const part of attribute.value) {
		value += part.type === "text" ? part.text : valueText(part, options.values(part.path), options);
	}
	return ` ${attribute.name}="${escapeAttribute(safeAttributeValue(attribute.name, value))}"`;
}
