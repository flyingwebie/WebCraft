import type { BuilderCatalogue, FieldDefinition } from "@webcraft/core";
import type { ElementNode, ElementTree, TreeNode } from "@webcraft/renderer/builder";

import { selectionOf } from "../../editor/selection-ref.ts";
import {
	canHoldChildren,
	childLists,
	dropPositionAt,
	insertAt,
	moveTo,
	type NodePath,
	newElement,
	nodeAt,
	type Place,
	placeBy,
	placeOf,
} from "../../editor/tree.ts";
import { fill, type Words } from "../api.ts";
import type { BuildingDocument } from "../documents.ts";
import { managementApi } from "../management.ts";
import type { PageLayoutEditor } from "./page-layout.ts";
import type { Structure, StructureSnapshot } from "./selection.ts";

/**
 * A reference's source part (everything before its `#`), as `selection.ts` reads it: kept here so the
 * Command menu's file, which a Member fetches too, doesn't bring the Structure's code with it.
 */
function sourceOf(ref: string): string {
	const at = ref.indexOf("#");
	return at < 0 ? ref : ref.slice(0, at);
}

/**
 * Inserting (SPEC 6, BA-10; `builder/04`, `06`, `09`, `docking/07`): what the insert row, the Command
 * menu's Insert tab and the empty Page put on the page, and where it lands.
 *
 * - **One rule**: inside the selection if it can hold the new element, otherwise after it. After an
 *   "inside" insert the parent stays selected; after an "after" insert the new element is. Holding ⌘
 *   (Ctrl elsewhere) forces "after".
 * - **Section** is always top level: after the top-level element the selection is in, arriving with its
 *   inner container selected.
 * - **On a Page** (D2) a Page holds placed Components only: Section makes a new Component ("Section1",
 *   "Section2", …), places it after the selected Placement (or at the end), and edits it in place with
 *   its container selected; a Component is placed the same way. With nothing selected on a Page the
 *   insert targets the Page, never the Site template around it (audit finding 7).
 * - Every insert into a Template's or Component's tree is one Undo step through its shared Draft
 *   (`structure.change`); a Placement on a Page is one step through the Page's (`PageLayoutEditor.place`).
 */

/** What the insert row and Insert offer by name. */
export type InsertKind =
	| "section"
	| "container"
	| "div"
	| "header"
	| "footer"
	| "heading"
	| "text"
	| "link"
	| "button"
	| "list"
	| "image"
	| "figure"
	| "video"
	| "icon"
	| "loop"
	| "condition"
	| "form"
	| "component"
	| "outlet";

/** The insert row's plain elements, in the row's order (SPEC 6). */
export const ROW_ELEMENTS = [
	"section",
	"container",
	"div",
	"heading",
	"text",
	"link",
	"image",
	"video",
	"icon",
	"list",
] as const satisfies readonly InsertKind[];

/** The row's tinted kinds after the elements: Template commands and Components ("more" follows). */
export const ROW_TINTED = ["loop", "condition", "component"] as const satisfies readonly InsertKind[];

/** The tag each element kind writes, as the Command menu shows it. */
export const KIND_TAGS: Record<InsertKind, string> = {
	section: "<section>",
	container: "<div>",
	div: "<div>",
	header: "<header>",
	footer: "<footer>",
	heading: "<h2>",
	text: "<p>",
	link: "<a>",
	button: "<a>",
	list: "<ul>",
	image: "<img>",
	figure: "<figure>",
	video: "<video>",
	icon: "<img>",
	loop: "{{@loop}}",
	condition: "{{@if}}",
	form: "{{@form}}",
	component: "<Component/>",
	outlet: "{{@outlet}}",
};

/** The tag an element kind makes, or null for a Template command or a Component. */
export function tagOfKind(kind: InsertKind): string | null {
	switch (kind) {
		case "container":
			return "div";
		case "heading":
			return "h2";
		case "text":
			return "p";
		case "link":
		case "button":
			return "a";
		case "list":
			return "ul";
		case "image":
		case "icon":
			return "img";
		case "loop":
		case "condition":
		case "form":
		case "component":
		case "outlet":
			return null;
		default:
			return kind;
	}
}

