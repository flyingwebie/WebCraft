/** Identity-tagged values whose old names are now occupied by another declaration. */
export const RETAINED_MAX_LENGTH = 16_777_216;
export const RETAINED_ATTRIBUTE = "data-wc-retained";
/** Kept inside its Group/Repeater row, so moving a row also moves its retained values. */
export const RETAINED_KEY = "$wc-retained";
export type RetainedJsonValue = { id: string; name: string; value: unknown };

export function retainedValues(input: unknown): RetainedJsonValue[] {
	if (input === undefined) return [];
	if (!Array.isArray(input) || input.length > 256) throw new Error("Retained values are a list of at most 256 values.");
	const ids = new Set<string>();
	for (const item of input) {
		if (
			!item ||
			typeof item !== "object" ||
			Array.isArray(item) ||
			Object.keys(item).some((key) => !["id", "name", "value"].includes(key)) ||
			typeof item.id !== "string" ||
			!/^[A-Za-z0-9_-]{1,64}$/.test(item.id) ||
			typeof item.name !== "string" ||
			!/^[a-z][A-Za-z0-9_]{0,63}$/.test(item.name) ||
			!("value" in item)
		)
			throw new Error("A retained value needs a declaration id, its name and its value.");
		if (ids.has(item.id)) throw new Error("A retained declaration is given twice.");
		ids.add(item.id);
	}
	return input as RetainedJsonValue[];
}

/** Structural part shared by tree input and format3; the source contract checks the value's type. */
export function retainedPropProblem(input: unknown): string | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return "A retained Prop is an object.";
	const item = input as Record<string, unknown>;
	if (Object.keys(item).some((key) => !["name", "value", "binding", "retained"].includes(key)))
		return "A retained Prop holds only its name, value, declaration identity and binding metadata.";
	if (typeof item.retained !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(item.retained))
		return "A retained Prop needs its declaration identity.";
	if (typeof item.name !== "string" || !/^[a-z][A-Za-z0-9_]{0,63}$/.test(item.name))
		return "A retained Prop needs its original name.";
	if (!Array.isArray(item.value) || item.value.length > 10_000)
		return "A retained Prop value holds at most 10000 text or value parts.";
	return undefined;
}
