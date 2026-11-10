import type { HoldEmbed } from "./body/blocks.ts";
import { renderBody, renderToc } from "./body/body.ts";
import { commandForNode } from "./commands.ts";
import { COMPONENT_LIMITS, type PlacementNode, type PropArgument } from "./components.ts";
import { escapeAttribute, escapeText, safeAttributeValue, safeUrl, URL_ATTRIBUTES } from "./escape.ts";
import type { RenderTime } from "./expressions.ts";
import { applyFormat } from "./formatters.ts";
import { textIn } from "./languages.ts";
import {
	isLoopValuePath,
	LOOP_LIMITS,
	LOOP_STATS,
	type LoopItem,
	type LoopItemPlace,
	type LoopRun,
	type RegionPlace,
} from "./loops.ts";
import { type ImagePriority, type MediaReader, mediaReference, renderMediaImage } from "./media.ts";
import { cleanRichText } from "./rich-text.ts";
import {
	type Attribute,
	type ElementNode,
	type ElementTree,
	type FilterNode,
	type LoopNode,
	type TreeNode,
	type ValueNode,
	VOID_ELEMENTS,
} from "./tree.ts";
import {
	isBody,
	isList,
	isPresent,
	isRichText,
	isToc,
	joinList,
	type TemplateValue,
	textOf,
	type ValueReader,
} from "./values.ts";

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
	/** What `{{@form <key>}}` shows: the Form with this id, rendered. Nothing when absent. */
	form?: (formId: string) => string;
	/** What `{{@search}}` shows: the Search element. Nothing when absent. */
	search?: () => string;
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
	 * WebCraft's own words in the page's language: what a body's video says ("Play video") and what
	 * pagination says (English when absent).
	 */
	words?: { playVideo: string; video: string } & Partial<PaginationWords>;
	/**
	 * What each Loop of the Site the page names shows here, by name; undefined when no Loop has the
	 * name, whose source is then a list the page reads (`gallery`). Without it, Loops show only lists.
	 */
	loop?: (name: string) => LoopRun | undefined;
	/** The time the page is rendered, for Conditions reading `now`; such tests never pass without it. */
	time?: RenderTime;
	/** How many Loop items the page has shown so far, shared by its templates (`LOOP_LIMITS.items`). */
	loopItemsShown?: { count: number };
	/** Counts what the page shows that needs a script of WebCraft's: a body's videos. */
	shown?: { videos: number };
	/** Holds embeds back until visitors accept their Consent category; absent where nothing is held back. */
	held?: HoldEmbed;
	/** What `{{@consentSettings}}` shows: the "Cookie settings" button. Nothing when absent. */
	consentSettings?: () => string;
	/** What `{{@filter <name> for="…"}}` shows: the Filter, rendered. Nothing when absent. */
	filter?: (node: FilterNode) => string;
	/**
	 * Whether a Loop of the Site is narrowed by a Filter on the page: its items and its pagination are
	 * then marked as regions (`filterRegion`), which the Filter's script swaps in place. Shared by the
	 * page's templates with `regions`, which numbers each region of a name in the order it renders.
	 */
	filtered?: (loop: string) => boolean;
	regions?: Map<string, number>;
	/**
	 * What a Placement shows: its Component's (published) tree, and what that tree's bindings read
	 * given the Placement's Prop values (`props.x`, read through `outer` where a value is passed on
	 * as it is). Undefined renders nothing, as a Placement of a Component the page can't show.
	 */
	component?: PlacementRenderer;
	/**
	 * Edit mode's tags (ADR 0022): the attributes that mark an element showing one binding alone
	 * (`<h1>{{ title }}</h1>`) as an editable region, or an image whose `src` is one binding
	 * (`<img src="{{ photo }}">`, `place.image`), or undefined when that binding isn't editable. A
	 * tagged element also carries its element id as `data-wc-id`, so Edit mode can find it in the
	 * tree, and a tagged image the Media item it shows (`data-wc-media`). Absent for the pages visitors
	 * get, which carry no such attributes.
	 */
	editRegion?: (
		value: ValueNode,
		place: RegionPlace,
	) => readonly (readonly [name: string, value: string])[] | undefined;
	/**
	 * Edit mode's marks around a Loop of the Site and each of its items: HTML comments, so they change
	 * nothing of the page's layout (`<!--wc-loop …-->` and `<!--wc-item <key>-->`, each closed). It
	 * answers what the Loop's mark says, by the Loop's name (its id, where its items come from, its
	 * name), or undefined for a Loop not to mark. Absent for the pages visitors get.
	 */
	editLoop?: (name: string) => readonly string[] | undefined;

	/**
	 * Code mode's tags (ADR 0016): where the tree being rendered comes from, such as `content` (the
	 * page's Entry template) or `site` (the Site template). Every element is tagged with it and its own
	 * id as `data-wc-code="<source>#<id>"`, and a Component's elements with the Placements that show
	 * them (`content/<placement id>#<id>`), so selecting an element on the page opens the Template or
	 * Component it comes from. Absent for the pages visitors get, which carry no such attributes.
	 */
	codeSource?: string;
};

