import type { SubmissionValue } from "@webcraft/module-sdk";
import {
	FORM_LIMITS,
	type FormField,
	type FormRule,
	type FormVersion,
	formTextIn,
	formWords,
	ruleMessage,
} from "@webcraft/renderer";

import { compiledPattern } from "../content/field-types.ts";
import { isDay } from "./definition.ts";

/**
 * Checking what a visitor sent against a Form's published version: the server's check is the one
 * that counts (whatever a browser checked first). Each field's value is read as its type reads it
 * (trimmed, an email in lower case, a number as a number, a choice among the options) and its rules
 * checked; an error is worded in the page's language, by WebCraft or by the field's own message.
 */

/** What was sent, by field name: every value sent under it, in order. */
export type SentFields = ReadonlyMap<string, readonly string[]>;

/** Where a hidden field's value comes from as the Form is sent: the page's address. */
export type SentFrom = { pageUrl: string | null; query: URLSearchParams };

export type CheckedValues = {
	/** Each field's value, in the Form's order, as it would be kept. */
	values: SubmissionValue[];
	/** Each field's error, by key, in the page's language. */
	errors: Record<string, string>;
};

/** Reads and checks every field of `version` from what was sent. */
export function checkValues(version: FormVersion, sent: SentFields, language: string, from: SentFrom): CheckedValues {
	const words = formWords(language);
	const values: SubmissionValue[] = [];
	const errors: Record<string, string> = {};
	for (const field of version.fields) {
		const raw = sent.get(field.key) ?? [];
		const { value, rule } = readValue(field, raw, from);
		values.push({ key: field.key, label: field.label.text, type: field.type, value });
		if (rule) {
			errors[field.key] = field.message
				? formTextIn(field.message, language)
				: ruleMessage(words, rule.rule, rule.params ?? {});
		}
	}
	return { values, errors };
}

/** What was sent, as kept in the Spam folder: as sent, unchecked, each text cut to the longest any field takes. */
export function sentValues(version: FormVersion, sent: SentFields, from: SentFrom): SubmissionValue[] {
	return version.fields.map((field) => {
		const raw = (sent.get(field.key) ?? []).map((text) => text.slice(0, FORM_LIMITS.textareaLength));
		const value =
			field.type === "hidden"
				? hiddenValue(field, from)
				: field.type === "checkboxes"
					? raw.slice(0, FORM_LIMITS.options)
					: (raw[0] ?? null);
		return { key: field.key, label: field.label.text, type: field.type, value };
	});
}

type Broken = { rule: FormRule; params?: Record<string, string | number> };

function hiddenValue(field: FormField, from: SentFrom): string | null {
	const source = field.source ?? { kind: "page" };
	if (source.kind === "fixed") return source.value;
	if (source.kind === "page") return from.pageUrl;
	return from.query.get(source.name)?.slice(0, FORM_LIMITS.labelLength) ?? null;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ().-]{5,30}$/;
const NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/;

function readValue(
	field: FormField,
	raw: readonly string[],
	from: SentFrom,
): { value: SubmissionValue["value"]; rule: Broken | null } {
	const first = (raw[0] ?? "").replaceAll("\r\n", "\n").trim();
	const required = (rule: FormRule = "required") => ({ value: null, rule: field.required ? { rule } : null });
	switch (field.type) {
		case "hidden":
			return { value: hiddenValue(field, from), rule: null };
		case "consent": {
			const given = raw.includes("yes");
			return { value: given, rule: field.required && !given ? { rule: "requiredConsent" } : null };
		}
		case "checkboxes": {
			const chosen = [...new Set(raw)];
			if (chosen.some((value) => !field.options.some((option) => option.value === value))) {
				return { value: chosen.slice(0, FORM_LIMITS.options), rule: { rule: "option" } };
			}
			if (chosen.length === 0) return { value: [], rule: field.required ? { rule: "requiredChoice" } : null };
			const ordered = field.options.map((option) => option.value).filter((value) => chosen.includes(value));
			if (field.minChoices !== null && ordered.length < field.minChoices) {
				return { value: ordered, rule: { rule: "minChoices", params: { min: field.minChoices } } };
			}
			if (field.maxChoices !== null && ordered.length > field.maxChoices) {
				return { value: ordered, rule: { rule: "maxChoices", params: { max: field.maxChoices } } };
			}
			return { value: ordered, rule: null };
		}
		case "select":
		case "radio": {
			if (first === "") return required("requiredChoice");
			const known = field.options.some((option) => option.value === first);
			return { value: first, rule: known ? null : { rule: "option" } };
		}
		default:
			break;
	}
	if (first === "") return required();
	switch (field.type) {
		case "email": {
			const email = first.toLowerCase();
			return { value: email, rule: email.length <= 254 && EMAIL.test(email) ? null : { rule: "email" } };
		}
		case "phone": {
			const digits = first.replace(/\D/g, "").length;
			return { value: first, rule: PHONE.test(first) && digits >= 5 ? null : { rule: "phone" } };
		}
		case "url":
			return { value: first, rule: isWebAddress(first) ? null : { rule: "url" } };
		case "number": {
			if (!NUMBER.test(first)) return { value: first.slice(0, 100), rule: { rule: "number" } };
			const number = Number(first);
			if (field.integer && !Number.isInteger(number)) return { value: number, rule: { rule: "integer" } };
			if (field.min !== null && number < field.min)
				return { value: number, rule: { rule: "min", params: { min: field.min } } };
			if (field.max !== null && number > field.max)
				return { value: number, rule: { rule: "max", params: { max: field.max } } };
			return { value: number, rule: null };
		}
		case "date": {
			if (!isDay(first)) return { value: first.slice(0, 100), rule: { rule: "date" } };
			if (field.minDate !== null && first < field.minDate) {
				return { value: first, rule: { rule: "minDate", params: { min: field.minDate } } };
			}
			if (field.maxDate !== null && first > field.maxDate) {
				return { value: first, rule: { rule: "maxDate", params: { max: field.maxDate } } };
			}
			return { value: first, rule: null };
		}
		default: {
			// Text and textareas.
			const cap = field.type === "textarea" ? FORM_LIMITS.textareaLength : FORM_LIMITS.textLength;
			const max = Math.min(field.maxLength ?? cap, cap);
			const length = [...first].length;
			if (field.minLength !== null && length < field.minLength) {
				return { value: first.slice(0, cap), rule: { rule: "minLength", params: { min: field.minLength } } };
			}
			if (length > max) return { value: first.slice(0, cap), rule: { rule: "maxLength", params: { max } } };
			if (field.pattern !== null && !compiledPattern(field.pattern).matches(first)) {
				return { value: first, rule: { rule: "pattern" } };
			}
			return { value: first, rule: null };
		}
	}
}

function isWebAddress(text: string): boolean {
	if (text.length > FORM_LIMITS.textLength) return false;
	try {
		const url = new URL(text);
		return (url.protocol === "https:" || url.protocol === "http:") && url.hostname.includes(".");
	} catch {
		return false;
	}
}
