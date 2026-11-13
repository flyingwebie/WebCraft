import type { ContentProblem } from "./errors.ts";
import type { FieldDefinition } from "./field-types.ts";
import type { PostType } from "./post-types.ts";

/**
 * A query Loop's query: which Entries it lists (GLOSSARY.md › Loop). Only published Entries shown in
 * the page's language are ever listed to visitors; the query narrows them further. It is stored as
 * data, checked against the Site's Post Types when it is saved and published, and run as one
 * parameterised SQL query (`loop-runs.ts`). Site search and Filters (ADR 0021) narrow the same query.
 */
export type LoopQuery = {
	/** The keys of the Post Types whose Entries it lists. */
	postTypes: string[];
	/** Whether an Entry must pass every filter (`all`) or one of them (`any`). */
	match: "all" | "any";
	filters: QueryFilter[];
	/** The order, first sort first; newest published first when empty. */
	sort: LoopSort[];
	/** How many items it shows (on each page, when it paginates). */
	limit: number;
	/** How many matching Entries it skips first. */
	offset: number;
	/** Whether it shows its items page by page on Archive templates and Pages (`{{@pagination}}`). */
	paginate: boolean;
	/** Whether it leaves out the Entry the page shows ("more posts" on an Entry template). */
	excludeCurrent: boolean;
};

/** How a Field's value is compared with a filter's value. */
export const FIELD_OPERATORS = [
	"equals",
	"notEquals",
	"contains",
	"lessThan",
	"atMost",
	"greaterThan",
	"atLeast",
	"empty",
	"notEmpty",
] as const;
export type FieldOperator = (typeof FIELD_OPERATORS)[number];

/** Which Entries a Relationship filter keeps: those pointing at the page's Entry, sharing one with it, or pointing at chosen ones. */
export const RELATIONSHIP_TARGETS = ["current", "sharedWithCurrent", "entries"] as const;
export type RelationshipTarget = (typeof RELATIONSHIP_TARGETS)[number];

/** A date window: before or after now, the last or next N units, or between two days. */
export const DATE_WINDOWS = ["past", "future", "last", "next", "between"] as const;
export type DateWindow = (typeof DATE_WINDOWS)[number];
export const DATE_UNITS = ["days", "weeks", "months", "years"] as const;
export type DateUnit = (typeof DATE_UNITS)[number];

/** An Entry's status, as the admin shows it: never published, published as it is, or changed since. */
export const ENTRY_STATUSES = ["draft", "published", "changed"] as const;
export type QueryStatus = (typeof ENTRY_STATUSES)[number];

export type QueryFilter =
	/** A Field's value (`minutes`, or a Group's Field: `address.city`) compared with `value`. */
	| { type: "field"; field: string; operator: FieldOperator; value: string | number | boolean | null }
	/**
	 * Entries whose Relationship `field` (its definition path, `categories` or `credits.person`)
	 * points at the page's Entry, at one the page's Entry points at through the same Field, or at
	 * the chosen `entries`.
	 */
	| { type: "relationship"; field: string; to: RelationshipTarget; entries: string[] }
	/** A date (a built-in date or a date Field) inside a window. */
	| {
			type: "date";
			field: string;
			window: DateWindow;
			amount: number | null;
			unit: DateUnit | null;
			/** `between`: the first day in the window, or null for no start. */
			from: string | null;
			/** `between`: the last day in the window, or null for no end. */
			to: string | null;
	  }
	/** Entries with one of these statuses. Visitors see only published Entries, so `draft` keeps none of theirs. */
	| { type: "status"; statuses: QueryStatus[] };

export type LoopSort = { by: string; direction: "asc" | "desc" };

/** What a query may ask for at most, so no page can run an unbounded query. */
export const QUERY_LIMITS = {
	postTypes: 10,
	filters: 20,
	sort: 3,
	limit: 100,
	offset: 1_000,
	/** Chosen Entries in one Relationship filter. */
	entries: 50,
	/** The amount of a `last` or `next` window. */
	amount: 1_000,
	/** A filter's text value, in characters. */
	text: 2_000,
} as const;

export function defaultQuery(): LoopQuery {
	return {
		postTypes: [],
		match: "all",
		filters: [],
		sort: [],
		limit: 10,
		offset: 0,
		paginate: false,
		excludeCurrent: false,
	};
}

/** Built-in values a query sorts by, and those it compares as dates. */
export const SORTABLE_BUILT_INS = ["title", "createdAt", "updatedAt", "publishedAt", "lastPublishedAt"] as const;
export const DATE_BUILT_INS = ["createdAt", "updatedAt", "publishedAt", "lastPublishedAt"] as const;

