import {
	ALWAYS_ON_BLOCKS,
	BLOCK_TYPES,
	type BlockProp,
	type BlockType,
	bodyHasContent,
	cleanRichText,
	isBlockType,
	RICH_TEXT_MAX_LENGTH,
	readBody,
	richTextToText,
	safeUrl,
	storedBlocks,
	videoAt,
} from "@webcraft/renderer";
import { RE2JS } from "re2js";
import { isUuid } from "../ids.ts";
import type { ContentProblem } from "./errors.ts";
import {
	DATE_MODES,
	type DateMode,
	FIELD_TYPE_TRAITS,
	FIELD_TYPES,
	type FieldType,
	type FieldTypeTraits,
	MAX_LINKED_ENTRIES,
	MAX_OPTIONS,
	MAX_ROWS,
	PATTERN_MAX_LENGTH,
	type SettingParams,
	type SettingRule,
	TEXT_VALUE_MAX_LENGTH,
} from "./field-rules.ts";

export {
	DATE_MODES,
	type DateMode,
	FIELD_TYPES,
	type FieldType,
	MAX_LINKED_ENTRIES,
	MAX_OPTIONS,
	MAX_ROWS,
	TEXT_VALUE_MAX_LENGTH,
} from "./field-rules.ts";

/**
 * The Field-type registry: everything the content store knows about each Field type, in one place.
 * A type checks its own settings, checks and reads its values, and lists the rules a value breaks.
 * Group and Repeater are containers: the content store walks into their Fields (`field-values.ts`).
 */

/** A JSON value, as Field values are stored and as the APIs give them. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

/** One choice of a select Field: the value stored, and the label people and visitors see. */
export type SelectOption = { value: string; label: string };

/** A link Field's value: where it goes and the text it shows. */
export type LinkValue = { url: string; text: string };

/** What every Field has, whatever its type. */
type Common<Type extends FieldType, Default> = {
	/** Names the Field in Template markup (`{{ summary }}`), the APIs and files. Never changes. */
	key: string;
	/** What people see next to it. */
	label: string;
	type: Type;
	/** Help text shown under it in the editors; "" for none. */
	help: string;
	/** Whether the Entry (or the Globals) can only be published with a value in it. */
	required: boolean;
	/** A value per language (ADR 0003); otherwise one value shared by every language. */
	translatable: boolean;
	/** The value a new Entry (or Repeater row) starts with; null for none. */
	default: Default;
};

export type TextField = Common<"text", string | null> & {
	minLength: number | null;
	maxLength: number | null;
	/** A regular expression the whole value must match, as in an HTML `pattern` attribute. */
	pattern: string | null;
};
export type RichTextField = Common<"richText", string | null> & {
	/** The most characters of text (tags not counted). */
	maxLength: number | null;
};
/**
 * A Body field (ADR 0018): long-form text as a list of typed Blocks with stable ids, each language
 * keeping its own list. A Post Type has at most one, at the top of its Fields; Pages, the Globals and
 * Components' Props have none.
 */
export type BodyField = Common<"body", null> & {
	/** The Block types Staff switched off: people can't add them, and those already there keep it from publishing. */
	blocksOff: BlockType[];
	/**
	 * The Site's Components Members may place in the body (by id, in the order the `/` menu offers
	 * them); none by default. A Block placing one no longer allowed stays, and keeps the Entry from
	 * being published.
	 */
	components: string[];
};
export type NumberField = Common<"number", number | null> & {
	min: number | null;
	max: number | null;
	/** Whole numbers only. */
	integer: boolean;
};
export type BooleanField = Common<"boolean", boolean | null>;
export type DateField = Common<"date", string | null> & { mode: DateMode; min: string | null; max: string | null };
export type SelectField = Common<"select", string | string[] | null> & {
	options: SelectOption[];
	/** Several choices (a list) or one. */
	multiple: boolean;
	/** With several choices: the fewest and most that may be chosen. */
	min: number | null;
	max: number | null;
};
/**
 * A media Field: the id of a file in the Site's Media library. Templates read it as `media:<id>`, so
 * an `<img>` bound to it renders as a Media image, and an `href` as the file's address.
 */
export type MediaField = Common<"media", null>;
export type LinkField = Common<"link", LinkValue | null>;
export type EmailField = Common<"email", string | null> & { pattern: string | null };
export type RelationshipField = Common<"relationship", null> & {
	/** The keys of the Post Types whose Entries it may point at. */
	postTypes: string[];
	multiple: boolean;
	/** Whether the Entries pointed at show the link back (two-way) or not (one-way). */
	twoWay: boolean;
	min: number | null;
	max: number | null;
};
/** A Group: a fixed set of other Fields. */
export type GroupField = Common<"group", null> & { fields: FieldDefinition[] };
/** A Repeater: an ordered list of Groups (rows), each with these Fields. */
export type RepeaterField = Common<"repeater", null> & {
	fields: FieldDefinition[];
	min: number | null;
	max: number | null;
};

/** One Field, as stored and as the APIs give it: the settings every Field has, and its type's. */
export type FieldDefinition =
	| TextField
	| RichTextField
	| BodyField
	| NumberField
	| BooleanField
	| DateField
	| SelectField
	| MediaField
	| LinkField
	| EmailField
	| RelationshipField
	| GroupField
	| RepeaterField;

