import { escapeAttribute, escapeText } from "../escape.ts";
import { type FormField, type FormText, type FormVersion, formTextIn } from "./version.ts";
import type { FormWords } from "./words.ts";

/**
 * How a Form renders on a page: a `<form>` posting to the Site itself (`/_webcraft/forms/<id>`), which
 * works without JavaScript. Every field has a label (kept for screen readers alone when Staff hide
 * it), its help and its error linked with `aria-describedby`; radio buttons and checkboxes sit in a
 * `<fieldset>` named by its `<legend>`. Nothing is inline: no style, no script, no event handler.
 * Classes are WebCraft's own hooks (`FORM_HOOKS`), styled in the Design system's base layer.
 *
 * The page a Form is cached on holds nothing of any one visitor's: the time it was handed out (the
 * token) is filled in as the page is answered. What a visitor sent comes back only in an answer made
 * for them (`FormState`), which is never cached.
 */

/** The class names WebCraft gives a Form's parts, styled in the Design system's base layer. */
export const FORM_HOOKS = {
	form: "wc-form",
	field: "wc-form-field",
	label: "wc-form-label",
	required: "wc-form-required",
	help: "wc-form-help",
	error: "wc-form-error",
	errors: "wc-form-errors",
	options: "wc-form-options",
	option: "wc-form-option",
	note: "wc-form-note",
	submit: "wc-form-submit",
	sent: "wc-form-sent",
	honeypot: "wc-form-hp",
	visuallyHidden: "wc-visually-hidden",
} as const;

/** The names of the inputs WebCraft adds to every Form (field keys never hold a dash, so none clashes). */
export const FORM_INPUTS = {
	/** The page the Form was sent from. */
	page: "wc-page",
	/** Which Form of the page it is, counting from 1. */
	instance: "wc-i",
	/** When the page was handed out, signed: the time trap. */
	token: "wc-t",
	/** The field people never see: anything in it is spam. */
	honeypot: "wc-website",
} as const;

/** Where a Form posts: `/_webcraft/forms/<id>` on the Site's own domain. */
export const FORM_POST_PATH = "/_webcraft/forms/";

/**
 * The mark a cached page holds where each Form's time-trap token goes: the Site pipeline puts a new
 * token there each time it answers the page, so the page cache never holds one. It starts with `<`,
 * which nothing else in a page's attributes or text can (they are escaped), so only a Form's token
 * input ever holds it.
 */
export const FORM_TOKEN_MARK = "<wc-form-token>";

/** What one visitor's answer shows in a Form: what they sent and what was wrong, or that it was sent. */
export type FormState =
	| {
			kind: "invalid";
			/** What was sent, by field key, as text (several for checkboxes). */
			values: Readonly<Record<string, readonly string[]>>;
			/** Each field's error, by key, in the page's language. */
			errors: Readonly<Record<string, string>>;
			/** An error about the Form as a whole (its CAPTCHA), in the page's language. */
			formError: string | null;
	  }
	| { kind: "sent"; message: string };

/** A Site's CAPTCHA, as its Forms show it: the widget's class and the Site's public key. */
export type FormCaptcha = { widgetClass: string; siteKey: string };

/** One Form on one page, ready to render. */
export type FormToRender = {
	/** The Form's id: where it posts. */
	id: string;
	/** Which Form of the page it is, counting from 1: its elements' ids start with `wc-form-<instance>`. */
	instance: number;
	version: FormVersion;
	/** The page's language: every text shows its value there. */
	language: string;
	/** The page's path, sent back with the Form. */
	page: string;
	/** The time trap's token, or the mark the Site pipeline replaces with one as it answers. */
	token: string;
	captcha: FormCaptcha | null;
	words: FormWords;
	state: FormState | null;
};

/** The id of one of a Form's elements: `wc-form-2-email`, `wc-form-2-email-help`. */
export function formElementId(instance: number, ...parts: string[]): string {
	return ["wc-form", String(instance), ...parts].join("-");
}

/** The id a field's error links to: its input, or the first of its options. */
export function fieldTargetId(instance: number, field: FormField): string {
	return field.type === "radio" || field.type === "checkboxes"
		? formElementId(instance, field.key, "0")
		: formElementId(instance, field.key);
}

