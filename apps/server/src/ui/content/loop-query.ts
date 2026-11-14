import type { FieldDefinition, LoopQuery, LoopSort, QueryFilter } from "@webcraft/core";

/**
 * A query Loop's settings as the people who build one see them (`GLOSSARY.md` › Loop): which Fields of
 * the chosen Post Types a filter or a sort may read, the operators each Field type takes, and what a
 * filter becomes when what it is about changes. No React, no router and no client: the admin's Loop
 * screen (`LoopEditor.tsx`) and the building area's Loops place (BA-25) both build queries with it.
 */

export type Query = LoopQuery;
export type Filter = QueryFilter;
export type Sort = LoopSort;
export type FieldOperator = Extract<Filter, { type: "field" }>["operator"];
export type DateWindow = Extract<Filter, { type: "date" }>["window"];
export type DateUnit = NonNullable<Extract<Filter, { type: "date" }>["unit"]>;
export type QueryStatus = Extract<Filter, { type: "status" }>["statuses"][number];

/** The Post Types a query can list, as far as it reads them: their key, name and Fields. */
export type QueryPostType = { key: string; name: string; fields: readonly FieldDefinition[] };

/** The operators each Field type takes in a filter, as the content store checks them. */
export const OPERATORS: Readonly<Record<string, readonly FieldOperator[]>> = {
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

/** The Field types a query sorts by (a select only when it holds one choice). */
export const SORTABLE: ReadonlySet<string> = new Set(["text", "email", "number", "date", "boolean", "select"]);
/** The built-in dates every Entry has, which a query filters and sorts by. */
export const DATE_BUILT_INS = ["publishedAt", "lastPublishedAt", "createdAt", "updatedAt"] as const;
export const WINDOWS: readonly DateWindow[] = ["past", "future", "last", "next", "between"];
export const UNITS: readonly DateUnit[] = ["days", "weeks", "months", "years"];
export const STATUSES: readonly QueryStatus[] = ["published", "changed", "draft"];

/** At most this many sorts, as the server takes them (`QUERY_LIMITS.sort`). */
export const SORTS_MAX = 3;

/** A Field a query can read, at its path (`address.city`), with the words for it. */
export type QueryField = { path: string; label: string; field: FieldDefinition };

/** The Fields of the chosen Post Types a query can read: top-level and Groups' Fields (Repeaters' too, `withRows`). */
export function queryFields(postTypes: readonly QueryPostType[], withRows = false): QueryField[] {
	const found = new Map<string, QueryField>();
	const visit = (fields: readonly FieldDefinition[], path: string, label: string) => {
		for (const field of fields) {
			const here = `${path}${field.key}`;
			const named = label ? `${label} › ${field.label}` : field.label;
			if (field.type === "group" || (withRows && field.type === "repeater")) {
				visit(field.fields, `${here}.`, named);
			} else if (field.type !== "repeater" && !found.has(here)) {
				found.set(here, { path: here, label: named, field });
			}
		}
	};
	for (const postType of postTypes) visit(postType.fields, "", "");
	return [...found.values()];
}

/** What a query over `postTypes` (those of the Site it lists) can filter and sort by. */
export function queryReads(postTypes: readonly QueryPostType[], query: Pick<Query, "postTypes">) {
	const listed = postTypes.filter((postType) => query.postTypes.includes(postType.key));
	const fields = queryFields(listed);
	return {
		/** Fields a filter compares (those with an operator). */
		fields,
		filterable: fields.filter(({ field }) => (OPERATORS[field.type]?.length ?? 0) > 0),
		/** Relationship Fields, Repeaters' too. */
		relationships: queryFields(listed, true).filter(({ field }) => field.type === "relationship"),
		/** Date Fields that hold a day. */
		dates: fields.filter(({ field }) => field.type === "date" && field.mode !== "time"),
		/** Fields a sort orders by. */
		sortable: fields.filter(({ field }) => SORTABLE.has(field.type) && !(field.type === "select" && field.multiple)),
	};
}

/** A filter's first value for a Field: a number, true, the first choice, a day, or empty text. */
export function defaultValue(field: FieldDefinition): string | number | boolean | null {
	switch (field.type) {
		case "number":
			return 0;
		case "boolean":
			return true;
		case "select":
			return field.options[0]?.value ?? null;
		case "date":
			return "2026-01-01";
		default:
			return "";
	}
}

/** A filter on a Field (`chosen`), with the Field's first operator and value. */
export function fieldFilter(chosen: QueryField | undefined): Filter {
	return {
		type: "field",
		field: chosen?.path ?? "",
		operator: chosen ? (OPERATORS[chosen.field.type]?.[0] ?? "empty") : "empty",
		value: chosen ? defaultValue(chosen.field) : null,
	};
}

/** A new filter of a kind, about the first thing of that kind the query reads. */
export function filterOfType(
	type: Filter["type"],
	reads: { fields: readonly QueryField[]; relationships: readonly QueryField[] },
): Filter {
	switch (type) {
		case "field":
			return fieldFilter(reads.fields[0]);
		case "relationship":
			return { type: "relationship", field: reads.relationships[0]?.path ?? "", to: "current", entries: [] };
		case "date":
			return { type: "date", field: "publishedAt", window: "past", amount: null, unit: null, from: null, to: null };
		default:
			return { type: "status", statuses: ["published"] };
	}
}

/** The filter a new one starts as: about the first Field, else Published Entries. */
export function newFilter(fields: readonly QueryField[]): Filter {
	const [first] = fields;
	return first ? fieldFilter(first) : { type: "status", statuses: ["published"] };
}

/** A date filter with another window: N units for `last` and `next`, two days for `between`. */
export function withWindow(filter: Extract<Filter, { type: "date" }>, window: DateWindow): Filter {
	const counted = window === "last" || window === "next";
	return {
		...filter,
		window,
		amount: counted ? (filter.amount ?? 12) : null,
		unit: counted ? (filter.unit ?? "months") : null,
		from: window === "between" ? (filter.from ?? "2026-01-01") : null,
		to: window === "between" ? filter.to : null,
	};
}

/** Whether a Field filter's operator compares with a value (`empty` and `notEmpty` take none). */
export function takesValue(operator: FieldOperator): boolean {
	return operator !== "empty" && operator !== "notEmpty";
}

/** A control's id from where its setting is (`query.filters[1].value`), as problems name it. */
export function settingId(at: string, prefix = "loop"): string {
	return `${prefix}-${at.replace(/[^A-Za-z0-9]+/g, "-")}`;
}
