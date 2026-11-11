/**
 * Placements: a Component placed in a tree (GLOSSARY.md). In Template markup a Placement is a
 * PascalCase tag with its Props as attributes, `<PostCard heading="{{ title }}" featured />`; in a
 * stored tree it is a node holding only the Component's id, its own Prop values and its stable id.
 * The Component's elements are never copied into the tree: editing the Component changes every copy,
 * and no copy's internals can be edited on their own. Components have no slots, so a Placement holds
 * nothing.
 *
 * The renderer knows Components only through a catalogue core hands it (`ComponentCatalogue`): their
 * names, their Props and how fixed text is read as each Prop's value, and their trees. It reads
 * nothing itself.
 */
import type { ComponentBlock } from "./body/blocks.ts";
import { commandForNode } from "./commands.ts";
import type { PropBinding } from "./prop-bindings.ts";
import {
	type AttributePart,
	type ElementTree,
	nestingProblem,
	TREE_LIMITS,
	type TreeNode,
	textPlacementProblem,
} from "./tree.ts";

/** A Component placed in a tree, with its own Prop values. */
export type PlacementNode = {
	type: "component";
	/** Stable across every edit, move and round trip; unique within the tree, among its elements too. */
	id: string;
	/** The Component's id: a UUID for the Site's own, `<module id>:<Name>` for a Module's. */
	component: string;
	/** Its Prop values, in order: fixed text and values read where it is placed. */
	props: PropValue[];
};

/** One Prop's value in a Placement, written as an attribute: fixed text and values joined together. */
export type PropValue = { name: string; value: AttributePart[]; binding?: PropBinding };

/** What reading and checking a Placement needs to know about one Prop of its Component. */
export type PropInfo = {
	/** The Prop's key, as Template markup writes it: `heading`. */
	key: string;
	/** A whole-Group/Repeater binding may retain relative paths through declaration renames. */
	bindingPaths?: readonly string[];
	/** Whether every Placement must give it: it is required and has no default. */
	required: boolean;
	/** Why fixed text can't be this Prop's value (`abc` for a number), or undefined when it can. */
	check(text: string): string | undefined;
};

/** What reading and checking a Placement needs to know about its Component. */
export type ComponentInfo = {
	id: string;
	/** Its PascalCase tag in Template markup. */
	name: string;
	props: readonly PropInfo[];
	/** The tree a Placement shows, so it can be checked where it sits (a <div> can't go inside <p>). */
	tree: ElementTree;
};

/** A Component found: its info, why it can't be placed here, or undefined when there is none. */
export type ComponentFound = ComponentInfo | { refused: string } | undefined;

/** The Components a tree may place, by name (Template markup) and by id (stored trees). */
export type ComponentCatalogue = {
	named(name: string): ComponentFound;
	byId(id: string): ComponentFound;
};

/**
 * How deep Components place Components (a Template placing a Component that places another is 2),
 * and how many nodes a tree may come to once every Placement shows its Component.
 */
export const COMPONENT_LIMITS = { depth: 10, expandedNodes: 100_000 } as const;

/** What a Prop of a Placement reads: one value, passed on as it is, or text made of its parts. */
export type PropArgument = { kind: "bound"; path: string; binding?: PropBinding } | { kind: "text"; text: string };

/** Whether Template markup reads a tag as a Component: PascalCase, `PostCard`, never `div` or `DIV`. */
export function isComponentTag(name: string): boolean {
	return /^[A-Z][A-Za-z0-9]*$/.test(name) && /[a-z]/.test(name);
}

/** Why a Placement holds something: Components have no slots. */
export function placementHoldsNothing(name: string): string {
	return `<${name}> holds nothing: write <${name} … /> and give it Props. Components have no slots, and their elements are changed in the Component, for every copy.`;
}

/** Why a stored Placement has more than its Component, Prop values and id. */
export const PLACEMENT_INTERNALS =
	"A Placement holds only its Component, its own Prop values and its id: the Component's elements are changed in the Component, for every copy.";

