import {
	emptyField,
	FIELD_TYPE_SETTINGS,
	FORM_FIELD_KEY,
	type FormField,
	type FormFieldType,
	type FormText,
	type FormVersion,
} from "@webcraft/renderer/forms";

/**
 * How the admin edits a Form's Draft: a copy of the version, changed field by field in the browser,
 * then saved as a whole (`forms.saveDraft`). The server checks it and answers each problem where it
 * is (`fields[2].options`), which the screens show on the field and in a list.
 */

export type { FormField, FormFieldType, FormText, FormVersion };

/** A problem the server answered, at its place in the version. */
export type FormProblem = { at: string; message: string };

/** The problems of a saved version that the server refused, or none. */
export function problemsOf(error: unknown): FormProblem[] {
	const { code, data } = (error ?? {}) as { code?: unknown; data?: { problems?: unknown } };
	if (code !== "FORM_INVALID" && code !== "CAPTCHA_INVALID") return [];
	return Array.isArray(data?.problems) ? (data.problems as FormProblem[]) : [];
}

/** The index of the field a problem is about (`fields[2].label` is 2), or null for the Form as a whole. */
export function fieldIndexOf(problem: FormProblem): number | null {
	const match = /^fields\[(\d+)\]/.exec(problem.at);
	return match ? Number(match[1]) : null;
}

/** A key for a new field of `type`, unused in the Form: `email`, then `email_2`, `email_3`… */
export function newKey(fields: readonly FormField[], type: FormFieldType): string {
	const base = type === "checkboxes" ? "choices" : type;
	const used = new Set(fields.map((field) => field.key));
	if (!used.has(base)) return base;
	for (let n = 2; ; n++) if (!used.has(`${base}_${n}`)) return `${base}_${n}`;
}

/** Whether `key` can be a field's key. */
export function isFieldKey(key: string): boolean {
	return FORM_FIELD_KEY.test(key) && key.length <= 64;
}

/** A new field of `type`, labelled `label`, with two options where it chooses among them. */
export function newField(fields: readonly FormField[], type: FormFieldType, label: string, option: string): FormField {
	const field = emptyField(newKey(fields, type), type, { text: label });
	if (FIELD_TYPE_SETTINGS[type].includes("options")) {
		field.options = [
			{ value: "option_1", label: { text: `${option} 1` } },
			{ value: "option_2", label: { text: `${option} 2` } },
		];
	}
	if (type === "consent") field.required = true;
	return field;
}

/** A copy of `field` under a new key, placed after it. */
export function duplicateField(fields: readonly FormField[], index: number): FormField[] {
	const field = fields[index];
	if (!field) return [...fields];
	const copy: FormField = { ...structuredClone(field), key: newKey(fields, field.type) };
	return [...fields.slice(0, index + 1), copy, ...fields.slice(index + 1)];
}

/** The fields with one moved by `by` places (−1 up, 1 down). */
export function moveField(fields: readonly FormField[], index: number, by: -1 | 1): FormField[] {
	const target = index + by;
	if (target < 0 || target >= fields.length) return [...fields];
	const moved = [...fields];
	const [field] = moved.splice(index, 1);
	if (field) moved.splice(target, 0, field);
	return moved;
}

/** Text with its value in `language` changed: the text as written in the Default language, else a translation. */
export function withText(text: FormText, language: string | null, value: string): FormText {
	if (language === null) return { ...text, text: value };
	const translations = { ...(text.translations ?? {}) };
	if (value.trim() === "") delete translations[language];
	else translations[language] = value;
	return Object.keys(translations).length > 0 ? { text: text.text, translations } : { text: text.text };
}

/** Optional text from what is typed: null when empty. */
export function optionalText(current: FormText | null, value: string): FormText | null {
	if (value.trim() === "") return null;
	return { ...(current ?? {}), text: value };
}

/** A whole number from what is typed, or null when empty or not one. */
export function numberOrNull(value: string): number | null {
	if (value.trim() === "") return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

/** The version as `forms.saveDraft` takes it. */
export function changeOf(version: FormVersion) {
	return {
		fields: version.fields,
		submitLabel: version.submitLabel,
		success: version.success,
		spam: version.spam,
	};
}

/** Every text of a version a translation can give, with where it is: for the Translations tab. */
export type TranslatableText = {
	id: string;
	/** What it is, for its label: the field's label, then which text of it. */
	field: string | null;
	part: "label" | "help" | "placeholder" | "message" | "option" | "submitLabel" | "successMessage";
	text: FormText;
	set(version: FormVersion, text: FormText): FormVersion;
};

export function translatableTexts(version: FormVersion): TranslatableText[] {
	const texts: TranslatableText[] = [];
	version.fields.forEach((field, index) => {
		const update = (change: (field: FormField) => FormField) => (current: FormVersion) => ({
			...current,
			fields: current.fields.map((each, at) => (at === index ? change(each) : each)),
		});
		texts.push({
			id: `${field.key}-label`,
			field: field.label.text,
			part: "label",
			text: field.label,
			set: (current, text) => update((each) => ({ ...each, label: text }))(current),
		});
		for (const part of ["help", "placeholder", "message"] as const) {
			const value = field[part];
			if (value) {
				texts.push({
					id: `${field.key}-${part}`,
					field: field.label.text,
					part,
					text: value,
					set: (current, text) => update((each) => ({ ...each, [part]: text }))(current),
				});
			}
		}
		field.options.forEach((option, optionIndex) => {
			texts.push({
				id: `${field.key}-option-${option.value}`,
				field: field.label.text,
				part: "option",
				text: option.label,
				set: (current, text) =>
					update((each) => ({
						...each,
						options: each.options.map((one, at) => (at === optionIndex ? { ...one, label: text } : one)),
					}))(current),
			});
		});
	});
	texts.push({
		id: "submit-label",
		field: null,
		part: "submitLabel",
		text: version.submitLabel,
		set: (current, text) => ({ ...current, submitLabel: text }),
	});
	if (version.success.kind === "message") {
		texts.push({
			id: "success-message",
			field: null,
			part: "successMessage",
			text: version.success.message,
			set: (current, text) => ({ ...current, success: { kind: "message", message: text } }),
		});
	}
	return texts;
}
