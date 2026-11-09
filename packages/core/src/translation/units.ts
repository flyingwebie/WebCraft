import { type Block, blockSpec, richTextToText, storedBlocks } from "@webcraft/renderer";

import { type FieldDefinition, type Json, type LeafField, specOf, type ValueSpec } from "../content/field-types.ts";
import type { StoredValues } from "../content/field-values.ts";
import type { LanguageValue } from "../content/values.ts";
import { SEO_GROUP } from "../seo/entry-seo.ts";

/**
 * The values AI translation translates, found by walking an item's Fields: text, rich text, link and
 * Body fields that are Translatable, and an Entry's title and SEO title and description. Numbers,
 * dates, choices, Media, email addresses, Relationships and shared Fields are never sent; nor is a
 * link's address, an SEO canonical URL, an image or code.
 *
 * A unit is named by its place in the stored values: `title`, `summary`, `address.city`,
 * `team[r1].role` (a Repeater row by its id, which is the same in every language), `seo.title`.
 */

/** The kinds of value translated, and how: as text, as rich text's paragraphs, as a link's text, or Block by Block. */
export type UnitKind = "text" | "richText" | "link" | "body";

/** One translatable value of an item: where it is stored, what its Fields are called, its kind and its Field. */
export type Unit = { path: string; labels: string[]; kind: UnitKind; field: FieldDefinition };

/** A Translatable text Field, for the values that aren't a Post Type's Fields (an Entry's title, a Form's emails). */
export function textField(key: string, label: string): FieldDefinition {
	return {
		key,
		label,
		help: "",
		required: false,
		translatable: true,
		default: null,
		type: "text",
		minLength: null,
		maxLength: null,
		pattern: null,
	} as FieldDefinition;
}

/** An Entry's translatable values: its title, its Post Type's Fields, and its SEO title and description. */
export function entryFields(postType: { fields: readonly FieldDefinition[] }): FieldDefinition[] {
	return [
		textField("title", "Title"),
		...postType.fields,
		{ ...SEO_GROUP, fields: SEO_GROUP.fields.filter((field) => field.key === "title" || field.key === "description") },
	];
}

/** A value as it is stored for every language. */
export type StoredLeaf = Record<string, LanguageValue | undefined>;

const KINDS: Partial<Record<string, UnitKind>> = { text: "text", richText: "richText", link: "link", body: "body" };

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function rowsOf(node: unknown): { id: string; values: StoredValues }[] {
	const rows = record(node).rows;
	if (!Array.isArray(rows)) return [];
	return rows.flatMap((row) => {
		const { id, values } = record(row);
		return typeof id === "string" ? [{ id, values: record(values) }] : [];
	});
}

/** Every translatable value of `values`, through Groups and the Repeater rows it has. */
export function unitsOf(
	values: StoredValues,
	fields: readonly FieldDefinition[],
	at = "",
	labels: string[] = [],
): Unit[] {
	const units: Unit[] = [];
	for (const field of fields) {
		const path = `${at}${field.key}`;
		const named = [...labels, field.label];
		if (field.type === "group") {
			units.push(...unitsOf(record(record(values[field.key]).values), field.fields, `${path}.`, named));
		} else if (field.type === "repeater") {
			for (const row of rowsOf(values[field.key])) {
				units.push(...unitsOf(row.values, field.fields, `${path}[${row.id}].`, named));
			}
		} else {
			const kind = KINDS[field.type];
			if (kind && field.translatable) units.push({ path, labels: named, kind, field });
		}
	}
	return units;
}

type Step = { key: string; row?: string };

function steps(path: string): Step[] {
	return path.split(".").map((part) => {
		const match = /^([^[\]]+)\[([^[\]]+)\]$/.exec(part);
		return match ? { key: match[1] ?? part, row: match[2] } : { key: part };
	});
}

/** The stored value at a unit's place, for every language; undefined when there is none yet. */
export function leafAt(values: StoredValues, path: string): StoredLeaf | undefined {
	let current: StoredValues = values;
	const all = steps(path);
	for (const [index, step] of all.entries()) {
		const node = current[step.key];
		if (index === all.length - 1) return node === undefined ? undefined : (record(node) as StoredLeaf);
		if (step.row !== undefined) {
			const row = rowsOf(node).find((candidate) => candidate.id === step.row);
			if (!row) return undefined;
			current = row.values;
		} else {
			current = record(record(node).values);
		}
	}
	return undefined;
}

/** `values` with the stored value at a unit's place replaced; a Repeater row that is gone is left alone. */
export function withLeafAt(values: StoredValues, path: string, leaf: StoredLeaf): StoredValues {
	const all = steps(path);
	const write = (current: StoredValues, index: number): StoredValues => {
		const step = all[index];
		if (!step) return current;
		if (index === all.length - 1) return { ...current, [step.key]: leaf };
		const node = current[step.key];
		if (step.row !== undefined) {
			const rows = rowsOf(node);
			if (!rows.some((row) => row.id === step.row)) return current;
			return {
				...current,
				[step.key]: {
					...record(node),
					rows: rows.map((row) => (row.id === step.row ? { id: row.id, values: write(row.values, index + 1) } : row)),
				},
			};
		}
		return { ...current, [step.key]: { ...record(node), values: write(record(record(node).values), index + 1) } };
	};
	return write(values, 0);
}

/** A value's text as people read it, for the Translations screen and the Entry editor. */
export function readableText(kind: UnitKind, value: Json | undefined): string {
	if (value === undefined || value === null) return "";
	if (kind === "richText") return typeof value === "string" ? richTextToText(value) : "";
	if (kind === "link") return String(record(value).text ?? "");
	if (kind === "body") return storedBlocks(value).map(blockText).filter(Boolean).join("\n\n");
	return typeof value === "string" ? value : "";
}

/** A Block's text as people read it (or a Block's content without its id, as a translation's source keeps it). */
export function blockText(block: Block | Record<string, unknown>): string {
	const full = { id: "x", ...block } as Block;
	try {
		return blockSpec(full).texts(full).filter(Boolean).join("\n");
	} catch {
		return "";
	}
}

/** The API's name for a unit's place: an Entry's own values as they are, Fields under `fields.`. */
export function apiPath(path: string): string {
	return path === "title" || path.startsWith("seo.") ? path : `fields.${path}`;
}

/** A unit's place from the API's name for it. */
export function storedPath(path: string): string {
	return path.startsWith("fields.") ? path.slice("fields.".length) : path;
}

/** Whether a stored value breaks one of its Field's rules (a length, a pattern): such a translation is never published as it is. */
export function breaksRules(field: FieldDefinition, stored: Json): boolean {
	if (field.type === "group" || field.type === "repeater") return false;
	const spec = specOf(field).value as unknown as ValueSpec<LeafField> | undefined;
	if (!spec) return false;
	const value = spec.read(stored, field);
	return value !== null && spec.rules(value, field).length > 0;
}
