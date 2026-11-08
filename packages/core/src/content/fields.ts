import type { ContentProblem } from "./errors.ts";

/** The Field types there are. More join them (rich text, number, Relationship, …). */
export const FIELD_TYPES = ["text"] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** One Field of a Post Type, as stored. */
export type FieldDefinition = {
	/** Names the Field in Template markup (`{{ summary }}`), the APIs and files. Never changes. */
	key: string;
	/** What people see next to it. */
	label: string;
	type: FieldType;
	/** A value per language (ADR 0003); otherwise one value shared by every language. */
	translatable: boolean;
	/** Whether the Entry can only be published with a value in it. */
	required: boolean;
};

/** A Field as people give it: `translatable` defaults to true, `required` to false. */
export type FieldInput = {
	key: string;
	label: string;
	type: FieldType;
	translatable?: boolean;
	required?: boolean;
};

/**
 * The built-in Fields every Entry has, whatever its Post Type. `title` and `slug` are Translatable
 * fields stored like any other; the rest are kept by WebCraft.
 */
export const BUILT_IN_FIELDS = [
	"title",
	"slug",
	"status",
	"author",
	"createdAt",
	"updatedAt",
	"publishedAt",
	"lastPublishedAt",
] as const;

export type BuiltInField = (typeof BUILT_IN_FIELDS)[number];

/**
 * Names a Field key can't take: the built-in Fields, and the names Template markup reads values
 * from (`site.x` Globals, `props.x` Props, `item.x` Loop items).
 */
const RESERVED_KEYS = new Set(
	[...BUILT_IN_FIELDS, "id", "site", "props", "item", "loop", "entry", "language", "url", "type", "fields"].map((key) =>
		key.toLowerCase(),
	),
);

/** A Field key: starts with a lower-case letter, then letters, digits and underscores; at most 64. */
const FIELD_KEY = /^[a-z][A-Za-z0-9_]{0,63}$/;

/** The most Fields a Post Type has. */
export const MAX_FIELDS = 200;

/** The longest label, and the longest text Field value, in characters. */
export const FIELD_LABEL_MAX_LENGTH = 100;
export const TEXT_VALUE_MAX_LENGTH = 2_000;

/**
 * Checks a Post Type's Fields, adding a problem for each one that is wrong. `existing` holds the
 * Fields stored so far: a Field keeps its type once created.
 */
export function parseFields(
	inputs: readonly FieldInput[],
	problems: ContentProblem[],
	existing: readonly FieldDefinition[] = [],
): FieldDefinition[] {
	if (inputs.length > MAX_FIELDS) {
		problems.push({ at: "fields", message: `A Post Type has at most ${MAX_FIELDS} Fields.` });
	}
	const seen = new Set<string>();
	return inputs.map((input, index) => {
		const at = `fields[${index}]`;
		const key = input.key.trim();
		const label = input.label.trim();
		if (!FIELD_KEY.test(key)) {
			problems.push({
				at: `${at}.key`,
				message: "A Field key starts with a lower-case letter, then letters, digits and underscores (at most 64).",
			});
		} else if (RESERVED_KEYS.has(key.toLowerCase())) {
			problems.push({ at: `${at}.key`, message: `${key} is kept for WebCraft; choose another key.` });
		} else if (seen.has(key.toLowerCase())) {
			problems.push({ at: `${at}.key`, message: `Two Fields have the key ${key}.` });
		}
		seen.add(key.toLowerCase());
		if (!label || label.length > FIELD_LABEL_MAX_LENGTH) {
			problems.push({ at: `${at}.label`, message: `A Field's label has 1 to ${FIELD_LABEL_MAX_LENGTH} characters.` });
		}
		if (!(FIELD_TYPES as readonly string[]).includes(input.type)) {
			problems.push({ at: `${at}.type`, message: `There is no Field type ${input.type}.` });
		}
		const before = existing.find((field) => field.key === key);
		if (before && before.type !== input.type) {
			problems.push({ at: `${at}.type`, message: `${key} is a ${before.type} Field; a Field keeps its type.` });
		}
		return {
			key,
			label,
			type: input.type,
			translatable: input.translatable ?? true,
			required: input.required ?? false,
		};
	});
}

/** Reads stored Field definitions. */
export function storedFields(value: unknown): FieldDefinition[] {
	return Array.isArray(value) ? (value as FieldDefinition[]) : [];
}
