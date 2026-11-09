import { commandForNode } from "./commands.ts";
import { COMPONENT_LIMITS, type PlacementNode, type PropArgument } from "./components.ts";
import { escapeAttribute, escapeText, safeAttributeValue, URL_ATTRIBUTES } from "./escape.ts";
import { applyFormat } from "./formatters.ts";
import { textIn } from "./languages.ts";
import { type ImagePriority, type MediaReader, mediaReference, renderMediaImage } from "./media.ts";
import { cleanRichText } from "./rich-text.ts";
import {
	type Attribute,
	type ElementNode,
	type ElementTree,
	type TreeNode,
	type ValueNode,
	VOID_ELEMENTS,
} from "./tree.ts";
import { isList, isRichText, joinList, type TemplateValue, textOf, type ValueReader } from "./values.ts";

export { escapeAttribute, escapeText, safeUrl } from "./escape.ts";

/** Options for rendering a tree. */
export type RenderOptions = {
	/** Reads the value a binding names. */
	values: ValueReader;
	/**
	 * The page's language, a BCP 47 tag such as `en`: fixed text shows its value in it, and formatters
	 * write in it. English when absent.
	 */
	language?: string;
	/** The class name of a Class id; Class references it doesn't know are left out. */
	className?: (classId: string) => string | undefined;
	/** What `{{@outlet}}` shows: the page's content, already rendered. Nothing when absent. */
	outlet?: () => string;
	/** What `{{@themeToggle}}` shows. Nothing when absent. */
	themeToggle?: () => string;
	/** What `{{@languageSwitcher}}` shows. Nothing when absent. */
	languageSwitcher?: () => string;
	/**
	 * Attributes WebCraft adds to an element, written after the element's own (such as the id of
	 * the page's <main>, which the skip link points at); their values are escaped.
	 */
	extraAttributes?: (element: ElementNode) => readonly (readonly [name: string, value: string])[];
	/**
	 * Finds the Site's Media items that `media:<id>` refers to. Without it, `media:` is no URL a page
	 * may hold, and becomes `#`.
	 */
	media?: MediaReader;
	/** Present while rendering `<main>`: its first Media image loads eagerly, with high priority. */
	priorityImage?: ImagePriority;
	/**
	 * What a Placement shows: its Component's (published) tree, and what that tree's bindings read
	 * given the Placement's Prop values (`props.x`, read through `outer` where a value is passed on
	 * as it is). Undefined renders nothing, as a Placement of a Component the page can't show.
	 */
	component?: PlacementRenderer;
	/**
	 * Edit mode's tags (ADR 0022): the attributes that mark an element showing one binding alone
	 * (`<h1>{{ title }}</h1>`) as an editable region, or undefined when that binding isn't editable.
	 * A tagged element also carries its element id as `data-wc-id`, so Edit mode can find it in the
	 * tree. Absent for the pages visitors get, which carry no such attributes.
	 */
	editRegion?: (value: ValueNode) => readonly (readonly [name: string, value: string])[] | undefined;
	/**
	 * Code mode's tags (ADR 0016): where the tree being rendered comes from, such as `content` (the
	 * page's Entry template) or `site` (the Site template). Every element is tagged with it and its own
	 * id as `data-wc-code="<source>#<id>"`, and a Component's elements with the Placements that show
	 * them (`content/<placement id>#<id>`), so selecting an element on the page opens the Template or
	 * Component it comes from. Absent for the pages visitors get, which carry no such attributes.
	 */
	codeSource?: string;
};

/** The attribute Code mode's tags are written in: see `RenderOptions.codeSource`. */
export const CODE_ATTRIBUTE = "data-wc-code";

/** Finds what a Placement shows: see `RenderOptions.component`. */
export type PlacementRenderer = (
	componentId: string,
	props: ReadonlyMap<string, PropArgument>,
	outer: ValueReader,
) => { tree: ElementTree; values: ValueReader } | undefined;

/** How deep the render is in Components, and how many nodes Components have shown on the page so far. */
type RenderState = { depth: number; budget: { nodes: number } };

/**
 * Renders a tree's nodes as HTML. Every value is escaped for where it lands (text, an attribute, a
 * URL), rich text is cleaned against its allowlist, comments are left out, and Conditions render
 * the branch whose test passes.
 */
export function renderTree(tree: ElementTree, options: RenderOptions): string {
	return renderNodes(tree.nodes, options, { depth: 0, budget: { nodes: 0 } });
}

function renderNodes(nodes: readonly TreeNode[], options: RenderOptions, state: RenderState): string {
	let html = "";
	for (const node of nodes) html += renderNode(node, options, state);
	return html;
}

