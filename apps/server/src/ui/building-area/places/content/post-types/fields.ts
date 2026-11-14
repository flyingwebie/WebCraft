import type { FieldDefinition, FieldInput } from "@webcraft/core";
import {
	FIELD_KEY,
	FIELD_TYPE_TRAITS,
	FIELD_TYPES,
	type FieldType,
	isContainerType,
	MAX_FIELD_DEPTH,
} from "@webcraft/core/field-rules";

import { keyFromLabel, newField } from "../../../../content/field-drafts.ts";

/**
 * The pure part of a Post Type's Fields in the Content place (SPEC 8, `places-content/03`): the Fields
 * as one indented list (those inside a Group or Repeater under it), found by their path of keys
 * (`seo.meta_title`), changed, moved among their siblings, added and removed. Every change answers
 * the whole list, which `postTypes.update` saves as it is (Structure has no Draft).
 */

export type { FieldDefinition, FieldType };

/** One row of the list: a Field, where it is, and how deep. */
export type FieldRow = {
	field: FieldDefinition;
	/** Its path of keys, `credits.writer` (unique: keys are unique among siblings). */
	path: string;
	/** 1 at the top. */
	depth: number;
	/** Its place among its siblings, from 0, and how many they are. */
	index: number;
	siblings: number;
	/** The Group or Repeater holding it; null at the top. */
	parent: string | null;
};

/** The Fields a Field holds (a Group's or a Repeater's), else none. */
export function innerFields(field: FieldDefinition): readonly FieldDefinition[] {
	return field.type === "group" || field.type === "repeater" ? field.fields : [];
}

/** Every Field as a row, in order, those inside a Group or Repeater right after it. */
export function rowsOf(fields: readonly FieldDefinition[], parent: string | null = null, depth = 1): FieldRow[] {
	return fields.flatMap((field, index) => {
		const path = parent === null ? field.key : `${parent}.${field.key}`;
		return [
			{ field, path, depth, index, siblings: fields.length, parent },
			...rowsOf(innerFields(field), path, depth + 1),
		];
	});
}

/** The Field at a path, if there is one. */
export function fieldAt(fields: readonly FieldDefinition[], path: string): FieldDefinition | null {
	return rowsOf(fields).find((row) => row.path === path)?.field ?? null;
}

/** The list holding the Fields at `parent` (null: the top), changed. */
function changeList(
	fields: readonly FieldDefinition[],
	parent: string | null,
	change: (list: FieldDefinition[]) => FieldDefinition[],
): FieldDefinition[] {
	if (parent === null) return change([...fields]);
	const [first, ...rest] = parent.split(".");
	return fields.map((field) => {
		if (field.key !== first || (field.type !== "group" && field.type !== "repeater")) return field;
		const inner = rest.length === 0 ? change([...field.fields]) : changeList(field.fields, rest.join("."), change);
		return { ...field, fields: inner };
	});
}

/** The parent part of a path (`credits` of `credits.writer`), null at the top, and the key. */
function split(path: string): { parent: string | null; key: string } {
	const at = path.lastIndexOf(".");
	return at < 0 ? { parent: null, key: path } : { parent: path.slice(0, at), key: path.slice(at + 1) };
}

/** The Fields with the one at `path` changed. */
export function replaceAt(
	fields: readonly FieldDefinition[],
	path: string,
	change: (field: FieldDefinition) => FieldDefinition,
): FieldDefinition[] {
	const { parent, key } = split(path);
	return changeList(fields, parent, (list) => list.map((field) => (field.key === key ? change(field) : field)));
}

/** The Fields without the one at `path` (and those inside it). */
export function removeAt(fields: readonly FieldDefinition[], path: string): FieldDefinition[] {
	const { parent, key } = split(path);
	return changeList(fields, parent, (list) => list.filter((field) => field.key !== key));
}

/** The Fields with the one at `path` moved to place `to` among its siblings (kept in range). */
export function moveTo(fields: readonly FieldDefinition[], path: string, to: number): FieldDefinition[] {
	const { parent, key } = split(path);
	return changeList(fields, parent, (list) => {
		const from = list.findIndex((field) => field.key === key);
		if (from < 0) return list;
		const [moved] = list.splice(from, 1);
		if (!moved) return list;
		list.splice(Math.max(0, Math.min(to, list.length)), 0, moved);
		return list;
	});
}

