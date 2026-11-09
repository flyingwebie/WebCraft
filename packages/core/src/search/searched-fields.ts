// The admin reads this file in the browser (`@webcraft/core/search-fields`): it imports types only.
import type { ContentProblem } from "../content/errors.ts";
import type { FieldDefinition } from "../content/field-types.ts";

/**
 * Searched fields (GLOSSARY.md, ADR 0021): the Fields of a Post Type that Site search and every
 * Filter's search box look in, each with a weight, set once on the Post Type. `title` is the built-in
 * title; any other is a Field's path: a top-level Field (`summary`), a Group's Field (`origin.city`)
 * or a Repeater's Field across its rows (`steps.text`).
 */
export type SearchedField = { field: string; weight: SearchWeight };

/** How much a Searched field counts in ranking hits: A most, then B, C and D. */
export const SEARCH_WEIGHTS = ["A", "B", "C", "D"] as const;
export type SearchWeight = (typeof SEARCH_WEIGHTS)[number];

/** How many Searched fields a Post Type has at most. */
export const SEARCHED_FIELDS_MAX = 50;

/**
 * The Field types search reads as text: text, rich text (its text), a body (its Blocks' text), a
 * select (its options' labels), a link (its text) and an email address.
 */
export const SEARCHED_TYPES: ReadonlySet<string> = new Set(["text", "richText", "body", "select", "link", "email"]);

/** The built-in value a Searched field may name. */
export const SEARCHED_TITLE = "title";

/**
 * What a new Post Type searches until Staff choose: its title at A, and its Body field (when it has
 * one) at B.
 */
export function defaultSearchedFields(fields: readonly FieldDefinition[]): SearchedField[] {
	const body = fields.find((field) => field.type === "body");
	return [{ field: SEARCHED_TITLE, weight: "A" }, ...(body ? [{ field: body.key, weight: "B" as const }] : [])];
}

/**
 * The Fields a Searched field's path walks through, the leaf last: undefined when the Post Type has no
 * Field there; `type` when it has one search can't read as text (a number, a Media Field, a Group
 * itself). The title has none.
 */
export function searchedChain(
	fields: readonly FieldDefinition[],
	path: string,
): FieldDefinition[] | "unknown" | "type" {
	const names = path.split(".");
	const chain: FieldDefinition[] = [];
	let list: readonly FieldDefinition[] = fields;
	for (const [index, name] of names.entries()) {
		const field = list.find((candidate) => candidate.key === name);
		if (!field) return "unknown";
		chain.push(field);
		const last = index === names.length - 1;
		if (field.type === "group" || field.type === "repeater") {
			if (last) return "type";
			list = field.fields;
			continue;
		}
		if (!last) return "unknown";
		return SEARCHED_TYPES.has(field.type) ? chain : "type";
	}
	return "unknown";
}

/**
 * Checks Searched fields against a Post Type's Fields, adding a problem for each that is wrong, where
 * it is (`searchedFields[1].field`), and answers the ones that are right.
 */
export function parseSearchedFields(
	input: unknown,
	fields: readonly FieldDefinition[],
	problems: ContentProblem[],
): SearchedField[] {
	if (!Array.isArray(input) || input.length > SEARCHED_FIELDS_MAX) {
		problems.push({
			at: "searchedFields",
			message: `A Post Type has up to ${SEARCHED_FIELDS_MAX} Searched fields.`,
			rule: "searchedFieldsCount",
			params: { max: SEARCHED_FIELDS_MAX },
		});
		return [];
	}
	const kept: SearchedField[] = [];
	input.forEach((item: unknown, index) => {
		const raw = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
		const at = `searchedFields[${index}]`;
		const weight = raw.weight;
		if (!SEARCH_WEIGHTS.includes(weight as SearchWeight)) {
			problems.push({
				at: `${at}.weight`,
				message: "A Searched field's weight is A, B, C or D.",
				rule: "searchedFieldWeight",
			});
			return;
		}
		const field = typeof raw.field === "string" ? raw.field.trim() : "";
		if (kept.some((searched) => searched.field === field)) {
			problems.push({
				at: `${at}.field`,
				message: `${field} is searched once, with one weight.`,
				rule: "searchedFieldTwice",
				params: { field },
			});
			return;
		}
		const found = field === SEARCHED_TITLE ? [] : searchedChain(fields, field);
		if (found === "unknown") {
			problems.push({
				at: `${at}.field`,
				message: `The Post Type has no Field ${field || "(none)"} to search.`,
				rule: "searchedFieldUnknown",
				params: { field },
			});
			return;
		}
		if (found === "type") {
			problems.push({
				at: `${at}.field`,
				message: `Site search reads text, rich text, Body, select, link and email Fields: not ${field}.`,
				rule: "searchedFieldType",
				params: { field },
			});
			return;
		}
		kept.push({ field, weight: weight as SearchWeight });
	});
	return kept;
}

/**
 * Stored Searched fields as they hold for a Post Type's Fields now: the ones whose Field is gone, or
 * no longer one search reads, are left out.
 */
export function keptSearchedFields(stored: unknown, fields: readonly FieldDefinition[]): SearchedField[] {
	if (!Array.isArray(stored)) return [];
	const kept: SearchedField[] = [];
	for (const item of stored) {
		const raw = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
		if (typeof raw.field !== "string" || !SEARCH_WEIGHTS.includes(raw.weight as SearchWeight)) continue;
		if (kept.some((searched) => searched.field === raw.field)) continue;
		const found = raw.field === SEARCHED_TITLE ? [] : searchedChain(fields, raw.field);
		if (Array.isArray(found)) kept.push({ field: raw.field, weight: raw.weight as SearchWeight });
	}
	return kept;
}

/**
 * What a Post Type's search documents are built from: its Searched fields with the definitions of the
 * Fields they read (whether each is translatable, a select's labels). When it changes, the documents
 * already in the index no longer match, and the Site's index is rebuilt.
 */
export function indexDefinition(fields: readonly FieldDefinition[], searched: readonly SearchedField[]): string {
	return JSON.stringify(
		searched.map((item) => ({
			...item,
			chain: item.field === SEARCHED_TITLE ? null : searchedChain(fields, item.field),
		})),
	);
}
