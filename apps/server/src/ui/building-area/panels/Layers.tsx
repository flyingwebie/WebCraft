import { type Json, sameValue } from "@webcraft/core/draft-document";
import { type ElementTree, type TreeNode, writeExpression } from "@webcraft/renderer/builder";
import {
	ChevronDownIcon,
	ChevronRightIcon,
	CodeXmlIcon,
	ComponentIcon,
	CopyPlusIcon,
	EyeIcon,
	EyeOffIcon,
	GitBranchIcon,
	LayersIcon,
	LayoutTemplateIcon,
	RepeatIcon,
	SquareDashedIcon,
	Trash2Icon,
	TypeIcon,
} from "lucide-react";
import {
	type DragEvent,
	type KeyboardEvent,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";

import { matches } from "../../builder/shortcuts.ts";
import {
	canHoldChildren,
	childLists,
	type DropPosition,
	dropPositionAt,
	insertAt,
	isFormatting,
	moveDown,
	moveIntoPrevious,
	moveOut,
	moveTo,
	moveUp,
	type NodePath,
	nodeAt,
	pathKey,
	placeBy,
	placeOf,
	removeAt,
	replaceAt,
	withNewIds,
} from "../../builder/tree.ts";
import { fill, type Words } from "../api.ts";
import { CHROME_EASE, FOCUS_RING, Tip } from "../controls.tsx";
import { holdsFixedText } from "../editing/fixed-text.ts";
import { type Hovered, hover, hoveredNow, subscribeHover } from "../editing/hover.ts";
import type { PageLayoutEditor } from "../editing/page-layout.ts";
import {
	keyOf,
	type LayoutPlacement,
	type Structure,
	type StructureSnapshot,
	type StructureSource,
	sourceOf,
} from "../editing/selection.ts";
import { RowMenu, type RowMenuHost } from "./RowMenu.tsx";

/**
 * The Layers panel for Staff (SPEC 5, `builder/01`, `builder/02`, `docking/07`; BA-08): the whole page
 * as one tree, from the Site template down through the page's content (its Entry, Archive or Search
 * results template, or a Page's Page layout) and into each Component its Placements show. Rows are 26
 * high, indented 14 per level; an element shows its tag and first Classes, a Placement its Component's
 * name and on how many pages it shows. Under the pointer (or with focus) a row offers Hide (Placements),
 * Duplicate and Delete.
 *
 * It is an ARIA tree with one tab stop: the arrows move between rows (selecting each, as the canvas
 * does) and open and close them, Home and End go to the ends, Alt with the arrows moves the selected
 * element (up, down, into the one before it, out of its parent), Delete removes it and ⌘D / Ctrl+D
 * duplicates it. Each change is one Undo step, made through its Template's or Component's shared Draft.
 *
 * A Page's Placements (BA-09) are rows of its Page layout: Alt with ↑ or ↓, or a drag, moves one among
 * them (the Site template's rows around them are locked, and so is a locked Placement for those who may
 * not lock), Hide, Duplicate and Delete act on the Page's Draft; each is one Undo step too. A drag moves
 * an element within its own Template or Component. While a Component is edited in place, its rows open
 * under its Placement and every other row is dimmed and locked.
 */

/** One row of the tree. */
type Row =
	| { kind: "divider"; key: string; label: string; icon: "site" | "content" | "layout"; depth: number }
	/** An empty element's or an empty Page layout's dashed slot (BA-10, `docking/07`): shown, never focused. */
	| { kind: "slot"; key: string; label: string; depth: number }
	/**
	 * A later branch of a Condition or a Loop (BA-33): Else if …, Else, When there are no items. It is
	 * selected as `<source>#<key>/<list>`, and what is pasted on it goes into it.
	 */
	| {
			kind: "branch";
			key: string;
			ref: string;
			source: StructureSource;
			/** Its Condition's or Loop's path, and which of its lists it is. */
			path: NodePath;
			list: number;
			label: string;
			depth: number;
			expandable: boolean;
			expanded: boolean;
			parent: string | null;
	  }
	| {
			kind: "node";
			key: string;
			/** The selection's reference: `<source>#<id or @path>`. */
			ref: string;
			source: StructureSource;
			path: NodePath;
			node: TreeNode;
			depth: number;
			expandable: boolean;
			expanded: boolean;
			/** For a Placement, its Component's source when the page shows it (its rows nest under it). */
			nested: StructureSource | null;
			parent: string | null;
	  }
	| {
			kind: "placement";
			key: string;
			placement: LayoutPlacement;
			depth: number;
			parent: string | null;
			/** Its place in the Page layout. */
			index: number;
			/** Its Component's source while it is edited in place (its rows nest under it). */
			nested: StructureSource | null;
			expandable: boolean;
			expanded: boolean;
			/** On how many published pages its Component shows, once the page has opened it. */
			pages: number | null;
	  };

/** What a node is called in a row: its tag (or Component, command), and a quieter detail. */
function rowName(
	node: TreeNode,
	source: StructureSource,
	nested: StructureSource | null,
): { name: string; detail: string } {
	switch (node.type) {
		case "element": {
			const classes = node.classes
				.map(
					(id) =>
						source.catalogue.classes.find((each) => each.id === id && !each.generated)?.name ??
						source.catalogue.utilities.find((each) => each.id === id)?.name,
				)
				.filter((name): name is string => Boolean(name))
				.slice(0, 2);
			return {
				name: node.label ?? node.tag,
				detail: [node.label ? node.tag : "", classes.length ? `.${classes.join(" .")}` : ""].filter(Boolean).join(" "),
			};
		}
		case "component":
			return {
				name:
					nested?.name ??
					source.catalogue.components.find((component) => component.id === node.component)?.name ??
					node.component,
				detail: "",
			};
		case "loop":
			return { name: `Loop ${node.source}`, detail: `as ${node.alias}` };
		case "condition":
			return { name: "{{@if}}", detail: "" };
		case "text":
			return { name: `“${node.text.replace(/\s+/g, " ").trim().slice(0, 40)}”`, detail: "" };
		case "value":
			return { name: `{{ ${node.path} }}`, detail: "" };
		default:
			return { name: `{{@${node.type}}}`, detail: "" };
	}
}

/** The label of the content the Site template's outlet shows. */
function contentLabel(words: Words, site: StructureSource, content: StructureSource | undefined): string | null {
	const said = words.structure;
	if (site.pageLayout) return fill(said.pageLayout, { name: site.pageLayout.title });
	if (!content) return null;
	switch (content.target.kind) {
		case "entryTemplate":
			return fill(said.entryTemplate, { name: content.name ?? "" });
		case "archiveTemplate":
			return fill(said.archiveTemplate, { name: content.name ?? "" });
		case "searchTemplate":
			return said.searchTemplate;
		default:
			return null;
	}
}

/** Whether a tree holds the outlet (`{{@outlet}}`) somewhere: its elements open towards it at first. */
function holdsOutlet(node: TreeNode): boolean {
	return node.type === "outlet" || childLists(node).some((list) => list.some(holdsOutlet));
}

/** Whether a source is `ref` or one of the sources nested under it (`content/a` holds `content/a/b`). */
function within(source: string, ref: string): boolean {
	return source === ref || source.startsWith(`${ref}/`);
}

/**
 * Whether the selection is inside a node: among its descendants in its own source, or in the Component
 * of a Placement it holds (or of the Placement it is). The tree opens towards it.
 */
function holdsSelection(
	node: TreeNode,
	source: StructureSource,
	nested: StructureSource | null,
	selected: string | null,
): boolean {
	if (!selected) return false;
	const at = sourceOf(selected);
	if (nested) return within(at, nested.ref);
	const key = keyOf(selected);
	const found = (list: readonly TreeNode[]): boolean =>
		list.some(
			(child) =>
				(at === source.ref && "id" in child && child.id === key) ||
				(child.type === "component" && within(at, `${source.ref}/${child.id}`)) ||
				childLists(child).some(found),
		);
	return found(childLists(node).flat());
}

/** The rows the tree shows: every node but formatting, inside what is open. */
function rowsOf(
	snapshot: StructureSnapshot,
	words: Words,
	expandedOf: (key: string, opened: boolean) => boolean,
): Row[] {
	const rows: Row[] = [];
	const site = snapshot.sources.get("site");
	if (!site) return rows;
	const content = snapshot.sources.get("content");
	const selected = snapshot.selection?.ref ?? null;
	const onTheWay = (ref: string) => selected !== null && selected !== ref && within(sourceOf(selected), sourceOf(ref));

	const visit = (
		source: StructureSource,
		nodes: readonly TreeNode[],
		prefix: number[],
		depth: number,
		parent: string | null,
	) => {
		nodes.forEach((node, index) => {
			if (isFormatting(node) || node.type === "comment" || node.type === "text" || node.type === "value") return;
			const path = [...prefix, index];
			if (node.type === "outlet") {
				const label = contentLabel(words, site, content);
				if (label) rows.push({ kind: "divider", key: `${source.ref}:outlet`, label, icon: "layout", depth });
				// An empty Page layout says where Components go (`builder/04`).
				if (site.pageLayout && snapshot.layout?.length === 0)
					rows.push({
						kind: "slot",
						key: `${source.ref}:outlet:empty`,
						label: words.insert.dropComponent,
						depth: depth + 1,
					});
				if (site.pageLayout && snapshot.layout) {
					snapshot.layout.forEach((placement, index) => {
						const key = `layout:${placement.id}`;
						const ref = `content/${placement.id}`;
						// A Page's Placement opens on its Component's elements while it is edited in place.
						const nested = snapshot.inPlace === ref ? (snapshot.sources.get(ref) ?? null) : null;
						const expandable = Boolean(nested?.tree.nodes.some((child) => !isFormatting(child)));
						const expanded = expandable && expandedOf(key, true);
						const pages = snapshot.sources.get(ref)?.pages ?? null;
						rows.push({ kind: "placement", key, placement, depth, parent, index, nested, expandable, expanded, pages });
						if (expanded && nested) visit(nested, nested.tree.nodes, [], depth + 1, key);
					});
				} else if (content) visit(content, content.tree.nodes, [], depth, parent);
				return;
			}
			const id = "id" in node ? node.id : `@${path.join(".")}`;
			const ref = `${source.ref}#${id}`;
			const nested = node.type === "component" ? (snapshot.sources.get(`${source.ref}/${node.id}`) ?? null) : null;
			const children = nested ? nested.tree.nodes : (childLists(node)[0] ?? []);
			const shown = (child: TreeNode) =>
				!isFormatting(child) && child.type !== "comment" && child.type !== "text" && child.type !== "value";
			// A Condition's or Loop's later lists are branches of their own (Else, When there are no items).
			const branches = nested ? [] : childLists(node).slice(1);
			const expandable = children.some(shown) || branches.length > 0;
			const opened =
				expandable && (holdsOutlet(node) || (onTheWay(ref) && holdsSelection(node, source, nested, selected)));
			const expanded = expandable && expandedOf(`${source.ref}:${pathKey(path)}`, opened);
			rows.push({
				kind: "node",
				key: `${source.ref}:${pathKey(path)}`,
				ref,
				source,
				path,
				node,
				depth,
				expandable,
				expanded,
				nested,
				parent,
			});
			// An element that holds nothing yet shows its empty slot (SPEC 6: empty elements are never invisible).
			if (node.type === "element" && canHoldChildren(node) && node.children.length === 0)
				rows.push({
					kind: "slot",
					key: `${source.ref}:${pathKey(path)}:empty`,
					label: words.insert.emptySlot,
					depth: depth + 1,
				});
			if (!expanded) return;
			const rowKey = `${source.ref}:${pathKey(path)}`;
			if (nested) visit(nested, nested.tree.nodes, [], depth + 1, rowKey);
			else visit(source, children, [...path, 0], depth + 1, rowKey);
			branches.forEach((list, index) => {
				const at = index + 1;
				const key = `${rowKey}/${at}`;
				const label =
					node.type === "condition"
						? node.branches[at]
							? `${words.layers.elseIf} ${writeExpression(node.branches[at].test)}`
							: words.layers.else
						: words.layers.empty;
				const open = list.some(shown);
				const branchExpanded = open && expandedOf(key, true);
				rows.push({
					kind: "branch",
					key,
					ref: `${source.ref}#${id}/${at}`,
					source,
					path,
					list: at,
					label,
					depth: depth + 1,
					expandable: open,
					expanded: branchExpanded,
					parent: rowKey,
				});
				// An empty branch shows its slot, as an empty element does.
				if (!open) rows.push({ kind: "slot", key: `${key}:empty`, label: words.insert.emptySlot, depth: depth + 2 });
				else if (branchExpanded) visit(source, list, [...path, at], depth + 2, key);
			});
		});
	};
	rows.push({ kind: "divider", key: "site:divider", label: words.structure.siteTemplate, icon: "site", depth: 0 });
	visit(site, site.tree.nodes, [], 0, null);
	return rows;
}

/** The pixel indent of a row: 14 per level (SPEC 4). */
const INDENT = 14;

export function Layers({
	structure,
	words,
	layout,
	menu,
}: {
	structure: Structure;
	words: Words;
	/** A Page's Page layout, as its Placements' rows change it (BA-09). */
	layout: PageLayoutEditor;
	/** An element row's menu (BA-10): Copy, Paste, Duplicate, Wrap in, Make Component, Delete. */
	menu?: RowMenuHost;
}) {
	const snapshot = useSyncExternalStore(structure.subscribe, structure.snapshot);
	const said = words.structure;
	const placed = words.placements;
	/** Rows the person opened or closed themselves; the others follow the outlet and the selection. */
	const [toggled, setToggled] = useState<ReadonlyMap<string, boolean>>(new Map());
	const rows = useMemo(
		() => rowsOf(snapshot, words, (key, opened) => toggled.get(key) ?? opened),
		[snapshot, words, toggled],
	);
	const selectedRef = snapshot.selection?.ref ?? null;
	const selectedRow = rows.find(
		(row) =>
			((row.kind === "node" || row.kind === "branch") && row.ref === selectedRef) ||
			(row.kind === "placement" && `content/${row.placement.id}` === selectedRef),
	);
	const [focusKey, setFocusKey] = useState<string | null>(null);
	const list = useRef<HTMLDivElement>(null);
	const focusable = rows.filter(
		(row): row is Extract<Row, { kind: "node" | "placement" | "branch" }> =>
			row.kind !== "divider" && row.kind !== "slot",
	);
	// What is under the pointer across the views (BA-33): a row hovered outlines its element on the canvas.
	const hovered = useSyncExternalStore(subscribeHover, hoveredNow);
	/** The row being renamed in place (F2, a double-click), by its key. */
	const [renaming, setRenaming] = useState<string | null>(null);
	/**
	 * The layer picked up with Space (BA-33): the arrow keys move it, each move made without a step of
	 * its own; Space puts it down as one Undo step, Escape puts it back. A peer's change meanwhile means
	 * it can no longer be put back: Escape then puts it down where it is.
	 */
	const [picked, setPicked] = useState<{
		ref: string;
		source: string;
		name: string;
		before: Json;
		last: Json;
		invalid: boolean;
	} | null>(null);
	/** The row whose menu is open, and where (BA-10). */
	const [rowMenu, setRowMenu] = useState<{ key: string; name: string; at: { x: number; y: number } } | null>(null);
	// The selection inside a branch someone closed (a caret in its text, BA-33): the nearest row shown
	// around it keeps the tree's tab stop, so the tree is still reached where the selection is.
	const aroundSelection = selectedRow
		? undefined
		: [...focusable]
				.reverse()
				.find((row) =>
					row.kind === "node"
						? holdsSelection(row.node, row.source, row.nested, selectedRef)
						: row.kind === "placement"
							? selectedRef !== null && within(sourceOf(selectedRef), `content/${row.placement.id}`)
							: false,
				);
	const tabStop =
		(selectedRow ?? aroundSelection ?? focusable.find((row) => row.key === focusKey) ?? focusable[0])?.key ?? null;

	// The selected row is brought into view as the selection changes (from the canvas, Undo, the address).
	useEffect(() => {
		if (!selectedRow) return;
		list.current
			?.querySelector<HTMLElement>(`[data-wc-row="${CSS.escape(selectedRow.key)}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [selectedRow]);

	const toggle = (key: string, open: boolean) => setToggled((was) => new Map(was).set(key, open));

	const focusRow = (key: string | null) => {
		if (!key) return;
		setFocusKey(key);
		requestAnimationFrame(() =>
			list.current?.querySelector<HTMLElement>(`[data-wc-row="${CSS.escape(key)}"]`)?.focus(),
		);
	};

	/** Whether a row is outside the Component edited in place: dimmed, and refused. */
	const lockedRow = (row: Row): boolean => {
		const inPlace = snapshot.inPlace;
		if (!inPlace || row.kind === "divider" || row.kind === "slot") return false;
		// The Placement of a Template whose Component is edited in place is that Component's row.
		if (row.kind === "node" && row.nested && within(row.nested.ref, inPlace)) return false;
		const ref = row.kind === "node" || row.kind === "branch" ? sourceOf(row.ref) : `content/${row.placement.id}`;
		return !within(ref, inPlace);
	};

	const choose = (row: Row) => {
		setFocusKey(row.key);
		if (lockedRow(row)) {
			announceRefusal(placed.locked);
			return;
		}
		if (row.kind === "node" || row.kind === "branch") structure.select(row.ref);
		// A Page layout's Placement: the Props panel opens on it.
		else if (row.kind === "placement") structure.select(`content/${row.placement.id}`);
	};

	/** Answers a Page layout change: said when refused. */
	const layoutDone = (refused: string | null) => {
		if (refused) announceRefusal(refused);
		return refused === null;
	};
	const placements = snapshot.layout ?? [];
	const actOnPlacement = (row: Extract<Row, { kind: "placement" }>, action: "hide" | "duplicate" | "delete") => {
		const id = row.placement.id;
		if (action === "hide") {
			layoutDone(layout.hide(placements, id));
			return;
		}
		if (action === "duplicate") {
			const made = layout.duplicate(placements, id);
			if ("refused" in made) announceRefusal(made.refused);
			else {
				structure.select(`content/${made.id}`);
				setFocusKey(`layout:${made.id}`);
			}
			return;
		}
		const at = focusable.findIndex((each) => each.key === row.key);
		const next = focusable[at + 1] ?? focusable[at - 1];
		if (layoutDone(layout.remove(placements, id))) {
			structure.select(null);
			if (next) focusRow(next.key);
		}
	};
	const movePlacement = (row: Extract<Row, { kind: "placement" }>, to: number) => {
		if (layoutDone(layout.move(placements, row.placement.id, to))) focusRow(row.key);
	};

	/** Changes the tree of a row's source; answers whether it was taken (else it was said why not). */
	const change = (row: Extract<Row, { kind: "node" }>, next: ElementTree, label: string, select?: string | null) => {
		const refused = structure.change(row.source.ref, next, label, select);
		if (refused) {
			announceRefusal(refused);
			return false;
		}
		return true;
	};
	const [refusal, setRefusal] = useState({ text: "", count: 0 });
	const announceRefusal = (text: string) => setRefusal((was) => ({ text, count: was.count + 1 }));

	const nameOfRow = (row: Extract<Row, { kind: "node" }>) => rowName(row.node, row.source, row.nested).name;

	const act = (row: Extract<Row, { kind: "node" }>, action: "hide" | "duplicate" | "delete") => {
		const tree = row.source.tree;
		const name = nameOfRow(row);
		if (action === "hide" && row.node.type === "component") {
			const hidden = !row.node.hidden;
			change(
				row,
				replaceAt(tree, row.path, { ...row.node, hidden }),
				fill(hidden ? said.steps.hide : said.steps.show, { name }),
			);
			return;
		}
		if (action === "duplicate") {
			const [copy] = withNewIds(tree, [row.node]);
			if (!copy) return;
			const place = placeOf(row.path);
			const made = insertAt(tree, { ...place, index: place.index + 1 }, [copy]);
			const key = "id" in copy ? copy.id : `@${made.path.join(".")}`;
			if (change(row, made.tree, fill(said.steps.duplicate, { name }), key))
				focusRow(`${row.source.ref}:${pathKey(made.path)}`);
			return;
		}
		if (action === "delete") {
			const at = focusable.findIndex((each) => each.key === row.key);
			const next = focusable[at + 1] ?? focusable[at - 1];
			if (change(row, removeAt(tree, row.path), fill(said.steps.delete, { name }), null) && next) focusRow(next.key);
		}
	};

	const move = (row: Extract<Row, { kind: "node" }>, how: "up" | "down" | "in" | "out") => {
		const moved = { up: moveUp, down: moveDown, in: moveIntoPrevious, out: moveOut }[how](row.source.tree, row.path);
		if ("refused" in moved) {
			announceRefusal(moved.refused);
			return;
		}
		const key = "id" in row.node ? row.node.id : `@${moved.path.join(".")}`;
		if (change(row, moved.tree, fill(said.steps.move, { name: nameOfRow(row) }), key))
			focusRow(`${row.source.ref}:${pathKey(moved.path)}`);
	};

	const openRowMenu = (row: Extract<Row, { kind: "node" }>, at: { x: number; y: number } | null) => {
		choose(row);
		const element = list.current?.querySelector<HTMLElement>(`[data-wc-row="${CSS.escape(row.key)}"]`);
		const box = element?.getBoundingClientRect();
		setRowMenu({
			key: row.key,
			name: nameOfRow(row),
			at: at ?? { x: (box?.left ?? 0) + 16, y: (box?.bottom ?? 0) + 2 },
		});
	};

	/** Where a node is among its siblings, for what a keyboard move says ("2 of 4 in article"). */
	const positionOf = (source: StructureSource, path: NodePath) => {
		const place = placeOf(path);
		const owner = place.owner?.length ? (nodeAt(source.tree, place.owner) ?? null) : null;
		const siblings = (owner ? childLists(owner)[place.list] : source.tree.nodes) ?? [];
		const counted = siblings.filter((each) => !isFormatting(each) && each.type !== "comment");
		const index = counted.indexOf(siblings[place.index] as TreeNode);
		const parent =
			owner?.type === "element" ? (owner.label ?? owner.tag) : owner ? rowName(owner, source, null).name : said2.top;
		return { position: String(index + 1), count: String(counted.length), parent };
	};
	const said2 = words.layers;
	/** The tree a source's Draft document holds (a Component's is inside it). */
	const treeOfDraft = (source: StructureSource, draft: Json): ElementTree =>
		(source.kind === "component" ? (draft as { tree: ElementTree }).tree : draft) as unknown as ElementTree;
	const pickUp = (row: Extract<Row, { kind: "node" }>) => {
		const before = structure.draft(row.source.ref);
		if (!before) return;
		choose(row);
		const name = nameOfRow(row);
		setPicked({ ref: row.ref, source: row.source.ref, name, before, last: before, invalid: false });
		announceRefusal(fill(said2.picked, { name }));
	};
	/** Puts the picked layer down where it is: its moves are one Undo step. */
	const putDown = (say = true) => {
		if (!picked) return;
		setPicked(null);
		const now = structure.draft(picked.source);
		const moved = !sameValue(picked.before, picked.last);
		if (moved)
			structure.record(picked.source, picked.before, picked.last, fill(said.steps.move, { name: picked.name }));
		const row = rows.find((each) => each.kind === "node" && each.ref === picked.ref);
		if (say && row?.kind === "node")
			announceRefusal(fill(said2.putDown, { name: picked.name, ...positionOf(row.source, row.path) }));
		void now;
	};
	/** Puts the picked layer back where it was, unless someone changed its source meanwhile. */
	const putBack = () => {
		if (!picked) return;
		const source = snapshot.sources.get(picked.source);
		if (picked.invalid || !source) {
			announceRefusal(said2.cantCancel);
			putDown(false);
			return;
		}
		setPicked(null);
		if (!sameValue(picked.before, picked.last)) {
			const refused = structure.change(
				source.ref,
				treeOfDraft(source, picked.before),
				fill(said2.putBack, { name: picked.name }),
				keyOf(picked.ref),
				undefined,
				{ record: false },
			);
			if (refused) announceRefusal(refused);
		} else announceRefusal(fill(said2.putBack, { name: picked.name }));
		// Back where it was: its row is found by its reference once the tree shows it there.
		const ref = picked.ref;
		requestAnimationFrame(() =>
			requestAnimationFrame(() =>
				list.current?.querySelector<HTMLElement>(`[data-wc-ref="${CSS.escape(ref)}"]`)?.focus(),
			),
		);
	};
	/** Moves the picked layer one step (no Undo step of its own). */
	const movePicked = (row: Extract<Row, { kind: "node" }>, how: "up" | "down" | "in" | "out") => {
		if (!picked) return;
		const moved = { up: moveUp, down: moveDown, in: moveIntoPrevious, out: moveOut }[how](row.source.tree, row.path);
		if ("refused" in moved) {
			announceRefusal(moved.refused);
			return;
		}
		const key = "id" in row.node ? row.node.id : `@${moved.path.join(".")}`;
		const refused = structure.change(
			row.source.ref,
			moved.tree,
			fill(said2.position, { name: picked.name, ...positionOf({ ...row.source, tree: moved.tree }, moved.path) }),
			key,
			undefined,
			{ record: false },
		);
		if (refused) {
			announceRefusal(refused);
			return;
		}
		const last = structure.draft(row.source.ref) ?? picked.last;
		setPicked({ ...picked, ref: `${row.source.ref}#${key}`, last });
		focusRow(`${row.source.ref}:${pathKey(moved.path)}`);
	};
	// Someone else changed the picked layer's source meanwhile: it can no longer be put back.
	useEffect(() => {
		if (!picked || picked.invalid) return;
		const now = structure.draft(picked.source);
		if (now && !sameValue(now, picked.last)) {
			setPicked({ ...picked, invalid: true });
			announceRefusal(said2.cantCancel);
		}
	});

	/** Renames an element's layer in place: its Layer label (empty takes it away). */
	const rename = (row: Extract<Row, { kind: "node" }>, label: string) => {
		setRenaming(null);
		focusRow(row.key);
		if (row.node.type !== "element") return;
		const wanted = label.trim();
		if ((row.node.label ?? "") === wanted) return;
		const { label: _old, ...rest } = row.node;
		const name = wanted || row.node.tag;
		if (
			change(
				row,
				replaceAt(row.source.tree, row.path, wanted ? { ...rest, label: wanted } : rest),
				fill(said2.renameStep, { name }),
			)
		)
			announceRefusal(fill(said2.renamed, { name }));
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		if (renaming) return;
		const at = focusable.findIndex((row) => row.key === (focusKey ?? tabStop));
		const row = focusable[at];
		if (!row) return;
		const go = (next: Row | undefined) => {
			if (!next) return;
			choose(next);
			focusRow(next.key);
		};
		const node = row.kind === "node" && !lockedRow(row) ? row : null;
		const placement = row.kind === "placement" && !lockedRow(row) ? row : null;
		const branch = row.kind === "branch" && !lockedRow(row) ? row : null;
		// A layer picked up (BA-33): the arrows move it, Space puts it down, Escape puts it back.
		if (picked) {
			const moving = rows.find(
				(each): each is Extract<Row, { kind: "node" }> => each.kind === "node" && each.ref === picked.ref,
			);
			if (event.key === " ") {
				event.preventDefault();
				putDown();
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopPropagation();
				putBack();
				return;
			}
			if (moving && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
				event.preventDefault();
				const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
				const inward = rtl ? "ArrowLeft" : "ArrowRight";
				movePicked(
					moving,
					event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : event.key === inward ? "in" : "out",
				);
				return;
			}
			// Any other key puts it down where it is first.
			putDown(false);
		}
		// Pasting on a branch puts what was copied into it (BA-33).
		if (branch && menu && branch.source.editable && matches(event.nativeEvent, "tree.paste")) {
			event.preventDefault();
			menu.ops.paste();
			return;
		}
		if (node?.source.editable && matches(event.nativeEvent, "tree.cut")) {
			event.preventDefault();
			menu?.ops.cut();
			return;
		}
		if (node?.source.editable && node.node.type === "element" && matches(event.nativeEvent, "tree.rename")) {
			event.preventDefault();
			setRenaming(node.key);
			return;
		}
		if (node?.source.editable && event.key === " " && !event.altKey && !event.ctrlKey && !event.metaKey) {
			event.preventDefault();
			pickUp(node);
			return;
		}
		// The row's menu (BA-10): Shift+F10 or the menu key opens it under the row; ⌘C and ⌘V copy and paste.
		if (node && menu && node.source.editable) {
			if ((event.key === "F10" && event.shiftKey) || event.key === "ContextMenu") {
				event.preventDefault();
				openRowMenu(node, null);
				return;
			}
			if (matches(event.nativeEvent, "tree.copy")) {
				event.preventDefault();
				menu.ops.copy();
				return;
			}
			if (matches(event.nativeEvent, "tree.paste")) {
				event.preventDefault();
				menu.ops.paste();
				return;
			}
		}
		if (placement && event.altKey && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
			event.preventDefault();
			// A Page layout is one level: a Placement moves up or down among the others, never in or out.
			if (event.key === "ArrowUp") movePlacement(placement, placement.index - 1);
			else if (event.key === "ArrowDown") movePlacement(placement, placement.index + 1);
			else announceRefusal(fill(placed.layoutRefusals.edge, { name: placement.placement.name }));
			return;
		}
		if (placement && (event.key === "Delete" || event.key === "Backspace")) {
			event.preventDefault();
			actOnPlacement(placement, "delete");
			return;
		}
		if (placement && matches(event.nativeEvent, "element.duplicate")) {
			event.preventDefault();
			actOnPlacement(placement, "duplicate");
			return;
		}
		if (event.altKey && node && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) {
			event.preventDefault();
			const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
			const inward = rtl ? "ArrowLeft" : "ArrowRight";
			move(
				node,
				event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : event.key === inward ? "in" : "out",
			);
			return;
		}
		if (node && (event.key === "Delete" || event.key === "Backspace")) {
			event.preventDefault();
			act(node, "delete");
			return;
		}
		if (node && matches(event.nativeEvent, "element.duplicate")) {
			event.preventDefault();
			act(node, "duplicate");
			return;
		}
		const rtl = getComputedStyle(event.currentTarget).direction === "rtl";
		const opening = rtl ? "ArrowLeft" : "ArrowRight";
		const closing = rtl ? "ArrowRight" : "ArrowLeft";
		const opens = row;
		switch (event.key) {
			case "ArrowDown":
				event.preventDefault();
				go(focusable[at + 1]);
				return;
			case "ArrowUp":
				event.preventDefault();
				go(focusable[at - 1]);
				return;
			case "Home":
				event.preventDefault();
				go(focusable[0]);
				return;
			case "End":
				event.preventDefault();
				go(focusable[focusable.length - 1]);
				return;
			case opening:
				event.preventDefault();
				if (opens?.expandable && !opens.expanded) toggle(opens.key, true);
				else if (opens?.expandable) go(focusable[at + 1]);
				return;
			case closing:
				event.preventDefault();
				if (opens?.expandable && opens.expanded) toggle(opens.key, false);
				else go(focusable.find((each) => each.key === row.parent));
				return;
			case "Enter":
			case " ":
				event.preventDefault();
				choose(row);
				return;
			default:
				return;
		}
	};

	// Drag and drop in the tree (BA-09): a Page's Placement among the Page layout's, an element within its
	// own Template or Component. Alt with the arrows does the same from the keyboard.
	const [dragging, setDragging] = useState<string | null>(null);
	const [dropAt, setDropAt] = useState<{ key: string; position: DropPosition } | null>(null);
	const rowByKey = (key: string | null) => (key ? focusable.find((row) => row.key === key) : undefined);
	const canDrag = (row: Row) =>
		!lockedRow(row) &&
		((row.kind === "placement" && Boolean(snapshot.layoutInfo?.canArrange)) ||
			(row.kind === "node" && row.source.editable));
	const positionOver = (row: Row, event: DragEvent<HTMLElement>): DropPosition => {
		const box = event.currentTarget.getBoundingClientRect();
		const y = box.height > 0 ? (event.clientY - box.top) / box.height : 0;
		return dropPositionAt(y, row.kind === "node" && canHoldChildren(row.node));
	};
	/** Drops the row being dragged at a row; says why not when it can't go there. */
	const drop = (target: Row, position: DropPosition) => {
		const moving = rowByKey(dragging);
		setDragging(null);
		setDropAt(null);
		if (!moving || moving.key === target.key) return;
		if (moving.kind === "placement") {
			// A Placement stays in its Page layout: the Site template's rows around it are locked.
			if (target.kind !== "placement") {
				announceRefusal(fill(placed.layoutRefusals.outside, { name: moving.placement.name }));
				return;
			}
			const after = position !== "before";
			const to = moving.index < target.index ? target.index - (after ? 0 : 1) : target.index + (after ? 1 : 0);
			movePlacement(moving, to);
			return;
		}
		if (moving.kind !== "node") return;
		if (target.kind !== "node" || target.source.ref !== moving.source.ref || lockedRow(target)) {
			announceRefusal(fill(placed.dragElsewhere, { name: nameOfRow(moving) }));
			return;
		}
		const moved = moveTo(moving.source.tree, moving.path, placeBy(moving.source.tree, target.path, position));
		if ("refused" in moved) {
			announceRefusal(fill(placed.dragElsewhere, { name: nameOfRow(moving) }));
			return;
		}
		const key = "id" in moving.node ? moving.node.id : `@${moved.path.join(".")}`;
		if (change(moving, moved.tree, fill(said.steps.move, { name: nameOfRow(moving) }), key))
			focusRow(`${moving.source.ref}:${pathKey(moved.path)}`);
	};
	const dragProps = (row: Row) => {
		if (row.kind === "divider" || row.kind === "slot" || row.kind === "branch") return {};
		const draggable = canDrag(row);
		return {
			draggable,
			onDragStart: (event: DragEvent<HTMLElement>) => {
				if (!draggable) return;
				event.dataTransfer.effectAllowed = "move";
				event.dataTransfer.setData("text/plain", row.key);
				setDragging(row.key);
			},
			onDragOver: (event: DragEvent<HTMLElement>) => {
				if (!dragging) return;
				event.preventDefault();
				event.dataTransfer.dropEffect = "move";
				const position = positionOver(row, event);
				if (dropAt?.key !== row.key || dropAt.position !== position) setDropAt({ key: row.key, position });
			},
			onDragLeave: () => setDropAt((was) => (was?.key === row.key ? null : was)),
			onDrop: (event: DragEvent<HTMLElement>) => {
				event.preventDefault();
				drop(row, positionOver(row, event));
			},
			onDragEnd: () => {
				setDragging(null);
				setDropAt(null);
			},
		};
	};

	if (!snapshot.sources.get("site")) {
		return <p className="text-chrome-muted px-2 py-1 text-[12px]">{said.loading}</p>;
	}

	return (
		<div className="flex min-h-0 grow flex-col" data-wc-layers="">
			<div
				ref={list}
				role="tree"
				aria-label={said.tree}
				aria-describedby="wc-layers-keys"
				onKeyDown={onKeyDown}
				onBlur={(event) => {
					// Focus leaving the tree puts a picked layer down where it is.
					if (picked && !event.currentTarget.contains(event.relatedTarget as Node | null)) putDown(false);
				}}
				onMouseLeave={() => hover(null, "tree")}
				className="-mx-1 min-h-0 grow overflow-auto px-1 pb-2"
			>
				{rows.map((row) =>
					row.kind === "slot" ? (
						<div
							key={row.key}
							role="presentation"
							className="flex h-[26px] items-center pe-1"
							style={{ paddingInlineStart: `${8 + row.depth * INDENT}px` }}
							data-wc-layers-slot=""
						>
							<span className="border-chrome-hover text-chrome-muted flex h-[22px] grow items-center justify-center rounded-[5px] border border-dashed text-[11px]">
								{row.label}
							</span>
						</div>
					) : row.kind === "divider" ? (
						<div
							key={row.key}
							role="presentation"
							className="text-chrome-muted flex h-[26px] items-center gap-1.5 text-[11px] font-semibold tracking-[0.06em] uppercase"
							style={{ paddingInlineStart: `${8 + row.depth * INDENT}px` }}
							data-wc-layers-divider=""
						>
							{row.icon === "site" ? (
								<LayoutTemplateIcon aria-hidden="true" className="size-3.5 shrink-0" />
							) : (
								<LayersIcon aria-hidden="true" className="size-3.5 shrink-0" />
							)}
							<span className="truncate">{row.label}</span>
						</div>
					) : (
						<TreeRow
							key={row.key}
							row={row}
							words={words}
							selected={
								row.kind === "node" || row.kind === "branch"
									? row.ref === selectedRef
									: selectedRef === `content/${row.placement.id}`
							}
							hovered={hoveredRow(row, hovered)}
							grabbed={row.kind === "node" && picked?.ref === row.ref}
							renaming={
								row.kind === "node" && renaming === row.key
									? {
											onDone: (label) => {
												if (label !== null) rename(row, label);
												else {
													setRenaming(null);
													focusRow(row.key);
												}
											},
										}
									: null
							}
							onRename={
								row.kind === "node" && row.node.type === "element" && row.source.editable && !lockedRow(row)
									? () => setRenaming(row.key)
									: undefined
							}
							tabStop={row.key === tabStop}
							locked={lockedRow(row)}
							inPlace={row.kind === "placement" && snapshot.inPlace === `content/${row.placement.id}`}
							drop={dropAt?.key === row.key ? dropAt.position : null}
							dragged={dragging === row.key}
							drag={dragProps(row)}
							onChoose={() => choose(row)}
							onToggle={row.expandable ? () => toggle(row.key, !row.expanded) : undefined}
							actions={
								lockedRow(row) || row.kind === "branch" ? null : row.kind === "node" ? (
									<RowActions row={row} words={words} onAction={(action) => act(row, action)} />
								) : snapshot.layoutInfo?.canArrange ? (
									<RowActions row={row} words={words} onAction={(action) => actOnPlacement(row, action)} />
								) : null
							}
							onFocus={() => setFocusKey(row.key)}
							onMenu={
								menu && row.kind === "node" && row.source.editable && !lockedRow(row)
									? (at) => openRowMenu(row, at)
									: undefined
							}
						/>
					),
				)}
			</div>
			<p id="wc-layers-keys" className="sr-only">
				{`${said.keys} ${placed.treeKeys}`}
			</p>
			<p className="sr-only" role="status" aria-live="polite">
				{refusal.text ? `${refusal.text}${refusal.count % 2 ? " " : ""}` : ""}
			</p>
			{rowMenu && menu ? (
				<RowMenu
					words={words}
					host={menu}
					name={rowMenu.name}
					at={rowMenu.at}
					onClose={(refocus) => {
						const key = rowMenu.key;
						setRowMenu(null);
						if (refocus) focusRow(key);
					}}
				/>
			) : null}
		</div>
	);
}

/** Whether a row is the one hovered on the canvas (its element, or a Page's Placement around it). */
function hoveredRow(row: Row, hovered: Hovered): boolean {
	if (hovered?.from !== "canvas") return false;
	if (row.kind === "node") return row.ref === hovered.ref;
	if (row.kind === "placement")
		return sourceOf(hovered.ref).split("/").slice(0, 2).join("/") === `content/${row.placement.id}` && !row.expanded;
	return false;
}

function TreeRow({
	row,
	words,
	selected,
	hovered,
	grabbed,
	renaming,
	onRename,
	tabStop,
	locked,
	inPlace,
	drop,
	dragged,
	drag,
	onChoose,
	onToggle,
	actions,
	onFocus,
	onMenu,
}: {
	row: Extract<Row, { kind: "node" } | { kind: "placement" } | { kind: "branch" }>;
	words: Words;
	selected: boolean;
	/** Its element is under the pointer on the canvas (BA-33). */
	hovered: boolean;
	/** Picked up with Space, being moved with the arrows. */
	grabbed: boolean;
	/** Renamed in place now: the label's field, Enter or leaving keeps it, Escape doesn't (null). */
	renaming: { onDone(label: string | null): void } | null;
	/** Starts renaming it (a double-click). */
	onRename?: () => void;
	tabStop: boolean;
	/** Outside the Component edited in place: dimmed. */
	locked: boolean;
	/** The Placement whose Component is edited in place (`builder/06`'s tinted row). */
	inPlace: boolean;
	/** Where the row being dragged would land on this one, drawn as a line (or an outline, inside). */
	drop: DropPosition | null;
	dragged: boolean;
	drag: Record<string, unknown>;
	onChoose(): void;
	onToggle?: () => void;
	actions: ReactNode;
	onFocus(): void;
	/** Opens the row's menu at the pointer (a right-click, BA-10). */
	onMenu?: (at: { x: number; y: number }) => void;
}) {
	const said = words.structure;
	const node = row.kind === "node" ? row.node : null;
	const component = node?.type === "component" || row.kind === "placement";
	const named =
		row.kind === "node"
			? rowName(row.node, row.source, row.nested)
			: row.kind === "branch"
				? { name: row.label, detail: "" }
				: { name: row.placement.name, detail: "" };
	const pages = row.kind === "placement" ? row.pages : row.kind === "node" ? (row.nested?.pages ?? null) : null;
	const hidden = (node?.type === "component" && node.hidden) || (row.kind === "placement" && row.placement.hidden);
	const expanded = row.expandable ? row.expanded : undefined;
	const Chevron = expanded ? ChevronDownIcon : ChevronRightIcon;
	const Glyph = component
		? ComponentIcon
		: node?.type === "loop"
			? RepeatIcon
			: node?.type === "condition" || row.kind === "branch"
				? GitBranchIcon
				: node?.type === "element"
					? CodeXmlIcon
					: SquareDashedIcon;
	// Text clients can't edit (BA-33): flagged, so Staff find what to make a Prop, a Field or a Global.
	const fixed = node !== null && holdsFixedText(node);
	const label = [
		named.name,
		named.detail,
		pages !== null && pages > 1 ? fill(said.pagesOther, { count: String(pages) }) : null,
		hidden ? said.hiddenRow : null,
		fixed ? words.fixedText.badge : null,
	]
		.filter(Boolean)
		.join(" ");
	return (
		<div
			role="treeitem"
			aria-level={row.depth + 1}
			aria-selected={selected}
			aria-expanded={expanded}
			aria-label={label}
			tabIndex={tabStop ? 0 : -1}
			aria-disabled={locked || undefined}
			onClick={onChoose}
			onDoubleClick={onRename}
			onMouseEnter={() => hover(row.kind === "placement" ? `content/${row.placement.id}` : row.ref, "tree")}
			data-hovered={hovered ? "true" : undefined}
			data-grabbed={grabbed ? "true" : undefined}
			onContextMenu={
				onMenu
					? (event) => {
							event.preventDefault();
							onMenu({ x: event.clientX, y: event.clientY });
						}
					: undefined
			}
			// The tree hears the keys for every row (one tab stop, arrow keys).
			onKeyDown={() => {}}
			onFocus={(event) => {
				if (event.target === event.currentTarget) onFocus();
			}}
			{...drag}
			className={`group/row relative flex h-[26px] cursor-default items-center gap-1 rounded-[5px] pe-1 text-[12px] ${
				inPlace
					? "bg-[#a78bfa]/20 text-[#ddd6fe] shadow-[inset_2px_0_0_#a78bfa]"
					: selected
						? "text-chrome-strong bg-[#6366f1]/25 shadow-[inset_2px_0_0_#6366f1]"
						: "hover:bg-chrome-hover text-chrome-text"
			} ${hidden ? "[&>[data-wc-row-name]]:opacity-50" : ""} ${locked ? "opacity-45" : ""} ${dragged || grabbed ? "opacity-50" : ""} ${
				hovered && !selected ? "bg-chrome-hover" : ""
			} ${grabbed ? "outline-chrome-focus outline-1 -outline-offset-1 outline-dashed" : ""} ${
				drop === "inside" ? "outline-chrome-focus outline-2 -outline-offset-2 outline-dashed" : ""
			} ${CHROME_EASE} ${FOCUS_RING}`}
			style={{ paddingInlineStart: `${4 + row.depth * INDENT}px` }}
			data-wc-row={row.key}
			data-wc-ref={row.kind === "placement" ? `content/${row.placement.id}` : row.ref}
			data-wc-locked={locked ? "" : undefined}
		>
			{drop === "before" || drop === "after" ? (
				<span
					aria-hidden="true"
					className={`bg-chrome-focus pointer-events-none absolute inset-x-0 h-0.5 rounded-full ${drop === "before" ? "-top-px" : "-bottom-px"}`}
					data-wc-drop-line={drop}
				/>
			) : null}
			<span aria-hidden="true" className="text-chrome-faint grid size-3.5 shrink-0 place-items-center">
				{onToggle ? (
					<Chevron
						className={expanded ? "size-3.5" : "size-3.5 rtl:rotate-180"}
						onClick={(event) => {
							event.stopPropagation();
							onToggle();
						}}
					/>
				) : null}
			</span>
			<Glyph
				aria-hidden="true"
				className={`size-3.5 shrink-0 ${component ? "text-[#a78bfa]" : node?.type === "loop" ? "text-[#fbbf24]" : node?.type === "condition" ? "text-[#60a5fa]" : "text-chrome-faint"}`}
			/>
			<span className="flex min-w-0 grow items-baseline gap-1.5 truncate" data-wc-row-name="">
				{renaming && node?.type === "element" ? (
					<RenameField
						label={fill(words.layers.renameLabel, { tag: node.tag })}
						value={node.label ?? ""}
						onDone={renaming.onDone}
					/>
				) : node?.type === "element" ? (
					<>
						<span className={`font-mono ${node.label ? "text-chrome-strong font-sans" : "text-[#f472b6]"}`}>
							{named.name}
						</span>
						{named.detail ? (
							<>
								{" "}
								<span className="text-chrome-muted truncate font-mono text-[11px]">{named.detail}</span>
							</>
						) : null}
					</>
				) : (
					<>
						<span
							className={
								component
									? inPlace
										? "font-medium"
										: "text-chrome-strong font-medium"
									: node?.type === "loop"
										? "font-mono text-[#fbbf24]"
										: "font-mono"
							}
						>
							{named.name}
						</span>
						{named.detail ? (
							<>
								{" "}
								<span className="text-chrome-muted truncate font-mono text-[11px]">{named.detail}</span>
							</>
						) : null}
					</>
				)}
			</span>
			{hidden ? <EyeOffIcon aria-hidden="true" className="text-chrome-faint size-3.5 shrink-0" /> : null}
			{fixed ? (
				<TypeIcon aria-hidden="true" className="size-3.5 shrink-0 text-[#fbbf24]" data-wc-fixed-text="" />
			) : null}
			{pages !== null && pages > 1 ? (
				<span className="shrink-0 rounded-[4px] bg-[#7c2d12] px-1.5 text-[11px] leading-[18px] font-medium text-[#fdba74]">
					{/* A space before it, so the row's text reads as its name does ("HeroSplit 3 pages"). */}
					{` ${fill(said.pagesOther, { count: String(pages) })}`}
				</span>
			) : null}
			{actions}
		</div>
	);
}

/** A layer's label typed in place (F2, a double-click): Enter or leaving keeps it, Escape doesn't. */
function RenameField({ label, value, onDone }: { label: string; value: string; onDone(label: string | null): void }) {
	const [text, setText] = useState(value);
	const field = useRef<HTMLInputElement>(null);
	const done = useRef(false);
	useEffect(() => {
		field.current?.focus();
		field.current?.select();
	}, []);
	const finish = (label: string | null) => {
		if (done.current) return;
		done.current = true;
		onDone(label);
	};
	return (
		<input
			ref={field}
			aria-label={label}
			value={text}
			spellCheck={false}
			autoComplete="off"
			onChange={(event) => setText(event.target.value)}
			onClick={(event) => event.stopPropagation()}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Enter") {
					event.preventDefault();
					finish(text);
				} else if (event.key === "Escape") {
					event.preventDefault();
					finish(null);
				}
			}}
			onBlur={() => finish(text)}
			className={`bg-chrome-well text-chrome-strong h-[20px] min-w-0 grow rounded-[3px] px-1 text-[12px] ${FOCUS_RING}`}
			data-wc-rename=""
		/>
	);
}

