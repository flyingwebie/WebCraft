import type { FormCondition, FormField } from "./version.ts";
import type { FormRule } from "./words.ts";

/**
 * The rules of a Form that the server and the browser both apply: which items its conditions show,
 * and whether a value keeps its field's rules. The server's check is the one that counts; the forms
 * script runs the very same code first, so a visitor sees the same errors before sending.
 *
 * Everything is inside one function that reads nothing from outside it: the forms script carries its
 * text (`formLogic.toString()`), so the browser runs exactly what the server runs. Keep it so: no
 * imports used at run time, no values from the module around it.
 */

/** What a value of a field reads as, once checked: the value kept, and the rule it breaks (if any). */
export type ReadValue = {
	value: string | number | boolean | string[] | null;
	broken: { rule: FormRule; params?: Record<string, string | number> } | null;
};

/** A file as both sides know it: its name, size in bytes, and (on the server) the format its bytes are. */
export type CheckedFile = { name: string; size: number; format?: string | null };

/** The limits the rules read (`FORM_LIMITS`), handed in so the function needs nothing from outside. */
export type LogicLimits = { textLength: number; textareaLength: number; options: number; defaultFileBytes: number };

export type FormLogic = {
	/**
	 * The keys of the items that show, given what was filled in (`valuesOf`: every value sent under a
	 * key). A field an item's condition reads counts as empty while it is itself hidden.
	 */
	visibleKeys(fields: readonly FormField[], valuesOf: (key: string) => readonly string[]): Set<string>;
	/** Whether a condition holds, given the values of the fields that show. */
	holds(condition: FormCondition | null, valuesOf: (key: string) => readonly string[]): boolean;
	/** Reads and checks a field's value from what was sent (any type but hidden, file, section and step). */
	readValue(
		field: FormField,
		raw: readonly string[],
		limits: LogicLimits,
		matches: (pattern: string, text: string) => boolean,
	): ReadValue;
	/**
	 * Checks the files sent for a file field: how many, how large, and of which formats: by their names'
	 * extensions (`extensions`, `.pdf`), and by what their bytes are where that is known (`format`, on
	 * the server: null for bytes that are none of the formats taken, SVG among them).
	 */
	checkFiles(
		field: FormField,
		files: readonly CheckedFile[],
		extensions: readonly string[],
		limits: LogicLimits,
	): ReadValue["broken"];
	/** Whether `value` is a day of the calendar, `2026-03-02`. */
	isDay(value: string): boolean;
	/** Words with their numbers filled in: `{min}`, `{max}`, `{count}`, `{types}`, `{n}`. */
	fill(template: string, params: Readonly<Record<string, string | number>>): string;
	/** A size in bytes as people read it: `10 MB`, `512 KB`. */
	size(bytes: number): string;
};