export type LeafField = Exclude<FieldDefinition, GroupField | RepeaterField>;

/** A Field as people give it. Only `key`, `label` and `type` are needed; the rest has defaults. */
export type FieldInput = {
	key: string;
	label: string;
	type: FieldType;
	help?: string;
	required?: boolean;
	translatable?: boolean;
	default?: unknown;
	minLength?: number | null;
	maxLength?: number | null;
	pattern?: string | null;
	min?: number | string | null;
	max?: number | string | null;
	integer?: boolean;
	mode?: string;
	options?: SelectOption[];
	multiple?: boolean;
	postTypes?: string[];
	twoWay?: boolean;
	blocksOff?: string[];
	/** A Body field's allowed Components, by id. */
	components?: string[];
	fields?: FieldInput[];
};

/** What defining Fields needs to know about the Site. */
export type DefineContext = {
	/** The keys of the Site's Post Types, which Relationships may point at. */
	postTypeKeys: ReadonlySet<string>;
	/**
	 * Whose Fields these are: Globals can't hold Relationships, nor can a Module's Component's Props
	 * (each Site has its own Post Types). A Component's Props are declared with the Field types. Only
	 * a Post Type other than the Page Post Type (`page`) has a Body field. A Loop's own items (`loop`)
	 * hold neither a Body field nor Relationships.
	 */
	owner: "postType" | "page" | "globals" | "component" | "moduleComponent" | "loop";
	/** The ids of the Site's own Components, which a Body field may allow. */
	componentIds?: ReadonlySet<string>;
};

/** Reports a problem with a setting, at a path below the Field (`maxLength`, `options[1].value`). */
/** Refuses a setting: why (`SETTING_RULES`), in English for API clients, and what fills in its wording. */
export type Report = (setting: string, rule: SettingRule, message: string, params?: SettingParams) => void;

/**
 * A rule a value breaks: which rule, and why in words. `within` places it inside the value (a Body's
 * Block: `[2]`), after the Field's path.
 */
export type BrokenRule = { rule: string; message: string; within?: string };

/**
 * What a value points at, checked against the Site once every value is read: Entries of some Post
 * Types (a Relationship) or files of its Media library (a media Field).
 */
export type Reference =
	| { kind: "entries"; ids: string[]; postTypes: readonly string[] }
	| { kind: "media"; ids: string[] }
	| { kind: "components"; ids: string[]; placements: BodyPlacement[] };

/** A Component placed in a body, as its Block holds it, and where the Block is in the value (`[2]`). */
export type BodyPlacement = { within: string; component: string; props: BlockProp[] };

/**
 * A value written as plain text (a cell of a CSV file), as a Field type reads it:
 * - `input`: what the type's `parse` takes; `rule` names what is wrong when `parse` refuses it;
 * - `entries`: Entries to find first, by slug or title (a Relationship), then given as their ids;
 * - `file`: a file to fetch into the Media library first, by its `https` address (a media Field);
 * - `problem`: why the text can't be a value of the Field (a rule code, with what fills in its wording).
 */
export type TextReading =
	| { input: unknown; rule: string }
	| { entries: string[] }
	| { file: string }
	| { problem: string; params?: Record<string, string | number> };

/** What a leaf type does with values. */
export type ValueSpec<Field extends LeafField> = {
	/** How the API shows an empty value. */
	empty(field: Field): Json;
	/**
	 * Reads a value people give (never null or "", which clear a value), answering the value to store,
	 * or null for empty. A value of the wrong kind is reported with `fail` (the save is refused), at a
	 * place inside the value when given (`[2].text`); `refer` names Entries it points at.
	 */
	parse(
		input: unknown,
		field: Field,
		fail: (message: string, within?: string) => null,
		refer: (reference: Reference) => void,
		/** The value it replaces in the same language, if any: a body keeps Components placed before. */
		previous?: Json,
	): Json;
	/** Reads a stored value; null when it isn't one this Field holds (its settings changed since). */
	read(stored: unknown, field: Field): Json;
	/** The rules a (non-empty) value breaks: min/max, pattern and the like. */
	rules(value: Json, field: Field): BrokenRule[];
	/** Whether a value counts as empty (for `required`); null and [] are by default. */
	isEmpty?(value: Json): boolean;
	/**
	 * What a stored value points at, checked against the Site whenever the version is checked (a
	 * reference that is gone is a broken rule), each at a place inside the value.
	 */
	references?(value: Json, field: Field): (Reference & { within: string })[];
	/**
	 * Reads a value written as plain text (never empty), such as a cell of a CSV file an Import reads:
	 * its one written form for this type (see `TextReading`).
	 */
	fromText(text: string, field: Field): TextReading;
};

/** Everything the content store knows about one Field type: its traits (`field-rules.ts`) and what it does. */
export type FieldTypeSpec<Field extends FieldDefinition = FieldDefinition> = FieldTypeTraits & {
	/** Reads the type's own settings from input, reporting each problem where it is. */
	settings(input: FieldInput, report: Report, context: DefineContext): Omit<Field, keyof Common<FieldType, unknown>>;
	/** The value side of a leaf type; containers (Group, Repeater) have none. */
	value?: Field extends LeafField ? ValueSpec<Field> : never;
};