/** The Fields with `field` added at the end of the list at `parent` (null: the top). */
export function addTo(
	fields: readonly FieldDefinition[],
	parent: string | null,
	field: FieldDefinition,
): FieldDefinition[] {
	return changeList(fields, parent, (list) => [...list, field]);
}

/** The Fields as `postTypes.update` takes them: the full list, in order, as they are. */
export function inputsOf(fields: readonly FieldDefinition[]): FieldInput[] {
	return fields as unknown as FieldInput[];
}

/** A key not taken among `taken`, made from a label: `Cover image` gives `cover_image`, then `cover_image_2`. */
export function freeKey(label: string, taken: readonly string[]): string {
	const stem = keyFromLabel(label) || "field";
	const used = new Set(taken.map((key) => key.toLowerCase()));
	for (let attempt = 1; ; attempt++) {
		const key = attempt === 1 ? stem : `${stem}_${attempt}`.slice(0, 64);
		if (!used.has(key.toLowerCase())) return key;
	}
}

/** Whether a key can be a Field's: a lower-case letter, then letters, digits and underscores (64 at most). */
export function isFieldKey(key: string): boolean {
	return FIELD_KEY.test(key);
}

/** The keys of the Fields at `parent` (null: the top). */
export function keysAt(fields: readonly FieldDefinition[], parent: string | null): string[] {
	const list = parent === null ? fields : innerFields(fieldAt(fields, parent) ?? ({ type: "text" } as FieldDefinition));
	return list.map((field) => field.key);
}

/** How deep the Field at `path` is: 1 at the top. */
export function depthOf(path: string): number {
	return path.split(".").length;
}

/**
 * The kinds a new Field can be inside `parent` (null: the top): Pages have no Body field, a Post Type
 * has one at most and only among its own Fields, and Groups and Repeaters nest at most 3 deep.
 */
export function offeredKinds(fields: readonly FieldDefinition[], parent: string | null, pages: boolean): FieldType[] {
	const depth = parent === null ? 1 : depthOf(parent) + 1;
	const hasBody = rowsOf(fields).some((row) => row.field.type === "body");
	return FIELD_TYPES.filter(
		(type) =>
			!(isContainerType(type) && depth >= MAX_FIELD_DEPTH) && !(type === "body" && (pages || depth > 1 || hasBody)),
	);
}

/** Whether a Field of this kind at this depth may hold more Fields. */
export function holdsFields(field: FieldDefinition, path: string): boolean {
	return isContainerType(field.type) && depthOf(path) < MAX_FIELD_DEPTH;
}

/** Whether a Field of this kind can be required, and whether it can be translatable. */
export function traitsOf(type: FieldType): { requirable: boolean; translatable: boolean } {
	const traits = FIELD_TYPE_TRAITS[type];
	return { requirable: traits.requirable, translatable: traits.translation !== "never" };
}

/**
 * A new Field of a kind, every setting at its default. A Group or Repeater holds at least one Field,
 * so it starts with a text Field labelled `inner`.
 */
export function made(type: FieldType, key: string, label: string, inner: string): FieldDefinition {
	const field = newField(type, key, label);
	if (field.type === "group" || field.type === "repeater")
		return { ...field, fields: [newField("text", freeKey(inner, []), inner)] };
	return field;
}

/**
 * Where a problem the server answered is: `fields[2].fields[0].label` is the setting `label` of the
 * first Field inside the third, read against the Fields as they were sent. Null `path` for a
 * problem about the Post Type itself (`name`, `urlPattern`) or the list (`fields`).
 */
export function problemPlace(fields: readonly FieldDefinition[], at: string): { path: string | null; setting: string } {
	let list: readonly FieldDefinition[] = fields;
	let rest = at;
	let path: string | null = null;
	for (;;) {
		const match = /^fields\[(\d+)\](?:\.(.*))?$/.exec(rest);
		const next = match ? list[Number(match[1])] : undefined;
		if (!match || !next) break;
		path = path === null ? next.key : `${path}.${next.key}`;
		list = innerFields(next);
		rest = match[2] ?? "";
	}
	return { path, setting: rest };
}