export function formLogic(): FormLogic {
	const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
	const PHONE = /^\+?[0-9 ().-]{5,30}$/;
	const NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;
	const DAY = /^\d{4}-\d{2}-\d{2}$/;

	function isDay(value: string): boolean {
		if (!DAY.test(value)) return false;
		const day = new Date(`${value}T00:00:00Z`);
		return !Number.isNaN(day.getTime()) && day.toISOString().slice(0, 10) === value;
	}

	function filled(values: readonly string[]): string[] {
		return values.map((value) => String(value).trim()).filter((value) => value !== "");
	}

	function holds(condition: FormCondition | null, valuesOf: (key: string) => readonly string[]): boolean {
		if (!condition || condition.rules.length === 0) return true;
		const results = condition.rules.map((rule) => {
			const values = filled(valuesOf(rule.field));
			const wanted = String(rule.value ?? "")
				.trim()
				.toLowerCase();
			switch (rule.op) {
				case "isEmpty":
					return values.length === 0;
				case "isNotEmpty":
					return values.length > 0;
				case "is":
					return values.some((value) => value.toLowerCase() === wanted);
				case "isNot":
					return !values.some((value) => value.toLowerCase() === wanted);
				case "greaterThan":
				case "lessThan": {
					const number = Number(values[0]);
					const limit = Number(wanted);
					if (values.length === 0 || wanted === "" || Number.isNaN(number) || Number.isNaN(limit)) return false;
					return rule.op === "greaterThan" ? number > limit : number < limit;
				}
				default:
					return false;
			}
		});
		return condition.match === "any" ? results.some(Boolean) : results.every(Boolean);
	}

	function visibleKeys(fields: readonly FormField[], valuesOf: (key: string) => readonly string[]): Set<string> {
		const visible = new Set<string>();
		const shownValue = (key: string) => (visible.has(key) ? valuesOf(key) : []);
		let step = true;
		let section = true;
		for (const field of fields) {
			let shows: boolean;
			if (field.type === "step") {
				step = holds(field.condition, shownValue);
				section = true;
				shows = step;
			} else if (field.type === "section") {
				section = step && holds(field.condition, shownValue);
				shows = section;
			} else {
				shows = step && section && holds(field.condition, shownValue);
			}
			if (shows) visible.add(field.key);
		}
		return visible;
	}

	function isWebAddress(text: string, max: number): boolean {
		if (text.length > max) return false;
		try {
			const url = new URL(text);
			return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".");
		} catch {
			return false;
		}
	}

	function readValue(
		field: FormField,
		raw: readonly string[],
		limits: LogicLimits,
		matches: (pattern: string, text: string) => boolean,
	): ReadValue {
		const first = String(raw[0] ?? "")
			.replaceAll("\r\n", "\n")
			.trim();
		const missing = (rule: FormRule = "required"): ReadValue => ({
			value: null,
			broken: field.required ? { rule } : null,
		});
		switch (field.type) {
			case "consent": {
				const given = raw.includes("yes");
				return { value: given, broken: field.required && !given ? { rule: "requiredConsent" } : null };
			}
			case "checkboxes": {
				const chosen = [...new Set(raw)];
				if (chosen.some((value) => !field.options.some((option) => option.value === value))) {
					return { value: chosen.slice(0, limits.options), broken: { rule: "option" } };
				}
				if (chosen.length === 0) return { value: [], broken: field.required ? { rule: "requiredChoice" } : null };
				const ordered = field.options.map((option) => option.value).filter((value) => chosen.includes(value));
				if (field.minChoices !== null && ordered.length < field.minChoices) {
					return { value: ordered, broken: { rule: "minChoices", params: { min: field.minChoices } } };
				}
				if (field.maxChoices !== null && ordered.length > field.maxChoices) {
					return { value: ordered, broken: { rule: "maxChoices", params: { max: field.maxChoices } } };
				}
				return { value: ordered, broken: null };
			}
			case "select":
			case "radio": {
				if (first === "") return missing("requiredChoice");
				const known = field.options.some((option) => option.value === first);
				return { value: first, broken: known ? null : { rule: "option" } };
			}
			default:
				break;
		}
		if (first === "") return missing();
		switch (field.type) {
			case "email": {
				const email = first.toLowerCase();
				return { value: email, broken: email.length <= 254 && EMAIL.test(email) ? null : { rule: "email" } };
			}
			case "phone": {
				const digits = first.replace(/\D/g, "").length;
				return { value: first, broken: PHONE.test(first) && digits >= 5 ? null : { rule: "phone" } };
			}
			case "url":
				return { value: first, broken: isWebAddress(first, limits.textLength) ? null : { rule: "url" } };
			case "number": {
				if (!NUMBER.test(first)) return { value: first.slice(0, 100), broken: { rule: "number" } };
				const number = Number(first);
				if (field.integer && !Number.isInteger(number)) return { value: number, broken: { rule: "integer" } };
				if (field.min !== null && number < field.min) {
					return { value: number, broken: { rule: "min", params: { min: field.min } } };
				}
				if (field.max !== null && number > field.max) {
					return { value: number, broken: { rule: "max", params: { max: field.max } } };
				}
				return { value: number, broken: null };
			}
			case "date": {
				if (!isDay(first)) return { value: first.slice(0, 100), broken: { rule: "date" } };
				if (field.minDate !== null && first < field.minDate) {
					return { value: first, broken: { rule: "minDate", params: { min: field.minDate } } };
				}
				if (field.maxDate !== null && first > field.maxDate) {
					return { value: first, broken: { rule: "maxDate", params: { max: field.maxDate } } };
				}
				return { value: first, broken: null };
			}
			default: {
				// Text and textareas.
				const cap = field.type === "textarea" ? limits.textareaLength : limits.textLength;
				const max = Math.min(field.maxLength ?? cap, cap);
				const length = [...first].length;
				if (field.minLength !== null && length < field.minLength) {
					return { value: first.slice(0, cap), broken: { rule: "minLength", params: { min: field.minLength } } };
				}
				if (length > max) return { value: first.slice(0, cap), broken: { rule: "maxLength", params: { max } } };
				if (field.pattern !== null && !matches(field.pattern, first)) {
					return { value: first, broken: { rule: "pattern" } };
				}
				return { value: first, broken: null };
			}
		}
	}

	function size(bytes: number): string {
		if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
		return `${Math.max(1, Math.round(bytes / 1024))} KB`;
	}

	function checkFiles(
		field: FormField,
		files: readonly CheckedFile[],
		extensions: readonly string[],
		limits: LogicLimits,
	): ReadValue["broken"] {
		if (files.length === 0) return field.required ? { rule: "requiredFile" } : null;
		const most = field.maxFiles ?? 1;
		if (files.length > most) return { rule: "fileCount", params: { max: most } };
		const types = extensions.join(", ");
		const taken = (file: CheckedFile) => {
			const dot = file.name.lastIndexOf(".");
			const extension = dot >= 0 ? file.name.slice(dot).toLowerCase() : "";
			if (!extensions.includes(extension)) return false;
			return file.format === undefined || (file.format !== null && (field.accept as string[]).includes(file.format));
		};
		if (!files.every(taken)) return { rule: "fileType", params: { types } };
		const largest = field.maxFileBytes ?? limits.defaultFileBytes;
		if (files.some((file) => file.size > largest)) {
			return { rule: "fileSize", params: { max: size(largest) } };
		}
		return null;
	}

	function fill(template: string, params: Readonly<Record<string, string | number>>): string {
		return template.replace(/\{(min|max|count|types|n)\}/g, (_, name: string) => String(params[name] ?? ""));
	}

	return { visibleKeys, holds, readValue, checkFiles, isDay, fill, size };
}
