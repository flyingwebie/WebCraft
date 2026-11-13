import { FILTER_LIMITS, RANGE_PARTS } from "@webcraft/renderer";

import { cleanSearchText } from "../search/text-search.ts";

/**
 * What visitors chose in a page's Filters, as its address keeps it (GLOSSARY.md › Filter): one query
 * parameter per control, under the control's URL key (the same in every language, prefixed with the
 * Filter's name when a page shows more than one): `category=bread,pastries&price=2-10&q=rye`.
 *
 * Only what the page's Filters allow is read (an allow-list, `StateReader`): known keys, known option
 * slugs, numbers and days that parse, an allowed sort. Anything else is dropped and never shown back.
 * The same choices always write the same query (keys sorted, an option list's slugs sorted, numbers in
 * their shortest form), which is the page's address in the page cache: `normalState`.
 *
 * A plain GET form sends its fields as they are (`category=bread&category=pastries`, `price.min=2`,
 * empty boxes as `q=`); `differs` says when what a request sent isn't the normal form, so the page can
 * send the visitor on to its normal address.
 */

/** One key a page's Filters keep their choices under, and what it takes. */
export type StateKey =
	/** A search box's text (`q`): free text, cleaned and cut as Site search reads it. */
	| { key: string; kind: "search" }
	/** Checkboxes: any of `values` (option slugs), written joined with commas. */
	| { key: string; kind: "many"; values: readonly string[] }
	/** Radio buttons, a select or a sort menu: one of `values`. */
	| { key: string; kind: "one"; values: readonly string[] }
	/** A toggle: on (`1`) or off (absent). */
	| { key: string; kind: "toggle" }
	/** A range of numbers (`2-10`, `2-`, `-10`) or of days (`2026-01-01..2026-03-31`). */
	| { key: string; kind: "number" | "date" };

/** What a page's Filters read from its address: every key they keep a choice under. */
export type StateReader = { keys: readonly StateKey[] };

/** A page with no Filter reads nothing. */
export const NO_STATE: StateReader = { keys: [] };

/** What a request's address chose, read through a page's Filters. */
export type FilterState = {
	/** Each key's choice in its normal form, for the keys that have one. */
	values: ReadonlyMap<string, string>;
	/** The choices as a query string, keys sorted (`category=bread,pastries&q=rye`); "" for none. */
	query: string;
	/** Whether the request sent its choices in another form than `query` (a plain form, a value dropped). */
	differs: boolean;
	/** The search box's text, when one has some. */
	search: string | undefined;
};

/** How a day is written. */
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** How a number is written in an address: digits, an optional sign and decimals, within what a page compares. */
const NUMBER = /^-?\d{1,12}(?:\.\d{1,6})?$/;
/** A range of numbers: from, a dash, to; either side may be left out. */
const NUMBER_RANGE = /^(-?\d{1,12}(?:\.\d{1,6})?)?-(-?\d{1,12}(?:\.\d{1,6})?)?$/;
/** A range of days: from, two dots, to; either side may be left out. */
const DAY_RANGE = /^(\d{4}-\d{2}-\d{2})?\.\.(\d{4}-\d{2}-\d{2})?$/;

/** Reads what a request's address chose in a page's Filters. */
export function readFilterState(reader: StateReader, params: URLSearchParams): FilterState {
	const values = new Map<string, string>();
	const given: [string, string][] = [];
	const names = new Set<string>();
	for (const { key, kind } of reader.keys) {
		names.add(key);
		if (kind === "number" || kind === "date") {
			names.add(`${key}${RANGE_PARTS.min}`);
			names.add(`${key}${RANGE_PARTS.max}`);
		}
	}
	for (const [name, value] of params) if (names.has(name)) given.push([name, value]);
	let search: string | undefined;
	for (const stateKey of reader.keys) {
		const value = readValue(stateKey, params);
		if (value === undefined) continue;
		values.set(stateKey.key, value);
		if (stateKey.kind === "search") search ??= value;
	}
	const query = writeQuery(values);
	return { values, query, differs: !samePairs(given, [...values]), search };
}

