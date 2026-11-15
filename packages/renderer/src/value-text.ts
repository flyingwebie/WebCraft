/**
 * Values read as text and compared: what a binding shows when nothing formats it, whether a value is
 * there, and how Conditions compare two values. Rich text is read without its markup, which takes the
 * rich text cleaner's HTML parser, so this lives apart from `values.ts`: only the renderer, the server
 * and the places that render or read values import it, never the code the building area's shell
 * loads at once.
 */
import { bodyHasContent, bodyText } from "./body/body.ts";
import { richTextToText } from "./rich-text.ts";
import {
	isBody,
	isList,
	isoDay,
	isRichText,
	isToc,
	joinList,
	type TemplateValue,
	toDate,
	toFiniteNumber,
	toNumber,
} from "./values.ts";

/**
 * A value as plain text: dates as `2026-03-02`, rich text without its markup, a body's text, a table
 * of contents' headings and a list joined with commas.
 */
export function textOf(value: TemplateValue): string {
	if (value === null || value === undefined) return "";
	if (isList(value)) return joinList(value.map(textOf));
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : isoDay(value);
	// On one line: a body read as text sits in an attribute or a formatter (a description, an excerpt).
	if (value.type === "body") return bodyText(value.blocks).replace(/\s+/g, " ").trim();
	if (value.type === "toc") return joinList(value.headings.map((heading) => heading.text));
	return richTextToText(value.html);
}

/**
 * Whether a value is there: not missing, not blank text, not false, not empty rich text, not a body
 * without content or a table of contents without headings, not an empty list.
 */
export function isPresent(value: TemplateValue): boolean {
	if (value === null || value === undefined) return false;
	if (isList(value)) return value.some(isPresent);
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return !Number.isNaN(value);
	if (value instanceof Date) return !Number.isNaN(value.getTime());
	if (isRichText(value)) return richTextToText(value.html).trim() !== "";
	if (isBody(value)) return bodyHasContent(value.blocks);
	if (isToc(value)) return value.headings.length > 0;
	return typeof value === "string" && value.trim() !== "";
}

function isEmpty(value: TemplateValue): boolean {
	return value === null || value === undefined || (typeof value !== "boolean" && !isPresent(value));
}

function toBoolean(value: TemplateValue): boolean {
	if (typeof value === "boolean") return value;
	if (value === "true" || value === "false") return value === "true";
	return isPresent(value);
}

/**
 * Whether two values are the same, as `==` in a Condition reads it: empty equals empty (`""`),
 * a number compares as a number, true and false as a yes or no, anything else as its text.
 */
export function sameValue(a: TemplateValue, b: TemplateValue): boolean {
	if (isEmpty(a) || isEmpty(b)) return isEmpty(a) && isEmpty(b);
	if (typeof a === "boolean" || typeof b === "boolean") return toBoolean(a) === toBoolean(b);
	if (typeof a === "number" || typeof b === "number") return toNumber(a) === toNumber(b);
	return textOf(a) === textOf(b);
}

/**
 * How two values order, as `<`, `<=`, `>` and `>=` in a Condition read them: dates as dates (a date,
 * or text written `2026-03-02…`), numbers as numbers, other text alphabetically. Undefined when
 * either is empty, or they can't be put in order (a list, or a date against a number).
 */
export function compareValues(a: TemplateValue, b: TemplateValue): number | undefined {
	if (isEmpty(a) || isEmpty(b) || isList(a) || isList(b)) return undefined;
	const [leftDate, rightDate] = [toDate(a), toDate(b)];
	if (leftDate && rightDate) return Math.sign(leftDate.getTime() - rightDate.getTime());
	if (leftDate || rightDate || typeof a === "boolean" || typeof b === "boolean") return undefined;
	const [leftNumber, rightNumber] = [toFiniteNumber(a), toFiniteNumber(b)];
	if (leftNumber !== undefined && rightNumber !== undefined) return Math.sign(leftNumber - rightNumber);
	if (typeof a === "number" || typeof b === "number") return undefined;
	const [left, right] = [textOf(a), textOf(b)];
	return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Whether `a` holds `b`, as `contains` in a Condition reads it: a list holds a value the same as
 * `b` (`tags contains "vegan"`), text holds `b`'s text whatever its case. Nothing holds an empty value.
 */
export function holds(a: TemplateValue, b: TemplateValue): boolean {
	if (isEmpty(b) || a === null || a === undefined) return false;
	if (isList(a)) return a.some((item) => sameValue(item, b) || (isList(item) && holds(item, b)));
	return textOf(a).toLowerCase().includes(textOf(b).toLowerCase());
}
