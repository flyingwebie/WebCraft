import { EXPRESSION_KEYWORDS } from "@webcraft/renderer";

import type { ContentProblem } from "./errors.ts";
import {
	type DefineContext,
	FIELD_TYPE_SPECS,
	type FieldDefinition,
	type FieldInput,
	isFieldType,
	type Json,
	reporterAt,
	specOf,
} from "./field-types.ts";

export {
	DATE_MODES,
	type DateMode,
	type DefineContext,
	FIELD_TYPES,
	type FieldDefinition,
	type FieldInput,
	type FieldType,
	type Json,
	type LinkValue,
	MAX_ROWS,
	RICH_TEXT_VALUE_MAX_LENGTH,
	type SelectOption,
	TEXT_VALUE_MAX_LENGTH,
} from "./field-types.ts";

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
 * Names a Post Type's Field can't take: the built-in Fields, the names Template markup reads values
 * from (`site.x` Globals, `props.x` Props, `item.x` Loop items) and the words Conditions' tests use
 * (`and`, `or`, `not`, `true`, `false`). The Page Post Type keeps `parent` too.
 */
export const RESERVED_FIELD_KEYS: ReadonlySet<string> = new Set(
	[
		...BUILT_IN_FIELDS,
		...EXPRESSION_KEYWORDS,
		"id",
		"site",
		"props",
		"item",
		"loop",
		"entry",
		"language",
		"url",
		"type",
		"fields",
	].map((key) => key.toLowerCase()),
);

/**
 * Names a Field inside a Group or Repeater can't take: a Repeater row's `id`, and the words
 * Conditions' tests use, which a path can't end in.
 */
const RESERVED_NESTED_KEYS: ReadonlySet<string> = new Set(["id", ...EXPRESSION_KEYWORDS]);

/** A Field key: starts with a lower-case letter, then letters, digits and underscores; at most 64. */
const FIELD_KEY = /^[a-z][A-Za-z0-9_]{0,63}$/;

/** The most Fields a Post Type (or the Globals) has, counting those inside Groups and Repeaters. */
export const MAX_FIELDS = 200;

/** How deep Groups and Repeaters nest: a Field at the top is at depth 1. */
export const MAX_FIELD_DEPTH = 3;

/** The longest label and help text, in characters. */
export const FIELD_LABEL_MAX_LENGTH = 100;
export const FIELD_HELP_MAX_LENGTH = 500;

/**
 * Checks a list of Fields (a Post Type's or the Globals'), adding a problem for each setting that is
 * wrong, where it is (`fields[2].fields[0].key`). `existing` holds the Fields stored so far: a Field
 * keeps its type once created, inside Groups and Repeaters too.
 */
