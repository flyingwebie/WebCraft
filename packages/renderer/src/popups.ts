import { childListsOf, type ElementTree, type TreeNode } from "./tree.ts";
/** Popup commands attach by id. Nested command bodies use the same child registry as every tree consumer. */
export function popupsPlacedIn(tree: ElementTree): string[] {
	const found = new Set<string>();
	const walk = (nodes: readonly TreeNode[]) => {
		for (const node of nodes) {
			if (node.type === "popup") found.add(node.popup);
			for (const children of childListsOf(node)) walk(children);
		}
	};
	walk(tree.nodes);
	return [...found];
}
