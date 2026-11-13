import { childListsOf, type ElementTree, type FilterNode, type TreeNode } from "../tree.ts";

/** Every Filter placed in the nodes, depth first, including those inside Template commands (not inside Components). */
export function* filtersIn(nodes: readonly TreeNode[]): Generator<FilterNode> {
	for (const node of nodes) {
		if (node.type === "filter") yield node;
		for (const children of childListsOf(node)) yield* filtersIn(children);
	}
}

/** The ids of the Filters a tree places directly (its form or one of its controls), each once. */
export function filtersPlacedIn(tree: ElementTree): string[] {
	return [...new Set([...filtersIn(tree.nodes)].map((placed) => placed.filter))];
}