/** Elements whose content is phrasing only: a paragraph, a heading or a section never goes inside them. */
const PHRASING_ONLY = new Set([
	"h1",
	"h2",
	"h3",
	"h4",
	"h5",
	"h6",
	"p",
	"a",
	"span",
	"strong",
	"em",
	"b",
	"i",
	"u",
	"s",
	"small",
	"mark",
	"code",
	"kbd",
	"samp",
	"var",
	"sub",
	"sup",
	"q",
	"cite",
	"abbr",
	"dfn",
	"time",
	"data",
	"bdi",
	"bdo",
	"ins",
	"del",
	"pre",
	"summary",
	"dt",
	"figcaption",
	"caption",
	"legend",
	"label",
]);

/** Elements that hold only particular children (list items, rows, sources): nothing the row offers goes inside. */
const PARTICULAR_CHILDREN = new Set([
	"ul",
	"ol",
	"menu",
	"dl",
	"table",
	"thead",
	"tbody",
	"tfoot",
	"tr",
	"colgroup",
	"picture",
	"audio",
	"video",
	"hgroup",
	"ruby",
]);

/** What may go in phrasing content: a link, a picture, a video, and Template commands around them. */
const PHRASING_KINDS = new Set<InsertKind>(["link", "image", "video", "icon", "loop", "condition"]);

/**
 * Whether a node can hold what a kind makes (SPEC 6's "if it can hold it"): an element that isn't void
 * and whose content model takes it (a paragraph never goes in a heading; nothing goes in a list but
 * its items), a Loop or a Condition (they hold what their own place holds), never a Placement.
 */
export function canHold(node: TreeNode, kind: InsertKind): boolean {
	if (childLists(node).length === 0) return false;
	if (node.type === "loop" || node.type === "condition") return true;
	if (node.type !== "element") return false;
	if (PARTICULAR_CHILDREN.has(node.tag)) return false;
	if (PHRASING_ONLY.has(node.tag)) return PHRASING_KINDS.has(kind) && !(node.tag === "a" && kind === "link");
	return true;
}

/** Where an insert lands. */
export type Landing =
	/** In a Template's or Component's tree: inside the selection (at its end), after it, or at the end of the tree. */
	| {
			kind: "tree";
			source: string;
			place: Place;
			/** "before": a drop on the canvas's upper half of an element (BA-33). */
			position: "inside" | "after" | "before" | "end";
			/** The element the landing line is drawn against (the selection, or the top-level one for Section); null at the end. */
			anchor: string | null;
			/** After an "inside" insert the parent stays selected. */
			keep: boolean;
	  }
	/** In a Page's Page layout, at a position among its Placements; `anchor` is the Placement it goes after. */
	| { kind: "page"; at: number; anchor: string | null }
	| { kind: "refused"; reason: string };

/** The key a node has in its source's tree (its id, or where it is for a node without one). */
export function keyAt(tree: ElementTree, path: NodePath): string | null {
	const node = nodeAt(tree, path);
	if (!node) return null;
	return "id" in node && typeof node.id === "string" ? node.id : `@${path.join(".")}`;
}

/** The open document's kind, as inserting tells a Template open on its page from the page itself. */
export type DocumentKind = BuildingDocument["kind"] | null;

/**
 * Where a kind lands for what is selected now (SPEC 6 and D2). `forceAfter`: ⌘ was held. `document`:
 * the open document, so that with nothing selected the insert goes into that document and nothing else.
 */