/** The operators each Field type takes in a filter; a type not here can't be filtered on. */
const OPERATORS_BY_TYPE: Readonly<Record<string, readonly FieldOperator[]>> = {
	text: ["equals", "notEquals", "contains", "empty", "notEmpty"],
	email: ["equals", "notEquals", "contains", "empty", "notEmpty"],
	richText: ["contains", "empty", "notEmpty"],
	select: ["equals", "notEquals", "empty", "notEmpty"],
	number: ["equals", "notEquals", "lessThan", "atMost", "greaterThan", "atLeast", "empty", "notEmpty"],
	date: ["equals", "notEquals", "lessThan", "atMost", "greaterThan", "atLeast", "empty", "notEmpty"],
	boolean: ["equals", "notEquals"],
	media: ["empty", "notEmpty"],
	link: ["empty", "notEmpty"],
	body: ["empty", "notEmpty"],
};

/** Field types a query sorts by. */
const SORTABLE_TYPES: ReadonlySet<string> = new Set(["text", "email", "number", "date", "boolean", "select"]);

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A Field found by its path in some of a query's Post Types, with the definition in each. */
export type FoundField = { field: FieldDefinition; postTypes: PostType[] };

/**
 * The Field at `path` in the Post Types that have it: a top-level Field or a Group's Field
 * (`address.city`); with `throughRepeaters`, a Repeater's Field too (`credits.person`), as
 * Relationships are kept in `entry_links`. Undefined when none has it.
 */
export function fieldAt(
	postTypes: readonly PostType[],
	path: string,
	throughRepeaters = false,
): { found: FoundField[] } | undefined {
	const found: FoundField[] = [];
	for (const postType of postTypes) {
		const field = fieldIn(postType.fields, path.split("."), throughRepeaters);
		if (!field) continue;
		const same = found.find((candidate) => candidate.field.type === field.type);
		if (same) same.postTypes.push(postType);
		else found.push({ field, postTypes: [postType] });
	}
	return found.length > 0 ? { found } : undefined;
}

function fieldIn(
	fields: readonly FieldDefinition[],
	names: readonly string[],
	throughRepeaters: boolean,
): FieldDefinition | undefined {
	const [name, ...rest] = names;
	const field = fields.find((candidate) => candidate.key === name);
	if (!field || rest.length === 0) return field;
	if (field.type === "group" || (throughRepeaters && field.type === "repeater")) {
		return fieldIn(field.fields, rest, throughRepeaters);
	}
	return undefined;
}

/**
 * Checks a query against the Site's Post Types, answering it in canonical form (every setting
 * filled in) and adding a problem for each setting that is wrong, where it is (`query.filters[1].value`).
 * Settings left out take their defaults.
 */
export function parseQuery(input: unknown, postTypes: readonly PostType[], problems: ContentProblem[]): LoopQuery {
	const raw = record(input);
	const query = defaultQuery();
	const problem = (at: string, message: string) => problems.push({ at: `query.${at}`, message });

	// Post Types
	const listed: PostType[] = [];
	if (raw.postTypes !== undefined) {
		if (!Array.isArray(raw.postTypes) || raw.postTypes.length > QUERY_LIMITS.postTypes) {
			problem("postTypes", `A query lists Entries of up to ${QUERY_LIMITS.postTypes} Post Types, by key.`);
		} else {
			raw.postTypes.forEach((key: unknown, index) => {
				const postType = postTypes.find((candidate) => candidate.key === key);
				if (!postType) problem(`postTypes[${index}]`, `The Site has no Post Type with the key ${String(key)}.`);
				else if (!query.postTypes.includes(postType.key)) {
					query.postTypes.push(postType.key);
					listed.push(postType);
				}
			});
		}
	}

	if (raw.match !== undefined) {
		if (raw.match === "all" || raw.match === "any") query.match = raw.match;
		else problem("match", "Filters match all or any.");
	}

	if (raw.filters !== undefined) {
		if (!Array.isArray(raw.filters) || raw.filters.length > QUERY_LIMITS.filters) {
			problem("filters", `A query has up to ${QUERY_LIMITS.filters} filters.`);
		} else {
			raw.filters.forEach((filter: unknown, index) => {
				const parsed = parseFilter(record(filter), listed, (at, message) =>
					problem(`filters[${index}]${at ? `.${at}` : ""}`, message),
				);
				if (parsed) query.filters.push(parsed);
			});
		}
	}

	if (raw.sort !== undefined) {
		if (!Array.isArray(raw.sort) || raw.sort.length > QUERY_LIMITS.sort) {
			problem("sort", `A query sorts by up to ${QUERY_LIMITS.sort} values.`);
		} else {
			raw.sort.forEach((sort: unknown, index) => {
				const { by, direction } = record(sort);
				const here = `sort[${index}]`;
				if (direction !== "asc" && direction !== "desc") {
					problem(`${here}.direction`, "A sort goes up (asc) or down (desc).");
					return;
				}
				if (typeof by !== "string" || !sortable(listed, by)) {
					problem(
						`${here}.by`,
						"A query sorts by the title, a date, or a text, number, date, true/false or single select Field.",
					);
					return;
				}
				query.sort.push({ by, direction });
			});
		}
	}

	if (raw.limit !== undefined) {
		if (!isWhole(raw.limit) || raw.limit < 1 || raw.limit > QUERY_LIMITS.limit) {
			problem("limit", `A query shows 1 to ${QUERY_LIMITS.limit} items.`);
		} else query.limit = raw.limit;
	}
	if (raw.offset !== undefined) {
		if (!isWhole(raw.offset) || raw.offset < 0 || raw.offset > QUERY_LIMITS.offset) {
			problem("offset", `A query skips 0 to ${QUERY_LIMITS.offset} items.`);
		} else query.offset = raw.offset;
	}
	for (const flag of ["paginate", "excludeCurrent"] as const) {
		if (raw[flag] === undefined) continue;
		if (typeof raw[flag] === "boolean") query[flag] = raw[flag];
		else problem(flag, `${flag} is true or false.`);
	}
	return query;
}