/** The longest rich text (as cleaned HTML), in characters. */
export const RICH_TEXT_VALUE_MAX_LENGTH = RICH_TEXT_MAX_LENGTH;
const OPTION_VALUE = /^[A-Za-z0-9_-]{1,64}$/;
const OPTION_LABEL_MAX_LENGTH = 100;
const LINK_TEXT_MAX_LENGTH = 300;
const URL_MAX_LENGTH = 2_000;
const EMAIL_MAX_LENGTH = 320;
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
/** A number as text: a dot or a comma as the decimal mark, no thousands separators. */
const WRITTEN_NUMBER = /^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/;
/** The words a true/false value is written with, in English and Italian, as text. */
const TRUE_WORDS = new Set(["true", "yes", "y", "1", "on", "si", "sì", "vero"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0", "off", "falso"]);

/** Several values in one piece of text: separated by semicolons, or by commas when there is none. */
function listedParts(text: string): string[] {
	return text
		.split(text.includes(";") ? ";" : ",")
		.map((part) => part.trim())
		.filter(Boolean);
}

const text: FieldTypeSpec<TextField> = {
	...FIELD_TYPE_TRAITS.text,
	settings(input, report) {
		const minLength = whole(input.minLength, "minLength", report, { min: 0, max: TEXT_VALUE_MAX_LENGTH });
		const maxLength = whole(input.maxLength, "maxLength", report, { min: 1, max: TEXT_VALUE_MAX_LENGTH });
		if (minLength !== null && maxLength !== null && maxLength < minLength) {
			report("maxLength", "lengthOrder", "The longest length can't be shorter than the shortest.");
		}
		return { minLength, maxLength, pattern: pattern(input.pattern, report) };
	},
	value: {
		empty: () => null,
		parse(input, _field, fail) {
			if (typeof input !== "string") return fail("A text value is text.");
			const value = input.trim();
			if (value.length > TEXT_VALUE_MAX_LENGTH)
				return fail(`A text value has at most ${TEXT_VALUE_MAX_LENGTH} characters.`);
			return value === "" ? null : value;
		},
		read: (stored) => (typeof stored === "string" ? stored : null),
		fromText: (text) => ({ input: text, rule: "tooLong" }),
		rules(value, field) {
			const length = String(value).length;
			return [
				...(field.minLength !== null && length < field.minLength
					? [{ rule: "minLength", message: `At least ${field.minLength} characters.` }]
					: []),
				...(field.maxLength !== null && length > field.maxLength
					? [{ rule: "maxLength", message: `At most ${field.maxLength} characters.` }]
					: []),
				...patternRule(String(value), field.pattern),
			];
		},
	},
};

const richText: FieldTypeSpec<RichTextField> = {
	...FIELD_TYPE_TRAITS.richText,
	settings(input, report) {
		return { maxLength: whole(input.maxLength, "maxLength", report, { min: 1, max: RICH_TEXT_VALUE_MAX_LENGTH }) };
	},
	value: {
		empty: () => null,
		parse(input, _field, fail) {
			if (typeof input !== "string") return fail("Rich text is HTML text.");
			if (input.length > RICH_TEXT_VALUE_MAX_LENGTH * 2) {
				return fail(`A rich text value has at most ${RICH_TEXT_VALUE_MAX_LENGTH} characters.`);
			}
			// Cleaned against the rich text allowlist (ADR 0017); empty when no text is left.
			const html = cleanRichText(input);
			if (html.length > RICH_TEXT_VALUE_MAX_LENGTH) {
				return fail(`A rich text value has at most ${RICH_TEXT_VALUE_MAX_LENGTH} characters.`);
			}
			return richTextToText(html).trim() === "" ? null : html;
		},
		read: (stored) => (typeof stored === "string" ? stored : null),
		// HTML, cleaned against the rich text allowlist like any rich text; plain text stays text.
		fromText: (text) => ({ input: text, rule: "tooLong" }),
		rules(value, field) {
			const length = richTextToText(String(value)).trim().length;
			return field.maxLength !== null && length > field.maxLength
				? [{ rule: "maxLength", message: `At most ${field.maxLength} characters of text.` }]
				: [];
		},
	},
};

const body: FieldTypeSpec<BodyField> = {
	...FIELD_TYPE_TRAITS.body,
	settings(input, report, context) {
		// Where a Body field may be (only one, at the top) is checked with the whole list (`parseFields`).
		if (context.owner !== "postType") {
			if (context.owner === "page") {
				report("type", "bodyOnPage", "Pages are arranged with a Page layout, so they have no Body field.");
			} else if (context.owner === "loop") {
				report(
					"type",
					"bodyInLoop",
					"Loop items have no Body field: a query Loop over a Post Type reads its Entries' bodies.",
				);
			} else {
				report("type", "bodyNotHere", "Only a Post Type has a Body field.");
			}
		}
		const blocksOff: BlockType[] = [];
		if (input.blocksOff !== undefined && input.blocksOff !== null) {
			if (!Array.isArray(input.blocksOff)) {
				report("blocksOff", "blocksOffList", "The Blocks switched off are a list of Block types.");
			} else {
				input.blocksOff.forEach((type, index) => {
					if (!isBlockType(type)) {
						report(
							`blocksOff[${index}]`,
							"blockUnknown",
							`There is no Block type ${String(type)}; they are ${BLOCK_TYPES.join(", ")}.`,
							{ type: String(type) },
						);
					} else if (ALWAYS_ON_BLOCKS.includes(type)) {
						report(`blocksOff[${index}]`, "blockAlwaysOn", `A body always has ${type}s.`, { type });
					} else if (!blocksOff.includes(type)) {
						blocksOff.push(type);
					}
				});
			}
		}
		const components: string[] = [];
		if (input.components !== undefined && input.components !== null) {
			if (!Array.isArray(input.components)) {
				report("components", "componentsList", "The Components a body allows are a list of Component ids.");
			} else {
				input.components.forEach((id, index) => {
					if (typeof id !== "string" || !context.componentIds?.has(id)) {
						report(`components[${index}]`, "componentUnknown", `The Site has no Component ${String(id)}.`);
					} else if (!components.includes(id)) {
						components.push(id);
					}
				});
			}
		}
		return { blocksOff: BLOCK_TYPES.filter((type) => blocksOff.includes(type)), components };
	},
	value: {
		empty: () => [],
		parse(input, field, fail, refer, previous) {
			const { blocks, problems } = readBody(input);
			for (const problem of problems) fail(problem.message, problem.at);
			if (problems.length > 0) return null;
			// A Component goes in only where the Field allows it. One placed before keeps its place (Staff
			// may have stopped allowing it since): it is listed in `problems` instead, so nothing else is lost.
			const placedBefore = new Set(
				storedBlocks(previous).flatMap((block) =>
					block.type === "component" ? [`${block.id} ${block.component}`] : [],
				),
			);
			let refused = false;
			const placements: BodyPlacement[] = [];
			blocks.forEach((block, index) => {
				if (block.type !== "component") return;
				if (!field.components.includes(block.component) && !placedBefore.has(`${block.id} ${block.component}`)) {
					refused = true;
					fail("This Body field doesn't allow that Component.", `[${index}].component`);
				}
				placements.push({ within: `[${index}]`, component: block.component, props: block.props });
			});
			if (refused) return null;
			if (placements.length > 0) {
				refer({ kind: "components", ids: [...new Set(placements.map((each) => each.component))], placements });
			}
			return blocks.length === 0 ? null : (blocks as unknown as Json);
		},
		read: (stored) => (Array.isArray(stored) ? stored : null),
		// Plain paragraphs: a blank line starts a new one, a single line break stays a line break. Nothing
		// in the text is read as markup.
		fromText: (text) => ({
			input: text
				.replace(/\r\n?/g, "\n")
				.split(/\n[ \t]*\n/)
				.map((paragraph) => paragraph.trim())
				.filter(Boolean)
				.map((paragraph) => ({ type: "paragraph", text: paragraph })),
			rule: "tooLong",
		}),
		rules(value, field) {
			const broken: BrokenRule[] = [];
			storedBlocks(value).forEach((block, index) => {
				if (block.type !== "component" && field.blocksOff.includes(block.type)) {
					broken.push({
						rule: "blockType",
						within: `[${index}]`,
						message: `The Body field has ${block.type} Blocks switched off.`,
					});
				}
				if (block.type === "video" && block.url !== "" && !videoAt(block.url)) {
					broken.push({ rule: "video", within: `[${index}].url`, message: "A video is on YouTube or Vimeo." });
				}
				if (block.type === "component" && !field.components.includes(block.component)) {
					broken.push({
						rule: "component",
						within: `[${index}].component`,
						message: "This Body field doesn't allow that Component any more.",
					});
				}
			});
			return broken;
		},
		isEmpty: (value) => !bodyHasContent(storedBlocks(value)),
		references: (value) => {
			const blocks = storedBlocks(value);
			const placements: BodyPlacement[] = blocks.flatMap((block, index) =>
				block.type === "component" ? [{ within: `[${index}]`, component: block.component, props: block.props }] : [],
			);
			return [
				...blocks.flatMap((block, index) =>
					block.type === "image" && block.media
						? [{ kind: "media" as const, ids: [block.media], within: `[${index}].media` }]
						: [],
				),
				...(placements.length > 0
					? [
							{
								kind: "components" as const,
								ids: [...new Set(placements.map((each) => each.component))],
								placements,
								within: "",
							},
						]
					: []),
			];
		},
	},
};

const number: FieldTypeSpec<NumberField> = {
	...FIELD_TYPE_TRAITS.number,
	settings(input, report) {
		const min = finite(input.min, "min", report);
		const max = finite(input.max, "max", report);
		if (min !== null && max !== null && max < min)
			report("max", "numberOrder", "The largest number can't be smaller than the smallest.");
		return { min, max, integer: flag(input.integer, "integer", report, false) };
	},
	value: {
		empty: () => null,
		parse(input, _field, fail) {
			if (input === null) return null;
			if (typeof input !== "number" || !Number.isFinite(input)) return fail("A number value is a number.");
			return input;
		},
		read: (stored) => (typeof stored === "number" && Number.isFinite(stored) ? stored : null),
		// A dot or a comma as the decimal mark, no thousands separators: `5.50`, `5,50`, `-3`, `1200`.
		fromText(text) {
			const written = text.trim();
			if (!WRITTEN_NUMBER.test(written)) return { problem: "number" };
			return { input: Number(written.replace(",", ".")), rule: "number" };
		},
		rules(value, field) {
			const n = Number(value);
			return [
				...(field.integer && !Number.isInteger(n) ? [{ rule: "integer", message: "A whole number." }] : []),
				...(field.min !== null && n < field.min ? [{ rule: "min", message: `At least ${field.min}.` }] : []),
				...(field.max !== null && n > field.max ? [{ rule: "max", message: `At most ${field.max}.` }] : []),
			];
		},
	},
};

const boolean: FieldTypeSpec<BooleanField> = {
	...FIELD_TYPE_TRAITS.boolean,
	settings: () => ({}),
	value: {
		empty: () => false,
		parse(input, _field, fail) {
			if (input === null) return null;
			if (typeof input !== "boolean") return fail("A true/false value is true or false.");
			return input;
		},
		read: (stored) => (typeof stored === "boolean" ? stored : null),
		fromText(text) {
			const word = text.trim().toLocaleLowerCase();
			if (TRUE_WORDS.has(word)) return { input: true, rule: "boolean" };
			if (FALSE_WORDS.has(word)) return { input: false, rule: "boolean" };
			return { problem: "boolean" };
		},
		rules: () => [],
		isEmpty: () => false,
	},
};

const date: FieldTypeSpec<DateField> = {
	...FIELD_TYPE_TRAITS.date,
	settings(input, report) {
		const mode = (input.mode ?? "date") as DateMode;
		if (!DATE_MODES.includes(mode)) {
			report("mode", "dateMode", `A date Field's mode is ${DATE_MODES.join(", ")}.`);
			return { mode: "date", min: null, max: null };
		}
		const bound = (value: unknown, setting: "min" | "max") => {
			if (value === undefined || value === null) return null;
			const parsed = typeof value === "string" ? parseDate(value, mode) : null;
			if (parsed === null)
				report(setting, "dateFormat", `Not a ${mode === "time" ? "time" : "date"} written as ${DATE_FORMATS[mode]}.`, {
					format: DATE_FORMATS[mode],
				});
			return parsed;
		};
		const min = bound(input.min, "min");
		const max = bound(input.max, "max");
		if (min !== null && max !== null && max < min)
			report("max", "dateOrder", "The latest can't be before the earliest.");
		return { mode, min, max };
	},
	value: {
		empty: () => null,
		parse(input, field, fail) {
			if (input === null || input === "") return null;
			const parsed = typeof input === "string" ? parseDate(input.trim(), field.mode) : null;
			if (parsed === null)
				return fail(`Not a ${field.mode === "time" ? "time" : "date"} written as ${DATE_FORMATS[field.mode]}.`);
			return parsed;
		},
		read: (stored, field) => (typeof stored === "string" ? parseDate(stored, field.mode) : null),
		// The stored form, and a moment without an offset (`2026-03-02 09:30`) read as UTC.
		fromText(text, field) {
			let written = text.trim();
			if (field.mode === "dateTime") {
				written = written.replace(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/, "$1T$2Z").replace(" ", "T");
			} else if (field.mode === "time") {
				written = written.replace(/^(\d):/, "0$1:").replace(/^(\d{2}:\d{2}):00$/, "$1");
			}
			return parseDate(written, field.mode) === null ? { problem: "date" } : { input: written, rule: "date" };
		},
		rules(value, field) {
			const written = String(value);
			return [
				...(field.min !== null && written < field.min ? [{ rule: "min", message: `${field.min} or later.` }] : []),
				...(field.max !== null && written > field.max ? [{ rule: "max", message: `${field.max} or earlier.` }] : []),
			];
		},
	},
};

const select: FieldTypeSpec<SelectField> = {
	...FIELD_TYPE_TRAITS.select,
	settings(input, report) {
		const options: SelectOption[] = [];
		if (!Array.isArray(input.options) || input.options.length === 0 || input.options.length > MAX_OPTIONS) {
			report("options", "optionsCount", `A select Field has 1 to ${MAX_OPTIONS} choices.`, { max: MAX_OPTIONS });
		} else {
			const seen = new Set<string>();
			input.options.forEach((option, index) => {
				const value = typeof option?.value === "string" ? option.value.trim() : "";
				const label = typeof option?.label === "string" ? option.label.trim() : "";
				if (!OPTION_VALUE.test(value)) {
					report(
						`options[${index}].value`,
						"optionValueFormat",
						"A choice's value is letters, digits, dashes and underscores (at most 64).",
					);
				} else if (seen.has(value)) {
					report(`options[${index}].value`, "optionValueTwice", `Two choices have the value ${value}.`, { value });
				}
				if (!label || label.length > OPTION_LABEL_MAX_LENGTH) {
					report(
						`options[${index}].label`,
						"optionLabelLength",
						`A choice's label has 1 to ${OPTION_LABEL_MAX_LENGTH} characters.`,
						{ max: OPTION_LABEL_MAX_LENGTH },
					);
				}
				seen.add(value);
				options.push({ value, label });
			});
		}
		const multiple = flag(input.multiple, "multiple", report, false);
		const { min, max } = counts(input, report, multiple, MAX_OPTIONS);
		return { options, multiple, min, max };
	},
	value: {
		empty: (field) => (field.multiple ? [] : null),
		parse(input, field, fail) {
			if (input === null) return null;
			const known = new Set(field.options.map((option) => option.value));
			if (!field.multiple) {
				if (typeof input !== "string") return fail("Choose one of the Field's choices.");
				if (input === "") return null;
				if (!known.has(input)) return fail(`${input} isn't one of the Field's choices.`);
				return input;
			}
			if (!Array.isArray(input) || input.some((value) => typeof value !== "string")) {
				return fail("Choose a list of the Field's choices.");
			}
			const unknown = input.find((value) => !known.has(value));
			if (unknown !== undefined) return fail(`${unknown} isn't one of the Field's choices.`);
			const chosen = [...new Set(input as string[])];
			return chosen.length === 0 ? null : chosen;
		},
		read(stored, field) {
			if (!field.multiple) return typeof stored === "string" ? stored : null;
			return Array.isArray(stored) && stored.every((value) => typeof value === "string") ? stored : null;
		},
		// A choice by its value or its label (in any case); several separated by semicolons, or by
		// commas when there is no semicolon.
		fromText(text, field) {
			const parts = field.multiple ? listedParts(text) : [text.trim()];
			const chosen: string[] = [];
			for (const part of parts) {
				const folded = part.toLocaleLowerCase();
				const option =
					field.options.find((candidate) => candidate.value === part) ??
					field.options.find((candidate) => candidate.label.toLocaleLowerCase() === folded);
				if (!option) return { problem: "choice", params: { value: part } };
				chosen.push(option.value);
			}
			return { input: field.multiple ? chosen : (chosen[0] ?? null), rule: "choice" };
		},
		rules(value, field) {
			const chosen = Array.isArray(value) ? (value as string[]) : [String(value)];
			const known = new Set(field.options.map((option) => option.value));
			return [
				...(chosen.some((choice) => !known.has(choice))
					? [{ rule: "options", message: "A choice that the Field no longer has." }]
					: []),
				...countRules(chosen.length, field),
			];
		},
		isEmpty: (value) => value === null || (Array.isArray(value) && value.length === 0),
	},
};

const media: FieldTypeSpec<MediaField> = {
	...FIELD_TYPE_TRAITS.media,
	settings: () => ({}),
	value: {
		empty: () => null,
		parse(input, _field, fail, refer) {
			if (input === null) return null;
			if (typeof input !== "string" || !isUuid(input.trim())) {
				return fail("A media value is the id of a file in the Site's Media library.");
			}
			const id = input.trim().toLowerCase();
			refer({ kind: "media", ids: [id] });
			return id;
		},
		read: (stored) => (typeof stored === "string" && isUuid(stored) ? stored : null),
		// An `https` address, fetched into the Media library (Import from URL), or the id of a file
		// already in it.
		fromText(text) {
			const written = text.trim();
			if (isUuid(written)) return { input: written, rule: "media" };
			try {
				if (new URL(written).protocol === "https:") return { file: written };
			} catch {
				// Not an address: refused below.
			}
			return { problem: "mediaAddress" };
		},
		rules: () => [],
	},
};

const link: FieldTypeSpec<LinkField> = {
	...FIELD_TYPE_TRAITS.link,
	settings: () => ({}),
	value: {
		empty: () => null,
		parse(input, _field, fail) {
			if (input === null) return null;
			const { url, text } = (typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<
				string,
				unknown
			>;
			if (typeof url !== "string" || (text !== undefined && typeof text !== "string")) {
				return fail("A link is an address (url) and its text.");
			}
			const value = { url: url.trim(), text: (text ?? "").trim() };
			if (value.url.length > URL_MAX_LENGTH) return fail(`A link's address has at most ${URL_MAX_LENGTH} characters.`);
			if (value.text.length > LINK_TEXT_MAX_LENGTH)
				return fail(`A link's text has at most ${LINK_TEXT_MAX_LENGTH} characters.`);
			if (value.url !== "" && !isSafeUrl(value.url)) {
				return fail("A link goes to an http, https, mailto or tel address, a path or an #anchor.");
			}
			return value.url === "" && value.text === "" ? null : value;
		},
		read(stored) {
			const { url, text } = (stored ?? {}) as Record<string, unknown>;
			return typeof url === "string" && typeof text === "string" ? { url, text } : null;
		},
		// Its address, without text.
		fromText: (text) => ({ input: { url: text.trim(), text: "" }, rule: "link" }),
		rules: (value) => ((value as LinkValue).url === "" ? [{ rule: "url", message: "A link needs an address." }] : []),
	},
};

const email: FieldTypeSpec<EmailField> = {
	...FIELD_TYPE_TRAITS.email,
	settings: (input, report) => ({ pattern: pattern(input.pattern, report) }),
	value: {
		empty: () => null,
		parse(input, _field, fail) {
			if (input === null) return null;
			if (typeof input !== "string") return fail("An email address is text.");
			const value = input.trim().toLowerCase();
			if (value.length > EMAIL_MAX_LENGTH) return fail(`An email address has at most ${EMAIL_MAX_LENGTH} characters.`);
			return value === "" ? null : value;
		},
		read: (stored) => (typeof stored === "string" ? stored : null),
		fromText: (text) => ({ input: text, rule: "tooLong" }),
		rules: (value, field) => [
			...(EMAIL.test(String(value)) ? [] : [{ rule: "email", message: "Not an email address." }]),
			...patternRule(String(value), field.pattern),
		],
	},
};

const relationship: FieldTypeSpec<RelationshipField> = {
	...FIELD_TYPE_TRAITS.relationship,
	settings(input, report, context) {
		if (context.owner === "globals" || context.owner === "moduleComponent" || context.owner === "loop") {
			if (context.owner === "globals") {
				report("type", "relationshipInGlobals", "Globals can't hold Relationships.");
			} else if (context.owner === "loop") {
				report("type", "relationshipInLoop", "Loop items can't hold Relationships: a query Loop lists Entries.");
			} else {
				report(
					"type",
					"relationshipInModuleComponent",
					"A Module's Component can't have Relationship Props: each Site has its own Post Types.",
				);
			}
			return { postTypes: [], multiple: false, twoWay: true, min: null, max: null };
		}
		const postTypes: string[] = [];
		if (!Array.isArray(input.postTypes) || input.postTypes.length === 0 || input.postTypes.length > 20) {
			report("postTypes", "postTypesCount", "A Relationship points at Entries of 1 to 20 Post Types.", { max: 20 });
		} else {
			input.postTypes.forEach((key, index) => {
				if (typeof key !== "string" || !context.postTypeKeys.has(key)) {
					report(`postTypes[${index}]`, "postTypeUnknown", `The Site has no Post Type ${String(key)}.`, {
						key: String(key),
					});
				} else if (!postTypes.includes(key)) {
					postTypes.push(key);
				}
			});
		}
		const multiple = flag(input.multiple, "multiple", report, false);
		const { min, max } = counts(input, report, multiple, MAX_LINKED_ENTRIES);
		return { postTypes, multiple, twoWay: flag(input.twoWay, "twoWay", report, true), min, max };
	},
	value: {
		empty: (field) => (field.multiple ? [] : null),
		parse(input, field, fail, refer) {
			if (input === null || input === "") return null;
			const ids = field.multiple ? input : [input];
			if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string" || !isUuid(id))) {
				return fail(field.multiple ? "A list of Entry ids." : "An Entry id.");
			}
			const unique = [...new Set((ids as string[]).map((id) => id.toLowerCase()))];
			if (unique.length > MAX_LINKED_ENTRIES) return fail(`At most ${MAX_LINKED_ENTRIES} Entries.`);
			if (unique.length === 0) return null;
			refer({ kind: "entries", ids: unique, postTypes: field.postTypes });
			return field.multiple ? unique : (unique[0] ?? null);
		},
		read(stored, field) {
			if (!field.multiple) return typeof stored === "string" ? stored : null;
			return Array.isArray(stored) && stored.every((id) => typeof id === "string") ? stored : null;
		},
		// Entries of its Post Types by slug or title; several separated by semicolons, or by commas when
		// there is no semicolon.
		fromText: (text, field) => ({ entries: field.multiple ? listedParts(text) : [text.trim()] }),
		rules: (value, field) => countRules(Array.isArray(value) ? value.length : 1, field),
		isEmpty: (value) => value === null || (Array.isArray(value) && value.length === 0),
	},
};

const group: FieldTypeSpec<GroupField> = {
	...FIELD_TYPE_TRAITS.group,
	// Its Fields are read by `parseFields`, which knows how deep they are.
	settings: () => ({ fields: [] }),
};

const repeater: FieldTypeSpec<RepeaterField> = {
	...FIELD_TYPE_TRAITS.repeater,
	settings(input, report) {
		const min = whole(input.min, "min", report, { min: 0, max: MAX_ROWS });
		const max = whole(input.max, "max", report, { min: 1, max: MAX_ROWS });
		if (min !== null && max !== null && max < min)
			report("max", "rowsOrder", "The most rows can't be fewer than the fewest.");
		return { fields: [], min, max };
	},
};

/** The registry. */
export const FIELD_TYPE_SPECS: {
	readonly [Type in FieldType]: FieldTypeSpec<Extract<FieldDefinition, { type: Type }>>;
} = {
	text,
	richText,
	body,
	number,
	boolean,
	date,
	select,
	media,
	link,
	email,
	relationship,
	group,
	repeater,
};

/** The spec of a Field's type. */
export function specOf<Field extends FieldDefinition>(field: Field): FieldTypeSpec<Field> {
	return FIELD_TYPE_SPECS[field.type] as unknown as FieldTypeSpec<Field>;
}

export function isFieldType(type: unknown): type is FieldType {
	return typeof type === "string" && (FIELD_TYPES as readonly string[]).includes(type);
}

export function isContainer(field: FieldDefinition): field is GroupField | RepeaterField {
	return field.type === "group" || field.type === "repeater";
}

/** Whether a URL may be stored in a link: one the renderer keeps as it is. */
function isSafeUrl(url: string): boolean {
	return url === "#" || safeUrl(url) !== "#";
}

function whole(value: unknown, setting: string, report: Report, range: { min: number; max: number }): number | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "number" || !Number.isInteger(value) || value < range.min || value > range.max) {
		report(setting, "wholeNumber", `A whole number from ${range.min} to ${range.max}.`, range);
		return null;
	}
	return value;
}