/** What pagination says, in the page's language. */
export type PaginationWords = {
	/** The <nav>'s name. */
	pagination: string;
	previousPage: string;
	nextPage: string;
	/** A page's link, for screen readers: "Page {n}". */
	pageNumber: string;
};

const ENGLISH_PAGINATION: PaginationWords = {
	pagination: "Pages",
	previousPage: "Previous",
	nextPage: "Next",
	pageNumber: "Page {n}",
};

/** The attribute Code mode's tags are written in: see `RenderOptions.codeSource`. */
export const CODE_ATTRIBUTE = "data-wc-code";

/** Finds what a Placement shows: see `RenderOptions.component`. */
export type PlacementRenderer = (
	componentId: string,
	props: ReadonlyMap<string, PropArgument>,
	outer: ValueReader,
) => { tree: ElementTree; values: ValueReader } | undefined;

/**
 * How deep the render is in Components and in Loops, how many nodes Components have shown on the
 * page so far, and how many Loop items.
 */
type RenderState = { depth: number; loops: number; budget: { nodes: number }; items: { count: number } };

/**
 * Renders a tree's nodes as HTML. Every value is escaped for where it lands (text, an attribute, a
 * URL), rich text is cleaned against its allowlist, comments are left out, Conditions render the
 * branch whose test passes, and Loops their content once per item.
 */
export function renderTree(tree: ElementTree, options: RenderOptions): string {
	return renderNodes(
		tree.nodes,
		{ ...options, values: withLoopStats(options.values, options) },
		{ depth: 0, loops: 0, budget: { nodes: 0 }, items: options.loopItemsShown ?? { count: 0 } },
	);
}

/**
 * Reads `<name>.count`, `.empty`, `.total`, `.page` and `.pages` of the Loops of the Site the page
 * names, and everything else through `read`.
 */
function withLoopStats(read: ValueReader, options: RenderOptions): ValueReader {
	if (!options.loop) return read;
	const runOf = options.loop;
	return (path) => {
		const [name = "", stat, ...rest] = path.split(".");
		if (rest.length > 0 || !(LOOP_STATS as readonly string[]).includes(stat ?? "")) return read(path);
		const run = runOf(name);
		if (!run) return read(path);
		switch (stat) {
			case "count":
				return run.items.length;
			case "empty":
				return run.items.length === 0;
			case "total":
				return run.total;
			case "page":
				return run.pages?.current ?? 1;
			default:
				return run.pages?.count ?? 1;
		}
	};
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
		time: options.time,
		nodes: (children) => renderNodes(children, options, state),
		outlet: () => options.outlet?.() ?? "",
		themeToggle: () => options.themeToggle?.() ?? "",
		languageSwitcher: () => options.languageSwitcher?.() ?? "",
		form: (formId) => options.form?.(formId) ?? "",
		search: () => options.search?.() ?? "",
		loop: (loop) => filterRegion(`loop ${loop.source}`, loop.source, renderLoop(loop, options, state), options),
		pagination: (name) =>
			filterRegion(
				`pagination ${name}`,
				name,
				paginationHtml(options.loop?.(name), options, options.filtered?.(name)),
				options,
			),
		consentSettings: () => options.consentSettings?.() ?? "",
		filter: (filter) => options.filter?.(filter) ?? "",
	});
}

/** The comment that starts a region of a page a Filter's script swaps; `/` and the same name end it. */
export const FILTER_REGION_MARK = "wc-region";

/**
 * Marks what a filtered Loop shows (`loop <name>`) or its pagination (`pagination <name>`) as a region
 * of the page with comments, numbered in render order (`<!--wc-region loop products 1-->` …
 * `<!--/wc-region loop products 1-->`). Comments may sit anywhere (inside a list or a table), and only
 * WebCraft writes them on pages: Staff's comments are never rendered and every value is escaped.
 */
function filterRegion(name: string, loop: string, html: string, options: RenderOptions): string {
	// A value-bound list (`isLoopValuePath`) is never a named query Loop, so it can never be filtered.
	if (isLoopValuePath(loop) || !options.filtered?.(loop) || !options.regions) return html;
	const n = (options.regions.get(name) ?? 0) + 1;
	options.regions.set(name, n);
	return `<!--${FILTER_REGION_MARK} ${name} ${n}-->${html}<!--/${FILTER_REGION_MARK} ${name} ${n}-->`;
}

