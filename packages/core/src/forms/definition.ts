import {
	canBeRequired,
	canonicalLanguage,
	emptyField,
	FIELD_TYPE_SETTINGS,
	FORM_AUTOCOMPLETE,
	FORM_FIELD_KEY,
	FORM_FIELD_TYPES,
	FORM_LIMITS,
	FORM_OPTION_VALUE,
	FORM_SPAM_DEFAULTS,
	type FormField,
	type FormFieldType,
	type FormOption,
	type FormText,
	type FormVersion,
	formWords,
	type HiddenSource,
	QUERY_PARAMETER,
} from "@webcraft/renderer";
import type { ContentProblem } from "../content/errors.ts";
import { compiledPattern } from "../content/field-types.ts";

/**
 * Reading a Form's Draft as Staff send it: each part given (`fields`, `submitLabel`, `success`,
 * `spam`) replaces that part of the version it changes, and the result is checked as a whole and
 * answered in canonical form (every setting of every field, unset ones as null). Text is given as a
 * string, or as `{ text, translations }` with its text in other languages by BCP 47 tag.
 */

/** A Form's Draft change: the parts given replace those of the Draft. */
export type FormVersionInput = {
	fields?: unknown;
	submitLabel?: unknown;
	success?: unknown;
	spam?: unknown;
};

/**
 * The version a new Form starts with: WebCraft's words for its button and its message, as written in
 * the Site's Default language and translated into its other languages.
 */
export function newFormVersion(language: string, others: readonly string[] = []): FormVersion {
	const inEvery = (pick: (words: ReturnType<typeof formWords>) => string): FormText => {
		const text = pick(formWords(language));
		const translations = Object.fromEntries(
			others.map((other) => [other, pick(formWords(other))] as const).filter(([, words]) => words !== text),
		);
		return Object.keys(translations).length > 0 ? { text, translations } : { text };
	};
	return {
		fields: [],
		submitLabel: inEvery((words) => words.send),
		success: { kind: "message", message: inEvery((words) => words.sent) },
		spam: { ...FORM_SPAM_DEFAULTS },
	};
}

/** A stored version, read back. Versions are checked before they are stored, so this only fills gaps. */
export function storedFormVersion(stored: unknown, language = "en"): FormVersion {
	const fresh = newFormVersion(language);
	const raw = (stored ?? {}) as Partial<FormVersion>;
	return {
		fields: Array.isArray(raw.fields)
			? raw.fields.map((field) => ({ ...emptyField(field.key, field.type, field.label), ...field }))
			: [],
		submitLabel: raw.submitLabel ?? fresh.submitLabel,
		success: raw.success ?? fresh.success,
		spam: { ...fresh.spam, ...raw.spam },
	};
}

/** What reading a Draft change gives: the checked version, and the Pages it sends visitors to. */
export type ReadFormVersion = { version: FormVersion; pageIds: string[] };

/**
 * Reads a Draft change over `current`. Problems are reported to `problems`, each where it is
 * (`fields[2].options`, `success.pageId`); the version answered is only meaningful when there are none.
 */
export function readFormVersion(
	input: FormVersionInput,
	current: FormVersion,
	problems: ContentProblem[],
): ReadFormVersion {
	const report = (at: string, message: string) => problems.push({ at, message });
	const fields = input.fields === undefined ? current.fields : readFields(input.fields, report);
	const submitLabel =
		input.submitLabel === undefined
			? current.submitLabel
			: (readText(input.submitLabel, "submitLabel", report, { required: true, max: FORM_LIMITS.labelLength }) ??
				current.submitLabel);
	const success = input.success === undefined ? current.success : readSuccess(input.success, report, current);
	const spam = input.spam === undefined ? current.spam : readSpam(input.spam, current, report);
	return {
		version: { fields, submitLabel, success, spam },
		pageIds: success.kind === "redirect" && input.success !== undefined ? [success.pageId] : [],
	};
}

type Report = (at: string, message: string) => void;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Text with a value per language: a string, or `{ text, translations }`. Trimmed; translations that
 * are empty are dropped, and each tag must be one WebCraft keeps (canonical: `pt-BR`).
 */
