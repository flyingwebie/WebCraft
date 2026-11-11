import { contentHash, type ElementTree } from "@webcraft/renderer";

import { type FieldDefinition, storedFields } from "./fields.ts";

/** One version of a Component: its Props and its element tree, published together. */
export type ComponentVersion = {
	/** The values each Placement fills in, declared with the Field types. */
	props: FieldDefinition[];
	/** Pre-change contract for values retained in Draft Placements until publish. */
	propBaseline?: FieldDefinition[];
	tree: ElementTree;
};

/** The tree of a Component with nothing in it yet. */
export const EMPTY_TREE: ElementTree = { version: 1, nodes: [] };

/** A Component version as stored (a `draft` or `published` column), read safely. */
export function storedComponentVersion(value: unknown): ComponentVersion {
	const { props, tree, propBaseline } = (value ?? {}) as { props?: unknown; tree?: unknown; propBaseline?: unknown };
	return {
		...(Array.isArray(propBaseline) ? { propBaseline: identifiedProps(storedFields(propBaseline)) } : {}),
		props: identifiedProps(storedFields(props)),
		tree: (tree as ElementTree | undefined) ?? EMPTY_TREE,
	};
}

/** Legacy declarations gain deterministic local identities on read, without rewriting history. */
function identifiedProps(fields: FieldDefinition[], path = ""): FieldDefinition[] {
	return fields.map((field) => ({
		...field,
		id: field.id ?? `legacy-${contentHash(`${path}.${field.key}`)}`,
		exposed: field.exposed ?? false,
		...("fields" in field ? { fields: identifiedProps(field.fields, `${path}.${field.key}`) } : {}),
	}));
}
