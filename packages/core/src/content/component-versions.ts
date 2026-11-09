import type { ElementTree } from "@webcraft/renderer";

import { type FieldDefinition, storedFields } from "./fields.ts";

/** One version of a Component: its Props and its element tree, published together. */
export type ComponentVersion = {
	/** The values each Placement fills in, declared with the Field types. */
	props: FieldDefinition[];
	tree: ElementTree;
};

/** The tree of a Component with nothing in it yet. */
export const EMPTY_TREE: ElementTree = { version: 1, nodes: [] };

/** A Component version as stored (a `draft` or `published` column), read safely. */
export function storedComponentVersion(value: unknown): ComponentVersion {
	const { props, tree } = (value ?? {}) as { props?: unknown; tree?: unknown };
	return { props: storedFields(props), tree: (tree as ElementTree | undefined) ?? EMPTY_TREE };
}
