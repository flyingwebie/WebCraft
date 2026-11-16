/**
 * The fixed set of formatters a value can have in Template markup (`{{ publishedAt | date: long }}`):
 *
 * - `date` (`short`, `medium` (the default), `long`, `full`, `time`, `iso`, `datetime`): a date in
 *   the page's language, in UTC;
 * - `number` (optionally the number of decimals, 0 to 10): a number in the page's language;
 * - `truncate: <length>` (1 to 10,000): text cut at a word boundary to at most that many
 *   characters, with `…` after it.
 *
 * A formatter turns a value into text (`apply-format.ts`); the renderer then escapes it for where it
 * lands. This module reads, writes and checks them only, so the browser's markup code can use it
 * without what reading a value as text takes.
 */

export const DATE_STYLES = ["short", "medium", "long", "full", "time", "iso", "datetime"] as const;
export type DateStyle = (typeof DATE_STYLES)[number];

export const FORMATTER_NAMES = ["date", "number", "truncate"] as const;

/** A value's formatter, as stored in element trees. */
export type ValueFormat =
	| { type: "date"; style?: DateStyle }
	| { type: "number"; digits?: number }
	| { type: "truncate"; length: number };

export const NUMBER_MAX_DIGITS = 10;
export const TRUNCATE_MAX_LENGTH = 10_000;

// ---------------------------------------------------------------------------------------------
// Formatters in Template markup: `date`, `date: long`, `number: 2`, `truncate: 120`

/** Reads the formatter written after `|`. */
export function readFormat(text: string): { format: ValueFormat } | { problem: string } {
	const match = /^\s*([A-Za-z]+)\s*(?::\s*([^\s]*)\s*)?$/.exec(text);
	if (!match) return { problem: "Write a formatter as name or name: setting, such as date: long or truncate: 120." };
	const [, name = "", argument] = match;
	switch (name) {
		case "date":
			if (argument === undefined) return { format: { type: "date" } };
			if (!(DATE_STYLES as readonly string[]).includes(argument)) {
				return { problem: `date takes one of ${DATE_STYLES.join(", ")}.` };
			}
			return { format: { type: "date", style: argument as DateStyle } };
		case "number":
			if (argument === undefined) return { format: { type: "number" } };
			if (!/^\d+$/.test(argument) || Number(argument) > NUMBER_MAX_DIGITS) {
				return { problem: `number takes how many decimals to show, 0 to ${NUMBER_MAX_DIGITS}.` };
			}
			return { format: { type: "number", digits: Number(argument) } };
		case "truncate":
			if (argument === undefined || !/^\d+$/.test(argument) || !inTruncateRange(Number(argument))) {
				return { problem: `truncate takes a length from 1 to ${TRUNCATE_MAX_LENGTH}, such as truncate: 120.` };
			}
			return { format: { type: "truncate", length: Number(argument) } };
		default:
			return { problem: `There is no formatter ${name}: use ${FORMATTER_NAMES.join(", ")}.` };
	}
}

/** Writes a formatter as Template markup reads it. */
export function writeFormat(format: ValueFormat): string {
	switch (format.type) {
		case "date":
			return format.style === undefined ? "date" : `date: ${format.style}`;
		case "number":
			return format.digits === undefined ? "number" : `number: ${format.digits}`;
		case "truncate":
			return `truncate: ${format.length}`;
	}
}

function inTruncateRange(length: number): boolean {
	return Number.isInteger(length) && length >= 1 && length <= TRUNCATE_MAX_LENGTH;
}

/** Checks a stored formatter and answers it in canonical form, or a problem. */
export function checkFormat(input: unknown): { format: ValueFormat } | { problem: string } {
	const raw = (input ?? {}) as Record<string, unknown>;
	switch (raw.type) {
		case "date":
			if (raw.style === undefined) return { format: { type: "date" } };
			if (!(DATE_STYLES as readonly unknown[]).includes(raw.style)) {
				return { problem: `date takes one of ${DATE_STYLES.join(", ")}.` };
			}
			return { format: { type: "date", style: raw.style as DateStyle } };
		case "number":
			if (raw.digits === undefined) return { format: { type: "number" } };
			if (!Number.isInteger(raw.digits) || (raw.digits as number) < 0 || (raw.digits as number) > NUMBER_MAX_DIGITS) {
				return { problem: `number takes how many decimals to show, 0 to ${NUMBER_MAX_DIGITS}.` };
			}
			return { format: { type: "number", digits: raw.digits as number } };
		case "truncate":
			if (typeof raw.length !== "number" || !inTruncateRange(raw.length)) {
				return { problem: `truncate takes a length from 1 to ${TRUNCATE_MAX_LENGTH}.` };
			}
			return { format: { type: "truncate", length: raw.length } };
		default:
			return { problem: `There is no formatter ${String(raw.type)}: use ${FORMATTER_NAMES.join(", ")}.` };
	}
}
