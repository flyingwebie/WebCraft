import { cleanRichText, richTextToText } from "./rich-text.ts";
import { type Attribute, type ElementTree, type TreeNode, VOID_ELEMENTS } from "./tree.ts";
import { safeUrl } from "./urls.ts";

export { safeUrl } from "./urls.ts";

/** Rich text: HTML, cleaned again where it renders (see `cleanRichText`). */
export type RichText = { readonly kind: "richText"; readonly html: string };

/**
 * A value a binding names, as core resolves it: text, a number, true/false, rich text, or a list of
 * values (a multi-select's labels, a Repeater's or Relationship's values). `null` or `undefined`
 * renders as nothing. Every value is escaped for where it lands: a reader never returns HTML except
 * as rich text, which is cleaned again here.
 */
export type RenderValue = string | number | boolean | null | undefined | RichText | readonly RenderValue[];

/** Reads the value a binding names. */
export type ValueReader = (path: string) => RenderValue;

function isRichText(value: RenderValue): value is RichText {
	return (
		typeof value === "object" && value !== null && !Array.isArray(value) && (value as RichText).kind === "richText"
	);
}

/**
 * A value as text, for attributes: numbers as written, true/false as `true` or `false`, rich text
 * without its tags, and a list as its values joined with commas.
 */
export function valueText(value: RenderValue): string {
	if (value === null || value === undefined) return "";
	if (Array.isArray(value)) {
		return (value as readonly RenderValue[])
			.map(valueText)
			.filter((text) => text !== "")
			.join(", ");
	}
	if (isRichText(value)) return richTextToText(value.html);
	return String(value);
}

/** A value in a text position: escaped text, or cleaned rich text. */
function valueHtml(value: RenderValue): string {
	if (Array.isArray(value)) {
		return (value as readonly RenderValue[])
			.map(valueHtml)
			.filter((html) => html !== "")
			.join(", ");
	}
	if (isRichText(value)) return cleanRichText(value.html);
	return escapeText(valueText(value));
}

/** Escapes text for an HTML text position. */
export function escapeText(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Escapes text for a double-quoted attribute value. */
export function escapeAttribute(text: string): string {
	return escapeText(text).replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Attributes holding one URL, checked with `safeUrl`. */
const URL_ATTRIBUTES: ReadonlySet<string> = new Set(["href", "src", "cite", "poster", "action", "background"]);

/** Attributes holding a list of image candidates, `url [descriptor]`, separated by commas. */
const SRCSET_ATTRIBUTES: ReadonlySet<string> = new Set(["srcset", "imagesrcset"]);

function safeSrcset(srcset: string): string {
	return srcset
		.split(",")
		.map((candidate) => {
			const [url = "", ...descriptor] = candidate.trim().split(/\s+/);
			return [safeUrl(url), ...descriptor].join(" ");
		})
		.join(", ");
}

/** Options for rendering a tree. */
export type RenderOptions = {
	/** Reads the value a binding names. */
	values: ValueReader;
	/** The class name of a Class id; Class references it doesn't know are left out. */
	className?: (classId: string) => string | undefined;
};

/** Renders a tree's nodes as HTML: every value escaped for where it lands, every URL checked. */
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
		case "value":
			return valueHtml(options.values(node.path));
		case "element": {
			const classNames = node.classes.map((classId) => options.className?.(classId)).filter(Boolean);
			let attributes = classNames.length > 0 ? ` class="${escapeAttribute(classNames.join(" "))}"` : "";
			for (const attribute of node.attributes) attributes += renderAttribute(attribute, options);
			if (VOID_ELEMENTS.has(node.tag)) return `<${node.tag}${attributes}>`;
			let children = renderNodes(node.children, options);
			// An HTML parser drops a newline right after <pre>; repeat it so the content stays as written.
			if (node.tag === "pre" && children.startsWith("\n")) children = `\n${children}`;
			return `<${node.tag}${attributes}>${children}</${node.tag}>`;
		}
	}
}

function renderAttribute(attribute: Attribute, options: RenderOptions): string {
	let value = "";
	for (const part of attribute.value) value += part.type === "text" ? part.text : valueText(options.values(part.path));
	if (URL_ATTRIBUTES.has(attribute.name)) value = safeUrl(value);
	if (SRCSET_ATTRIBUTES.has(attribute.name)) value = safeSrcset(value);
	return ` ${attribute.name}="${escapeAttribute(value)}"`;
}
