import type { FieldDefinition } from "./field-types.ts";

/**
 * The kinds of value Edit mode lets people type over in place: plain text and rich text (with its
 * floating toolbar). Images, Loop items and the rest come with their own Edit mode tools.
 */
export type EditableType = "text" | "richText";

/** A Field whose value can be typed over in place, and how. */
export type EditableField = { field: FieldDefinition; type: EditableType; label: string };

/**
 * The Field a binding's path names among `fields`, when its value can be typed over in place: a
 * text or rich text Field, at the top or inside Groups (`address.city`). Repeaters' Fields (a list
 * until Loops show their rows), parts of links and selects, and what Relationships point at (other
 * Entries) can't be. `label` names it for people, a Group's Field after its Group (`Address › City`).
 */
export function editableField(fields: readonly FieldDefinition[], path: string): EditableField | undefined {
	const names = path.split(".");
	let within: readonly FieldDefinition[] = fields;
	const labels: string[] = [];
	for (const [index, name] of names.entries()) {
		const field = within.find((candidate) => candidate.key === name);
		if (!field) return undefined;
		labels.push(field.label);
		if (index === names.length - 1) {
			return field.type === "text" || field.type === "richText"
				? { field, type: field.type, label: labels.join(" › ") }
				: undefined;
		}
		if (field.type !== "group") return undefined;
		within = field.fields;
	}
	return undefined;
}