/** Renders a Form: what visitors fill in, or the message shown once it was sent. */
export function renderForm(form: FormToRender): string {
	const { state, words, instance } = form;
	const text = (value: FormText) => escapeText(formTextIn(value, form.language));
	if (state?.kind === "sent") {
		return `<div class="${FORM_HOOKS.sent}" id="${formElementId(instance)}" role="status" tabindex="-1" autofocus><p>${escapeText(state.message)}</p></div>`;
	}
	const invalid = state?.kind === "invalid" ? state : null;
	const shown = form.version.fields.filter((field) => field.type !== "hidden");
	const parts: string[] = [];
	if (invalid) parts.push(errorSummary(form, shown, invalid));
	parts.push(
		hidden(FORM_INPUTS.page, form.page),
		hidden(FORM_INPUTS.instance, String(instance)),
		form.token === FORM_TOKEN_MARK
			? `<input type="hidden" name="${FORM_INPUTS.token}" value="${FORM_TOKEN_MARK}">`
			: hidden(FORM_INPUTS.token, form.token),
		honeypot(instance, words),
	);
	if (shown.some((field) => field.required)) {
		parts.push(`<p class="${FORM_HOOKS.note}">${escapeText(words.required)}</p>`);
	}
	for (const field of shown) parts.push(renderField(form, field, invalid));
	if (form.captcha) {
		const errorId = formElementId(instance, "captcha", "error");
		const error = invalid?.formError
			? `<p class="${FORM_HOOKS.error}" id="${errorId}">${errorText(words, invalid.formError)}</p>`
			: "";
		parts.push(
			`<div class="${FORM_HOOKS.field}">${error}<div class="${escapeAttribute(form.captcha.widgetClass)}" id="${formElementId(instance, "captcha")}" data-sitekey="${escapeAttribute(form.captcha.siteKey)}" data-lang="${escapeAttribute(form.language)}"></div></div>`,
		);
	}
	parts.push(`<button type="submit" class="${FORM_HOOKS.submit}">${text(form.version.submitLabel)}</button>`);
	return `<form class="${FORM_HOOKS.form}" id="${formElementId(instance)}" method="post" action="${FORM_POST_PATH}${escapeAttribute(form.id)}" novalidate>${parts.join("")}</form>`;
}

function hidden(name: string, value: string): string {
	return `<input type="hidden" name="${name}" value="${escapeAttribute(value)}">`;
}

/**
 * The field people never see, which bots fill in: out of sight (by the stylesheet, never an inline
 * style), out of the tab order and hidden from screen readers, with a label in case it is reached.
 */
function honeypot(instance: number, words: FormWords): string {
	const id = formElementId(instance, "hp");
	return `<div class="${FORM_HOOKS.honeypot}" aria-hidden="true"><label for="${id}">${escapeText(words.honeypot)}</label><input type="text" id="${id}" name="${FORM_INPUTS.honeypot}" tabindex="-1" autocomplete="off"></div>`;
}

/**
 * The error summary at the top of a Form sent back with errors: a heading and a link to each field
 * with an error. It takes focus as the page loads (`autofocus`), so the visitor hears it first.
 */
function errorSummary(form: FormToRender, shown: readonly FormField[], state: FormStateInvalid): string {
	const { instance, words } = form;
	const items: string[] = [];
	for (const field of shown) {
		const error = state.errors[field.key];
		if (!error) continue;
		const label = formTextIn(field.label, form.language);
		items.push(`<li><a href="#${fieldTargetId(instance, field)}">${escapeText(label)}: ${escapeText(error)}</a></li>`);
	}
	if (state.formError && form.captcha) {
		items.push(`<li><a href="#${formElementId(instance, "captcha")}">${escapeText(state.formError)}</a></li>`);
	}
	const titleId = formElementId(instance, "errors", "title");
	return `<div class="${FORM_HOOKS.errors}" id="${formElementId(instance, "errors")}" role="group" aria-labelledby="${titleId}" tabindex="-1" autofocus><h2 id="${titleId}">${escapeText(words.problemTitle)}</h2><ul>${items.join("")}</ul></div>`;
}

type FormStateInvalid = Extract<FormState, { kind: "invalid" }>;

function errorText(words: FormWords, message: string): string {
	return `<span class="${FORM_HOOKS.visuallyHidden}">${escapeText(words.errorPrefix)}</span> ${escapeText(message)}`;
}

/** What browsers may fill a field with: the field's own choice, else what its type collects. */
function autocompleteOf(field: FormField): string | null {
	if (field.autocomplete) return field.autocomplete;
	if (field.type === "email") return "email";
	if (field.type === "phone") return "tel";
	return null;
}

