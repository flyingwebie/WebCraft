/**
 * The builder's element tree in the browser (ADR 0002): where a node is, the Layers panel's rows,
 * and the moves the panel, the canvas and the keyboard make. Every change answers a new tree (the
 * old one stays for undo), and is checked with the same element, nesting and placement rules the
 * server checks stored trees with (`@webcraft/renderer/builder`), so a move the tree would refuse is
 * refused at once, in the same words. The server checks the whole tree again on every preview and save.
 *
 * Whitespace-only text is the formatting of Template markup typed by hand: the Layers panel hides
 * it and moves step over it, but it stays where it is, so switching to Template markup shows the
 * markup as it was typed.
 */
import {
	commandForNode,
	type ElementNode,
	type ElementTree,
	elementProblem,
	hasText,
	nestingProblem,
	randomElementId,
	type TextNode,
	type TreeNode,
	textPlacementProblem,
	VOID_ELEMENTS,
} from "@webcraft/renderer/builder";

/**
 * Where a node is: its index in the tree's top-level nodes, then, for each level down, which of its
 * container's lists of children (an element has one; a Condition one per branch, then Else; a Loop
 * its items, then Empty) and its index there: `[2, 0, 1]` is the second child of the third node.
 */
export type NodePath = readonly number[];

/** A list of children: the tree's own nodes (`owner` null) or one list of a node. */
export type ListRef = { owner: NodePath | null; list: number };

/** Where a node goes: a list, and the index in it. */
export type Place = ListRef & { index: number };

/** A path written as a key, for React and for remembering what is open. */
export function pathKey(path: NodePath): string {
	return path.join(".");
}

/** The list a node is in, and its index there. */
export function placeOf(path: NodePath): Place {
	const index = path.at(-1) ?? 0;
	if (path.length === 1) return { owner: null, list: 0, index };
	return { owner: path.slice(0, -2), list: path.at(-2) ?? 0, index };
}

/** The path of the node at `index` in a list. */
export function pathIn(list: ListRef, index: number): NodePath {
	return list.owner === null ? [index] : [...list.owner, list.list, index];
}

/** A node's lists of children, in order: what can be inside it. */
export function childLists(node: TreeNode): readonly (readonly TreeNode[])[] {
	switch (node.type) {
		case "element":
			return VOID_ELEMENTS.has(node.tag) ? [] : [node.children];
		case "condition":
			return [...node.branches.map((branch) => branch.children), ...(node.otherwise ? [node.otherwise] : [])];
		case "loop":
			return [node.children, ...(node.empty ? [node.empty] : [])];
		default:
			return [];
	}
}

/** Where something dropped on a layer or an element goes: before it, after it, or inside it. */
export type DropPosition = "before" | "after" | "inside";

/**
 * Where a drop goes by how far down the target the pointer is (0 at its top, 1 at its bottom): inside
 * the middle of something that can hold children, else before it in its top half and after it below.
 * The Layers panel and the canvas both drop this way.
 */
export function dropPositionAt(y: number, canHold: boolean): DropPosition {
	if (canHold && y > 0.3 && y < 0.7) return "inside";
	return y < 0.5 ? "before" : "after";
}

/** Whether something can go inside a node: a non-void element, a Condition or a Loop. */
export function canHoldChildren(node: TreeNode): boolean {
	return childLists(node).length > 0;
}

/** The node with one of its lists of children replaced. */
function withChildList(node: TreeNode, list: number, nodes: TreeNode[]): TreeNode {
	switch (node.type) {
		case "element":
			return { ...node, children: nodes };
		case "condition":
			if (list < node.branches.length) {
				return {
					...node,
					branches: node.branches.map((branch, index) => (index === list ? { ...branch, children: nodes } : branch)),
				};
			}
			return { ...node, otherwise: nodes };
		case "loop":
			return list === 0 ? { ...node, children: nodes } : { ...node, empty: nodes };
		default:
			return node;
	}
}

/** The node at a path, or undefined. */
export function nodeAt(tree: ElementTree, path: NodePath): TreeNode | undefined {
	let nodes: readonly TreeNode[] = tree.nodes;
	let node: TreeNode | undefined;
	for (let step = 0; step < path.length; step += 2) {
		node = nodes[path[step] ?? -1];
		if (!node) return undefined;
		if (step + 1 < path.length) nodes = childLists(node)[path[step + 1] ?? -1] ?? [];
	}
	return node;
}