export function landingFor(
	snapshot: StructureSnapshot,
	kind: InsertKind,
	options: { forceAfter: boolean; document: DocumentKind; words: Words },
): Landing {
	const said = options.words.insert.refusals;
	const site = snapshot.sources.get("site");
	if (!site) return { kind: "refused", reason: said.connecting };
	const selection = snapshot.selection;
	const onPage = Boolean(site.pageLayout) && options.document !== "siteTemplate";

	if (onPage && !snapshot.inPlace) {
		const placements = snapshot.layout ?? [];
		const placed = selection
			? placements.findIndex((each) => `content/${each.id}` === `content/${sourceOf(selection.ref).split("/")[1]}`)
			: -1;
		const inContent = selection ? sourceOf(selection.ref).startsWith("content") : false;
		const chosen = placed >= 0 ? placements[placed] : undefined;
		if (kind === "section" || kind === "component")
			return {
				kind: "page",
				at: chosen ? placed + 1 : placements.length,
				anchor: chosen ? `content/${chosen.id}` : null,
			};
		// Nothing selected: the Page, which holds Components only (never the Site template around it).
		if (!selection) return { kind: "refused", reason: said.page };
		if (chosen || inContent) return { kind: "refused", reason: fill(said.placement, { name: chosen?.name ?? "" }) };
		// Something of the Site template selected on purpose: inserted there, by the one rule.
	}

	const selected = selection?.path && selection.node ? selection : null;
	let sourceRef: string | null;
	let path: NodePath | null = null;
	if (selected?.path) {
		sourceRef = selected.source;
		path = selected.path;
	} else if (snapshot.inPlace) sourceRef = snapshot.inPlace;
	else if (options.document === "siteTemplate") sourceRef = "site";
	// On its stand-in, the document is the page's content (a Component no page shows, too).
	else if (snapshot.root === "content") sourceRef = "content";
	else if (
		options.document === "entryTemplate" ||
		options.document === "archiveTemplate" ||
		options.document === "searchTemplate" ||
		(options.document === "page" && site.contentAvailable)
	)
		sourceRef = site.contentAvailable ? "content" : "site";
	else sourceRef = null;
	const source = sourceRef ? snapshot.sources.get(sourceRef) : undefined;
	if (!sourceRef || !source) return { kind: "refused", reason: sourceRef ? said.connecting : said.nothing };
	const tree = source.tree;
	const refOf = (at: NodePath) => {
		const key = keyAt(tree, at);
		return key ? `${sourceRef}#${key}` : null;
	};

	if (kind === "section") {
		if (!path)
			return { kind: "tree", source: sourceRef, place: endOf(tree), position: "end", anchor: null, keep: false };
		const top = path[0] ?? 0;
		return {
			kind: "tree",
			source: sourceRef,
			place: { owner: null, list: 0, index: top + 1 },
			position: "after",
			anchor: refOf([top]),
			keep: false,
		};
	}
	if (!path) return { kind: "tree", source: sourceRef, place: endOf(tree), position: "end", anchor: null, keep: false };
	const node = nodeAt(tree, path);
	if (!node) return { kind: "refused", reason: said.connecting };
	if (!options.forceAfter && canHold(node, kind)) {
		const children = childLists(node)[0] ?? [];
		return {
			kind: "tree",
			source: sourceRef,
			place: { owner: path, list: 0, index: children.length },
			position: "inside",
			anchor: refOf(path),
			keep: true,
		};
	}
	const place = placeOf(path);
	return {
		kind: "tree",
		source: sourceRef,
		place: { ...place, index: place.index + 1 },
		position: "after",
		anchor: refOf(path),
		keep: false,
	};
}

function endOf(tree: ElementTree): Place {
	return { owner: null, list: 0, index: tree.nodes.length };
}

/** What a picked Media file gives a new element: its id (its alt text comes from Media as the page renders). */
export type PickedMedia = { id: string };

/** Fixed text in a new element. */
const text = (words: string): TreeNode => ({ type: "text", text: words });

/** An element with plain-text attributes. */
function element(
	tree: ElementTree,
	tag: string,
	children: TreeNode[] = [],
	attributes: Record<string, string> = {},
): ElementNode {
	const made = newElement(tree, tag, children);
	return {
		...made,
		attributes: Object.entries(attributes).map(([name, value]) => ({ name, value: [{ type: "text", text: value }] })),
	};
}

/**
 * The container a Section holds (`builder/06`'s `div.container`): the Site's `container` Class when it
 * has one, else a `div` labelled "Container" in Layers.
 */
