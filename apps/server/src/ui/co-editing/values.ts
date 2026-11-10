import { type Json as DocumentJson, sameValue } from "@webcraft/core/draft-document";

import type { FieldValues, Json } from "../content/model.ts";

/** What reading and writing values needs of a Field: its key, kind and whether it is Translatable. */
export type ValueField = {
	key: string;
	type: string;
	translatable: boolean;
	/** A Group's or Repeater's Fields. */
	fields?: readonly ValueField[];
	/** A select's or Relationship's: whether it holds a list. */
	multiple?: boolean;
};

type FieldDefinition = ValueField;

/**
 * The SEO fields every Entry has, kept like a Group of Fields under `seo` (as the server keeps them):
 * all Translatable but noindex, which is one value for every language.
 */
export const SEO_FIELD: ValueField = {
	key: "seo",
	type: "group",
	translatable: false,
	fields: [
		{ key: "title", type: "text", translatable: true },
		{ key: "description", type: "text", translatable: true },
		{ key: "canonical", type: "text", translatable: true },
		{ key: "image", type: "media", translatable: true },
		{ key: "noindex", type: "boolean", translatable: false },
	],
};

/**
 * An Entry's (or the Globals') values as the shared document holds them (ADR 0025): by key, each
 * leaf kept per language (`{ en: "Fresh bread", fr: "Pain frais" }`), a Group as `{ values }`, a
 * Repeater as `{ rows: [{ id, values }] }`. The editors read the values of one language from it, as
 * the API shows them (a Translatable field without its own value falls back to the Default language),
 * and write a change back into it the way a save takes values: a leaf in the language being written
 * (a shared Field's in the Default language), a Group's Fields by key, a Repeater's whole list of rows.
 * The server checks and saves what changed, as the person.
 */

export type DocumentValues = Record<string, DocumentJson>;

/** Where values are read and written: the language of the tab, and the Default language. */
export type ValueLanguages = { language: string; defaultLanguage: string };

type Node = Record<string, DocumentJson>;

function record(value: DocumentJson | undefined): Node | null {
	return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : null;
}

/** The values a Draft's document holds (`{ values }`). */
export function documentValues(draft: DocumentJson): DocumentValues {
	return record(record(draft)?.values) ?? {};
}

/** A leaf's value in a language: its own (for a Translatable field), else the Default language's. */
function readLeaf(node: DocumentJson | undefined, translatable: boolean, languages: ValueLanguages): Json {
	const kept = record(node) ?? {};
	const own = translatable ? kept[languages.language] : undefined;
	const value = own ?? kept[languages.defaultLanguage];
	return (value ?? null) as Json;
}

/** What a Field with no value shows, as the API gives it: false, an empty list, or null. */
function emptyOf(field: FieldDefinition): Json {
	if (field.type === "boolean") return false;
	if (field.type === "body") return [];
	if ((field.type === "select" || field.type === "relationship") && field.multiple) return [];
	return null;
}

/** The values of a list of Fields in a language, by key, as the API shows them. */
export function readFieldValues(
	values: DocumentValues,
	fields: readonly FieldDefinition[],
	languages: ValueLanguages,
): FieldValues {
	return Object.fromEntries(fields.map((field) => [field.key, readField(values[field.key], field, languages)]));
}

function readField(node: DocumentJson | undefined, field: FieldDefinition, languages: ValueLanguages): Json {
	if (field.type === "group") return readFieldValues(documentValues(node ?? null), field.fields ?? [], languages);
	if (field.type === "repeater") {
		return rowsOf(node).map((row) => ({ id: row.id, ...readFieldValues(row.values, field.fields ?? [], languages) }));
	}
	return readLeaf(node, field.translatable, languages) ?? emptyOf(field);
}

/** A built-in value kept per language (`title`, `slug`) in a language, falling back to the Default language. */
export function readBuiltIn(values: DocumentValues, key: string, languages: ValueLanguages): string {
	const value = readLeaf(values[key], true, languages);
	return typeof value === "string" ? value : "";
}

/** A shared built-in value (`parent`), kept in the Default language. */
export function readShared(values: DocumentValues, key: string, languages: ValueLanguages): Json {
	return readLeaf(values[key], false, languages);
}

type Row = { id: string; values: DocumentValues };

function rowsOf(node: DocumentJson | undefined): Row[] {
	const rows = record(node ?? null)?.rows;
	if (!Array.isArray(rows)) return [];
	return rows.flatMap((row) => {
		const own = record(row);
		return own && typeof own.id === "string" ? [{ id: own.id, values: documentValues(own) }] : [];
	});
}

/** Sets a leaf in a language (null or "" clears it). */
function writeLeaf(node: DocumentJson | undefined, value: Json, language: string): DocumentJson {
	const kept = { ...(record(node) ?? {}) };
	if (value === null || value === "") delete kept[language];
	else kept[language] = value as DocumentJson;
	return kept;
}

/** Writes a Field's value as a save takes it (see the file's comment). */
export function writeField(
	values: DocumentValues,
	field: FieldDefinition,
	value: Json,
	languages: ValueLanguages,
): DocumentValues {
	return { ...values, [field.key]: writeNode(values[field.key], field, value, languages) };
}