function renderField(form: FormToRender, field: FormField, state: FormStateInvalid | null): string {
	const { instance, words, language } = form;
	const id = formElementId(instance, field.key);
	const helpId = formElementId(instance, field.key, "help");
	const errorId = formElementId(instance, field.key, "error");
	const error = state?.errors[field.key];
	const sent = state?.values[field.key] ?? [];
	const describedBy = [field.help ? helpId : null, error ? errorId : null].filter(Boolean).join(" ");
	const help = field.help
		? `<p class="${FORM_HOOKS.help}" id="${helpId}">${escapeText(formTextIn(field.help, language))}</p>`
		: "";
	const errorLine = error ? `<p class="${FORM_HOOKS.error}" id="${errorId}">${errorText(words, error)}</p>` : "";
	const labelText = escapeText(formTextIn(field.label, language));
	const requiredMark = field.required ? `<span class="${FORM_HOOKS.required}" aria-hidden="true"> *</span>` : "";
	const labelClass = field.hideLabel ? `${FORM_HOOKS.label} ${FORM_HOOKS.visuallyHidden}` : FORM_HOOKS.label;
	const common = [
		field.required ? " required" : "",
		error ? ' aria-invalid="true"' : "",
		describedBy ? ` aria-describedby="${describedBy}"` : "",
	].join("");
	const placeholder = field.placeholder
		? ` placeholder="${escapeAttribute(formTextIn(field.placeholder, language))}"`
		: "";

	if (field.type === "radio" || field.type === "checkboxes") {
		const inputType = field.type === "radio" ? "radio" : "checkbox";
		const options = field.options.map((option, index) => {
			const optionId = formElementId(instance, field.key, String(index));
			const checked = sent.includes(option.value) ? " checked" : "";
			const required = field.required && field.type === "radio" ? " required" : "";
			const invalid = error && index === 0 ? ' aria-invalid="true"' : "";
			return `<div class="${FORM_HOOKS.option}"><input type="${inputType}" id="${optionId}" name="${field.key}" value="${escapeAttribute(option.value)}"${checked}${required}${invalid}><label for="${optionId}">${escapeText(formTextIn(option.label, language))}</label></div>`;
		});
		const legendClass = field.hideLabel ? ` class="${FORM_HOOKS.visuallyHidden}"` : "";
		const groupDescribedBy = describedBy ? ` aria-describedby="${describedBy}"` : "";
		return `<fieldset class="${FORM_HOOKS.field}" data-type="${field.type}"${groupDescribedBy}><legend${legendClass}>${labelText}${requiredMark}</legend>${help}${errorLine}<div class="${FORM_HOOKS.options}">${options.join("")}</div></fieldset>`;
	}

	if (field.type === "consent") {
		const checked = sent.includes("yes") ? " checked" : "";
		return `<div class="${FORM_HOOKS.field}" data-type="consent">${errorLine}<div class="${FORM_HOOKS.option}"><input type="checkbox" id="${id}" name="${field.key}" value="yes"${checked}${common}><label class="${labelClass}" for="${id}">${labelText}${requiredMark}</label></div>${help}</div>`;
	}

	const label = `<label class="${labelClass}" for="${id}">${labelText}${requiredMark}</label>`;
	const value = sent[0] ?? "";
	let control: string;
	if (field.type === "textarea") {
		control = `<textarea id="${id}" name="${field.key}" rows="5"${common}${placeholder}>${escapeText(value)}</textarea>`;
	} else if (field.type === "select") {
		const choose = field.placeholder ? formTextIn(field.placeholder, language) : words.choose;
		const options = [
			`<option value="">${escapeText(choose)}</option>`,
			...field.options.map(
				(option) =>
					`<option value="${escapeAttribute(option.value)}"${value === option.value ? " selected" : ""}>${escapeText(formTextIn(option.label, language))}</option>`,
			),
		];
		control = `<select id="${id}" name="${field.key}"${common}>${options.join("")}</select>`;
	} else {
		const inputType = INPUT_TYPES[field.type] ?? "text";
		const autocomplete = autocompleteOf(field);
		const extra = [
			autocomplete ? ` autocomplete="${escapeAttribute(autocomplete)}"` : "",
			field.type === "number" && field.min !== null ? ` min="${field.min}"` : "",
			field.type === "number" && field.max !== null ? ` max="${field.max}"` : "",
			field.type === "number" ? ` step="${field.integer ? "1" : "any"}"` : "",
			field.type === "date" && field.minDate ? ` min="${field.minDate}"` : "",
			field.type === "date" && field.maxDate ? ` max="${field.maxDate}"` : "",
		].join("");
		control = `<input type="${inputType}" id="${id}" name="${field.key}" value="${escapeAttribute(value)}"${common}${extra}${placeholder}>`;
	}
	return `<div class="${FORM_HOOKS.field}" data-type="${field.type}">${label}${help}${errorLine}${control}</div>`;
}

const INPUT_TYPES: Partial<Record<FormField["type"], string>> = {
	text: "text",
	email: "email",
	phone: "tel",
	url: "url",
	number: "number",
	date: "date",
};