function container(tree: ElementTree, catalogue: BuilderCatalogue | null, words: Words): ElementNode {
	const made = element(tree, "div");
	const named = catalogue?.classes.find((each) => each.name === "container");
	return named ? { ...made, classes: [named.id] } : { ...made, label: words.insert.items.container.name };
}

/** The kinds that ask for a Media file before they are made: a picture (an image, a Figure's, an icon) or a video. */
export function mediaOf(kind: InsertKind): "image" | "video" | null {
	if (kind === "image" || kind === "figure" || kind === "icon") return "image";
	return kind === "video" ? "video" : null;
}

/**
 * The nodes an element kind makes, with fresh ids (`select`: the key to select after an "after" or a
 * Section: the Section's container; `always`: selected even after an "inside", as a Figure's `img`
 * is). Media kinds need the file chosen; Template commands and Components are made by the Command
 * menu, which asks its question first.
 */
export function nodesFor(
	kind: InsertKind,
	tree: ElementTree,
	catalogue: BuilderCatalogue | null,
	words: Words,
	media?: PickedMedia,
): { nodes: TreeNode[]; select: string | null; always?: boolean } | null {
	const defaults = words.insert.defaults;
	const one = (node: ElementNode) => ({ nodes: [node], select: node.id });
	switch (kind) {
		case "section": {
			const section = element(tree, "section", [container(tree, catalogue, words)]);
			// Making the section gives what it holds fresh ids: its container's is read from it.
			const inner = section.children[0];
			return { nodes: [section], select: inner && "id" in inner ? inner.id : null };
		}
		case "container":
			return one(container(tree, catalogue, words));
		case "div":
		case "header":
		case "footer":
			return one(element(tree, kind));
		case "heading":
			return one(element(tree, "h2", [text(defaults.heading)]));
		case "text":
			return one(element(tree, "p", [text(defaults.text)]));
		case "link":
			return one(element(tree, "a", [text(defaults.link)], { href: "/" }));
		case "button":
			return one(element(tree, "a", [text(defaults.button)], { href: "/" }));
		case "list":
			return one(element(tree, "ul", [element(tree, "li", [text(defaults.listItem)])]));
		case "image":
			return media ? one(element(tree, "img", [], { src: `media:${media.id}` })) : null;
		case "figure": {
			// A Figure holds its picture and a caption under it; the picture is what is chosen next.
			if (!media) return null;
			const figure = element(tree, "figure", [
				element(tree, "img", [], { src: `media:${media.id}` }),
				element(tree, "figcaption", [text(defaults.caption)]),
			]);
			const picture = figure.children[0];
			return { nodes: [figure], select: picture && "id" in picture ? picture.id : null, always: true };
		}
		case "icon":
			// An icon is decoration: rendered with empty alt text.
			return media ? one({ ...element(tree, "img", [], { src: `media:${media.id}` }), decorative: true }) : null;
		case "video":
			return media ? one(element(tree, "video", [], { src: `media:${media.id}`, controls: "" })) : null;
		case "outlet":
			return { nodes: [{ type: "outlet" } as TreeNode], select: null };
		default:
			return null;
	}
}

/** The name a kind is called by in Undo and announcements. */
export function kindName(kind: InsertKind, words: Words): string {
	return words.insert.items[kind].name;
}

/** A Component name for a new section: "Section1", or the next one the Site hasn't taken. */
export function nextSectionName(taken: Iterable<string>): string {
	const names = new Set(taken);
	let count = 1;
	while (names.has(`Section${count}`)) count++;
	return `Section${count}`;
}

/** What the inserter needs of the shell. */
export type InserterHost = {
	token: string;
	siteId: string;
	words: Words;
	structure: Structure;
	layout: PageLayoutEditor;
	/** The open document's kind now. */
	document(): DocumentKind;
	announce(text: string, urgent?: boolean): void;
	/** Edits a Component on the page in place (BA-09's): its source, id, name and the Placement Done selects. */
	editInPlace(target: { source: string; componentId: string; name: string; placement: string }): void;
	/** Opens the Media picker (`pickMedia`): the file chosen, or null. */
	pick(kind: "image" | "video"): Promise<PickedMedia | null>;
};