function finite(value: unknown, setting: string, report: Report): number | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		report(setting, "number", "A number.");
		return null;
	}
	return value;
}

function flag(value: unknown, setting: string, report: Report, fallback: boolean): boolean {
	if (value === undefined || value === null) return fallback;
	if (typeof value !== "boolean") {
		report(setting, "boolean", "true or false.");
		return fallback;
	}
	return value;
}

/** The fewest and most choices or Entries; only a Field holding several has them. */
function counts(input: FieldInput, report: Report, multiple: boolean, most: number) {
	if (!multiple) {
		if (input.min !== undefined && input.min !== null)
			report("min", "minNotMultiple", "Only a Field holding several values has a fewest.");
		if (input.max !== undefined && input.max !== null)
			report("max", "maxNotMultiple", "Only a Field holding several values has a most.");
		return { min: null, max: null };
	}
	const min = whole(input.min, "min", report, { min: 0, max: most });
	const max = whole(input.max, "max", report, { min: 1, max: most });
	if (min !== null && max !== null && max < min)
		report("max", "countsOrder", "The most can't be fewer than the fewest.");
	return { min, max };
}

function countRules(count: number, field: { min: number | null; max: number | null }): BrokenRule[] {
	return [
		...(field.min !== null && count < field.min ? [{ rule: "min", message: `At least ${field.min}.` }] : []),
		...(field.max !== null && count > field.max ? [{ rule: "max", message: `At most ${field.max}.` }] : []),
	];
}