/**
 * A Loop: its content once per item, reading the item as `<alias>.x` and its position as `loop.x`,
 * else its `{{@empty}}` content. Its items are a Loop of the Site's (`RenderOptions.loop`), or a list
 * the place reads: each value of a Repeater, a Relationship or a multiple select, one item for a
 * single value. Loops nest at most `LOOP_LIMITS.depth` deep (deeper ones render nothing), and a page
 * shows at most `LOOP_LIMITS.items` items through them.
 */
function renderLoop(node: LoopNode, options: RenderOptions, state: RenderState): string {
	if (state.loops >= LOOP_LIMITS.depth) return "";
	const run = node.source.includes(".") ? undefined : options.loop?.(node.source);
	const all = run ? run.items : listItems(node.source, options.values);
	const items = all.slice(0, Math.max(0, LOOP_LIMITS.items - state.items.count));
	state.items.count += items.length;
	const mark = run ? options.editLoop?.(node.source) : undefined;
	const marked = (html: string) =>
		mark ? `<!--wc-loop ${mark.map(markToken).join(" ")}-->${html}<!--/wc-loop-->` : html;
	if (items.length === 0) return marked(node.empty ? renderNodes(node.empty, options, state) : "");
	const inner: RenderState = { ...state, loops: state.loops + 1 };
	let html = "";
	items.forEach((item, index) => {
		const place: LoopItemPlace = { alias: node.alias, key: item.key };
		const editRegion = options.editRegion;
		const shown = renderNodes(
			node.children,
			{
				...options,
				values: itemReader(node.alias, item, index, items.length, options.values),
				editRegion: editRegion && ((value, at) => editRegion(value, { ...at, item: place })),
				// A Form shows once where it is placed, never once per item: markup can't place one in a
				// Loop's items, and one a Component brings there renders nothing.
				form: undefined,
				filter: undefined,
			},
			inner,
		);
		html += mark && item.key ? `<!--wc-item ${markToken(item.key)}-->${shown}<!--/wc-item-->` : shown;
	});
	return marked(html);
}

/**
 * A word of an Edit mode mark, written so it can't end the comment or break it (`--`, a last `-`):
 * percent-encoded, dashes too; `decodeURIComponent` reads it back.
 */
function markToken(text: string): string {
	return encodeURIComponent(text).replace(/-/g, "%2D");
}

/**
 * The items of a list the place reads, by its path: each value of a list (a Repeater's rows, the
 * Entries a Relationship points at, a multiple select's choices), one item for a single value, none
 * for an empty one. An item's values are read through the list's path, the item's own among them.
 */
function listItems(source: string, read: ValueReader): LoopItem[] {
	const value = read(source);
	const many = isList(value);
	const values = many ? value : isPresent(value) ? [value] : [];
	const known = new Map<string, TemplateValue>();
	const at = (rest: string): TemplateValue => {
		const path = rest ? `${source}.${rest}` : source;
		if (!known.has(path)) known.set(path, read(path));
		return known.get(path);
	};
	return values.map((_, index) => ({
		read: (rest) => {
			const found = at(rest);
			return many ? (isList(found) ? found[index] : undefined) : found;
		},
	}));
}

/** What a Loop's content reads for one item: the item, its position, and everything around the Loop. */
function itemReader(alias: string, item: LoopItem, index: number, count: number, outer: ValueReader): ValueReader {
	const prefix = `${alias}.`;
	return (path) => {
		if (path === alias) return item.read("");
		if (path.startsWith(prefix)) return item.read(path.slice(prefix.length));
		switch (path) {
			case "loop.index":
				return index + 1;
			case "loop.first":
				return index === 0;
			case "loop.last":
				return index === count - 1;
			case "loop.odd":
				return index % 2 === 0;
			case "loop.even":
				return index % 2 === 1;
			case "loop.count":
				return count;
		}
		return outer(path);
	};
}

/**
 * Links to a Loop's pages, when it paginates here with more than one: a <nav> named in the page's
 * language, holding the previous page, the first and last pages and those near the current one (a gap
 * between them shown as …), and the next page. The current page is marked `aria-current="page"`.
 */