/** Whether a query over `postTypes` can sort by `by`: the title, a built-in date, or one sortable Field. */
export function sortable(postTypes: readonly PostType[], by: string): boolean {
	if ((SORTABLE_BUILT_INS as readonly string[]).includes(by)) return true;
	const at = fieldAt(postTypes, by);
	return (
		at !== undefined &&
		at.found.length === 1 &&
		at.found.every(({ field }) => SORTABLE_TYPES.has(field.type) && !(field.type === "select" && field.multiple))
	);
}

function parseFilter(
	raw: Record<string, unknown>,
	postTypes: readonly PostType[],
	problem: (at: string, message: string) => void,
): QueryFilter | undefined {
	const field = raw.field;
	switch (raw.type) {
		case "field": {
			if (typeof field !== "string") return void problem("field", "A filter names a Field.");
			const at = fieldAt(postTypes, field);
			if (!at) return void problem("field", `The query's Post Types have no Field ${field}.`);
			if (at.found.length > 1) {
				return void problem("field", `${field} is a Field of different types in the query's Post Types.`);
			}
			const definition = (at.found[0] as FoundField).field;
			const operators = OPERATORS_BY_TYPE[definition.type] ?? [];
			if (operators.length === 0) return void problem("field", `A query can't filter on ${definition.label}.`);
			const operator = raw.operator as FieldOperator;
			if (!operators.includes(operator)) {
				return void problem("operator", `${definition.label} is compared with ${operators.join(", ")}.`);
			}
			if (operator === "empty" || operator === "notEmpty") return { type: "field", field, operator, value: null };
			const value = filterValue(definition, raw.value);
			if (value === undefined) return void problem("value", valueMessage(definition));
			return { type: "field", field, operator, value };
		}
		case "relationship": {
			if (typeof field !== "string") return void problem("field", "A filter names a Relationship Field.");
			const at = fieldAt(postTypes, field, true);
			if (!at || at.found.some(({ field: found }) => found.type !== "relationship")) {
				return void problem("field", `The query's Post Types have no Relationship Field ${field}.`);
			}
			const to = raw.to as RelationshipTarget;
			if (!RELATIONSHIP_TARGETS.includes(to)) {
				return void problem("to", "A Relationship filter keeps Entries related to the current Entry or chosen ones.");
			}
			const entries: string[] = [];
			if (to === "entries") {
				const given = raw.entries;
				if (
					!Array.isArray(given) ||
					given.length === 0 ||
					given.length > QUERY_LIMITS.entries ||
					given.some((id) => typeof id !== "string" || !UUID.test(id))
				) {
					return void problem("entries", `Choose 1 to ${QUERY_LIMITS.entries} Entries.`);
				}
				for (const id of given as string[]) if (!entries.includes(id.toLowerCase())) entries.push(id.toLowerCase());
			}
			return { type: "relationship", field, to, entries };
		}
		case "date": {
			if (typeof field !== "string" || !isDateField(postTypes, field)) {
				return void problem("field", "A date filter names a built-in date or a date Field with a day in it.");
			}
			const window = raw.window as DateWindow;
			if (!DATE_WINDOWS.includes(window)) return void problem("window", `A date window is ${DATE_WINDOWS.join(", ")}.`);
			const filter: QueryFilter = { type: "date", field, window, amount: null, unit: null, from: null, to: null };
			if (window === "last" || window === "next") {
				if (!isWhole(raw.amount) || raw.amount < 1 || raw.amount > QUERY_LIMITS.amount) {
					return void problem("amount", `A window is 1 to ${QUERY_LIMITS.amount} days, weeks, months or years.`);
				}
				if (!DATE_UNITS.includes(raw.unit as DateUnit))
					return void problem("unit", "A window counts days, weeks, months or years.");
				return { ...filter, amount: raw.amount, unit: raw.unit as DateUnit };
			}
			if (window === "between") {
				for (const end of ["from", "to"] as const) {
					const day = raw[end];
					if (day === undefined || day === null) continue;
					if (typeof day !== "string" || !isDay(day)) return void problem(end, "A day is written 2026-03-02.");
					filter[end] = day;
				}
				if (filter.from === null && filter.to === null)
					return void problem("from", "A window between days needs a first or a last day.");
				if (filter.from !== null && filter.to !== null && filter.from > filter.to) {
					return void problem("to", "The last day comes after the first.");
				}
			}
			return filter;
		}
		case "status": {
			const statuses = raw.statuses;
			if (
				!Array.isArray(statuses) ||
				statuses.length === 0 ||
				statuses.some((status) => !ENTRY_STATUSES.includes(status as QueryStatus))
			) {
				return void problem("statuses", `Choose one or more of ${ENTRY_STATUSES.join(", ")}.`);
			}
			return { type: "status", statuses: ENTRY_STATUSES.filter((status) => statuses.includes(status)) };
		}
		default:
			problem("type", "A filter is on a Field, a Relationship, a date or the status.");
			return undefined;
	}
}

