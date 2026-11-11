import type { ElementTree, TreeNode } from "@webcraft/renderer/builder";
import type { useT } from "../i18n.tsx";
import type { LayerAction } from "./LayersPanel.tsx";
import { type BuilderDoc, type Catalogue, layerName, type Selection } from "./model.ts";
import {
	copiedIds,
	insertAt,
	insertionPlace,
	isFormatting,
	listAt,
	moveDown,
	moveIntoPrevious,
	moveOut,
	moveUp,
	type NodePath,
	nodeAt,
	placeBy,
	placeOf,
	removeAt,
	withNewIds,
} from "./tree.ts";

type T = ReturnType<typeof useT>;
export type LayerClipboard = { nodes: TreeNode[]; styles: Record<string, string> };
type ActionResult = {
	message: string;
	clipboard?: LayerClipboard;
	change?: { doc: BuilderDoc; selection: Selection | null };
};

/** A layer's position, in words, shared by keyboard actions and canvas moves. */
export function layerLocation(t: T, tree: ElementTree, path: NodePath, catalogue: Catalogue): string {
	const place = placeOf(path);
	const siblings = listAt(tree, place)
		.map((node, index) => ({ node, index }))
		.filter(({ node }) => !isFormatting(node));
	const position = siblings.findIndex(({ index }) => index === place.index) + 1;
	const parent = place.owner ? nodeAt(tree, place.owner) : undefined;
	const owner = parent ? layerName(t, parent, catalogue).name : t("builder.moves.top");
	return t("builder.moves.where", { position, count: siblings.length, owner });
}

/** Both canvases use the same transformations, next selection, clipboard and announcements. */
export function runLayerAction(
	action: LayerAction,
	{
		doc,
		selection,
		clipboard,
		catalogue,
	}: { doc: BuilderDoc; selection: Selection | null; clipboard: LayerClipboard | null; catalogue: Catalogue },
	t: T,
): ActionResult | null {
	const where = (tree: ElementTree, path: NodePath) => layerLocation(t, tree, path, catalogue);
	if (action === "paste") {
		if (!clipboard || !selection) return { message: t("builder.moves.nothingToPaste") };
		const nodes = withNewIds(doc.tree, clipboard.nodes);
		const made = insertAt(doc.tree, insertionPlace(doc.tree, selection, "after"), nodes);
		const node = nodeAt(made.tree, made.path);
		return {
			message: t("builder.moves.pasted", {
				name: node ? layerName(t, node, catalogue).name : "",
				where: where(made.tree, made.path),
			}),
			change: {
				doc: {
					...doc,
					tree: made.tree,
					styles: withCopiedStyles(doc.styles, clipboard.nodes, nodes, clipboard.styles),
				},
				selection: { kind: "node", path: made.path },
			},
		};
	}
	if (selection?.kind !== "node") return null;
	const { path } = selection;
	const node = nodeAt(doc.tree, path);
	if (!node) return null;
	const name = layerName(t, node, catalogue).name;
	switch (action) {
		case "moveUp":
		case "moveDown":
		case "moveIn":
		case "moveOut": {
			const result = { moveUp, moveDown, moveIn: moveIntoPrevious, moveOut }[action](doc.tree, path);
			if ("refused" in result) return { message: t(`builder.moves.refused.${result.refused as "first"}`, { name }) };
			return {
				message: t("builder.moves.moved", { name, where: where(result.tree, result.path) }),
				change: { doc: { ...doc, tree: result.tree }, selection: { kind: "node", path: result.path } },
			};
		}
		case "copy":
			return { clipboard: { nodes: [node], styles: doc.styles }, message: t("builder.moves.copied", { name }) };
		case "cut":
		case "delete": {
			const tree = removeAt(doc.tree, path);
			const place = placeOf(path);
			const next = listAt(tree, place).findIndex((each, index) => index >= place.index && !isFormatting(each));
			const selection: Selection | null =
				next >= 0
					? { kind: "node", path: [...path.slice(0, -1), next] }
					: place.owner
						? { kind: "node", path: place.owner }
						: null;
			const styles = { ...doc.styles };
			if (node.type === "element") delete styles[node.id];
			return {
				...(action === "cut" ? { clipboard: { nodes: [node], styles: doc.styles } } : {}),
				message: t(action === "cut" ? "builder.moves.cut" : "builder.moves.deleted", { name }),
				change: { doc: { ...doc, tree, styles }, selection },
			};
		}
		case "duplicate": {
			const copies = withNewIds(doc.tree, [node]);
			const made = insertAt(doc.tree, placeBy(doc.tree, path, "after"), copies);
			return {
				message: t("builder.moves.duplicated", { name, where: where(made.tree, made.path) }),
				change: {
					doc: { ...doc, tree: made.tree, styles: withCopiedStyles(doc.styles, [node], copies, doc.styles) },
					selection: { kind: "node", path: made.path },
				},
			};
		}
		case "rename":
			return { message: t("builder.layers.renameElementsOnly") };
	}
}

/** One-off styles follow copied elements while they are still unsaved. */
function withCopiedStyles(
	styles: Record<string, string>,
	originals: readonly TreeNode[],
	copies: readonly TreeNode[],
	from: Record<string, string>,
): Record<string, string> {
	const next = { ...styles };
	for (const [original, copy] of copiedIds(originals, copies)) {
		const style = from[original];
		if (style) next[copy] = style;
	}
	return next;
}