export function parseFields(
	inputs: readonly FieldInput[],
	problems: ContentProblem[],
	context: DefineContext & { reservedKeys: ReadonlySet<string> },
	existing: readonly FieldDefinition[] = [],
): FieldDefinition[] {
	let count = 0;
	const parseList = (
		list: readonly FieldInput[],
		at: string,
		depth: number,
		before: readonly FieldDefinition[],
	): FieldDefinition[] => {
		const seen = new Set<string>();
		const reserved = depth === 1 ? context.reservedKeys : RESERVED_NESTED_KEYS;
		return list.map((input, index) => {
			count++;
			if (count === MAX_FIELDS + 1) {
				problems.push({
					at: "fields",
					message: `At most ${MAX_FIELDS} Fields, counting those inside Groups and Repeaters.`,
				});
			}
			const here = `${at}[${index}]`;
			const report = reporterAt(here, problems);
			const key = typeof input.key === "string" ? input.key.trim() : "";
			if (!FIELD_KEY.test(key)) {
				report(
					"key",
					"A Field key starts with a lower-case letter, then letters, digits and underscores (at most 64).",
				);
			} else if (reserved.has(key.toLowerCase())) {
				report("key", `${key} is kept for WebCraft; choose another key.`);
			} else if (seen.has(key.toLowerCase())) {
				report("key", `Two Fields have the key ${key}.`);
			}
			seen.add(key.toLowerCase());
			const label = typeof input.label === "string" ? input.label.trim() : "";
			if (!label || label.length > FIELD_LABEL_MAX_LENGTH) {
				report("label", `A Field's label has 1 to ${FIELD_LABEL_MAX_LENGTH} characters.`);
			}
			const help = typeof input.help === "string" ? input.help.trim() : "";
			if (help.length > FIELD_HELP_MAX_LENGTH)
				report("help", `Help text has at most ${FIELD_HELP_MAX_LENGTH} characters.`);
			const type = isFieldType(input.type) ? input.type : "text";
			if (!isFieldType(input.type)) report("type", `There is no Field type ${String(input.type)}.`);
			const previous = before.find((field) => field.key === key);
			if (previous && previous.type !== input.type) {
				report("type", `${key} is a ${previous.type} Field; a Field keeps its type.`);
			}

			const spec = FIELD_TYPE_SPECS[type];
			const required = input.required ?? false;
			if (required && !spec.requirable)
				report("required", "A true/false Field always has a value, so it can't be required.");
			let translatable = spec.translation === "default-on";
			if (input.translatable !== undefined) {
				if (input.translatable && spec.translation === "never") {
					report(
						"translatable",
						type === "relationship"
							? "A Relationship is shared by every language."
							: "Its Fields are translatable one by one; set it on each of them.",
					);
				} else {
					translatable = input.translatable;
				}
			}
			const settings = spec.settings(input as never, report, context) as Record<string, unknown>;
			const field = {
				key,
				label,
				type,
				help,
				required,
				translatable,
				default: null,
				...settings,
			} as FieldDefinition;
			if (field.type === "group" || field.type === "repeater") {
				const inner = Array.isArray(input.fields) ? input.fields : [];
				if (depth >= MAX_FIELD_DEPTH) {
					report("fields", `Groups and Repeaters nest at most ${MAX_FIELD_DEPTH} deep.`);
				} else if (inner.length === 0) {
					report("fields", `A ${field.type === "group" ? "Group" : "Repeater"} holds at least one Field.`);
				} else {
					const previousFields = previous && "fields" in previous ? previous.fields : [];
					field.fields = parseList(inner, `${here}.fields`, depth + 1, previousFields);
				}
			}
			field.default = parseDefault(field, input.default, report);
			return field;
		});
	};
	return parseList(inputs, "fields", 1, existing);
}

/** Checks a Field's default against its own type and rules. Only some types have one. */
function parseDefault(
	field: FieldDefinition,
	input: unknown,
	report: (setting: string, message: string) => void,
): never {
	if (input === undefined || input === null) return null as never;
	const value = specOf(field).value;
	if (!value || field.type === "media" || field.type === "relationship") {
		report("default", "This kind of Field has no default.");
		return null as never;
	}
	let refused = false;
	const parsed = value.parse(
		input,
		field as never,
		(message) => {
			refused = true;
			report("default", message);
			return null;
		},
		() => {},
	);
	if (refused || parsed === null) return null as never;
	const broken = value.rules(parsed, field as never);
	if (broken.length > 0) {
		report("default", broken.map((rule) => rule.message).join(" "));
		return null as never;
	}
	return parsed as never;
}

/** Reads stored Field definitions. */
export function storedFields(value: unknown): FieldDefinition[] {
	return Array.isArray(value) ? (value as FieldDefinition[]) : [];
}

/** The Field at a definition path (`address.city`, `team.person`), inside Groups and Repeaters. */
export function fieldAt(fields: readonly FieldDefinition[], path: string): FieldDefinition | undefined {
	let list: readonly FieldDefinition[] = fields;
	let found: FieldDefinition | undefined;
	for (const key of path.split(".")) {
		found = list.find((field) => field.key === key);
		if (!found) return undefined;
		list = "fields" in found ? found.fields : [];
	}
	return found;
}

/** A Json default value, for the types that have one. */
export function defaultOf(field: FieldDefinition): Json {
	return field.default as Json;
}