export function readText(
	input: unknown,
	at: string,
	report: Report,
	options: { required: boolean; max: number },
): FormText | null {
	if (input === null || input === undefined || input === "") {
		if (options.required) report(at, "Write it: it can't be empty.");
		return null;
	}
	const raw = typeof input === "string" ? { text: input } : isRecord(input) ? input : null;
	if (!raw || typeof raw.text !== "string") {
		report(at, "Text is a string, or { text, translations }.");
		return null;
	}
	for (const key of Object.keys(raw)) {
		if (key !== "text" && key !== "translations") report(`${at}.${key}`, `Text has no ${key}.`);
	}
	const text = raw.text.trim();
	if (text === "") {
		if (options.required) report(at, "Write it: it can't be empty.");
		else return null;
	}
	if (text.length > options.max) report(at, `At most ${options.max} characters.`);
	const translations: Record<string, string> = {};
	if (raw.translations !== undefined && raw.translations !== null) {
		if (!isRecord(raw.translations)) {
			report(`${at}.translations`, 'Translations are text by language tag, such as { it: "…" }.');
		} else {
			for (const [tag, value] of Object.entries(raw.translations)) {
				const language = canonicalLanguage(tag);
				if (!language) {
					report(`${at}.translations.${tag}`, `${tag} isn't a language tag: write one such as fr or pt-BR.`);
					continue;
				}
				if (typeof value !== "string") {
					report(`${at}.translations.${tag}`, "A translation is text.");
					continue;
				}
				const translated = value.trim();
				if (translated.length > options.max) report(`${at}.translations.${tag}`, `At most ${options.max} characters.`);
				if (translated !== "") translations[language] = translated;
			}
		}
	}
	return Object.keys(translations).length > 0 ? { text, translations } : { text };
}

/** The settings a field may be given, besides those every field has. */
const SETTING_KEYS = new Set([
	"placeholder",
	"minLength",
	"maxLength",
	"pattern",
	"autocomplete",
	"min",
	"max",
	"integer",
	"minDate",
	"maxDate",
	"options",
	"minChoices",
	"maxChoices",
	"source",
]);
const COMMON_KEYS = new Set(["key", "type", "label", "hideLabel", "help", "message", "required"]);

/** Whether a setting was left unset: absent, null, or the empty value of a list or a switch. */
function isUnset(name: string, value: unknown): boolean {
	if (value === undefined || value === null) return true;
	if (name === "options") return Array.isArray(value) && value.length === 0;
	if (name === "integer") return value === false;
	if (name === "placeholder" || name === "pattern" || name === "autocomplete") return value === "";
	return false;
}

function readFields(input: unknown, report: Report): FormField[] {
	if (!Array.isArray(input)) {
		report("fields", "A Form's fields are a list.");
		return [];
	}
	if (input.length > FORM_LIMITS.fields) report("fields", `A Form has at most ${FORM_LIMITS.fields} fields.`);
	const keys = new Set<string>();
	const fields: FormField[] = [];
	input.forEach((raw: unknown, index) => {
		const at = `fields[${index}]`;
		const field = readField(raw, at, report);
		if (!field) return;
		if (keys.has(field.key)) {
			report(`${at}.key`, `Another field has the key ${field.key}: each field's key is its own.`);
			return;
		}
		keys.add(field.key);
		fields.push(field);
	});
	return fields;
}