/** Whether a found Component can be placed. */
export function isComponentInfo(found: ComponentFound): found is ComponentInfo {
	return found !== undefined && !("refused" in found);
}

/** Every Placement in the nodes, depth first, including those inside Template commands (not inside Components). */
/** The lists of children a Template command's node holds (a Condition's branches, a Loop's items and `{{@empty}}`); none for anything else. */
function commandChildren(node: TreeNode): readonly (readonly TreeNode[])[] {
	if (node.type === "element" || node.type === "text" || node.type === "value" || node.type === "comment") return [];
	if (node.type === "component") return [];
	return commandForNode(node.type)?.children(node) ?? [];
}

export function* placementsIn(nodes: readonly TreeNode[]): Generator<PlacementNode> {
	for (const node of nodes) {
		if (node.type === "component") yield node;
		else if (node.type === "element") yield* placementsIn(node.children);
		else for (const children of commandChildren(node)) yield* placementsIn(children);
	}
}

/** The ids of the Components a tree places directly, each once. */
export function componentsPlacedIn(tree: ElementTree): string[] {
	return [...new Set([...placementsIn(tree.nodes)].map((placement) => placement.component))];
}

/**
 * Why a Placement of `info` can't sit inside `ancestors` (outermost first): what the Component
 * shows there must still be HTML a browser keeps as it is (a <div> can't go inside <p>), nest no
 * deeper than any tree may, and place Components no more than `COMPONENT_LIMITS.depth` deep
 * (`depth` is how deep this Placement is: 1 in a Template, 2 in a Component's tree). Undefined when
 * it can.
 */
export function boundaryProblem(
	info: ComponentInfo,
	ancestors: readonly string[],
	byId: ComponentCatalogue["byId"],
	memo: Map<string, string | undefined> = new Map(),
	depth = 1,
): string | undefined {
	const visit = (
		nodes: readonly TreeNode[],
		inner: readonly string[],
		depth: number,
		where: string,
	): string | undefined => {
		for (const node of nodes) {
			const around = [...ancestors, ...inner];
			if (node.type === "element") {
				if (around.length >= TREE_LIMITS.depth) {
					return `Elements nest at most ${TREE_LIMITS.depth} deep, counting those inside Components.`;
				}
				const nesting = nestingProblem(node.tag, around);
				if (nesting) return `${where} can't go here: ${nesting}`;
				const found = visit(node.children, [...inner, node.tag], depth, where);
				if (found) return found;
			} else if (node.type === "text" || node.type === "value") {
				const misplaced = node.type === "value" || node.text.trim() ? textPlacementProblem(around.at(-1)) : undefined;
				if (misplaced) return `${where} can't go here: ${misplaced}`;
			} else if (node.type === "component") {
				if (depth >= COMPONENT_LIMITS.depth)
					return `Components place Components at most ${COMPONENT_LIMITS.depth} deep.`;
				const nested = byId(node.component);
				if (!isComponentInfo(nested)) continue;
				const key = `${nested.id}|${depth}|${around.join(">")}`;
				if (!memo.has(key)) memo.set(key, visit(nested.tree.nodes, inner, depth + 1, where));
				const found = memo.get(key);
				if (found) return found;
			} else {
				for (const children of commandChildren(node)) {
					const found = visit(children, inner, depth, where);
					if (found) return found;
				}
			}
		}
		return undefined;
	};
	return visit(info.tree.nodes, [], depth, info.name);
}

/**
 * Every Placement in the nodes whose Component's HTML can't sit where it is (see `boundaryProblem`),
 * with why. `placedDepth` is how deep the nodes already sit in Components: 0 for a Template, 1 for
 * a Component's own tree.
 */
export function placementProblems(
	nodes: readonly TreeNode[],
	byId: ComponentCatalogue["byId"],
	placedDepth = 0,
): { node: PlacementNode; message: string }[] {
	const problems: { node: PlacementNode; message: string }[] = [];
	const memo = new Map<string, string | undefined>();
	const visit = (list: readonly TreeNode[], ancestors: readonly string[]) => {
		for (const node of list) {
			if (node.type === "element") visit(node.children, [...ancestors, node.tag]);
			else if (node.type !== "component") {
				for (const children of commandChildren(node)) visit(children, ancestors);
			} else {
				const info = byId(node.component);
				if (!isComponentInfo(info)) continue;
				const problem = boundaryProblem(info, ancestors, byId, memo, placedDepth + 1);
				if (problem) problems.push({ node, message: problem });
			}
		}
	};
	visit(nodes, []);
	return problems;
}