/** What the insert row and Insert show of where the next insert lands (`InsertLine.tsx`). */
export type InsertPreview = { landing: Landing; kind: InsertKind } | null;

export type Inserter = {
	/** Where a kind lands for the selection now. */
	landing(kind: InsertKind, forceAfter?: boolean): Landing;
	/**
	 * Inserts what a kind makes (the insert row, the empty Page, Insert): asks for a Media file first for
	 * an image, a video or an icon. Answers why not (also said), or null.
	 */
	insert(kind: InsertKind, options?: { forceAfter?: boolean }): Promise<string | null>;
	/** Inserts nodes the Command menu made (a Loop, a Condition, a Form, a Component in a tree, any element). */
	insertNodes(nodes: TreeNode[], name: string, landing: Landing): string | null;
	/** Places a Component of the Site on the Page, where `landing` says (a `page` landing). */
	placeComponent(componentId: string, landing: Landing): Promise<string | null>;
	/** Starts a new section on the Page (D2) at a position among its Placements. */
	newSection(at: number): Promise<string | null>;
	/**
	 * A drag dropped on the page (BA-33): a row's kind (`insert:<kind>`) lands against the element at
	 * `ref` (before, inside or after it, by where the drop was down its box: `fraction`), and the
	 * selection's chip (`move`) moves the selected element there, within its own Template or Component
	 * (a Page's Placement among the Page layout's). One Undo step; answers why not (also said), or null.
	 */
	dropAt(source: string, ref: string | null, fraction: number | null): Promise<string | null>;
	/** The landing line shown now (the row's button under the pointer or with focus, Insert open), or none. */
	preview(kind: InsertKind | null, forceAfter?: boolean): void;
	current(): InsertPreview;
	subscribe(listener: () => void): () => void;
};

/** How long a new section waits for its Placement to show on the page before it is edited in place, in milliseconds. */
const PLACED_WAIT_MS = 10_000;

