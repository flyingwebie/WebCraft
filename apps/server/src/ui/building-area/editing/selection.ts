import type { BuilderCatalogue, BuilderOpened, BuilderTarget, FieldDefinition } from "@webcraft/core";
import { createDraftClient, type DraftClient, type Json, sameValue } from "@webcraft/core/draft-document";
import type { ElementTree, TreeNode } from "@webcraft/renderer/builder";

import { editorHistory } from "../../builder/editor-history.ts";
import type { Selection } from "../../builder/model.ts";
import { selectionKey, selectionOf } from "../../builder/selection-ref.ts";
import { type NodePath, nodeAt, treeProblem } from "../../builder/tree.ts";
import { type EditRequests, fill, type Words } from "../api.ts";
import type { SelectionKind } from "../docks/panels.ts";
import { managementApi } from "../management.ts";
import { connect } from "./drafts.ts";
import type { ShellHistory } from "./history.ts";

/**
 * The Structure of the page in the frame, for Staff (ADR 0037 › 1.3 and 1.5, BA-08): the Templates
 * and Components it is made of, what is selected among their elements, and the changes the Layers
 * panel and the Inspector make to them.
 *
 * - Every element of the page carries where it comes from (`data-wc-code="<source>#<id>"`: `site` for
 *   the Site template, `content` for the page's Entry, Archive or Search results template, then the id
 *   of each Placement on the way to a Component's element). That string is the selection's reference,
 *   the same on the canvas, in the tree and in the address (`wc-select`).
 * - Each source is opened by its reference through Code mode's `code/editor` edit request: its tree,
 *   what it may hold (the catalogue), whether the person may change it (a Module's Component is read
 *   only), and where it is used.
 * - Each Template or Component is changed through its shared Draft (Co-editing, ADR 0025) over the
 *   Site's own socket, opened once for the shell's life: a change is one Undo step in the tab's
 *   history, taken back through the same Draft. Once the Draft has saved it, the page in the frame is
 *   drawn again in place (`rerender`), scroll and selection kept.
 */

/** One Template or Component the page is made of, as `code/editor` opens it by the page's reference. */
export type StructureSource = {
	/** The page's reference to it: `site`, `content`, `content/<placement id>`, … */
	ref: string;
	kind: "template" | "component";
	/** The Template's or Component's id; null for a Template the Site hasn't made yet. */
	id: string | null;
	/** The Component's name, or the Template's Post Type (null for the Site and Search results templates). */
	name: string | null;
	target: BuilderTarget;
	/** Whether the person may change it: not a Module's Component, not a Template not made yet. */
	editable: boolean;
	/** Its tree as its shared Draft holds it now. */
	tree: ElementTree;
	/** A Component's Props as its shared Draft holds them now (BA-09); null for a Template. */
	props: FieldDefinition[] | null;
	catalogue: BuilderCatalogue;
	/** For a Component: on how many published pages visitors see it. */
	pages: number | null;
	/** On a Page: its Page layout (the Page's id and title), which the Site template's outlet shows. */
	pageLayout: { id: string; title: string } | null;
	/** Whether the page's content comes from a Template (an Entry, Archive or Search results template). */
	contentAvailable: boolean;
};

/** A Placement of the page's Page layout (a Page's content), as the tree lists it and the Props panel edits it. */
export type LayoutPlacement = {
	id: string;
	name: string;
	hidden: boolean;
	/** Its Component's id. */
	component: string;
	locked: boolean;
	/** Its Props' declarations, as the Placement keeps them, and their values in the page's language. */
	props: FieldDefinition[];
	values: Record<string, unknown>;
};

/** What the page's Page layout says of itself (`pageLayouts.get`): whose it is, who may arrange it, its language. */
export type LayoutInfo = {
	/** The Page's Entry. */
	entryId: string;
	canArrange: boolean;
	/** Whether the person may move past and change locked Placements (Staff). */
	canLock: boolean;
	language: string;
	defaultLanguage: string;
};

