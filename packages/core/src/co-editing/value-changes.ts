import type { ContentProblem } from "../content/errors.ts";
import type { FieldDefinition, RepeaterField } from "../content/field-types.ts";
import { type Json, sameValue } from "./document.ts";

type Node = Record<string, Json>;

export function record(value: Json | undefined): Node | null {
	return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function valuesOf(view: Json): Node {
	return record(record(view)?.values) ?? {};
}

/** Changes by language: what each language's save is given. */
type ByLanguage = Map<string, Record<string, unknown>>;

function inLanguage(out: ByLanguage, language: string): Record<string, unknown> {
	let change = out.get(language);
	if (!change) {
		change = {};
		out.set(language, change);
	}
	return change;
}

/** The languages in the order their saves run: the Default language first, so new rows start there. */
export function inOrder(out: ByLanguage, defaultLanguage: string): string[] {
	return [...out.keys()].sort((a, b) => (a === defaultLanguage ? -1 : b === defaultLanguage ? 1 : a.localeCompare(b)));
}

type ChangeContext = { defaultLanguage: string; problems: ContentProblem[] };

/**
 * The values someone changed among `fields`, by language, as the saves take them: a leaf's value
 * (null clearing it), a Group's changed Fields by key, a Repeater's whole list of rows (each row with
 * its id and the values changed in that language).
 */
export function valueChanges(
	before: Node,
	after: Node,
	fields: readonly FieldDefinition[],
	context: ChangeContext,
	at: string,
) {
	const out: ByLanguage = new Map();
	for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
		if (sameValue(before[key] ?? null, after[key] ?? null)) continue;
		const field = fields.find((candidate) => candidate.key === key);
		if (!field) {
			context.problems.push({ at: `${at}${key}`, message: `There is no Field ${key}.` });
			continue;
		}
		for (const [language, value] of fieldChanges(before[key], after[key], field, context, `${at}${key}`)) {
			inLanguage(out, language)[key] = value;
		}
	}
	return out;
}

export function fieldChanges(
	before: Json | undefined,
	after: Json | undefined,
	field: FieldDefinition,
	context: ChangeContext,
	at: string,
): Map<string, unknown> {
	const changes = new Map<string, unknown>();
	if (field.type === "group") {
		const inner = valueChanges(valuesOf(before ?? null), valuesOf(after ?? null), field.fields, context, `${at}.`);
		for (const [language, value] of inner) changes.set(language, value);
		return changes;
	}
	if (field.type === "repeater") return rowChanges(before, after, field, context, at);
	const was = record(before ?? null) ?? {};
	const now = record(after ?? null) ?? {};
	for (const language of new Set([...Object.keys(was), ...Object.keys(now)])) {
		if (sameValue(was[language] ?? null, now[language] ?? null)) continue;
		if (!field.translatable && language !== context.defaultLanguage) {
			context.problems.push({ at, message: "A shared value is kept in the Default language." });
			continue;
		}
		changes.set(language, now[language] ?? null);
	}
	return changes;
}

type RowView = { id: string; values: Node };

function rowsOf(node: Json | undefined): RowView[] {
	const rows = record(node ?? null)?.rows;
	if (!Array.isArray(rows)) return [];
	return rows.flatMap((row) => {
		const own = record(row);
		return own && typeof own.id === "string" ? [{ id: own.id, values: valuesOf(own) }] : [];
	});
}

/** A Repeater's rows, in each language a row changed in: the whole list, each row with what changed there. */
function rowChanges(
	before: Json | undefined,
	after: Json | undefined,
	field: RepeaterField,
	context: ChangeContext,
	at: string,
): Map<string, unknown> {
	const was = rowsOf(before);
	const now = rowsOf(after);
	const known = new Map(was.map((row) => [row.id, row]));
	const languages = new Set<string>();
	const changed = new Map<string, ByLanguage>();
	const added = new Set<string>();
	now.forEach((row, index) => {
		const earlier = known.get(row.id);
		if (!earlier) {
			added.add(row.id);
			for (const language of languagesIn(row.values)) languages.add(language);
			return;
		}
		const inner = valueChanges(earlier.values, row.values, field.fields, context, `${at}[${index}].`);
		changed.set(row.id, inner);
		for (const language of inner.keys()) languages.add(language);
	});
	const moved = was.length !== now.length || was.some((row, index) => now[index]?.id !== row.id);
	if (moved || added.size > 0 || (record(after ?? null) === null) !== (record(before ?? null) === null)) {
		languages.add(context.defaultLanguage);
	}
	const changes = new Map<string, unknown>();
	for (const language of languages) {
		changes.set(
			language,
			now.map((row) => ({
				id: row.id,
				...(added.has(row.id)
					? ownValues(row.values, field.fields, language, context.defaultLanguage)
					: (changed.get(row.id)?.get(language) ?? {})),
			})),
		);
	}
	return changes;
}

/** Every language a row's values are kept in. */
function languagesIn(values: Node): Set<string> {
	const found = new Set<string>();
	const walk = (node: Json | undefined) => {
		const own = record(node ?? null);
		if (!own) return;
		if (Array.isArray(own.rows))
			for (const row of rowsOf(own)) for (const child of Object.values(row.values)) walk(child);
		else if (record(own.values ?? null)) for (const child of Object.values(valuesOf(own))) walk(child);
		else for (const language of Object.keys(own)) found.add(language);
	};
	for (const child of Object.values(values)) walk(child);
	return found;
}

/** A new row's own values in a language, as a save takes them (shared values in the Default language only). */
function ownValues(
	values: Node,
	fields: readonly FieldDefinition[],
	language: string,
	defaultLanguage: string,
): Record<string, unknown> {
	const own: Record<string, unknown> = {};
	for (const field of fields) {
		const node = values[field.key];
		if (node === undefined) continue;
		if (field.type === "group") {
			own[field.key] = ownValues(valuesOf(node), field.fields, language, defaultLanguage);
		} else if (field.type === "repeater") {
			own[field.key] = rowsOf(node).map((row) => ({
				id: row.id,
				...ownValues(row.values, field.fields, language, defaultLanguage),
			}));
		} else {
			const kept = record(node) ?? {};
			const place = field.translatable ? language : defaultLanguage;
			if (!field.translatable && language !== defaultLanguage) continue;
			if (Object.hasOwn(kept, place)) own[field.key] = kept[place];
		}
	}
	return own;
}
