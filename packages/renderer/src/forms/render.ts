import { escapeAttribute, escapeText } from "../escape.ts";
import { formLogic } from "./logic.ts";
import {
	FORM_LIMITS,
	type FormField,
	type FormText,
	type FormVersion,
	formTextIn,
	isLayoutItem,
	uploadExtensions,
} from "./version.ts";
import type { FormWords } from "./words.ts";

const logic = formLogic();

/**
 * How a Form renders on a page: a `<form>` posting to the Site itself (`/_webcraft/forms/<id>`), which
 * works without JavaScript. Every field has a label (kept for screen readers alone when Staff hide
 * it), its help and its error linked with `aria-describedby`; radio buttons and checkboxes sit in a
 * `<fieldset>` named by its `<legend>`. Nothing is inline: no style, no script, no event handler.
 * Classes are WebCraft's own hooks (`FORM_HOOKS`), styled in the Design system's base layer.
 *
 * Sections are `<fieldset>`s named by their `<legend>`. Steps are too: without JavaScript every step
 * shows, one after the other, and the server checks the whole Form; the forms script shows one step
 * at a time, with the progress and the Back and Next buttons the page holds for it (hidden until it
 * runs), and checks each step before the next. Items with a condition carry `data-wc-key`, so the
 * script can show and hide them; without it they all show, and the server ignores what they hide.
 * The rules the script checks are the Form's own, in `data-wc-rules` (JSON, never code).
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
	section: "wc-form-section",
	step: "wc-form-step",
	stepNav: "wc-form-step-nav",
	back: "wc-form-back",
	next: "wc-form-next",
	progress: "wc-form-progress",
	limits: "wc-form-limits",
	status: "wc-form-status",
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
	const items = form.version.fields.filter((field) => field.type !== "hidden");
	const shown = items.filter((field) => !isLayoutItem(field));
	const steps = items.filter((field) => field.type === "step");
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
	if (steps.length > 0) parts.push(progress(form, steps));
	parts.push(renderItems(form, items, invalid));
	if (form.captcha) {
		const errorId = formElementId(instance, "captcha", "error");
		const error = invalid?.formError
			? `<p class="${FORM_HOOKS.error}" id="${errorId}">${errorText(words, invalid.formError)}</p>`
			: "";
		parts.push(
			`<div class="${FORM_HOOKS.field}">${error}<div class="${escapeAttribute(form.captcha.widgetClass)}" id="${formElementId(instance, "captcha")}" data-sitekey="${escapeAttribute(form.captcha.siteKey)}" data-lang="${escapeAttribute(form.language)}"></div></div>`,
		);
	}
	parts.push(
		`<div class="${FORM_HOOKS.status} ${FORM_HOOKS.visuallyHidden}" id="${formElementId(instance, "status")}" role="status"></div>`,
		`<button type="submit" class="${FORM_HOOKS.submit}">${text(form.version.submitLabel)}</button>`,
	);
	const enctype = shown.some((field) => field.type === "file") ? ' enctype="multipart/form-data"' : "";
	return `<form class="${FORM_HOOKS.form}" id="${formElementId(instance)}" method="post" action="${FORM_POST_PATH}${escapeAttribute(form.id)}"${enctype} novalidate data-wc-rules="${escapeAttribute(JSON.stringify(scriptRules(form)))}">${parts.join("")}</form>`;
}

/**
 * The Form's items in order, each section and step a `<fieldset>` holding the items after it: a
 * section up to the next section or step, a step up to the next step.
 */
function renderItems(form: FormToRender, items: readonly FormField[], state: FormStateInvalid | null): string {
	const { instance, language } = form;
	const steps = items.filter((field) => field.type === "step");
	let html = "";
	let inStep = false;
	let inSection = false;
	let stepNumber = 0;
	const closeSection = () => {
		if (inSection) html += "</fieldset>";
		inSection = false;
	};
	const closeStep = () => {
		closeSection();
		if (!inStep) return;
		html += stepNav(form, stepNumber, steps.length);
		html += "</fieldset>";
		inStep = false;
	};
	for (const item of items) {
		if (item.type === "step" || item.type === "section") {
			if (item.type === "step") {
				closeStep();
				stepNumber++;
				inStep = true;
			} else {
				closeSection();
				inSection = true;
			}
			const id = formElementId(instance, item.key);
			const helpId = formElementId(instance, item.key, "help");
			const hook = item.type === "step" ? FORM_HOOKS.step : FORM_HOOKS.section;
			const legendClass = item.hideLabel ? ` class="${FORM_HOOKS.visuallyHidden}"` : "";
			const help = item.help
				? `<p class="${FORM_HOOKS.help}" id="${helpId}">${escapeText(formTextIn(item.help, language))}</p>`
				: "";
			const describedBy = item.help ? ` aria-describedby="${helpId}"` : "";
			const number = item.type === "step" ? ` data-wc-step="${stepNumber}"` : "";
			html += `<fieldset class="${hook}" id="${id}" data-wc-key="${item.key}"${number}${describedBy}><legend${legendClass}>${escapeText(formTextIn(item.label, language))}</legend>${help}`;
			continue;
		}
		html += renderField(form, item, state);
	}
	closeStep();
	return html;
}

