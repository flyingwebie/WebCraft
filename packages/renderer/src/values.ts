/**
 * The values bindings read where a page renders: a Field, a built-in such as `publishedAt`, and later
 * Globals (`site.x`), Loop items (`item.x`) and Props (`props.x`). The content store hands them over
 * typed; the renderer decides how each lands in the page.
 *
 * This module only knows the kinds of values: it imports no parser, so the code that reads and
 * writes Template markup in the browser (`@webcraft/renderer/builder`) can use it without the
 * rich text cleaner. Reading a value as text, and comparing values, is `value-text.ts`.
 */
import type { Block } from "./body/blocks.ts";
import type { TocHeading } from "./body/body.ts";

/** Rich text: HTML, cleaned against the rich text allowlist wherever it lands. */
export type RichText = { type: "richText"; html: string };

/** Marks HTML as rich text, so the renderer cleans it and writes it as markup rather than as text. */
export function richText(html: string): RichText {
	return { type: "richText", html };
}

/** A Body field's value: its Blocks in the page's language, rendered as semantic HTML (ADR 0018). */
export type BodyValue = { type: "body"; blocks: readonly Block[] };

/** Marks Blocks as a body, so the renderer writes them as HTML rather than as text. */
export function bodyValue(blocks: readonly Block[]): BodyValue {
	return { type: "body", blocks };
}

/** A body's table of contents (`body.toc`): its headings with their anchors, rendered as a list of links. */
export type TocValue = { type: "toc"; headings: readonly TocHeading[] };

export function tocValue(headings: readonly TocHeading[]): TocValue {
	return { type: "toc", headings };
}

/**
 * A value a binding reads. `null` and `undefined` render as nothing. A list (a multi-select's labels,
 * a Repeater's Field across its rows, the Entries a Relationship points at) renders as its values
 * joined with commas, until Loops show them one by one.
 */
export type TemplateValue =
	| string
	| number
	| boolean
	| Date
	| RichText
	| BodyValue
	| TocValue
	| readonly TemplateValue[]
	| null
	| undefined;

/** Reads the value a binding names. */
export type ValueReader = (path: string) => TemplateValue;

export function isList(value: TemplateValue): value is readonly TemplateValue[] {
	return Array.isArray(value);
}

/** A value of WebCraft's own kinds, rich text, a body or a table of contents, rather than plain data. */
type Typed = RichText | BodyValue | TocValue;

function isTyped(value: TemplateValue): value is Typed {
	return typeof value === "object" && value !== null && !(value instanceof Date) && !Array.isArray(value);
}

export function isRichText(value: TemplateValue): value is RichText {
	return isTyped(value) && value.type === "richText";
}

export function isBody(value: TemplateValue): value is BodyValue {
	return isTyped(value) && value.type === "body";
}

export function isToc(value: TemplateValue): value is TocValue {
	return isTyped(value) && value.type === "toc";
}

/** A date as visitors read it when no formatter says otherwise: `2026-03-02`, in UTC. */
export function isoDay(date: Date): string {
	return date.toISOString().slice(0, 10);
}

/** A list's values as text, the empty ones left out, joined with commas. */
export function joinList(texts: readonly string[]): string {
	return texts.filter((text) => text !== "").join(", ");
}

/** Reads a number from a value: a number, or text written as one; not a number otherwise. */
export function toNumber(value: TemplateValue): number {
	if (typeof value === "number") return value;
	if (typeof value === "string" && /^\s*-?\d+(?:\.\d+)?\s*$/.test(value)) return Number(value);
	return Number.NaN;
}

/** Reads a date from a value: a date, or text that starts with `YYYY-MM-DD`. */
export function toDate(value: TemplateValue): Date | undefined {
	if (value instanceof Date) return Number.isNaN(value.getTime()) ? undefined : value;
	if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value)) return undefined;
	const date = new Date(value.length === 10 ? `${value}T00:00:00Z` : value);
	return Number.isNaN(date.getTime()) ? undefined : date;
}

/** Reads a number from a value: a number, or text written as one. */
export function toFiniteNumber(value: TemplateValue): number | undefined {
	const number = toNumber(value);
	return Number.isFinite(number) ? number : undefined;
}