/** The nodes of a list. */
export function listAt(tree: ElementTree, list: ListRef): readonly TreeNode[] {
	if (list.owner === null) return tree.nodes;
	const owner = nodeAt(tree, list.owner);
	return owner ? (childLists(owner)[list.list] ?? []) : [];
}

/** The tree with a list's nodes changed by `change`. */
function changeList(tree: ElementTree, list: ListRef, change: (nodes: TreeNode[]) => TreeNode[]): ElementTree {
	const rebuild = (nodes: readonly TreeNode[], path: NodePath): TreeNode[] => {
		if (path.length === 0) return canonical(change([...nodes]));
		const [index = 0, inner = 0, ...rest] = path;
		return nodes.map((node, at) =>
			at === index ? withChildList(node, inner, rebuild(childLists(node)[inner] ?? [], rest)) : node,
		);
	};
	const route = list.owner === null ? [] : [...list.owner, list.list];
	return { ...tree, nodes: rebuild(tree.nodes, route) };
}

/** Text next to text joined and empty text dropped, as the server keeps trees (its canonical form). */
function canonical(nodes: readonly TreeNode[]): TreeNode[] {
	const joined: TreeNode[] = [];
	for (const node of nodes) {
		if (node.type === "text" && node.text === "" && !node.translations) continue;
		const previous = joined.at(-1);
		if (node.type === "text" && !node.translations && previous?.type === "text" && !previous.translations) {
			joined[joined.length - 1] = { type: "text", text: previous.text + node.text };
		} else {
			joined.push(node);
		}
	}
	return joined;
}

/** Whether a node is formatting only: whitespace between elements, hidden from the Layers panel. */
export function isFormatting(node: TreeNode): boolean {
	return node.type === "text" && !hasText(node);
}

/** Where a node is now, found by itself (moves and joined text shift paths). */
export function pathOf(tree: ElementTree, wanted: TreeNode): NodePath | undefined {
	const search = (nodes: readonly TreeNode[], prefix: number[]): NodePath | undefined => {
		for (let index = 0; index < nodes.length; index++) {
			const node = nodes[index] as TreeNode;
			const here = [...prefix, index];
			if (node === wanted) return here;
			const lists = childLists(node);
			for (let list = 0; list < lists.length; list++) {
				const found = search(lists[list] ?? [], [...here, list]);
				if (found) return found;
			}
		}
		return undefined;
	};
	return search(tree.nodes, []);
}

/** The path of the element or Placement with this id. */
export function pathOfId(tree: ElementTree, id: string): NodePath | undefined {
	const search = (nodes: readonly TreeNode[], prefix: number[]): NodePath | undefined => {
		for (let index = 0; index < nodes.length; index++) {
			const node = nodes[index] as TreeNode;
			const here = [...prefix, index];
			if ((node.type === "element" || node.type === "component") && node.id === id) return here;
			const lists = childLists(node);
			for (let list = 0; list < lists.length; list++) {
				const found = search(lists[list] ?? [], [...here, list]);
				if (found) return found;
			}
		}
		return undefined;
	};
	return search(tree.nodes, []);
}

/** The path of the first place a Filter is shown (its form before any of its controls shown on its own). */
export function pathOfFilter(tree: ElementTree, filterId: string): NodePath | undefined {
	let apart: NodePath | undefined;
	const search = (nodes: readonly TreeNode[], prefix: number[]): NodePath | undefined => {
		for (let index = 0; index < nodes.length; index++) {
			const node = nodes[index] as TreeNode;
			const here = [...prefix, index];
			if (node.type === "filter" && node.filter === filterId) {
				if (node.control === undefined) return here;
				apart ??= here;
			}
			const lists = childLists(node);
			for (let list = 0; list < lists.length; list++) {
				const found = search(lists[list] ?? [], [...here, list]);
				if (found) return found;
			}
		}
		return undefined;
	};
	return search(tree.nodes, []) ?? apart;
}

/** A change's result: the new tree and where the node it moved or made is now. */
export type Changed = { tree: ElementTree; path: NodePath };