/** What is selected: its reference, and where it is in its source's tree when the source is open. */
export type StructureSelection = {
	ref: string;
	/** The reference's source part (`content/placed`) and its key in that source's tree (an id, or `@0.1`). */
	source: string;
	key: string;
	/** Where it is in its source's tree, and the node; null while the source isn't open (or can't be). */
	path: NodePath | null;
	node: TreeNode | null;
	kind: SelectionKind;
};

export type StructureSnapshot = {
	/** The page's sources by reference, as far as they are open. */
	sources: ReadonlyMap<string, StructureSource>;
	/** On a Page, its Page layout's Placements (the content of the Site template's outlet). */
	layout: readonly LayoutPlacement[] | null;
	/** On a Page, what its Page layout says of itself. */
	layoutInfo: LayoutInfo | null;
	selection: StructureSelection | null;
	/**
	 * The Component edited in place (BA-09), by its source's reference (`content/<placement id>`): the
	 * rest of the page is locked, and the page's selection stays inside it. Null when none is.
	 */
	inPlace: string | null;
};

export type Structure = {
	/** The page the frame shows now (its path), or none (a stand-in, nothing): another page's sources are forgotten. */
	page(path: string | null): void;
	/** The page's elements are there (loaded, or drawn again): the sources they name are opened. */
	found(document: Document): void;
	/** Selects by reference (null: nothing). Tells `onSelect`, unless it came from there. */
	select(ref: string | null, from?: "canvas" | "panel"): void;
	snapshot(): StructureSnapshot;
	subscribe(listener: () => void): () => void;
	/**
	 * Changes a source's tree (one Undo step, `label`), then selects `select` (a key in the new tree; the
	 * selection as it was when undefined). Answers why it was refused, or null.
	 */
	change(source: string, next: ElementTree, label: string, select?: string | null): string | null;
	/** Adds a Class to the Design system's Draft (a name the Site doesn't have yet): its id, or why not. */
	createClass(name: string): Promise<{ id: string; name: string } | { refused: string }>;
	/**
	 * Changes a Component's Props through its shared Draft (one Undo step, `label`): `source` is the
	 * reference of a source that is that Component. Answers why it was refused, or null.
	 */
	changeProps(source: string, props: FieldDefinition[], label: string): string | null;
	/** Reads the page's Page layout again (it changed: a move, a Prop, someone else's change). */
	reloadLayout(): Promise<void>;
	/**
	 * Edits the Component a source is in place (its reference, `content/<placement id>`), or stops
	 * (null). While one is, a selection on the page outside it is refused (`locked` says why).
	 */
	editInPlace(source: string | null): void;
	destroy(): void;
};

/** A source's part of a reference: everything before its `#`. */
export function sourceOf(ref: string): string {
	const at = ref.indexOf("#");
	return at < 0 ? ref : ref.slice(0, at);
}

/** A reference's key in its source's tree: everything after its `#`. */
export function keyOf(ref: string): string {
	const at = ref.indexOf("#");
	return at < 0 ? "" : ref.slice(at + 1);
}

/** The reference an element of the page carries: its own, or the nearest one around it. */
export function refOf(element: Element): string | null {
	return element.closest("[data-wc-code]")?.getAttribute("data-wc-code") ?? null;
}

/** The page's element a reference names (the first, for an element a Loop repeats). */
export function elementOf(document: Document, ref: string): Element | null {
	return document.querySelector(`[data-wc-code="${CSS.escape(ref)}"]`);
}

/** What `code/editor` answers. */
type EditorAnswer = {
	opened: BuilderOpened;
	target: BuilderTarget;
	ref: string;
	editable: boolean;
	name: string | null;
	pageLayout: { id: string; title: string } | null;
	contentAvailable: boolean;
};

/** What kind of thing a node is, for the panels' rules. */
export function kindOf(node: TreeNode | null): SelectionKind {
	if (node?.type === "component") return "placement";
	if (node?.type === "loop") return "loop";
	if (node?.type === "condition") return "condition";
	return "element";
}