function paginationHtml(run: LoopRun | undefined, options: RenderOptions, filtered = false): string {
	const pages = run?.pages;
	if (!pages || pages.count < 2) return "";
	const words = { ...ENGLISH_PAGINATION, ...options.words };
	// A filtered Loop's pages are swapped in place by the Filter script.
	const mark = filtered ? " data-wc-filter-link" : "";
	const link = (page: number, text: string, extra: string) =>
		`<li><a${mark} href="${escapeAttribute(safeUrl(pages.href(page)))}"${extra}>${escapeText(text)}</a></li>`;
	const shown = [...new Set([1, pages.current - 1, pages.current, pages.current + 1, pages.count])]
		.filter((page) => page >= 1 && page <= pages.count)
		.sort((a, b) => a - b);
	const items: string[] = [];
	if (pages.current > 1) items.push(link(pages.current - 1, words.previousPage, ' rel="prev"'));
	shown.forEach((page, index) => {
		if (index > 0 && page - (shown[index - 1] ?? page) > 1) items.push('<li aria-hidden="true">…</li>');
		const label = words.pageNumber.replace("{n}", String(page));
		const current = page === pages.current ? ' aria-current="page"' : "";
		items.push(link(page, String(page), ` aria-label="${escapeAttribute(label)}"${current}`));
	});
	if (pages.current < pages.count) items.push(link(pages.current + 1, words.nextPage, ' rel="next"'));
	return `<nav class="wc-pagination" aria-label="${escapeAttribute(words.pagination)}"><ul>${items.join("")}</ul></nav>`;
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
	// Inside a Component its bindings read its Props, the Globals and the Loops of the Site; it holds
	// no outlet. Edit mode tags regions of the page's own Template: a Component's elements are the
	// Component's. Code mode tags them as the Component's, reached through this Placement.
	const inner: RenderOptions = {
		...options,
		values: withLoopStats(shown.values, options),
		outlet: undefined,
		editRegion: undefined,
		codeSource: options.codeSource === undefined ? undefined : `${options.codeSource}/${node.id}`,
	};
	return renderNodes(shown.tree.nodes, inner, { ...state, depth: state.depth + 1 });
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
	const region = options.editRegion(only, {});
	return region ? [...region, ["data-wc-id", node.id]] : [];
}

/**
 * A value in a text position: escaped text, cleaned rich text, a body's Blocks or a table of contents
 * as HTML, or a list of them joined with commas. Through a formatter, each is its text.
 */
function valueHtml(node: ValueNode, value: TemplateValue, options: RenderOptions): string {
	if (isList(value)) return joinList(value.map((item) => valueHtml(node, item, options)));
	if (!node.format && isRichText(value)) return cleanRichText(value.html);
	if (!node.format && isBody(value)) {
		const editRegion = options.editRegion;
		return renderBody(value.blocks, {
			media: options.media,
			priorityImage: options.priorityImage,
			words: options.words ?? { playVideo: "Play video", video: "Video" },
			shown: options.shown,
			held: options.held,
			// Edit mode: each image Block's image is a region of its own, named by the Block.
			imageRegion: editRegion && ((block) => blockRegion(editRegion(node, { image: true, block }), block)),
		});
	}
	if (!node.format && isToc(value)) return renderToc(value.headings);
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
	const region = src ? imageRegion(node, src, options) : undefined;
	const id = src ? mediaReference(attributeText(src, options)) : undefined;
	const image = id === undefined ? undefined : media(id);
	const classNames = node.classes.map((classId) => options.className?.(classId)).filter(Boolean);
	if (image?.kind !== "image") {
		// In Edit mode an image region with no image to show is still there to choose one in.
		if (region) return emptyImageRegion(region, classNames);
		return id === undefined ? undefined : "";
	}
	const own: [string, string][] = classNames.length > 0 ? [["class", classNames.join(" ")]] : [];
	for (const attribute of node.attributes) own.push([attribute.name, attributeText(attribute, options)]);
	if (options.codeSource !== undefined) own.push([CODE_ATTRIBUTE, `${options.codeSource}#${node.id}`]);
	if (region) own.push(...region, ["data-wc-media", id ?? ""]);
	return renderMediaImage(image, own, options.priorityImage);
}

/**
 * Edit mode's tags for an image whose `src` is one binding without a formatter, when that binding is
 * an editable image (`editRegion` with `image`): the region's attributes and the element's id.
 */
function imageRegion(node: ElementNode, src: Attribute, options: RenderOptions): [string, string][] | undefined {
	const [only] = src.value;
	if (!options.editRegion || src.value.length !== 1 || only?.type !== "value" || only.format) return undefined;
	const region = options.editRegion(only, { image: true });
	return region
		? [...region.map(([name, value]): [string, string] => [name, value]), ["data-wc-id", node.id]]
		: undefined;
}

/** An image Block's region: its attributes and the Block's id, or undefined when it isn't editable. */
function blockRegion(
	region: readonly (readonly [string, string])[] | undefined,
	block: string,
): readonly (readonly [string, string])[] | undefined {
	return region && [...region, ["data-wc-block", block]];
}

/**
 * An image region with no image to show (none chosen, or one that isn't a ready image of the Site):
 * an empty element in its place, with the Template's Classes, for the editing bar to label.
 */
function emptyImageRegion(
	region: readonly (readonly [string, string])[],
	classNames: readonly (string | undefined)[],
): string {
	const attributes: [string, string][] = classNames.length > 0 ? [["class", classNames.join(" ")]] : [];
	attributes.push(...region.map(([name, value]): [string, string] => [name, value]));
	return `<span${attributes.map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`).join("")}></span>`;
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
