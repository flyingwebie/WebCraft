import type { ElementTree } from "@webcraft/renderer/builder";
import type { Selection } from "./model.ts";
import { childLists, nodeAt, pathOfId } from "./tree.ts";

/** Element ids stay stable; other rows use a derived address in this source's current tree. */
export function selectionKey(tree: ElementTree, selection: Selection): string | null {
	const path = selection.kind === "node" ? selection.path : selection.list.owner;
	const node = path && nodeAt(tree, path);
	if (!node || !path) return null;
	const key = "id" in node ? node.id : `@${path.join(".")}`;
	return selection.kind === "node" ? key : `${key}/${selection.list.list}`;
}

export function selectionOf(tree: ElementTree, key: string): Selection | null {
	const [address = "", list] = key.split("/");
	const path = address.startsWith("@")
		? /^@\d+(?:\.\d+)*$/.test(address)
			? address.slice(1).split(".").map(Number)
			: undefined
		: pathOfId(tree, address);
	const node = path && nodeAt(tree, path);
	if (!path || !node) return null;
	if (list === undefined) return { kind: "node", path };
	return childLists(node)[Number(list)] ? { kind: "list", list: { owner: path, list: Number(list) } } : null;
}

/** Layers keep their existing row keys; Code mode adds @ to distinguish paths from element ids. */
export function hoveredRow(ref: string | null): string | null {
	if (!ref) return null;
	const [source, key = ""] = ref.split("#");
	return `${source}:${key.startsWith("@") ? key.slice(1) : `#${key}`}`;
}