function writeNode(
	node: DocumentJson | undefined,
	field: FieldDefinition,
	value: Json,
	languages: ValueLanguages,
): DocumentJson {
	if (field.type === "group") {
		let inner = documentValues(node ?? null);
		const given = value && typeof value === "object" && !Array.isArray(value) ? value : null;
		for (const child of field.fields ?? []) {
			if (given === null) inner = writeField(inner, child, child.type === "repeater" ? [] : null, languages);
			else if (Object.hasOwn(given, child.key) && !shows(inner, child, given[child.key] ?? null, languages)) {
				inner = writeField(inner, child, given[child.key] ?? null, languages);
			}
		}
		return { values: inner };
	}
	if (field.type === "repeater") {
		const before = new Map(rowsOf(node).map((row) => [row.id, row]));
		const list = Array.isArray(value) ? value : [];
		return {
			rows: list.map((item) => {
				const given = item && typeof item === "object" && !Array.isArray(item) ? (item as Record<string, Json>) : {};
				const id = typeof given.id === "string" && given.id !== "" ? given.id : newRowId();
				const earlier = before.get(id);
				let inner = earlier?.values ?? {};
				for (const child of field.fields ?? []) {
					if (!Object.hasOwn(given, child.key)) continue;
					// What a row shows unchanged (a value falling back to the Default language) isn't written.
					if (earlier && shows(inner, child, given[child.key] ?? null, languages)) continue;
					inner = writeField(inner, child, given[child.key] ?? null, languages);
				}
				return { id, values: inner };
			}),
		};
	}
	return writeLeaf(node, value, field.translatable ? languages.language : languages.defaultLanguage);
}

/** Whether a Field already shows `value` in the language: writing it would change nothing people see. */
function shows(values: DocumentValues, field: FieldDefinition, value: Json, languages: ValueLanguages): boolean {
	return sameValue(readField(values[field.key], field, languages) as DocumentJson, value as DocumentJson);
}

/** Sets a built-in value kept per language (`title`, `slug`) in the language being written. */
export function writeBuiltIn(
	values: DocumentValues,
	key: string,
	value: string,
	languages: ValueLanguages,
): DocumentValues {
	return { ...values, [key]: writeLeaf(values[key], value, languages.language) };
}

/** Sets a shared built-in value (`parent`) in the Default language. */
export function writeShared(
	values: DocumentValues,
	key: string,
	value: Json,
	languages: ValueLanguages,
): DocumentValues {
	return { ...values, [key]: writeLeaf(values[key], value, languages.defaultLanguage) };
}

/** A new Repeater row's id, as the server makes them: letters and digits. */
export function newRowId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** What the Entry editor edits in one language: an Entry's built-in values, Fields and SEO fields. */
export type EntryFormValues = {
	title: string;
	slug: string;
	parentId: string | null;
	fields: FieldValues;
	seo: FieldValues;
};

/** A change the Entry editor makes, as `entries.saveDraft` takes one. */
export type EntryFormChange = {
	title?: string;
	slug?: string;
	parentId?: string | null;
	fields?: Record<string, Json>;
	seo?: Record<string, Json>;
};

/** An Entry's values in one language, read from its shared document. */
export function entryValuesIn(
	draft: DocumentJson,
	fields: readonly ValueField[],
	languages: ValueLanguages,
): EntryFormValues {
	const values = documentValues(draft);
	const parent = readShared(values, "parent", languages);
	return {
		title: readBuiltIn(values, "title", languages),
		slug: readBuiltIn(values, "slug", languages),
		parentId: typeof parent === "string" ? parent : null,
		fields: readFieldValues(values, fields, languages),
		seo: (readFieldValues(values, [SEO_FIELD], languages).seo ?? {}) as FieldValues,
	};
}

/** An Entry's shared document with a change written in, as the editor's person made it. */
export function withEntryChange(
	draft: DocumentJson,
	change: EntryFormChange,
	fields: readonly ValueField[],
	languages: ValueLanguages,
): DocumentJson {
	let values = documentValues(draft);
	if (change.title !== undefined) values = writeBuiltIn(values, "title", change.title, languages);
	if (change.slug !== undefined) values = writeBuiltIn(values, "slug", change.slug, languages);
	if (change.parentId !== undefined) values = writeShared(values, "parent", change.parentId, languages);
	for (const [key, value] of Object.entries(change.fields ?? {})) {
		const field = fields.find((candidate) => candidate.key === key);
		if (field) values = writeField(values, field, value, languages);
	}
	if (change.seo) values = writeField(values, SEO_FIELD, change.seo as Json, languages);
	return { ...(record(draft) ?? {}), values };
}

/** The Globals' shared document with Fields' values written in. */
export function withFieldValues(
	draft: DocumentJson,
	change: Record<string, Json>,
	fields: readonly ValueField[],
	languages: ValueLanguages,
): DocumentJson {
	let values = documentValues(draft);
	for (const [key, value] of Object.entries(change)) {
		const field = fields.find((candidate) => candidate.key === key);
		if (field) values = writeField(values, field, value, languages);
	}
	return { ...(record(draft) ?? {}), values };
}
