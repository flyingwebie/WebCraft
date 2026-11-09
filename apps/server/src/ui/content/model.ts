import type { ApiClient } from "@webcraft/api";
import type { FieldDefinition, Json } from "@webcraft/core";

/** A Post Type as the Management API answers it, with its Fields. */
export type PostTypeView = Awaited<ReturnType<ApiClient["postTypes"]["get"]>>["postType"];

/** An Entry as the Management API answers it: its Draft and published values in one language. */
export type EntryView = Awaited<ReturnType<ApiClient["entries"]["get"]>>["entry"];

/** The Site's Globals: their Fields, Draft and published values. */
export type GlobalsView = Awaited<ReturnType<ApiClient["globals"]["get"]>>["globals"];

/** A Loop as the Management API answers it: its Draft and published versions, its Loop items in one language. */
export type LoopView = Awaited<ReturnType<ApiClient["loops"]["get"]>>["loop"];

/** What keeps a Draft from being published (or a value from being saved), where it is. */
export type Problem = { at: string; message: string; rule?: string };

export type { FieldDefinition, Json };

/** Field values by key, as the API gives and takes them. */
export type FieldValues = Record<string, Json>;

/** A Repeater row as the API gives it: its id and its Fields' values. */
export type RowValue = { id: string } & FieldValues;

/**
 * A Field's empty value, as the API shows one: `false` for true/false, `[]` for a list (several
 * choices or Entries, a Repeater), a Group's Fields' empty values, null otherwise.
 */
export function emptyValue(field: FieldDefinition): Json {
	switch (field.type) {
		case "boolean":
			return false;
		case "select":
		case "relationship":
			return field.multiple ? [] : null;
		case "group":
			return Object.fromEntries(field.fields.map((inner) => [inner.key, emptyValue(inner)]));
		case "repeater":
			return [];
		default:
			return null;
	}
}

/** What a Field starts with in a new Entry or Repeater row: its default, or its empty value. */
export function startingValue(field: FieldDefinition): Json {
	if (field.type === "group") return Object.fromEntries(field.fields.map((inner) => [inner.key, startingValue(inner)]));
	return field.default ?? emptyValue(field);
}

/** A new Repeater row: a new id (the server keeps it) and its Fields' defaults. */
export function newRow(fields: readonly FieldDefinition[]): RowValue {
	return { id: crypto.randomUUID(), ...Object.fromEntries(fields.map((field) => [field.key, startingValue(field)])) };
}

/** A Field's value read as a Group's values (by key). */
export function groupValues(value: Json): FieldValues {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as FieldValues) : {};
}

/** A Field's value read as a Repeater's rows. */
export function rowsOf(value: Json): RowValue[] {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(row): row is RowValue =>
			Boolean(row) && typeof row === "object" && !Array.isArray(row) && typeof (row as FieldValues).id === "string",
	);
}

/** A DOM id for a value's control, from where it is (`fields.team[1].name`). */
export function controlId(prefix: string, path: string): string {
	return `${prefix}-${path.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
}

/** The problems at exactly this path. */
export function problemsAt(problems: readonly Problem[], path: string): Problem[] {
	return problems.filter((problem) => problem.at === path);
}

/** The problems at this path or anywhere inside it (a Group's Fields, a Repeater's rows). */
export function problemsWithin(problems: readonly Problem[], path: string): Problem[] {
	return problems.filter(
		(problem) => problem.at === path || problem.at.startsWith(`${path}.`) || problem.at.startsWith(`${path}[`),
	);
}

/**
 * The Field a value's path names (`fields.recipe.prep_minutes`, `fields.steps[1].text`), and where it
 * is in words: each Field's label, with the row number inside a Repeater.
 */
export function fieldAtPath(
	fields: readonly FieldDefinition[],
	path: string,
): { field: FieldDefinition; trail: { label: string; row?: number }[] } | null {
	const parts = path.replace(/^fields\./, "").match(/[^.[\]]+|\[\d+\]/g) ?? [];
	let list: readonly FieldDefinition[] = fields;
	let found: FieldDefinition | null = null;
	const trail: { label: string; row?: number }[] = [];
	for (const part of parts) {
		if (part.startsWith("[")) {
			const last = trail.at(-1);
			if (last) last.row = Number(part.slice(1, -1)) + 1;
			continue;
		}
		const next = list.find((field) => field.key === part);
		if (!next) return found ? { field: found, trail } : null;
		found = next;
		trail.push({ label: next.label });
		list = "fields" in next ? next.fields : [];
	}
	return found ? { field: found, trail } : null;
}