/** Why a change can't be made: the tree's rules, in their words, or a reason of the builder's. */
export type Refused = { refused: string };

/** The tree without the node at `path`. */
export function removeAt(tree: ElementTree, path: NodePath): ElementTree {
	const place = placeOf(path);
	return changeList(tree, place, (nodes) => nodes.filter((_, index) => index !== place.index));
}

/** The tree with `nodes` put at a place; the path of the first of them. */
export function insertAt(tree: ElementTree, place: Place, nodes: readonly TreeNode[]): Changed {
	const next = changeList(tree, place, (list) => [...list.slice(0, place.index), ...nodes, ...list.slice(place.index)]);
	const first = nodes[0];
	return { tree: next, path: (first && pathOf(next, first)) ?? pathIn(place, place.index) };
}

/** The tree with the node at `path` replaced. */
export function replaceAt(tree: ElementTree, path: NodePath, node: TreeNode): ElementTree {
	const place = placeOf(path);
	return changeList(tree, place, (nodes) => nodes.map((each, index) => (index === place.index ? node : each)));
}

/** The index of the nearest node before (`-1`) or after (`1`) one in its list that isn't formatting. */
function neighbour(nodes: readonly TreeNode[], index: number, step: -1 | 1): number | undefined {
	for (let at = index + step; at >= 0 && at < nodes.length; at += step) {
		if (!isFormatting(nodes[at] as TreeNode)) return at;
	}
	return undefined;
}

/**
 * Moves a node to another place: out of its list, into `to` (whose index counts the list as it is
 * before the move). Refused when the node would end up inside itself.
 */
export function moveTo(tree: ElementTree, path: NodePath, to: Place): Changed | Refused {
	const node = nodeAt(tree, path);
	if (!node) return { refused: "gone" };
	const destination = pathIn(to, to.index);
	if (destination.length > path.length && pathKey(destination.slice(0, path.length)) === pathKey(path)) {
		return { refused: "inside-itself" };
	}
	return insertAt(removeAt(tree, path), placeOf(afterRemoval(destination, path)), [node]);
}

/**
 * A path as it is once the node at `removed` is gone: what came after it in its own list (or
 * inside what came after it) moves one place up.
 */
function afterRemoval(target: NodePath, removed: NodePath): NodePath {
	const at = removed.length - 1;
	if (target.length <= at) return target;
	for (let step = 0; step < at; step++) if (target[step] !== removed[step]) return target;
	if ((target[at] ?? 0) <= (removed[at] ?? 0)) return target;
	const moved = [...target];
	moved[at] = (moved[at] ?? 0) - 1;
	return moved;
}

/** Moves a node before the nearest node before it in its list (whitespace stays where it is). */
export function moveUp(tree: ElementTree, path: NodePath): Changed | Refused {
	const place = placeOf(path);
	const before = neighbour(listAt(tree, place), place.index, -1);
	if (before === undefined) return { refused: "first" };
	return moveTo(tree, path, { ...place, index: before });
}

/** Moves a node after the nearest node after it in its list. */
export function moveDown(tree: ElementTree, path: NodePath): Changed | Refused {
	const place = placeOf(path);
	const after = neighbour(listAt(tree, place), place.index, 1);
	if (after === undefined) return { refused: "last" };
	return moveTo(tree, path, { ...place, index: after + 1 });
}

/** Moves a node into the node before it, at the end of its first list of children. */
export function moveIntoPrevious(tree: ElementTree, path: NodePath): Changed | Refused {
	const place = placeOf(path);
	const nodes = listAt(tree, place);
	const before = neighbour(nodes, place.index, -1);
	const previous = before === undefined ? undefined : nodes[before];
	if (before === undefined || !previous) return { refused: "first" };
	if (!canHoldChildren(previous)) return { refused: "holds-nothing" };
	const owner = pathIn(place, before);
	return moveTo(tree, path, { owner, list: 0, index: childLists(previous)[0]?.length ?? 0 });
}

/** Moves a node out of what holds it, to just after it. */
export function moveOut(tree: ElementTree, path: NodePath): Changed | Refused {
	const place = placeOf(path);
	if (place.owner === null) return { refused: "top" };
	const ownerPlace = placeOf(place.owner);
	return moveTo(tree, path, { ...ownerPlace, index: ownerPlace.index + 1 });
}

