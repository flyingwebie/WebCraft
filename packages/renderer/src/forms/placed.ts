import { childListsOf, type ElementTree, type FormNode, type TreeNode } from "../tree.ts";

/** Every Form placed in the nodes, depth first, including those inside Template commands (not inside Components). */
export function* formsIn(nodes: readonly TreeNode[]): Generator<FormNode> {
	for (const node of nodes) {
		if (node.type === "form") yield node;
		for (const children of childListsOf(node)) yield* formsIn(children);
	}
}

/** The ids of the Forms a tree places directly, each once. */
export function formsPlacedIn(tree: ElementTree): string[] {
	return [...new Set([...formsIn(tree.nodes)].map((placed) => placed.form))];
}