/** Compiled patterns, by source. */
const patterns = new Map<string, RE2JS>();

/**
 * The pattern a whole value must match, as an HTML `pattern` attribute reads it. Patterns are
 * Staff's input and run on every save, list and publish, so they run on a linear-time engine (RE2):
 * no pattern can keep the web process busy, whatever its shape and whatever the value.
 */
export function compiledPattern(source: string): RE2JS {
	let compiled = patterns.get(source);
	if (!compiled) {
		compiled = RE2JS.compile(`^(?:${source})$`);
		if (patterns.size > 1_000) patterns.clear();
		patterns.set(source, compiled);
	}
	return compiled;
}

function patternRule(value: string, source: string | null): BrokenRule[] {
	if (source === null) return [];
	return compiledPattern(source).matches(value)
		? []
		: [{ rule: "pattern", message: "Doesn't match the Field's pattern." }];
}

/**
 * Reads a `pattern` setting: a regular expression, as in an HTML `pattern` attribute, in the syntax
 * the linear-time engine reads (no look-around, no back-references).
 */
function pattern(value: unknown, report: Report): string | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "string" || value.length > PATTERN_MAX_LENGTH) {
		report(
			"pattern",
			"patternLength",
			`A pattern is a regular expression of at most ${PATTERN_MAX_LENGTH} characters.`,
			{
				max: PATTERN_MAX_LENGTH,
			},
		);
		return null;
	}
	try {
		compiledPattern(value);
	} catch {
		report(
			"pattern",
			"patternInvalid",
			"Not a regular expression WebCraft can run (look-around and back-references aren't supported).",
		);
		return null;
	}
	return value;
}

