/**
 * Forms (GLOSSARY.md): what a Form is, as stored in its Draft and published version, and the rules
 * its fields keep. This file imports nothing, so the admin's browser code reads the same rules
 * (`@webcraft/renderer/forms`) that core checks a Form against and the renderer renders it with.
 *
 * Fixed text in a Form (labels, help, placeholders, options, messages) has a value per language, as
 * fixed text in Templates does: the text as written and, optionally, its text in other languages by
 * BCP 47 tag (`FormText`). A page in one of them shows that, every other page the text as written.
 */

/** Text with a value per language: the text as written, and its own text in other languages. */
export type FormText = { text: string; translations?: Record<string, string> };

/** The kinds of field a Form has. File uploads come later. */
export const FORM_FIELD_TYPES = [
	"text",
	"email",
	"phone",
	"url",
	"textarea",
	"number",
	"date",
	"select",
	"radio",
	"checkboxes",
	"consent",
	"hidden",
] as const;

export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

/** One choice of a select, radio or checkboxes field: the value stored, and the label shown. */
export type FormOption = { value: string; label: FormText };

/**
 * Where a hidden field's value comes from, worked out when the Form is sent: a parameter of the
 * page's address (`utm_source`), the page's address itself, or fixed text.
 */
export type HiddenSource = { kind: "query"; name: string } | { kind: "page" } | { kind: "fixed"; value: string };

/**
 * One field. Every field has every setting; the ones its type doesn't use are null (or empty). Its
 * `key` names its value in Submissions, Notifications, exports and Webhooks, and never repeats in
 * the Form.
 */
export type FormField = {
	key: string;
	type: FormFieldType;
	/** Every field has a label; `hideLabel` keeps it for screen readers only. */
	label: FormText;
	hideLabel: boolean;
	help: FormText | null;
	placeholder: FormText | null;
	/** The error shown for any value the field refuses, in place of WebCraft's own words. */
	message: FormText | null;
	/** A value must be given (a choice made, the consent ticked). Hidden fields never are. */
	required: boolean;
	/** Text and textareas: the shortest and longest value, in characters. */
	minLength: number | null;
	maxLength: number | null;
	/** Text: a regular expression the whole value matches, as an HTML `pattern` reads it (run on RE2). */
	pattern: string | null;
	/** Text, email, phone and URL: what the browser may fill in (`name`, `email`, `tel`…). */
	autocomplete: string | null;
	/** Numbers: the smallest and largest value, and whether it is a whole number. */
	min: number | null;
	max: number | null;
	integer: boolean;
	/** Dates: the earliest and latest day, `2026-03-02`. */
	minDate: string | null;
	maxDate: string | null;
	/** Select, radio and checkboxes: the choices, in order. */
	options: FormOption[];
	/** Checkboxes: how many may be ticked at least and at most. */
	minChoices: number | null;
	maxChoices: number | null;
	/** Hidden fields: where the value comes from. */
	source: HiddenSource | null;
};

/** What a visitor sees once a Form is sent: a message in place of the Form, or another Page. */
export type FormSuccess = { kind: "message"; message: FormText } | { kind: "redirect"; pageId: string };

/** How a Form keeps spam out: the fewest seconds a person takes, and how often one address may send it. */
export type FormSpam = { minFillSeconds: number; perMinute: number; perHour: number };

/** One version of a Form (its Draft, or what is published). */
export type FormVersion = {
	fields: FormField[];
	submitLabel: FormText;
	success: FormSuccess;
	spam: FormSpam;
};

/** How much a Form holds at most. */
export const FORM_LIMITS = {
	fields: 100,
	options: 200,
	keyLength: 64,
	nameLength: 200,
	labelLength: 500,
	helpLength: 1000,
	messageLength: 1000,
	optionValueLength: 200,
	patternLength: 500,
	/** The longest value of a text field, and of a textarea, in characters. */
	textLength: 2000,
	textareaLength: 20_000,
	minFillSeconds: 600,
	perMinute: 1000,
	perHour: 10_000,
} as const;

/** The spam limits a new Form starts with (5 a minute and 30 an hour from one address). */
export const FORM_SPAM_DEFAULTS: FormSpam = { minFillSeconds: 3, perMinute: 5, perHour: 30 };

/** A Form's key: lower-case words joined by dashes (`wedding-cake`), as `{{@form wedding-cake}}` names it. */
export const FORM_KEY = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** A field's key: a lower-case letter, then lower-case letters, digits and underscores (`first_name`). */
export const FORM_FIELD_KEY = /^[a-z][a-z0-9_]*$/;

/** An option's value: letters, digits, dashes and underscores (`tiered`, `2-tiers`). */
export const FORM_OPTION_VALUE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** A query parameter a hidden field reads (`utm_source`). */
export const QUERY_PARAMETER = /^[A-Za-z0-9_.-]{1,100}$/;

/** What browsers may fill fields in with (WCAG 1.3.5): the purposes WebCraft offers. */
export const FORM_AUTOCOMPLETE = [
	"name",
	"given-name",
	"family-name",
	"organization",
	"organization-title",
	"street-address",
	"address-line1",
	"address-line2",
	"address-level2",
	"address-level1",
	"postal-code",
	"country-name",
	"email",
	"tel",
	"url",
	"off",
] as const;

/** Which settings each type of field uses; the others are null (or empty). */
export const FIELD_TYPE_SETTINGS: Readonly<
	Record<
		FormFieldType,
		readonly (
			| "placeholder"
			| "minLength"
			| "maxLength"
			| "pattern"
			| "autocomplete"
			| "min"
			| "max"
			| "integer"
			| "minDate"
			| "maxDate"
			| "options"
			| "minChoices"
			| "maxChoices"
			| "source"
		)[]
	>
> = {
	text: ["placeholder", "minLength", "maxLength", "pattern", "autocomplete"],
	email: ["placeholder", "autocomplete"],
	phone: ["placeholder", "autocomplete"],
	url: ["placeholder", "autocomplete"],
	textarea: ["placeholder", "minLength", "maxLength"],
	number: ["placeholder", "min", "max", "integer"],
	date: ["minDate", "maxDate"],
	select: ["placeholder", "options"],
	radio: ["options"],
	checkboxes: ["options", "minChoices", "maxChoices"],
	consent: [],
	hidden: ["source"],
};

/** Whether a type of field can be required (a hidden field's value isn't the visitor's to give). */
export function canBeRequired(type: FormFieldType): boolean {
	return type !== "hidden";
}

/** A field of `type` with every setting unset. */
export function emptyField(key: string, type: FormFieldType, label: FormText): FormField {
	return {
		key,
		type,
		label,
		hideLabel: false,
		help: null,
		placeholder: null,
		message: null,
		required: false,
		minLength: null,
		maxLength: null,
		pattern: null,
		autocomplete: null,
		min: null,
		max: null,
		integer: false,
		minDate: null,
		maxDate: null,
		options: [],
		minChoices: null,
		maxChoices: null,
		source: type === "hidden" ? { kind: "page" } : null,
	};
}

/** Fixed text in a language: its own text there, else the text as written. */
export function formTextIn(text: FormText, language: string | undefined): string {
	return (language !== undefined && text.translations?.[language]) || text.text;
}