function readField(raw: unknown, at: string, report: Report): FormField | undefined {
	if (!isRecord(raw)) {
		report(at, "A field is an object with its key, type and label.");
		return undefined;
	}
	const type = raw.type;
	if (typeof type !== "string" || !(FORM_FIELD_TYPES as readonly string[]).includes(type)) {
		report(`${at}.type`, `A field's type is one of ${FORM_FIELD_TYPES.join(", ")}.`);
		return undefined;
	}
	const fieldType = type as FormFieldType;
	let ok = true;
	/** Reports a problem at a full path, such as `fields[2].label.translations.xx`. */
	const failAt: Report = (path, message) => {
		ok = false;
		report(path, message);
	};
	/** Reports a problem at one of the field's settings. */
	const fail: Report = (where, message) => failAt(`${at}.${where}`, message);
	for (const key of Object.keys(raw)) {
		if (COMMON_KEYS.has(key)) continue;
		if (!SETTING_KEYS.has(key)) fail(key, `A field has no setting named ${key}.`);
		else if (!(FIELD_TYPE_SETTINGS[fieldType] as readonly string[]).includes(key) && !isUnset(key, raw[key])) {
			fail(key, `A ${fieldType} field has no ${key}.`);
		}
	}
	const key = typeof raw.key === "string" ? raw.key : "";
	if (!FORM_FIELD_KEY.test(key) || key.length > FORM_LIMITS.keyLength) {
		fail(
			"key",
			`A field's key starts with a lower-case letter, then lower-case letters, digits and underscores, at most ${FORM_LIMITS.keyLength}: such as first_name.`,
		);
	}
	const label = readText(raw.label, `${at}.label`, failAt, { required: true, max: FORM_LIMITS.labelLength });
	const help = readText(raw.help, `${at}.help`, failAt, { required: false, max: FORM_LIMITS.helpLength });
	const message = readText(raw.message, `${at}.message`, failAt, { required: false, max: FORM_LIMITS.messageLength });
	const placeholder = readText(raw.placeholder, `${at}.placeholder`, failAt, {
		required: false,
		max: FORM_LIMITS.labelLength,
	});
	const field = emptyField(key, fieldType, label ?? { text: "" });
	field.help = help;
	field.message = message;
	field.placeholder = placeholder;
	field.hideLabel = readBoolean(raw.hideLabel, "hideLabel", fail);
	field.required = readBoolean(raw.required, "required", fail);
	if (field.required && !canBeRequired(fieldType))
		fail("required", "A hidden field's value isn't the visitor's to give, so it can't be required.");

	const uses = (name: string) => (FIELD_TYPE_SETTINGS[fieldType] as readonly string[]).includes(name);
	if (uses("minLength") || uses("maxLength")) {
		const cap = fieldType === "textarea" ? FORM_LIMITS.textareaLength : FORM_LIMITS.textLength;
		field.minLength = readInteger(raw.minLength, "minLength", fail, 1, cap);
		field.maxLength = readInteger(raw.maxLength, "maxLength", fail, 1, cap);
		if (field.minLength !== null && field.maxLength !== null && field.minLength > field.maxLength) {
			fail("maxLength", "The longest a value may be can't be less than the shortest.");
		}
	}
	if (uses("pattern")) field.pattern = readPattern(raw.pattern, fail);
	if (uses("autocomplete") && !isUnset("autocomplete", raw.autocomplete)) {
		if (typeof raw.autocomplete !== "string" || !(FORM_AUTOCOMPLETE as readonly string[]).includes(raw.autocomplete)) {
			fail("autocomplete", `What a browser may fill in is one of ${FORM_AUTOCOMPLETE.join(", ")}.`);
		} else {
			field.autocomplete = raw.autocomplete;
		}
	}
	if (uses("min")) {
		field.min = readNumber(raw.min, "min", fail);
		field.max = readNumber(raw.max, "max", fail);
		field.integer = readBoolean(raw.integer, "integer", fail);
		if (field.min !== null && field.max !== null && field.min > field.max) {
			fail("max", "The largest value can't be less than the smallest.");
		}
	}
	if (uses("minDate")) {
		field.minDate = readDate(raw.minDate, "minDate", fail);
		field.maxDate = readDate(raw.maxDate, "maxDate", fail);
		if (field.minDate !== null && field.maxDate !== null && field.minDate > field.maxDate) {
			fail("maxDate", "The latest day can't be before the earliest.");
		}
	}
	if (uses("options")) field.options = readOptions(raw.options, `${at}.options`, failAt);
	if (uses("minChoices")) {
		const count = field.options.length;
		field.minChoices = readInteger(raw.minChoices, "minChoices", fail, 0, Math.max(count, 0));
		field.maxChoices = readInteger(raw.maxChoices, "maxChoices", fail, 1, Math.max(count, 1));
		if (field.minChoices !== null && field.maxChoices !== null && field.minChoices > field.maxChoices) {
			fail("maxChoices", "The most choices can't be fewer than the fewest.");
		}
	}
	if (uses("source")) field.source = readSource(raw.source, fail);
	return ok ? field : undefined;
}

function readBoolean(value: unknown, name: string, fail: Report): boolean {
	if (value === undefined || value === null) return false;
	if (typeof value !== "boolean") {
		fail(name, "Yes (true) or no (false).");
		return false;
	}
	return value;
}

function readInteger(value: unknown, name: string, fail: Report, min: number, max: number): number | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		fail(name, `A whole number from ${min} to ${max}.`);
		return null;
	}
	return value;
}

function readNumber(value: unknown, name: string, fail: Report): number | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		fail(name, "A number.");
		return null;
	}
	return value;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `value` is a day of the calendar, `2026-03-02`. */
export function isDay(value: string): boolean {
	if (!DAY.test(value)) return false;
	const day = new Date(`${value}T00:00:00Z`);
	return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
}

function readDate(value: unknown, name: string, fail: Report): string | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "string" || !isDay(value)) {
		fail(name, "A day, such as 2026-03-02.");
		return null;
	}
	return value;
}