/** How long a change waits for its Draft to save before the page is drawn again anyway, in milliseconds. */
const SAVE_WAIT_MS = 10_000;

/** How soon after someone else's change to a Template or Component the page is drawn again, in milliseconds. */
const REMOTE_DELAY_MS = 300;

export function structure(options: {
	token: string;
	siteId: string;
	words: Words;
	request: EditRequests;
	history: ShellHistory;
	announce(text: string, urgent?: boolean): void;
	/** Draws the page in the frame again in place, from the Drafts as they are now. */
	rerender(): Promise<void>;
	/** The selection changed here (from a panel, a change, Undo): the canvas follows it. */
	onSelect(ref: string | null): void;
	/** A change of the person's didn't save: the Draft state says so. */
	failed(): void;
}): Structure {
	const { words, request, history, announce } = options;
	const said = words.structure;
	const listeners = new Set<() => void>();
	let path: string | null = null;
	let generation = 0;
	let sources = new Map<string, StructureSource>();
	let layout: LayoutPlacement[] | null = null;
	let layoutInfo: LayoutInfo | null = null;
	let selected: string | null = null;
	let inPlace: string | null = null;
	let snapshot: StructureSnapshot = { sources, layout, layoutInfo, selection: null, inPlace };
	/** References being opened now, so each is asked for once. */
	const opening = new Set<string>();

	type OpenDraft = { client: DraftClient; kind: "template" | "component"; stop: () => void; unregister: () => void };
	/** The shared Drafts of the Templates and Components opened in this tab, by id: open for the shell's life. */
	const drafts = new Map<string, OpenDraft>();

	const resourceOf = (kind: "template" | "component", id: string) => `draft:${options.siteId}:${kind}:${id}`;

	/** A tree from what a Draft's document holds: a Template's is its tree, a Component's has its tree and Props. */
	const treeIn = (kind: "template" | "component", draft: Json): ElementTree | null => {
		const tree = kind === "component" ? (draft as { tree?: Json } | null)?.tree : draft;
		return tree && typeof tree === "object" && Array.isArray((tree as { nodes?: unknown }).nodes)
			? (tree as unknown as ElementTree)
			: null;
	};

	/** A Component's Props from what its Draft's document holds; null when it holds none. */
	const propsIn = (kind: "template" | "component", draft: Json): FieldDefinition[] | null => {
		const props = kind === "component" ? (draft as { props?: Json } | null)?.props : null;
		return Array.isArray(props) ? (props as unknown as FieldDefinition[]) : null;
	};

	const selectionNow = (): StructureSelection | null => {
		if (!selected) return null;
		const source = sourceOf(selected);
		const key = keyOf(selected);
		const open = sources.get(source);
		const found = open && key ? selectionOf(open.tree, key) : null;
		const at = found?.kind === "node" ? found.path : null;
		const node = at && open ? (nodeAt(open.tree, at) ?? null) : null;
		// A reference to a source itself (a Page layout's Placement) selects that Placement.
		return { ref: selected, source, key, path: at, node, kind: key ? kindOf(node) : "placement" };
	};

	const tell = () => {
		snapshot = { sources, layout, layoutInfo, selection: selectionNow(), inPlace };
		for (const listener of listeners) listener();
	};

	/**
	 * Every open source of a Template or Component shows its tree (and a Component its Props) as the
	 * Draft has it now: whether one changed.
	 */
	const follow = (id: string, tree: ElementTree, props: FieldDefinition[] | null = null): boolean => {
		let changed = false;
		const next = new Map(sources);
		for (const [ref, source] of sources) {
			if (source.id !== id) continue;
			const sameTree = sameValue(source.tree as unknown as Json, tree as unknown as Json);
			const sameProps = props === null || sameValue(source.props as unknown as Json, props as unknown as Json);
			if (sameTree && sameProps) continue;
			next.set(ref, { ...source, tree, ...(props === null ? {} : { props }) });
			changed = true;
		}
		if (!changed) return false;
		sources = next;
		tell();
		return true;
	};

	// The page is drawn again once what was changed is saved: one drawing at a time, the newest last.
	let drawing: Promise<void> | null = null;
	let again = false;
	const redraw = async () => {
		if (drawing) {
			again = true;
			return drawing;
		}
		drawing = (async () => {
			do {
				again = false;
				await options.rerender();
			} while (again);
		})();
		try {
			await drawing;
		} finally {
			drawing = null;
		}
	};
	let remoteTimer: number | undefined;
	const redrawSoon = () => {
		window.clearTimeout(remoteTimer);
		remoteTimer = window.setTimeout(() => void redraw(), REMOTE_DELAY_MS);
	};

	/** Waits until a Draft has saved what was sent (or can't): true when it has. */
	const saved = async (client: DraftClient): Promise<boolean> => {
		client.flush();
		const started = Date.now();
		while (Date.now() - started < SAVE_WAIT_MS) {
			const status = client.status();
			if (status === "saved") return true;
			if (status !== "saving" && status !== "connecting") return false;
			await new Promise((resolve) => setTimeout(resolve, 40));
		}
		return false;
	};

	const openDraft = (kind: "template" | "component", id: string) => {
		if (drafts.has(id)) return;
		const url = new URL(`/_webcraft/edit/drafts/${kind}/${id}`, window.location.href);
		url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
		const client = createDraftClient({
			onChange: (draft, from) => {
				const tree = treeIn(kind, draft);
				// Someone else's change to it (not the Draft as it was opened): the page shows it too.
				if (tree && follow(id, tree, propsIn(kind, draft)) && from === "remote") redrawSoon();
			},
			onRefused: (refusal) => {
				options.failed();
				announce(fill(said.refused, { reason: refusal.code }), true);
			},
		});
		const stop = connect(client, url, options.token);
		const unregister = history.register(resourceOf(kind, id), {
			reverse: async (from, to) => {
				const result = await client.reverse(from, to);
				if (result.ok) {
					const tree = treeIn(kind, client.draft());
					if (tree) follow(id, tree, propsIn(kind, client.draft()));
					void saved(client).then(() => redraw());
				}
				return result;
			},
		});
		drafts.set(id, { client, kind, stop, unregister });
	};

	/** Opens a source by the page's reference to it. */
	const load = async (ref: string) => {
		if (!path || sources.has(ref) || opening.has(ref)) return;
		const asked = generation;
		opening.add(ref);
		const answer = await request<EditorAnswer>("code/editor", { path, ref });
		opening.delete(ref);
		if (asked !== generation || !answer.ok) return;
		const { opened, target, editable } = answer.data;
		const kind = target.kind === "component" ? "component" : "template";
		const id = opened.component?.id ?? opened.template?.id ?? null;
		const draft = id ? drafts.get(id)?.client.draft() : undefined;
		const fromDraft = draft !== undefined ? treeIn(kind, draft) : null;
		const propsFromDraft = draft !== undefined ? propsIn(kind, draft) : null;
		const source: StructureSource = {
			ref: answer.data.ref,
			kind,
			id,
			name: opened.component?.name ?? answer.data.name ?? opened.postType?.name ?? null,
			target,
			editable: editable && id !== null,
			tree: fromDraft && fromDraft.nodes.length > 0 ? fromDraft : opened.tree,
			props: kind === "component" ? (propsFromDraft ?? opened.props ?? []) : null,
			catalogue: opened.catalogue,
			pages: opened.usage?.pages ?? null,
			pageLayout: answer.data.pageLayout,
			contentAvailable: answer.data.contentAvailable,
		};
		sources = new Map(sources).set(source.ref, source);
		if (id && editable) openDraft(kind, id);
		tell();
		// The Site template opened first says what the outlet shows: a Template's elements, or a Page layout.
		if (source.ref === "site") {
			if (source.pageLayout) void readLayout(source.pageLayout.id, asked);
			// The content's references open where the content is a Template's, and a Page's Placements
			// (`content/<placement id>`, BA-09); the Site template's own always do.
			for (const waiting of pending.splice(0)) {
				if (waiting.startsWith("site") || source.contentAvailable || placementOnPage(waiting, source))
					void load(waiting);
			}
		}
	};

	/** References the page names whose source waits for the Site template's answer (Templates or a Page layout). */
	const pending: string[] = [];

	/** Whether a reference is a Page's Placement (or something in one) while the Site template says the page is a Page. */
	const placementOnPage = (ref: string, site: StructureSource | undefined) =>
		Boolean(site?.pageLayout) && ref.startsWith("content/");

	const readLayout = async (entryId: string, asked: number) => {
		try {
			const read = await managementApi(options.token).pageLayouts.get({ siteId: options.siteId, entryId });
			if (asked !== generation) return;
			layout = read.placements.map((placement) => ({
				id: placement.id,
				name: placement.componentName,
				hidden: placement.hidden,
				component: placement.component,
				locked: placement.locked,
				props: placement.props as FieldDefinition[],
				values: placement.values as Record<string, unknown>,
			}));
			layoutInfo = {
				entryId,
				canArrange: read.canArrange,
				canLock: read.canLock,
				language: read.language,
				defaultLanguage: read.defaultLanguage,
			};
			tell();
		} catch {
			// Without it the tree shows the Site template only.
		}
	};

	/**
	 * What the canvas selected, as the Structure selects it. On a Page (outside the Component edited in
	 * place) an element a Placement shows selects the Placement: a Page holds placed Components, whose
	 * elements are changed by editing the Component in place. While one is edited in place, a selection
	 * outside it is refused: the page keeps what was selected.
	 */
	const fromCanvas = (ref: string | null): string | null | undefined => {
		// While a Component is edited in place, nothing outside it is selected (its elements are, or what was).
		if (ref === null) return inPlace ? undefined : null;
		const source = sourceOf(ref);
		if (inPlace) return source === inPlace || source.startsWith(`${inPlace}/`) ? ref : undefined;
		const site = sources.get("site");
		if (site?.pageLayout && source.startsWith("content/")) return `content/${source.split("/")[1]}`;
		return ref;
	};

	return {
		page(next) {
			if (next === path) return;
			path = next;
			generation++;
			sources = new Map();
			layout = null;
			layoutInfo = null;
			selected = null;
			inPlace = null;
			opening.clear();
			pending.length = 0;
			tell();
		},
		found(document) {
			if (!path) return;
			const refs = new Set<string>(["site"]);
			for (const element of document.querySelectorAll("[data-wc-code]")) {
				const ref = sourceOf(element.getAttribute("data-wc-code") ?? "");
				// Each Placement on the way to a Component's element is a source of its own.
				const parts = ref.split("/");
				for (let at = 1; at <= parts.length; at++) refs.add(parts.slice(0, at).join("/"));
			}
			const site = sources.get("site");
			for (const ref of refs) {
				if (ref === "site" || ref.startsWith("site/")) void load(ref);
				// The content's sources open once the Site template says the page's content is a Template's,
				// or that it is a Page (its Placements open, not its Page layout itself).
				else if (site?.contentAvailable || placementOnPage(ref, site)) void load(ref);
				else if (!site && !pending.includes(ref)) pending.push(ref);
			}
		},
		select(ref, from = "panel") {
			const wanted = from === "canvas" ? fromCanvas(ref) : ref;
			if (wanted === undefined) {
				// Outside the Component edited in place: the page goes back to what is selected.
				announce(words.placements.locked);
				options.onSelect(selected);
				return;
			}
			if (wanted === selected) {
				// The canvas outlined an element of the Placement selected: it outlines the Placement again.
				if (from === "canvas" && wanted !== ref) options.onSelect(wanted);
				return;
			}
			selected = wanted;
			tell();
			if (from !== "canvas" || wanted !== ref) options.onSelect(wanted);
		},
		snapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		change(ref, next, label, select) {
			const source = sources.get(ref);
			if (!source?.id || !source.editable) return fill(said.readOnly, { name: source?.name ?? said.thisSource });
			const problem = treeProblem(next, {
				elements: new Set(source.catalogue.elements),
				commands: new Set(source.catalogue.commands),
			});
			if (problem) return problem.message;
			const open = drafts.get(source.id);
			const status = open?.client.status();
			if (!open || (status !== "saved" && status !== "saving" && status !== "offline")) return said.connecting;
			const before = open.client.draft();
			const changed = open.client.change(
				open.kind === "component"
					? { ...(before as Record<string, Json>), tree: next as unknown as Json }
					: (next as unknown as Json),
			);
			if (!changed) return said.connecting;
			const resource = resourceOf(open.kind, source.id);
			const key = select === undefined ? keyOf(selected ?? "") : select;
			editorHistory().record({
				resource,
				before,
				after: open.client.draft(),
				label,
				location: { siteId: options.siteId, draft: resource, panel: "tree", ref, selection: key, title: label },
			});
			follow(source.id, next);
			if (select !== undefined) {
				selected = select === null ? null : `${ref}#${select}`;
				tell();
			}
			announce(label);
			const id = source.id;
			void saved(open.client).then((ok) => {
				if (!ok) {
					options.failed();
					announce(said.notSaved, true);
				}
				void redraw().then(() => {
					// The canvas outlines the selection where the page now draws it.
					if (drafts.has(id)) options.onSelect(selected);
				});
			});
			return null;
		},
		changeProps(ref, props, label) {
			const source = sources.get(ref);
			if (source?.kind !== "component" || !source.id || !source.editable)
				return fill(said.readOnly, { name: source?.name ?? said.thisSource });
			const open = drafts.get(source.id);
			const status = open?.client.status();
			if (!open || (status !== "saved" && status !== "saving" && status !== "offline")) return said.connecting;
			const before = open.client.draft();
			if (!open.client.change({ ...(before as Record<string, Json>), props: props as unknown as Json }))
				return said.connecting;
			const resource = resourceOf("component", source.id);
			editorHistory().record({
				resource,
				before,
				after: open.client.draft(),
				label,
				location: {
					siteId: options.siteId,
					draft: resource,
					panel: "tree",
					ref,
					selection: keyOf(selected ?? ""),
					title: label,
				},
			});
			follow(source.id, source.tree, props);
			announce(label);
			const id = source.id;
			void saved(open.client).then((ok) => {
				if (!ok) {
					options.failed();
					announce(said.notSaved, true);
				}
				void redraw().then(() => {
					if (drafts.has(id)) options.onSelect(selected);
				});
			});
			return null;
		},
		async reloadLayout() {
			const entryId = layoutInfo?.entryId ?? sources.get("site")?.pageLayout?.id;
			if (entryId) await readLayout(entryId, generation);
		},
		editInPlace(ref) {
			if (ref === inPlace) return;
			inPlace = ref;
			tell();
		},
		async createClass(name) {
			// The Class is the Design system's: taking the element's change back leaves it there, unused, as
			// Code mode always has (a Class is never deleted from an element's panel).
			const made = await request<{ class: { id: string; name: string } }>("code/createClass", { name });
			if (!made.ok) return { refused: fill(said.classRefused, { name, reason: made.code }) };
			return { id: made.data.class.id, name: made.data.class.name };
		},
		destroy() {
			window.clearTimeout(remoteTimer);
			for (const open of drafts.values()) {
				open.unregister();
				open.client.close();
				open.stop();
			}
			drafts.clear();
			listeners.clear();
		},
	};
}

/** The key of a selection in a tree (an element's id, or where a node without one is). */
export function keyIn(tree: ElementTree, at: Selection): string | null {
	return selectionKey(tree, at);
}