const DATE_FORMATS: Record<DateMode, string> = {
	date: "2026-03-02",
	time: "09:30",
	dateTime: "2026-03-02T09:30:00Z",
};

/**
 * Reads a date in a mode's written form, answering it the one way WebCraft stores it: a day as
 * `2026-03-02`, a time as `09:30`, a moment in UTC as `2026-03-02T09:30:00Z` (an offset is turned
 * into UTC). Null when it isn't one.
 */
export function parseDate(value: string, mode: DateMode): string | null {
	if (mode === "time") return /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(value) ? value : null;
	if (mode === "date") {
		const match = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(value);
		if (!match) return null;
		const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
		return day.toISOString().slice(0, 10) === value ? value : null;
	}
	const match =
		/^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}:[0-9]{2})(?::([0-9]{2})(?:\.[0-9]{1,9})?)?(Z|[+-][0-9]{2}:[0-9]{2})$/.exec(
			value,
		);
	if (!match || parseDate(match[1] ?? "", "date") === null || parseDate(match[2] ?? "", "time") === null) return null;
	if (Number(match[3] ?? "0") > 59) return null;
	const moment = new Date(`${match[1]}T${match[2]}:${match[3] ?? "00"}${match[4]}`);
	if (Number.isNaN(moment.getTime())) return null;
	return `${moment.toISOString().slice(0, 19)}Z`;
}

/** Adds a problem for a Field's setting, at `<at>.<setting>`. */
export function reporterAt(at: string, problems: ContentProblem[]): Report {
	return (setting, rule, message, params) =>
		problems.push({ at: `${at}.${setting}`, message, rule, ...(params ? { params } : {}) });
}