function readPattern(value: unknown, fail: Report): string | null {
	if (value === undefined || value === null || value === "") return null;
	if (typeof value !== "string" || value.length > FORM_LIMITS.patternLength) {
		fail("pattern", `A pattern is a regular expression of at most ${FORM_LIMITS.patternLength} characters.`);
		return null;
	}
	try {
		compiledPattern(value);
	} catch {
		fail("pattern", "This pattern can't be used: write a regular expression without look-around or back-references.");
		return null;
	}
	return value;
}

function readOptions(value: unknown, at: string, fail: Report): FormOption[] {
	if (!Array.isArray(value) || value.length === 0) {
		fail(at, "Give at least one option to choose from.");
		return [];
	}
	if (value.length > FORM_LIMITS.options) fail(at, `At most ${FORM_LIMITS.options} options.`);
	const options: FormOption[] = [];
	const values = new Set<string>();
	value.forEach((raw: unknown, index) => {
		const here = `${at}[${index}]`;
		if (!isRecord(raw)) {
			fail(here, "An option is { value, label }.");
			return;
		}
		const optionValue = typeof raw.value === "string" ? raw.value.trim() : "";
		if (!FORM_OPTION_VALUE.test(optionValue) || optionValue.length > FORM_LIMITS.optionValueLength) {
			fail(`${here}.value`, "An option's value is letters, digits, dashes and underscores, such as tiered.");
			return;
		}
		if (values.has(optionValue)) {
			fail(`${here}.value`, `Another option has the value ${optionValue}.`);
			return;
		}
		values.add(optionValue);
		const label = readText(raw.label, `${here}.label`, fail, {
			required: true,
			max: FORM_LIMITS.labelLength,
		});
		if (label) options.push({ value: optionValue, label });
	});
	return options;
}

function readSource(value: unknown, fail: Report): HiddenSource | null {
	if (value === undefined || value === null) return { kind: "page" };
	if (!isRecord(value)) {
		fail(
			"source",
			'Where a hidden field\'s value comes from: { kind: "query", name }, { kind: "page" } or { kind: "fixed", value }.',
		);
		return null;
	}
	if (value.kind === "page") return { kind: "page" };
	if (value.kind === "query") {
		if (typeof value.name !== "string" || !QUERY_PARAMETER.test(value.name)) {
			fail("source.name", "The name of a parameter of the page's address, such as utm_source.");
			return null;
		}
		return { kind: "query", name: value.name };
	}
	if (value.kind === "fixed") {
		if (typeof value.value !== "string" || value.value.length > FORM_LIMITS.labelLength) {
			fail("source.value", `Fixed text of at most ${FORM_LIMITS.labelLength} characters.`);
			return null;
		}
		return { kind: "fixed", value: value.value };
	}
	fail("source.kind", "query, page or fixed.");
	return null;
}

function readSuccess(input: unknown, report: Report, current: FormVersion): FormVersion["success"] {
	if (!isRecord(input)) {
		report(
			"success",
			'What happens once the Form is sent: { kind: "message", message } or { kind: "redirect", pageId }.',
		);
		return current.success;
	}
	if (input.kind === "message") {
		const message = readText(input.message, "success.message", report, {
			required: true,
			max: FORM_LIMITS.messageLength,
		});
		return message ? { kind: "message", message } : current.success;
	}
	if (input.kind === "redirect") {
		if (typeof input.pageId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.pageId)) {
			report("success.pageId", "The Page visitors go on to, by id.");
			return current.success;
		}
		return { kind: "redirect", pageId: input.pageId.toLowerCase() };
	}
	report("success.kind", "message or redirect.");
	return current.success;
}

function readSpam(input: unknown, current: FormVersion, report: Report): FormVersion["spam"] {
	if (!isRecord(input)) {
		report("spam", "The spam limits: { minFillSeconds, perMinute, perHour }.");
		return current.spam;
	}
	const spam = { ...current.spam };
	const limits: [keyof FormVersion["spam"], number, number][] = [
		["minFillSeconds", 0, FORM_LIMITS.minFillSeconds],
		["perMinute", 1, FORM_LIMITS.perMinute],
		["perHour", 1, FORM_LIMITS.perHour],
	];
	for (const [name, min, max] of limits) {
		const value = input[name];
		if (value === undefined) continue;
		if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
			report(`spam.${name}`, `A whole number from ${min} to ${max}.`);
			continue;
		}
		spam[name] = value;
	}
	for (const key of Object.keys(input)) {
		if (!limits.some(([name]) => name === key)) report(`spam.${key}`, `The spam limits have no ${key}.`);
	}
	return spam;
}