function renderNode(node: TreeNode, options: RenderOptions, state: RenderState): string {
	if (state.depth > 0) state.budget.nodes++;
	switch (node.type) {
		case "text":
			return escapeText(textIn(node, options.language));
		case "comment":
			return "";
		case "value":
			return valueHtml(node, options.values(node.path), options);
		case "element": {
			if (node.tag === "img" && options.media) {
				const image = mediaImage(node, options.media, options);
				if (image !== undefined) return image;
			}
			const classNames = node.classes.map((classId) => options.className?.(classId)).filter(Boolean);
			let attributes = classNames.length > 0 ? ` class="${escapeAttribute(classNames.join(" "))}"` : "";
			for (const attribute of node.attributes) attributes += renderAttribute(attribute, options);
			for (const [name, value] of [...(options.extraAttributes?.(node) ?? []), ...editTags(node, options)]) {
				attributes += ` ${name}="${escapeAttribute(value)}"`;
			}
			if (options.codeSource !== undefined) {
				attributes += ` ${CODE_ATTRIBUTE}="${escapeAttribute(`${options.codeSource}#${node.id}`)}"`;
			}
			if (VOID_ELEMENTS.has(node.tag)) return `<${node.tag}${attributes}>`;
			let children = renderNodes(node.children, options, state);
			// An HTML parser drops a newline right after <pre>; repeat it so the content stays as written.
			if (node.tag === "pre" && children.startsWith("\n")) children = `\n${children}`;
			return `<${node.tag}${attributes}>${children}</${node.tag}>`;
		}
		case "component":
			return renderPlacement(node, options, state);
	}
	const command = commandForNode(node.type);
	if (!command) return "";
	return command.render(node, {
		read: options.values,
		nodes: (children) => renderNodes(children, options, state),
		outlet: () => options.outlet?.() ?? "",
		themeToggle: () => options.themeToggle?.() ?? "",
		languageSwitcher: () => options.languageSwitcher?.() ?? "",
	});
}

/**
 * A Placement: its Component's tree, rendered with its own Prop values. A Prop given as one value
 * alone (`heading="{{ title }}"`) passes that value on as it is (a date stays a date, rich text stays
 * rich text); anything else is the text its parts make. Components nest at most
 * `COMPONENT_LIMITS.depth` deep, and a page shows at most `COMPONENT_LIMITS.expandedNodes` nodes
 * through them: past either, Placements render nothing.
 */
function renderPlacement(node: PlacementNode, options: RenderOptions, state: RenderState): string {
	if (!options.component || state.depth >= COMPONENT_LIMITS.depth) return "";
	if (state.budget.nodes > COMPONENT_LIMITS.expandedNodes) return "";
	const props = new Map<string, PropArgument>();
	for (const prop of node.props) {
		const [only] = prop.value;
		props.set(
			prop.name,
			prop.value.length === 1 && only?.type === "value" && !only.format
				? { kind: "bound", path: only.path }
				: { kind: "text", text: attributeText({ name: prop.name, value: prop.value }, options) },
		);
	}
	const shown = options.component(node.component, props, options.values);
	if (!shown) return "";
	// Inside a Component its bindings read its Props and the Globals; it holds no outlet. Edit mode
	// tags regions of the page's own Template: a Component's elements are the Component's. Code mode
	// tags them as the Component's, reached through this Placement.
	const inner: RenderOptions = {
		...options,
		values: shown.values,
		outlet: undefined,
		editRegion: undefined,
		codeSource: options.codeSource === undefined ? undefined : `${options.codeSource}/${node.id}`,
	};
	return renderNodes(shown.tree.nodes, inner, { depth: state.depth + 1, budget: state.budget });
}

/**
 * Edit mode's tags for an element: when its only content is one binding (comments aside) and that
 * binding is editable, the region's attributes and the element's id. Nothing otherwise.
 */
function editTags(node: ElementNode, options: RenderOptions): readonly (readonly [string, string])[] {
	if (!options.editRegion || VOID_ELEMENTS.has(node.tag)) return [];
	const content = node.children.filter((child) => child.type !== "comment");
	const [only] = content;
	if (content.length !== 1 || only?.type !== "value") return [];
	const region = options.editRegion(only);
	return region ? [...region, ["data-wc-id", node.id]] : [];
}

/** A value in a text position: escaped text, cleaned rich text, or a list of them joined with commas. */
function valueHtml(node: ValueNode, value: TemplateValue, options: RenderOptions): string {
	if (isList(value)) return joinList(value.map((item) => valueHtml(node, item, options)));
	if (!node.format && isRichText(value)) return cleanRichText(value.html);
	return escapeText(valueText(node, value, options));
}

/** A value as text, through its formatter when it has one (each of a list's values through it). */
function valueText(node: Pick<ValueNode, "format">, value: TemplateValue, options: RenderOptions): string {
	if (isList(value)) return joinList(value.map((item) => valueText(node, item, options)));
	return node.format ? applyFormat(value, node.format, options.language ?? "en") : textOf(value);
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
	if (options.codeSource !== undefined) own.push([CODE_ATTRIBUTE, `${options.codeSource}#${node.id}`]);
	return renderMediaImage(image, own, options.priorityImage);
}

/** An attribute's value, its bindings read. */
function attributeText(attribute: Attribute, options: RenderOptions): string {
	let value = "";
	for (const part of attribute.value) {
		value +=
			part.type === "text" ? textIn(part, options.language) : valueText(part, options.values(part.path), options);
	}
	return value;
}

function renderAttribute(attribute: Attribute, options: RenderOptions): string {
	let value = attributeText(attribute, options);
	// `media:<id>` in a URL attribute is the file's own address on the Site's domain.
	if (URL_ATTRIBUTES.has(attribute.name) && options.media) {
		const id = mediaReference(value);
		if (id !== undefined) value = options.media(id)?.url ?? "#";
	}
	return ` ${attribute.name}="${escapeAttribute(safeAttributeValue(attribute.name, value))}"`;
}