/**
 * The first Placement that takes the nodes past `COMPONENT_LIMITS.expandedNodes` once every
 * Placement shows its Component (Components placing Components included), with why; undefined
 * while they stay within it.
 */
export function expansionProblem(
	nodes: readonly TreeNode[],
	byId: ComponentCatalogue["byId"],
): { node: PlacementNode; message: string } | undefined {
	const sizes = new Map<string, number>();
	const sizeOf = (list: readonly TreeNode[], depth: number): number => {
		let size = 0;
		for (const node of list) {
			size++;
			if (node.type === "component") size += componentSize(node.component, depth);
			else if (node.type === "element") size += sizeOf(node.children, depth);
			else for (const children of commandChildren(node)) size += sizeOf(children, depth);
			if (size > COMPONENT_LIMITS.expandedNodes) return size;
		}
		return size;
	};
	const tooMany = COMPONENT_LIMITS.expandedNodes + 1;
	const componentSize = (id: string, depth: number): number => {
		if (depth > COMPONENT_LIMITS.depth) return tooMany;
		const known = sizes.get(id);
		if (known !== undefined) return known;
		const info = byId(id);
		if (!isComponentInfo(info)) return 0;
		// A Component that reaches itself would never end: it counts as too many.
		sizes.set(id, tooMany);
		const size = sizeOf(info.tree.nodes, depth + 1);
		sizes.set(id, size);
		return size;
	};
	let total = 0;
	const visit = (list: readonly TreeNode[]): PlacementNode | undefined => {
		for (const node of list) {
			total++;
			if (node.type === "component") total += componentSize(node.component, 1);
			else if (node.type === "element") {
				const found = visit(node.children);
				if (found) return found;
			} else {
				for (const children of commandChildren(node)) {
					const found = visit(children);
					if (found) return found;
				}
			}
			if (total > COMPONENT_LIMITS.expandedNodes && node.type === "component") return node;
		}
		return undefined;
	};
	const node = visit(nodes);
	return node
		? {
				node,
				message: `With its Components shown, this comes to more than ${COMPONENT_LIMITS.expandedNodes.toLocaleString("en")} nodes: place fewer, or smaller, Components.`,
			}
		: undefined;
}

/**
 * A Component Block of a body as the Placement it is (#79): the same node a Template places a
 * Component with, its Prop values fixed text, so it renders through the same `PlacementRenderer`.
 */
export function blockPlacement(block: ComponentBlock): PlacementNode {
	return {
		type: "component",
		id: block.id,
		component: block.component,
		props: block.props.map((prop) => ({ name: prop.name, value: [{ type: "text", text: prop.value }] })),
	};
}

/**
 * The Component Blocks inside values (an Entry's Fields, as the API gives them or as they are stored),
 * as Placements: what a page showing those values has to load Components for.
 */
export function placementsInValues(values: unknown): PlacementNode[] {
	const found: PlacementNode[] = [];
	const walk = (value: unknown, depth: number) => {
		if (depth > 12 || value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const item of value) {
				const block = item as Partial<ComponentBlock> | null;
				if (
					block &&
					typeof block === "object" &&
					block.type === "component" &&
					typeof block.id === "string" &&
					typeof block.component === "string" &&
					Array.isArray(block.props)
				) {
					found.push(
						blockPlacement({
							...(block as ComponentBlock),
							props: block.props.filter((prop) => typeof prop?.name === "string" && typeof prop.value === "string"),
						}),
					);
				} else walk(item, depth + 1);
			}
			return;
		}
		for (const inner of Object.values(value)) walk(inner, depth + 1);
	};
	walk(values, 0);
	return found;
}