/** A key's choice in its normal form, or undefined when the address chose nothing it allows. */
function readValue(stateKey: StateKey, params: URLSearchParams): string | undefined {
	const all = params.getAll(stateKey.key);
	switch (stateKey.kind) {
		case "search": {
			const text = cleanSearchText(all[0] ?? "");
			return text === "" ? undefined : text;
		}
		case "many": {
			const allowed = new Set(stateKey.values);
			const chosen = new Set<string>();
			for (const value of all) {
				for (const part of value.split(",")) {
					const slug = part.trim();
					if (allowed.has(slug) && chosen.size < FILTER_LIMITS.values) chosen.add(slug);
				}
			}
			return chosen.size === 0 ? undefined : [...chosen].sort().join(",");
		}
		case "one":
			return all.find((value) => stateKey.values.includes(value));
		case "toggle":
			return all.some((value) => value === "1") ? "1" : undefined;
		case "number":
		case "date": {
			const parts = rangeParts(stateKey, params, all);
			if (!parts) return undefined;
			const read = stateKey.kind === "number" ? readNumber : readDay;
			let [from, to] = [read(parts[0]), read(parts[1])];
			if (from === undefined && to === undefined) return undefined;
			if (from !== undefined && to !== undefined && compare(stateKey.kind, from, to) > 0) [from, to] = [to, from];
			return stateKey.kind === "number" ? `${from ?? ""}-${to ?? ""}` : `${from ?? ""}..${to ?? ""}`;
		}
	}
}

/** A range's two sides as sent: one value (`2-10`), or a plain form's two boxes (`price.min`, `price.max`). */
function rangeParts(
	stateKey: StateKey,
	params: URLSearchParams,
	all: readonly string[],
): [string | undefined, string | undefined] | undefined {
	const [joined] = all;
	if (joined !== undefined && joined !== "") {
		const match = (stateKey.kind === "number" ? NUMBER_RANGE : DAY_RANGE).exec(joined);
		return match ? [match[1], match[2]] : undefined;
	}
	const min = params.get(`${stateKey.key}${RANGE_PARTS.min}`) ?? undefined;
	const max = params.get(`${stateKey.key}${RANGE_PARTS.max}`) ?? undefined;
	return [min?.trim() || undefined, max?.trim() || undefined];
}

/** A number in its shortest form (`02.50` is `2.5`), or undefined for anything else. */
function readNumber(text: string | undefined): string | undefined {
	if (text === undefined || !NUMBER.test(text)) return undefined;
	const number = Number(text);
	return Number.isFinite(number) ? String(Object.is(number, -0) ? 0 : number) : undefined;
}

/** A day that exists (`2026-02-30` doesn't), or undefined. */
function readDay(text: string | undefined): string | undefined {
	if (text === undefined || !DAY.test(text)) return undefined;
	const date = new Date(`${text}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text) ? text : undefined;
}

function compare(kind: "number" | "date", a: string, b: string): number {
	return kind === "number" ? Number(a) - Number(b) : a.localeCompare(b);
}

/** Choices as a query string, keys sorted; text values encoded as a form encodes them. */
export function writeQuery(values: Iterable<readonly [string, string]>): string {
	return [...values]
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([key, value]) => new URLSearchParams([[key, value]]).toString().replaceAll("%2C", ","))
		.join("&");
}

/** Whether two lists of parameters hold the same pairs, whatever their order. */
function samePairs(a: readonly (readonly [string, string])[], b: readonly (readonly [string, string])[]): boolean {
	if (a.length !== b.length) return false;
	const key = (pairs: readonly (readonly [string, string])[]) =>
		pairs
			.map(([name, value]) => `${name}=${value}`)
			.sort()
			.join("&");
	return key(a) === key(b);
}

/** A range's sides as stored in its normal form: `["2", "10"]`, `["2026-01-01", ""]`. */
export function rangeSides(kind: "number" | "date", value: string): [string, string] {
	if (kind === "date") {
		const [from = "", to = ""] = value.split("..");
		return [from, to];
	}
	const match = NUMBER_RANGE.exec(value);
	return [match?.[1] ?? "", match?.[2] ?? ""];
}