/** A copy of nodes with new ids for every element and Placement in them, none of them taken in `tree`. */
export function withNewIds(tree: ElementTree, nodes: readonly TreeNode[]): TreeNode[] {
	const taken = new Set(idsIn(tree.nodes));
	const fresh = () => {
		let id = randomElementId();
		while (taken.has(id)) id = randomElementId();
		taken.add(id);
		return id;
	};
	const copy = (node: TreeNode): TreeNode => {
		const lists = childLists(node);
		let copied: TreeNode = structuredClone(node);
		lists.forEach((list, index) => {
			copied = withChildList(copied, index, list.map(copy));
		});
		if (copied.type === "element" || copied.type === "component") copied = { ...copied, id: fresh() };
		return copied;
	};
	return nodes.map(copy);
}

/** The ids of nodes and of their copies (`withNewIds`), element by element, in the same order. */
export function copiedIds(nodes: readonly TreeNode[], copies: readonly TreeNode[]): Map<string, string> {
	const pairs = new Map<string, string>();
	const original = idsIn(nodes);
	const copied = idsIn(copies);
	original.forEach((id, index) => {
		const copy = copied[index];
		if (copy) pairs.set(id, copy);
	});
	return pairs;
}

/** Every element and Placement id in nodes. */
export function idsIn(nodes: readonly TreeNode[]): string[] {
	const ids: string[] = [];
	const visit = (list: readonly TreeNode[]) => {
		for (const node of list) {
			if (node.type === "element" || node.type === "component") ids.push(node.id);
			for (const inner of childLists(node)) visit(inner);
		}
	};
	visit(nodes);
	return ids;
}

/** A new element with a fresh id. */
export function newElement(tree: ElementTree, tag: string, children: TreeNode[] = []): ElementNode {
	const [made] = withNewIds(tree, [{ type: "element", id: "new", tag, attributes: [], classes: [], children }]);
	return made as ElementNode;
}

/** Fixed text: what clients can't edit until it becomes a Prop, a Field or a Global. */
export function isFixedText(node: TreeNode): node is TextNode {
	return node.type === "text" && hasText(node);
}

/** What a kind of tree may hold, beyond the rules every tree keeps. */
export type TreeAllows = { elements: ReadonlySet<string>; commands: ReadonlySet<string> };

/**
 * Why the tree can't be kept as it is, by the rules the server checks every stored tree with (an
 * element this kind of tree can't hold, nesting a browser would change, text where a browser moves
 * it, a Template command where it can't go), with the path of the node it is about.
 */
export function treeProblem(tree: ElementTree, allows: TreeAllows): { path: NodePath; message: string } | undefined {
	const visit = (
		nodes: readonly TreeNode[],
		prefix: number[],
		ancestors: readonly string[],
	): { path: NodePath; message: string } | undefined => {
		for (let index = 0; index < nodes.length; index++) {
			const node = nodes[index] as TreeNode;
			const path = [...prefix, index];
			const parent = ancestors.at(-1);
			let message: string | undefined;
			if (node.type === "element") {
				message =
					elementProblem(node.tag) ??
					(allows.elements.has(node.tag) ? undefined : `There is no element named ${node.tag} here.`) ??
					nestingProblem(node.tag, ancestors) ??
					(VOID_ELEMENTS.has(node.tag) && node.children.length > 0 ? `${node.tag} can't have children.` : undefined);
			} else if ((node.type === "text" && hasText(node)) || node.type === "value") {
				message = textPlacementProblem(parent);
			} else if (node.type !== "text" && node.type !== "comment" && node.type !== "component") {
				const command = commandForNode(node.type);
				message =
					command && !allows.commands.has(command.name)
						? `{{@${command.name}}} can't go in this kind of Template.`
						: command?.placementProblem?.(ancestors);
			}
			if (message) return { path, message };
			const inside = node.type === "element" ? [...ancestors, node.tag] : ancestors;
			const lists = childLists(node);
			for (let list = 0; list < lists.length; list++) {
				const found = visit(lists[list] ?? [], [...path, list], inside);
				if (found) return found;
			}
		}
		return undefined;
	};
	return visit(tree.nodes, [], []);
}
