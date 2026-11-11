import { checkFormat } from "./formatters.ts";
import { stableJson } from "./json.ts";
import { canonicalLanguage } from "./languages.ts";
import { isPropDeclarationId } from "./prop-identities.ts";
import { isValuePath, textProblem } from "./tree.ts";

/** Identity-tagged values whose old names are now occupied by another declaration. */
export const RETAINED_MAX_LENGTH = 16_777_216;
export const CONTRACTS_ATTRIBUTE = "data-wc-contracts";
export const RETAINED_ATTRIBUTE = "data-wc-retained";
/** Kept inside its Group/Repeater row, so moving a row also moves its retained values. */
export const RETAINED_KEY = "$wc-retained";
export type RetainedJsonValue = { id: string; name: string; value: unknown; contract?: Record<string, unknown> };

export function retainedValues(input: unknown): RetainedJsonValue[] {
	if (input === undefined) return [];
	if (!Array.isArray(input) || input.length > 256) throw new Error("Retained values are a list of at most 256 values.");
	const ids = new Set<string>();
	for (const item of input) {
		if (
			!item ||
			typeof item !== "object" ||
			Array.isArray(item) ||
			Object.keys(item).some((key) => !["id", "name", "value", "contract"].includes(key)) ||
			!isPropDeclarationId(item.id) ||
			typeof item.name !== "string" ||
			!/^[a-z][A-Za-z0-9_]{0,63}$/.test(item.name) ||
			!("value" in item)
		)
			throw new Error("A retained value needs a declaration id, its name and its value.");
		const identity = retainedValueIdentity(item.id, item.contract);
		if (ids.has(identity)) throw new Error("A retained declaration is given twice.");
		ids.add(identity);
	}
	return input as RetainedJsonValue[];
}

/** Structural part shared by tree input and format3; the source contract checks the value's type. */
export function retainedPropProblem(input: unknown): string | undefined {
	if (!input || typeof input !== "object" || Array.isArray(input)) return "A retained Prop is an object.";
	const item = input as Record<string, unknown>;
	if (Object.keys(item).some((key) => !["name", "value", "binding", "retained", "contract"].includes(key)))
		return "A retained Prop holds only its name, value, declaration identity and binding metadata.";
	if (!isPropDeclarationId(item.retained)) return "A retained Prop needs its declaration identity.";
	try {
		retainedValueIdentity(item.retained as string, item.contract as Record<string, unknown> | undefined);
	} catch (error) {
		return (error as Error).message;
	}
	if (typeof item.name !== "string" || !/^[a-z][A-Za-z0-9_]{0,63}$/.test(item.name))
		return "A retained Prop needs its original name.";
	if (!Array.isArray(item.value) || item.value.length > 10_000)
		return "A retained Prop value holds at most 10000 text or value parts.";
	for (const part of item.value) {
		if (!part || typeof part !== "object" || Array.isArray(part)) return "Retained values are text or value parts.";
		if (part.type === "text") {
			if (Object.keys(part).some((key) => !["type", "text", "translations"].includes(key)))
				return "A retained text part holds text and translations.";
			if (typeof part.text !== "string") return "Retained text must be a string.";
			const problem = textProblem(part.text);
			if (problem) return problem;
			if (part.translations !== undefined) {
				if (!part.translations || typeof part.translations !== "object" || Array.isArray(part.translations))
					return "Retained translations are text by language tag.";
				const languages = new Set<string>();
				for (const [tag, text] of Object.entries(part.translations)) {
					const language = canonicalLanguage(tag);
					if (!language || languages.has(language) || typeof text !== "string")
						return "Retained translations need distinct language tags and text.";
					const problem = textProblem(text);
					if (problem) return problem;
					languages.add(language);
				}
			}
		} else if (part.type === "value") {
			if (
				Object.keys(part).some((key) => !["type", "path", "format"].includes(key)) ||
				typeof part.path !== "string" ||
				!isValuePath(part.path)
			)
				return "A retained bound value needs a Field path and optional formatter.";
			if (part.format !== undefined) {
				const checked = checkFormat(part.format);
				if ("problem" in checked) return checked.problem;
			}
		} else return "Retained values are text or value parts.";
	}
	return undefined;
}

/** One retained value per declaration and recursive types, independent of values, names and order. */
export function retainedValueIdentity(id: string, contract?: Record<string, unknown>): string {
	if (contract === undefined) return `${id}/legacy`;
	let count = 0;
	const shape = (value: unknown, depth: number): unknown => {
		if (!value || typeof value !== "object" || Array.isArray(value) || depth > 8 || ++count > 256)
			throw new Error("Invalid or oversized retained contract.");
		const field = value as Record<string, unknown>;
		if (!isPropDeclarationId(field.id) || typeof field.type !== "string" || field.type.length > 64)
			throw new Error("A retained contract needs declaration identities and Field types.");
		if (field.fields !== undefined && !Array.isArray(field.fields)) throw new Error("Invalid retained Fields.");
		return {
			id: field.id,
			type: field.type,
			...(Array.isArray(field.fields)
				? {
						fields: field.fields
							.map((child) => shape(child, depth + 1))
							.sort((a, b) => stableJson(a).localeCompare(stableJson(b))),
					}
				: {}),
		};
	};
	return `${id}/${stableJson(shape(contract, 1))}`;
}

/** Bound the combined list too, including metadata recovered from an existing Placement. */
export function retainedPropsProblem(values: readonly unknown[]): string | undefined {
	const contracts = values
		.filter((value) => value && typeof value === "object" && "contract" in value && !("retained" in value))
		.map((value) => (value as { contract: unknown }).contract);
	if (contracts.length > 256 || JSON.stringify(contracts).length > RETAINED_MAX_LENGTH)
		return "Prop source contracts exceed the 256-value or 16 MiB metadata limit.";
	const held = values.filter((value) => value && typeof value === "object" && "retained" in value);
	if (held.length > 256 || JSON.stringify(held).length > RETAINED_MAX_LENGTH)
		return "Retained Props exceed the 256-value or 16 MiB metadata limit.";
	return undefined;
}
