import { EXPRESSION_KEYWORDS } from "@webcraft/renderer";

import type { ContentProblem } from "./errors.ts";
import {
	FIELD_HELP_MAX_LENGTH,
	FIELD_KEY,
	FIELD_LABEL_MAX_LENGTH,
	FIELD_TYPE_TRAITS,
	MAX_FIELD_DEPTH,
	MAX_FIELDS,
} from "./field-rules.ts";
import {
	type DefineContext,
	FIELD_TYPE_SPECS,
	type FieldDefinition,
	type FieldInput,
	isFieldType,
	type Json,
	type Report,
	reporterAt,
	specOf,
} from "./field-types.ts";

export {
	FIELD_HELP_MAX_LENGTH,
	FIELD_LABEL_MAX_LENGTH,
	MAX_FIELD_DEPTH,
	MAX_FIELDS,
} from "./field-rules.ts";
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
 * (`and`, `or`, `not`, `true`, `false`) and `seo`, where every Entry keeps its SEO fields. The Page Post
 * Type keeps `parent` too.
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
		// Every Entry's SEO fields are kept under it (`seo/entry-seo.ts`).
		"seo",
	].map((key) => key.toLowerCase()),
);

/**
 * Names a Field inside a Group or Repeater can't take: a Repeater row's `id`, and the words
 * Conditions' tests use, which a path can't end in.
 */
const RESERVED_NESTED_KEYS: ReadonlySet<string> = new Set(["id", ...EXPRESSION_KEYWORDS]);

/**
 * Checks a list of Fields (a Post Type's or the Globals'), adding a problem for each setting that is
 * wrong, where it is (`fields[2].fields[0].key`). `existing` holds the Fields stored so far: a Field
 * keeps its type once created, inside Groups and Repeaters too.
 */
export function parseFields(
	inputs: readonly FieldInput[],
	problems: ContentProblem[],
	context: DefineContext & {
		reservedKeys: ReadonlySet<string>;
		/** What the top-level list is called in problems: `fields` (a Post Type's, the Globals') or `props` (a Component's). */
		listName?: "fields" | "props";
	},
	existing: readonly FieldDefinition[] = [],
): FieldDefinition[] {
	const listName = context.listName ?? "fields";
	/** Props are declared with the Field types; problems about the top-level list name what they are. */
	const word = (depth: number) => (depth === 1 && listName === "props" ? "Prop" : "Field");
	/** What the list holds, for the admin's wording: Props or Fields. */
	const kind = (depth: number) => (depth === 1 && listName === "props" ? "prop" : "field");
	let count = 0;
	let bodies = 0;
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
					rule: "fieldCount",
					params: { max: MAX_FIELDS },
				});
			}
			const here = `${at}[${index}]`;
			const report = reporterAt(here, problems);
			const key = typeof input.key === "string" ? input.key.trim() : "";
			if (!FIELD_KEY.test(key)) {
				report(
					"key",
					"keyFormat",
					`A ${word(depth)} key starts with a lower-case letter, then letters, digits and underscores (at most 64).`,
					{ kind: kind(depth) },
				);
			} else if (reserved.has(key.toLowerCase())) {
				report("key", "keyReserved", `${key} is kept for WebCraft; choose another key.`, { key });
			} else if (seen.has(key.toLowerCase())) {
				report("key", "keyTwice", `Two ${word(depth)}s have the key ${key}.`, { key, kind: kind(depth) });
			}
			seen.add(key.toLowerCase());
			const label = typeof input.label === "string" ? input.label.trim() : "";
			if (!label || label.length > FIELD_LABEL_MAX_LENGTH) {
				report("label", "labelLength", `A ${word(depth)}'s label has 1 to ${FIELD_LABEL_MAX_LENGTH} characters.`, {
					max: FIELD_LABEL_MAX_LENGTH,
					kind: kind(depth),
				});
			}
			const help = typeof input.help === "string" ? input.help.trim() : "";
			if (help.length > FIELD_HELP_MAX_LENGTH)
				report("help", "helpLength", `Help text has at most ${FIELD_HELP_MAX_LENGTH} characters.`, {
					max: FIELD_HELP_MAX_LENGTH,
				});
			const type = isFieldType(input.type) ? input.type : "text";
			if (!isFieldType(input.type)) {
				report("type", "typeUnknown", `There is no Field type ${String(input.type)}.`, { type: String(input.type) });
			}
			const previous = before.find((field) => field.key === key);
			if (previous && previous.type !== input.type) {
				report("type", "typeChanged", `${key} is a ${previous.type} ${word(depth)}; a ${word(depth)} keeps its type.`, {
					key,
					type: previous.type,
					kind: kind(depth),
				});
			}

			if (type === "body") {
				// "The body" is never ambiguous: a Post Type has one at most, among its own Fields.
				if (depth > 1) {
					report(
						"type",
						"bodyNested",
						"A Body field sits among a Post Type's own Fields, not inside a Group or Repeater.",
					);
				} else if (bodies++ > 0) {
					report("type", "bodyTwice", "A Post Type has at most one Body field.");
				}
			}
			const spec = FIELD_TYPE_SPECS[type];
			const required = input.required ?? false;
			if (required && !spec.requirable)
				report("required", "requiredNever", "A true/false Field always has a value, so it can't be required.");
			let translatable = spec.translation === "default-on";
			if (input.translatable !== undefined) {
				if (input.translatable && spec.translation === "never") {
					if (type === "relationship") {
						report("translatable", "translatableShared", "A Relationship is shared by every language.");
					} else {
						report(
							"translatable",
							"translatableInner",
							"Its Fields are translatable one by one; set it on each of them.",
						);
					}
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
					report("fields", "fieldsDepth", `Groups and Repeaters nest at most ${MAX_FIELD_DEPTH} deep.`, {
						max: MAX_FIELD_DEPTH,
					});
				} else if (inner.length === 0) {
					report(
						"fields",
						"fieldsEmpty",
						`A ${field.type === "group" ? "Group" : "Repeater"} holds at least one Field.`,
						{
							kind: field.type,
						},
					);
				} else {
					const previousFields = previous && "fields" in previous ? previous.fields : [];
					field.fields = parseList(inner, `${here}.fields`, depth + 1, previousFields);
				}
			}
			field.default = parseDefault(field, input.default, report);
			return field;
		});
	};
	return parseList(inputs, listName, 1, existing);
}

/** Checks a Field's default against its own type and rules. Only some types have one. */
function parseDefault(field: FieldDefinition, input: unknown, report: Report): never {
	if (input === undefined || input === null) return null as never;
	const value = specOf(field).value;
	if (!value || !FIELD_TYPE_TRAITS[field.type].hasDefault) {
		report("default", "defaultNone", "This kind of Field has no default.");
		return null as never;
	}
	let refused = false;
	const parsed = value.parse(
		input,
		field as never,
		(message) => {
			refused = true;
			report("default", "defaultInvalid", message);
			return null;
		},
		() => {},
	);
	if (refused || parsed === null) return null as never;
	const broken = value.rules(parsed, field as never);
	if (broken.length > 0) {
		report("default", "defaultInvalid", broken.map((rule) => rule.message).join(" "));
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
