import type { FieldDefinition, Json, LeafField } from "./field-types.ts";

/** Walk typed Prop values, including nested existing Group/Repeater Fields. URLs, UUID-looking
 * text and settings are never guessed to be references or human text. */
export function mapPropLeaves(
	field: FieldDefinition,
	value: Json,
	leaf: (field: LeafField, value: Json) => Json,
): Json {
	if (field.type === "group") {
		if (!value || typeof value !== "object" || Array.isArray(value)) return value;
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => {
				const inner = field.fields.find((f) => f.key === key);
				return [key, inner ? mapPropLeaves(inner, item, leaf) : item];
			}),
		);
	}
	if (field.type === "repeater") {
		if (!Array.isArray(value)) return value;
		return value.map((row) => mapPropLeaves({ ...field, type: "group" }, row, leaf));
	}
	return leaf(field, value);
}