/** The progress of a Form with steps: hidden until the forms script shows one step at a time. */
function progress(form: FormToRender, steps: readonly FormField[]): string {
	const titles = steps
		.map((step, index) => `<li data-wc-step="${index + 1}">${escapeText(formTextIn(step.label, form.language))}</li>`)
		.join("");
	return `<ol class="${FORM_HOOKS.progress}" id="${formElementId(form.instance, "progress")}" hidden>${titles}</ol>`;
}

/** A step's Back and Next buttons, hidden until the forms script runs; the last step has the Form's own button. */
function stepNav(form: FormToRender, step: number, count: number): string {
	const back =
		step > 1 ? `<button type="button" class="${FORM_HOOKS.back}">${escapeText(form.words.back)}</button>` : "";
	const next =
		step < count ? `<button type="button" class="${FORM_HOOKS.next}">${escapeText(form.words.next)}</button>` : "";
	return back || next ? `<div class="${FORM_HOOKS.stepNav}" hidden>${back}${next}</div>` : "";
}

/**
 * What the forms script checks, as data: each item's rules and conditions (never its words but its
 * own error), and the words it writes, in the page's language.
 */
function scriptRules(form: FormToRender) {
	const { words, language } = form;
	return {
		fields: form.version.fields
			.filter((field) => field.type !== "hidden")
			.map((field) => ({
				key: field.key,
				type: field.type,
				required: field.required,
				minLength: field.minLength,
				maxLength: field.maxLength,
				pattern: field.pattern,
				min: field.min,
				max: field.max,
				integer: field.integer,
				minDate: field.minDate,
				maxDate: field.maxDate,
				options: field.options.map((option) => ({ value: option.value })),
				minChoices: field.minChoices,
				maxChoices: field.maxChoices,
				accept: field.accept,
				extensions: uploadExtensions(field.accept),
				maxFileBytes: field.maxFileBytes,
				maxFiles: field.maxFiles,
				condition: field.condition,
				message: field.message ? formTextIn(field.message, language) : null,
			})),
		limits: {
			textLength: FORM_LIMITS.textLength,
			textareaLength: FORM_LIMITS.textareaLength,
			options: FORM_LIMITS.options,
			defaultFileBytes: FORM_LIMITS.defaultFileBytes,
		},
		words: {
			errors: words.errors,
			errorPrefix: words.errorPrefix,
			step: words.step,
			problems: words.problems,
			problem: words.problem,
			sending: words.sending,
			sent: words.sent,
		},
	};
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
		return `<fieldset class="${FORM_HOOKS.field}" data-type="${field.type}"${keyAttribute(field)}${groupDescribedBy}><legend${legendClass}>${labelText}${requiredMark}</legend>${help}${errorLine}<div class="${FORM_HOOKS.options}">${options.join("")}</div></fieldset>`;
	}

	if (field.type === "consent") {
		const checked = sent.includes("yes") ? " checked" : "";
		return `<div class="${FORM_HOOKS.field}" data-type="consent"${keyAttribute(field)}>${errorLine}<div class="${FORM_HOOKS.option}"><input type="checkbox" id="${id}" name="${field.key}" value="yes"${checked}${common}><label class="${labelClass}" for="${id}">${labelText}${requiredMark}</label></div>${help}</div>`;
	}

	const label = `<label class="${labelClass}" for="${id}">${labelText}${requiredMark}</label>`;
	if (field.type === "file") {
		const limitsId = formElementId(instance, field.key, "limits");
		const extensions = uploadExtensions(field.accept);
		const types = extensions.join(", ");
		const max = logic.size(field.maxFileBytes ?? FORM_LIMITS.defaultFileBytes);
		const most = field.maxFiles ?? 1;
		const limitsText =
			most > 1 ? logic.fill(words.filesMany, { types, max, count: most }) : logic.fill(words.files, { types, max });
		const fileDescribedBy = [field.help ? helpId : null, limitsId, error ? errorId : null].filter(Boolean).join(" ");
		const fileCommon = [
			field.required ? " required" : "",
			error ? ' aria-invalid="true"' : "",
			` aria-describedby="${fileDescribedBy}"`,
		].join("");
		const multiple = most > 1 ? " multiple" : "";
		return `<div class="${FORM_HOOKS.field}" data-type="file"${keyAttribute(field)}>${label}${help}<p class="${FORM_HOOKS.limits}" id="${limitsId}">${escapeText(limitsText)}</p>${errorLine}<input type="file" id="${id}" name="${field.key}" accept="${escapeAttribute(extensions.join(","))}"${multiple}${fileCommon}></div>`;
	}
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
	return `<div class="${FORM_HOOKS.field}" data-type="${field.type}"${keyAttribute(field)}>${label}${help}${errorLine}${control}</div>`;
}

/** The key a field shown only under a condition carries, so the forms script can show and hide it. */
function keyAttribute(field: FormField): string {
	return field.condition ? ` data-wc-key="${field.key}"` : "";
}

const INPUT_TYPES: Partial<Record<FormField["type"], string>> = {
	text: "text",
	email: "email",
	phone: "tel",
	url: "url",
	number: "number",
	date: "date",
};
