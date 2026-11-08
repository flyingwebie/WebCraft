import { type ImagePriority, type MediaReader, mediaReference, renderMediaImage } from "./media.ts";
import { type Attribute, type ElementNode, type ElementTree, type TreeNode, VOID_ELEMENTS } from "./tree.ts";

/**
 * Reads the value a binding names, as text. `null` or `undefined` renders as nothing. Every value is
 * escaped for where it lands, so a reader returns plain text, never HTML.
 */
export type ValueReader = (path: string) => string | null | undefined;

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

const SAFE_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto", "tel"]);

/**
 * A URL as it may appear in a page: relative paths, `#anchors`, and `http`, `https`, `mailto` and
 * `tel` addresses pass; anything else (`javascript:`, `data:`, …) becomes `#`. The scheme is read
 * the way browsers read it, ignoring the whitespace and control characters they ignore.
 */
export function safeUrl(url: string): string {
	// Browsers drop tabs and newlines anywhere, and leading C0 controls and spaces.
	const read = url.replace(/[\t\n\r]/g, "");
	let start = 0;
	while (start < read.length && read.charCodeAt(start) <= 0x20) start++;
	const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(read.slice(start))?.[1];
	if (scheme === undefined) return url;
	return SAFE_SCHEMES.has(scheme.toLowerCase()) ? url : "#";
}

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
	/**
	 * Finds the Site's Media items that `media:<id>` refers to. Without it, `media:` is no URL a page
	 * may hold, and becomes `#`.
	 */
	media?: MediaReader;
	/** Present while rendering `<main>`: its first Media image loads eagerly, with high priority. */
	priorityImage?: ImagePriority;
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
			return escapeText(options.values(node.path) ?? "");
		case "element": {
			if (node.tag === "img" && options.media) {
				const image = mediaImage(node, options.media, options);
				if (image !== undefined) return image;
			}
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

/**
 * An `<img>` whose `src` reads `media:<id>`: the Media image (`<picture>`), or nothing when the Site
 * has no such image ready. Undefined for any other `<img>`.
 */
function mediaImage(node: ElementNode, media: MediaReader, options: RenderOptions): string | undefined {
	const src = node.attributes.find((attribute) => attribute.name === "src");
	const id = src ? mediaReference(attributeText(src, options)) : undefined;
	if (id === undefined) return undefined;
	const image = media(id);
	if (image?.kind !== "image") return "";
	const classNames = node.classes.map((classId) => options.className?.(classId)).filter(Boolean);
	const own: [string, string][] = classNames.length > 0 ? [["class", classNames.join(" ")]] : [];
	for (const attribute of node.attributes) own.push([attribute.name, attributeText(attribute, options)]);
	return renderMediaImage(image, own, options.priorityImage);
}

/** An attribute's value, its bindings read. */
function attributeText(attribute: Attribute, options: RenderOptions): string {
	let value = "";
	for (const part of attribute.value) value += part.type === "text" ? part.text : (options.values(part.path) ?? "");
	return value;
}

function renderAttribute(attribute: Attribute, options: RenderOptions): string {
	let value = attributeText(attribute, options);
	if (URL_ATTRIBUTES.has(attribute.name) && options.media) {
		const id = mediaReference(value);
		if (id !== undefined) value = options.media(id)?.url ?? "#";
	}
	if (URL_ATTRIBUTES.has(attribute.name)) value = safeUrl(value);
	if (SRCSET_ATTRIBUTES.has(attribute.name)) value = safeSrcset(value);
	return ` ${attribute.name}="${escapeAttribute(value)}"`;
}
