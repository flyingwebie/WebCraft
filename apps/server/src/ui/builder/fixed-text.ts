import { sameValue } from "@webcraft/core/draft-document";
import type { ElementTree } from "@webcraft/renderer/builder";
import { type NodePath, nodeAt, pathOfId } from "./tree.ts";

/** Fixed text follows its nearest element while a dialog is open; changed text is never replaced. */
export type FixedTextLocation = {
	element: string | null;
	/** Relative to the element, or absolute when there is no element to follow. */
	path: NodePath;
	text: string;
	/** Without an element identity, only the unchanged tree is safe to address. */
	before: ElementTree | null;
};

export function rememberFixedText(tree: ElementTree, path: NodePath): FixedTextLocation | null {
	const text = nodeAt(tree, path);
	if (text?.type !== "text") return null;
	for (let length = path.length - 2; length > 0; length -= 2) {
		const owner = nodeAt(tree, path.slice(0, length));
		if (owner?.type === "element")
			return { element: owner.id, path: path.slice(length), text: text.text, before: null };
	}
	return { element: null, path, text: text.text, before: tree };
}

export function resolveFixedText(tree: ElementTree, location: FixedTextLocation): NodePath | undefined {
	if (location.before && !sameValue(location.before, tree)) return undefined;
	const owner = location.element ? pathOfId(tree, location.element) : [];
	if (!owner) return undefined;
	const path = [...owner, ...location.path];
	const node = nodeAt(tree, path);
	return node?.type === "text" && node.text === location.text ? path : undefined;
}
