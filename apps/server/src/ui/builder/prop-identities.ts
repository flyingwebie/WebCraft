import type { FieldInput } from "@webcraft/core";

/** Keep a new declaration identifiable through its first shared save and any intervening edit. */
export function identifyNewProps(props: readonly FieldInput[]): FieldInput[] {
	return props.map((prop) => ({
		...prop,
		id: prop.id ?? crypto.randomUUID(),
		exposed: prop.exposed ?? false,
		...(prop.type === "group" || prop.type === "repeater" ? { fields: identifyNewProps(prop.fields ?? []) } : {}),
	}));
}