export function inserter(host: InserterHost): Inserter {
	const { words, structure } = host;
	const said = words.insert;
	let shown: InsertPreview = null;
	const listeners = new Set<() => void>();
	const tell = () => {
		for (const listener of listeners) listener();
	};

	const landing = (kind: InsertKind, forceAfter = false) =>
		landingFor(structure.snapshot(), kind, { forceAfter, document: host.document(), words });

	const refuse = (reason: string) => {
		host.announce(reason, true);
		return reason;
	};

	/** The name of what a landing goes against, for "Inserted Heading inside div". */
	const whereOf = (at: Landing): string => {
		if (at.kind !== "tree") return said.wherePage;
		const snapshot = structure.snapshot();
		const anchor = at.anchor ? anchorName(snapshot, at.anchor) : null;
		if (at.position === "inside" && anchor) return fill(said.whereInside, { name: anchor });
		if (at.position === "after" && anchor) return fill(said.whereAfter, { name: anchor });
		if (at.position === "before" && anchor) return fill(words.canvasDrop.whereBefore, { name: anchor });
		const source = snapshot.sources.get(at.source);
		return fill(said.whereEnd, { name: source?.name ?? words.structure.siteTemplate });
	};

	const insertNodes = (
		nodes: TreeNode[],
		name: string,
		at: Landing,
		select?: string | null,
		always = false,
	): string | null => {
		if (at.kind === "refused") return refuse(at.reason);
		if (at.kind !== "tree") return refuse(said.refusals.page);
		const source = structure.snapshot().sources.get(at.source);
		if (!source) return refuse(said.refusals.connecting);
		const made = insertAt(source.tree, at.place, nodes);
		const newKey = keyAt(made.tree, made.path);
		const keep = at.keep && !always;
		const kept = keep ? (structure.snapshot().selection?.key ?? null) : null;
		const chosen = keep ? kept : (select ?? newKey);
		const refused = structure.change(at.source, made.tree, fill(said.steps.insert, { name }), chosen);
		if (refused) return refuse(refused);
		host.announce(fill(said.inserted, { name, where: whereOf(at) }));
		return null;
	};

	const sourceTree = (at: Landing): { tree: ElementTree; catalogue: BuilderCatalogue | null } | null => {
		if (at.kind !== "tree") return null;
		const source = structure.snapshot().sources.get(at.source);
		return source ? { tree: source.tree, catalogue: source.catalogue } : null;
	};

	/** Waits until the page shows a source (a new Placement's Component, opened as the page drew it again). */
	const shownSource = (ref: string) =>
		new Promise<boolean>((resolve) => {
			if (structure.snapshot().sources.has(ref)) {
				resolve(true);
				return;
			}
			const timer = window.setTimeout(() => {
				stop();
				resolve(false);
			}, PLACED_WAIT_MS);
			const stop = structure.subscribe(() => {
				if (!structure.snapshot().sources.has(ref)) return;
				window.clearTimeout(timer);
				stop();
				resolve(true);
			});
		});

	const newSection = async (at: number): Promise<string | null> => {
		const api = managementApi(host.token);
		let name = "Section1";
		try {
			const listed = await api.components.list({ siteId: host.siteId });
			name = nextSectionName(listed.components.map((each) => each.name));
			host.announce(fill(said.section.making, { name }));
			const { component } = await api.components.create({ siteId: host.siteId, name });
			const empty: ElementTree = { version: 1, nodes: [] };
			const section = element(empty, "section", [container(empty, sourceCatalogue(structure.snapshot()), words)]);
			const inner = section.children[0] as ElementNode;
			await api.components.saveDraft({
				siteId: host.siteId,
				componentId: component.id,
				tree: { version: 1, nodes: [section] },
			});
			const placed = host.layout.place(
				structure.snapshot().layout ?? [],
				{ id: component.id, props: [] },
				at,
				fill(said.steps.add, { name }),
			);
			if ("refused" in placed) return refuse(placed.refused);
			const ref = `content/${placed.id}`;
			// Selected once the page shows it, never before: until the Page's Draft has saved the Placement,
			// the panes reading the selection get CODE_SOURCE_NOT_FOUND from the server, and keep it.
			if (!(await shownSource(ref))) return null;
			host.editInPlace({ source: ref, componentId: component.id, name, placement: ref });
			// Its container, as the Component's Draft holds it (the server keeps or gives the ids).
			const shown = structure.snapshot().sources.get(ref)?.tree.nodes[0];
			const held = shown?.type === "element" ? shown.children.find((child) => child.type === "element") : undefined;
			const containerId = held && "id" in held ? held.id : inner.id;
			structure.select(`${ref}#${containerId}`);
			host.announce(fill(said.section.made, { name }));
			return null;
		} catch (error) {
			return refuse(fill(said.section.failed, { reason: error instanceof Error ? error.message : String(error) }));
		}
	};

	const placeComponent = async (componentId: string, at: Landing): Promise<string | null> => {
		if (at.kind !== "page") return refuse(said.refusals.nothing);
		try {
			const { component } = await managementApi(host.token).components.get({ siteId: host.siteId, componentId });
			const placed = host.layout.place(
				structure.snapshot().layout ?? [],
				{ id: component.id, props: component.draft.props as FieldDefinition[] },
				at.at,
				fill(said.steps.add, { name: component.name }),
			);
			if ("refused" in placed) return refuse(placed.refused);
			// Selected once the page shows it (or its wait is over), as a new section is: not before.
			const ref = `content/${placed.id}`;
			void shownSource(ref).then(() => structure.select(ref));
			host.announce(fill(said.inserted, { name: component.name, where: said.wherePage }));
			return null;
		} catch (error) {
			return refuse(fill(said.refusals.notAllowed, { name: error instanceof Error ? error.message : String(error) }));
		}
	};

	/** A Page's Placement a reference is in (`content/<id>…`) while the page is a Page, by its place in the layout. */
	const placementOn = (ref: string) => {
		const snapshot = structure.snapshot();
		const site = snapshot.sources.get("site");
		if (!site?.pageLayout || host.document() === "siteTemplate" || snapshot.inPlace) return null;
		const id = /^content\/([^/#]+)/.exec(ref)?.[1];
		const index = id ? (snapshot.layout ?? []).findIndex((each) => each.id === id) : -1;
		return id && index >= 0 ? { id, index } : null;
	};

	/** Moves the selected element (or a Page's Placement) to where a drop on `ref` lands. */
	const moveTo_ = (ref: string, fraction: number): string | null => {
		const snapshot = structure.snapshot();
		const selection = snapshot.selection;
		if (!selection) return refuse(words.canvasDrop.nothingHere);
		const name = anchorName(snapshot, selection.ref);
		// A Page's Placement moves among the Page layout's.
		const moving = !selection.key ? placementOn(selection.ref) : null;
		if (moving) {
			const target = placementOn(ref);
			if (!target) return refuse(fill(words.placements.layoutRefusals.outside, { name }));
			const after = fraction >= 0.5;
			const to = moving.index < target.index ? target.index - (after ? 0 : 1) : target.index + (after ? 1 : 0);
			if (to === moving.index) return null;
			const refused = host.layout.move(snapshot.layout ?? [], moving.id, to);
			return refused ? refuse(refused) : null;
		}
		if (!selection.path || !selection.node || selection.list !== null) return refuse(words.canvasDrop.nothingHere);
		const source = snapshot.sources.get(selection.source);
		const key = ref.includes("#") ? ref.slice(ref.indexOf("#") + 1) : "";
		const found = source && sourceOf(ref) === selection.source && key ? selectionOf(source.tree, key) : null;
		if (!source || found?.kind !== "node") return refuse(fill(words.placements.dragElsewhere, { name }));
		const target = nodeAt(source.tree, found.path);
		if (!target) return refuse(said.refusals.connecting);
		const from = selection.path.join(".");
		const to = found.path.join(".");
		if (to === from) return null;
		if (to.startsWith(`${from}.`)) return refuse(fill(words.canvasDrop.intoItself, { name }));
		const position = dropPositionAt(fraction, canHoldChildren(target));
		const moved = moveTo(source.tree, selection.path, placeBy(source.tree, found.path, position));
		if ("refused" in moved) return refuse(moved.refused);
		const refused = structure.change(
			selection.source,
			moved.tree,
			fill(words.structure.steps.move, { name }),
			keyAt(moved.tree, moved.path),
		);
		return refused ? refuse(refused) : null;
	};

	/** Inserts a row's kind where a drop on `ref` lands. */
	const insertOn = async (kind: InsertKind, ref: string, fraction: number): Promise<string | null> => {
		// On a Page, a section dropped on a Placement goes before or after it; nothing else goes in a Page.
		const placed = placementOn(ref);
		if (placed) {
			if (kind !== "section") return refuse(said.refusals.page);
			return newSection(fraction < 0.5 ? placed.index : placed.index + 1);
		}
		const wanted = mediaOf(kind);
		const media = wanted ? await host.pick(wanted) : undefined;
		if (media === null) return null;
		// The tree as it is after the picker (someone may have changed it meanwhile).
		const snapshot = structure.snapshot();
		const sourceRef = sourceOf(ref);
		const source = snapshot.sources.get(sourceRef);
		const key = ref.includes("#") ? ref.slice(ref.indexOf("#") + 1) : "";
		const found = source && key ? selectionOf(source.tree, key) : null;
		if (!source || found?.kind !== "node") return refuse(said.refusals.connecting);
		if (!source.editable)
			return refuse(fill(words.structure.readOnly, { name: source.name ?? words.structure.thisSource }));
		const target = nodeAt(source.tree, found.path);
		if (!target) return refuse(said.refusals.connecting);
		const anchor = `${sourceRef}#${key}`;
		let landing: Landing;
		if (kind === "section") {
			// Section is always top level: before or after the top-level element the drop is in.
			const top = found.path[0] ?? 0;
			const after = fraction >= 0.5;
			landing = {
				kind: "tree",
				source: sourceRef,
				place: { owner: null, list: 0, index: after ? top + 1 : top },
				position: after ? "after" : "before",
				anchor: keyAt(source.tree, [top]) ? `${sourceRef}#${keyAt(source.tree, [top])}` : null,
				keep: false,
			};
		} else {
			const position = dropPositionAt(fraction, canHold(target, kind));
			landing =
				position === "inside"
					? {
							kind: "tree",
							source: sourceRef,
							place: { owner: found.path, list: 0, index: childLists(target)[0]?.length ?? 0 },
							position: "inside",
							anchor,
							keep: false,
						}
					: {
							kind: "tree",
							source: sourceRef,
							place: placeBy(source.tree, found.path, position),
							position,
							anchor,
							keep: false,
						};
		}
		const made = nodesFor(kind, source.tree, source.catalogue, words, media);
		if (!made) return refuse(fill(said.refusals.notAllowed, { name: kindName(kind, words) }));
		return insertNodes(made.nodes, kindName(kind, words), landing, made.select, made.always);
	};

	return {
		landing,
		async dropAt(source, ref, fraction) {
			if (!ref || fraction === null) return refuse(words.canvasDrop.nothingHere);
			if (source === "move") return moveTo_(ref, fraction);
			if (source.startsWith("insert:")) return insertOn(source.slice("insert:".length) as InsertKind, ref, fraction);
			return null;
		},
		async insert(kind, options = {}) {
			const at = landing(kind, options.forceAfter ?? false);
			if (at.kind === "refused") return refuse(at.reason);
			if (at.kind === "page") {
				if (kind === "section") return newSection(at.at);
				return refuse(said.refusals.page);
			}
			const wanted = mediaOf(kind);
			const media = wanted ? await host.pick(wanted) : undefined;
			if (media === null) return null;
			// The tree as it is after the picker (someone may have changed it meanwhile).
			const again = media ? landing(kind, options.forceAfter ?? false) : at;
			const source = sourceTree(again);
			if (!source) return refuse(again.kind === "refused" ? again.reason : said.refusals.connecting);
			const made = nodesFor(kind, source.tree, source.catalogue, words, media);
			if (!made) return refuse(fill(said.refusals.notAllowed, { name: kindName(kind, words) }));
			return insertNodes(made.nodes, kindName(kind, words), again, made.select, made.always);
		},
		insertNodes: (nodes, name, at) => insertNodes(nodes, name, at),
		placeComponent,
		newSection,
		preview(kind, forceAfter = false) {
			const next = kind ? { kind, landing: landing(kind, forceAfter) } : null;
			if (
				next?.kind === shown?.kind &&
				JSON.stringify(next?.landing ?? null) === JSON.stringify(shown?.landing ?? null)
			)
				return;
			shown = next;
			tell();
		},
		current: () => shown,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
	};
}

/** The catalogue of the page's own Template (for the Site's Classes), or null while none is open. */
function sourceCatalogue(snapshot: StructureSnapshot): BuilderCatalogue | null {
	return snapshot.sources.get("site")?.catalogue ?? null;
}

/** An anchor's name as Layers shows it: an element's label or tag and first Class, a Placement's Component. */
export function anchorName(snapshot: StructureSnapshot, ref: string): string {
	const source = snapshot.sources.get(sourceOf(ref));
	const placement = snapshot.layout?.find((each) => `content/${each.id}` === ref);
	if (placement) return placement.name;
	if (!source) return "";
	const key = ref.slice(ref.indexOf("#") + 1);
	const find = (nodes: readonly TreeNode[], prefix: number[]): TreeNode | null => {
		for (const [index, node] of nodes.entries()) {
			const path = [...prefix, index];
			if (("id" in node && node.id === key) || `@${path.join(".")}` === key) return node;
			for (const [list, children] of childLists(node).entries()) {
				const found = find(children, [...path, list]);
				if (found) return found;
			}
		}
		return null;
	};
	const node = find(source.tree.nodes, []);
	if (node?.type === "element") {
		const first = node.classes[0] ? source.catalogue.classes.find((each) => each.id === node.classes[0]) : undefined;
		return node.label ?? (first ? `${node.tag}.${first.name}` : node.tag);
	}
	if (node?.type === "component")
		return source.catalogue.components.find((each) => each.id === node.component)?.name ?? "";
	if (node?.type === "loop") return node.source;
	return source.name ?? "";
}