/** A row's actions, under the pointer or with focus in the row (`docking/07`): Hide, Duplicate, Delete. */
function RowActions({
	row,
	words,
	onAction,
}: {
	row: Extract<Row, { kind: "node" } | { kind: "placement" }>;
	words: Words;
	onAction(action: "hide" | "duplicate" | "delete"): void;
}) {
	if (row.kind === "node" && !row.source.editable) return null;
	const said = words.structure.actions;
	const placement = row.kind === "placement" || row.node.type === "component";
	const hidden = row.kind === "placement" ? row.placement.hidden : row.node.type === "component" && row.node.hidden;
	const buttons: { action: "hide" | "duplicate" | "delete"; label: string; icon: typeof EyeIcon }[] = [
		...(placement
			? [
					{
						action: "hide" as const,
						label: hidden ? said.show : said.hide,
						icon: hidden ? EyeIcon : EyeOffIcon,
					},
				]
			: []),
		{ action: "duplicate", label: said.duplicate, icon: CopyPlusIcon },
		{ action: "delete", label: said.delete, icon: Trash2Icon },
	];
	return (
		<span
			className="hidden shrink-0 items-center group-focus-within/row:flex group-hover/row:flex"
			data-wc-row-actions=""
		>
			{buttons.map(({ action, label, icon: Icon }, index) => (
				<button
					key={action}
					type="button"
					tabIndex={-1}
					aria-label={label}
					onClick={(event) => {
						event.stopPropagation();
						onAction(action);
					}}
					className={`group text-chrome-muted hover:bg-chrome-hover hover:text-chrome-strong relative grid size-6 place-items-center rounded-[4px] ${CHROME_EASE} ${FOCUS_RING}`}
					data-wc-row-action={action}
				>
					<Icon aria-hidden="true" className="size-3.5" />
					<Tip label={label} side="bottom" align={index === buttons.length - 1 ? "end" : "center"} />
				</button>
			))}
		</span>
	);
}
