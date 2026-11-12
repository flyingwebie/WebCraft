import type { ElementTree, TreeNode } from "@webcraft/renderer/builder";

import { childLists } from "./tree.ts";

/** Whether a tree holds a node with this id, anywhere. */
export function holdsId(tree: ElementTree, id: string): boolean {
	const visit = (nodes: readonly TreeNode[]): boolean =>
		nodes.some((node) => ("id" in node && node.id === id) || childLists(node).some(visit));
	return visit(tree.nodes);
}

/**
 * Waits for a change the server made to a shared Draft (Make Component's Placement, #134) to reach
 * this editor's copy: until `tree()` holds the node `id`, five seconds at most. Answers whether it
 * arrived. Both canvases use it, each reading its own shared Draft.
 */
export async function serverChangeArrived(tree: () => ElementTree, id: string): Promise<boolean> {
	for (let waited = 0; waited < 5000; waited += 50) {
		if (holdsId(tree(), id)) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return holdsId(tree(), id);
}
