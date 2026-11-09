/**
 * What every Field type is, and the limits Fields and their values keep. This module imports
 * nothing, so the admin's browser code (`@webcraft/core/field-rules`) reads the same rules the
 * content store checks: which types there are, which are translatable by default, which can be
 * required or have a default, and the rule codes a value's problems carry.
 */

/** The Field types there are, in the order the admin offers them. */
export const FIELD_TYPES = [
	"text",
	"richText",
	"body",
	"number",
	"boolean",
	"date",
	"select",
	"media",
	"link",
	"email",
	"relationship",
	"group",
	"repeater",
] as const;

export type FieldType = (typeof FIELD_TYPES)[number];

/** How a date Field is written: a day (`2026-03-02`), a time of day (`09:30`) or a moment (`2026-03-02T09:30:00Z`). */
export const DATE_MODES = ["date", "time", "dateTime"] as const;

export type DateMode = (typeof DATE_MODES)[number];

/** What a Field type is, whatever its settings. */
export type FieldTypeTraits = {
	/** Whether values are per language: by default, only when chosen, or never (shared by every language). */
	readonly translation: "default-on" | "default-off" | "never";
	/** Whether a value can be required (a true/false Field always has one). */
	readonly requirable: boolean;
	/** Whether the Field can give new Entries (and Repeater rows) a value to start with. */
	readonly hasDefault: boolean;
};

/** Each Field type's traits (ADR 0003 for translation). */
export const FIELD_TYPE_TRAITS: { readonly [Type in FieldType]: FieldTypeTraits } = {
	text: { translation: "default-on", requirable: true, hasDefault: true },
	richText: { translation: "default-on", requirable: true, hasDefault: true },
	// Each language keeps its own Block list (ADR 0018).
	body: { translation: "default-on", requirable: true, hasDefault: false },
	number: { translation: "default-off", requirable: true, hasDefault: true },
	boolean: { translation: "default-off", requirable: false, hasDefault: true },
	date: { translation: "default-off", requirable: true, hasDefault: true },
	select: { translation: "default-off", requirable: true, hasDefault: true },
	media: { translation: "default-off", requirable: true, hasDefault: false },
	link: { translation: "default-on", requirable: true, hasDefault: true },
	email: { translation: "default-off", requirable: true, hasDefault: true },
	relationship: { translation: "never", requirable: true, hasDefault: false },
	group: { translation: "never", requirable: true, hasDefault: false },
	repeater: { translation: "never", requirable: true, hasDefault: false },
};

/** Whether a Field type holds other Fields: a Group (one set) or a Repeater (rows of them). */
export function isContainerType(type: FieldType): type is "group" | "repeater" {
	return type === "group" || type === "repeater";
}

/** A Field key: starts with a lower-case letter, then letters, digits and underscores; at most 64. */
export const FIELD_KEY = /^[a-z][A-Za-z0-9_]{0,63}$/;

/** The most Fields a Post Type (or the Globals) has, counting those inside Groups and Repeaters. */
export const MAX_FIELDS = 200;

/** How deep Groups and Repeaters nest: a Field at the top is at depth 1. */
export const MAX_FIELD_DEPTH = 3;

/** The longest label and help text, in characters. */
export const FIELD_LABEL_MAX_LENGTH = 100;
export const FIELD_HELP_MAX_LENGTH = 500;

/** The longest title an Entry has, in characters. */
export const ENTRY_TITLE_MAX_LENGTH = 300;

/** The longest text value, in characters. */
export const TEXT_VALUE_MAX_LENGTH = 2_000;

/** The most choices of a select Field, and the most Entries a Relationship points at. */
export const MAX_OPTIONS = 200;
export const MAX_LINKED_ENTRIES = 200;

/** The most rows a Repeater holds. */
export const MAX_ROWS = 500;

/** How deep Pages nest: a Page's path has at most this many parts. */
export const MAX_PAGE_DEPTH = 10;

/** The longest `pattern` setting (a regular expression in RE2 syntax), in characters. */
export const PATTERN_MAX_LENGTH = 200;

/**
 * The rules a value can break, as an Entry's (or the Globals') `problems` name them, for the admin to
 * word: an empty required value, too few or too many (characters, choices, Entries, rows), not
 * matching the pattern, not a whole number, not an email address, a choice the Field no longer has,
 * a link without an address, an Entry or file the Field can't point at, a Block of a type the Body
 * field has switched off, and a video that isn't on YouTube or Vimeo.
 */
export const VALUE_RULES = [
	"required",
	"min",
	"max",
	"minLength",
	"maxLength",
	"pattern",
	"integer",
	"email",
	"options",
	"url",
	"postTypes",
	"media",
	"blockType",
	"video",
] as const;

export type ValueRule = (typeof VALUE_RULES)[number];

/**
 * Why a Post Type's, a Field's or the Globals' settings were refused, as their `problems` name it
 * (`rule`, with `params` to fill in), for the admin to word in each Admin language. The English
 * `message` beside it stays for API clients.
 */
export const SETTING_RULES = [
	// The list of Fields
	"fieldCount",
	"keyFormat",
	"keyReserved",
	"keyTwice",
	"labelLength",
	"helpLength",
	"typeUnknown",
	"typeChanged",
	"bodyNested",
	"bodyTwice",
	"bodyOnPage",
	"bodyInLoop",
	"bodyNotHere",
	"requiredNever",
	"translatableShared",
	"translatableInner",
	"fieldsDepth",
	"fieldsEmpty",
	"defaultNone",
	"defaultInvalid",
	// One type's settings
	"wholeNumber",
	"number",
	"boolean",
	"lengthOrder",
	"numberOrder",
	"dateMode",
	"dateFormat",
	"dateOrder",
	"optionsCount",
	"optionValueFormat",
	"optionValueTwice",
	"optionLabelLength",
	"minNotMultiple",
	"maxNotMultiple",
	"countsOrder",
	"rowsOrder",
	"patternLength",
	"patternInvalid",
	"blocksOffList",
	"blockUnknown",
	"blockAlwaysOn",
	"relationshipInGlobals",
	"relationshipInLoop",
	"relationshipInModuleComponent",
	"postTypesCount",
	"postTypeUnknown",
	// The Post Type itself
	"postTypeKeyFormat",
	"postTypeNameLength",
	"pageUrlPattern",
	"urlPatternFormat",
	"urlPatternParts",
	// Its Searched fields (Site search)
	"searchedFieldsCount",
	"searchedFieldWeight",
	"searchedFieldUnknown",
	"searchedFieldType",
	"searchedFieldTwice",
] as const;

export type SettingRule = (typeof SETTING_RULES)[number];

/** What fills in a setting problem's wording, such as the key or the largest number allowed. */
export type SettingParams = Readonly<Record<string, string | number>>;
