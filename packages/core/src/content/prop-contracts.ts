/** Self-contained source declarations for values held across incompatible Prop type changes. */
import { isPropDeclarationId } from "@webcraft/renderer";
import type { ContentProblem } from "./errors.ts";
import { type FieldDefinition, type FieldInput, MAX_FIELD_DEPTH, MAX_FIELDS, parseFields } from "./fields.ts";
import { sameJson } from "./json.ts";

/** Check before traversing untrusted metadata; do not let a snapshot introduce unbounded schemas. */
export function readRetainedContract(input: unknown, id: string): FieldDefinition {
	let count = 0;
	const postTypeKeys = new Set<string>();
	const visit = (value: unknown, depth: number) => {
		if (!value || typeof value !== "object" || Array.isArray(value) || depth > MAX_FIELD_DEPTH || ++count > MAX_FIELDS)
			throw new Error("A retained contract exceeds the Field count or depth limits.");
		const field = value as Record<string, unknown>;
		if (!isPropDeclarationId(field.id) || field.type === "body") throw new Error("Invalid retained declaration.");
		if (Array.isArray(field.postTypes))
			for (const key of field.postTypes) if (typeof key === "string") postTypeKeys.add(key);
		if (field.fields !== undefined) {
			if (!Array.isArray(field.fields)) throw new Error("Retained Fields must be a list.");
			for (const child of field.fields) visit(child, depth + 1);
		}
	};
	visit(input, 1);
	const problems: ContentProblem[] = [];
	// A retained union can contain dormant same-name declarations after a collision.
	// Identities remain distinct; ordinary authoring still rejects duplicate keys.
	const [field] = parseFields([input as FieldInput], problems, {
		owner: "component",
		listName: "props",
		reservedKeys: new Set(),
		postTypeKeys,
	});
	if (!field || field.id !== id || problems.some((problem) => problem.rule !== "keyTwice") || !sameJson(input, field))
		throw new Error(
			problems[0]?.message ??
				"A retained contract must be a complete Field declaration with its own identity and no unsupported settings.",
		);
	return field;
}