/** Whether `field` is a built-in date, or a date Field (with a day in it) in the query's Post Types. */
function isDateField(postTypes: readonly PostType[], field: string): boolean {
	if ((DATE_BUILT_INS as readonly string[]).includes(field)) return true;
	const at = fieldAt(postTypes, field);
	return at?.found.every(({ field: found }) => found.type === "date" && found.mode !== "time") === true;
}

/** A filter's value as its Field's type takes it, or undefined when it can't be one. */
function filterValue(field: FieldDefinition, value: unknown): string | number | boolean | undefined {
	switch (field.type) {
		case "number":
			return typeof value === "number" && Number.isFinite(value) ? value : undefined;
		case "boolean":
			return typeof value === "boolean" ? value : undefined;
		case "date":
			return typeof value === "string" && (isDay(value) || /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?Z$/.test(value))
				? value
				: undefined;
		case "select":
			return typeof value === "string" && field.options.some((option) => option.value === value) ? value : undefined;
		default:
			return typeof value === "string" && value.trim() !== "" && value.length <= QUERY_LIMITS.text
				? value.trim()
				: undefined;
	}
}

function valueMessage(field: FieldDefinition): string {
	switch (field.type) {
		case "number":
			return `${field.label} is compared with a number.`;
		case "boolean":
			return `${field.label} is compared with true or false.`;
		case "date":
			return `${field.label} is compared with a day (2026-03-02) or a time in UTC (2026-03-02T09:30Z).`;
		case "select":
			return `${field.label} is compared with one of its options' values.`;
		default:
			return `${field.label} is compared with text of 1 to ${QUERY_LIMITS.text} characters.`;
	}
}

function isDay(text: string): boolean {
	if (!DAY.test(text)) return false;
	const date = new Date(`${text}T00:00:00Z`);
	return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(text);
}

function isWhole(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value);
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Reads a stored query; anything missing or unreadable takes its default. */
export function storedQuery(value: unknown): LoopQuery {
	const raw = record(value);
	const query = defaultQuery();
	return {
		postTypes: Array.isArray(raw.postTypes) ? raw.postTypes.filter((key) => typeof key === "string") : query.postTypes,
		match: raw.match === "any" ? "any" : "all",
		filters: Array.isArray(raw.filters) ? (raw.filters as QueryFilter[]) : [],
		sort: Array.isArray(raw.sort) ? (raw.sort as LoopSort[]) : [],
		limit: isWhole(raw.limit) ? raw.limit : query.limit,
		offset: isWhole(raw.offset) ? raw.offset : query.offset,
		paginate: raw.paginate === true,
		excludeCurrent: raw.excludeCurrent === true,
	};
}
