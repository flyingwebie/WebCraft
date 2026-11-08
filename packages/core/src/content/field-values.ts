import type { ContentProblem } from "./errors.ts";
import {
	type FieldDefinition,
	type GroupField,
	type Json,
	type LeafField,
	MAX_ROWS,
	type Reference,
	type RepeaterField,
	specOf,
	type ValueSpec,
} from "./field-types.ts";
import { sameJson } from "./json.ts";
import type { LanguageValue, Writer } from "./values.ts";

/**
 * Field values inside one version of an Entry (or of the Globals), walked through the Field
 * definitions. Every leaf Field keeps its values per language (ADR 0003): a Translatable field one
 * per language, a shared Field one under the Default language, each with who wrote it. Groups and
 * Repeaters hold no language themselves: a Group keeps its Fields' values, a Repeater an ordered list
 * of rows, each with a stable id and its Fields' values. So rows are the same in every language, and
 * each Field in them falls back to the Default language one at a time.
 *
 *     { values: {
 *         summary: { en: { value: "Crusty", by }, it: { value: "Croccante", by } },
 *         address: { values: { city: { en: { value: "Dublin", by } } } },
 *         team: { rows: [{ id: "r1", values: { name: { en: { value: "Ada", by } } } }] },
 *     } }
 */

/** Values by Field key, as stored. */
export type StoredValues = Record<string, unknown>;

type StoredLeaf = Record<string, LanguageValue>;
type StoredGroup = { values: StoredValues };
type StoredRow = { id: string; values: StoredValues };

/** The language values are read or written in, and the Default language they fall back to. */
export type Languages = { language: string; defaultLanguage: string };

/** A Repeater row's id: 1 to 64 letters, digits, dashes and underscores. */
const ROW_ID = /^[A-Za-z0-9_-]{1,64}$/;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function groupOf(node: unknown): StoredGroup {
	return { values: record(record(node).values) };
}

function rowsOf(node: unknown): StoredRow[] {
	const rows = record(node).rows;
	if (!Array.isArray(rows)) return [];
	return rows.flatMap((row) => {
		const { id, values } = record(row);
		return typeof id === "string" ? [{ id, values: record(values) }] : [];
	});
}

/** The stored value of a leaf Field in a language, falling back to the Default language for a Translatable field. */
function pick(node: unknown, field: FieldDefinition, languages: Languages): unknown {
	const byLanguage = record(node) as StoredLeaf;
	const own = field.translatable ? byLanguage[languages.language] : undefined;
	return (own ?? byLanguage[languages.defaultLanguage])?.value;
}

function leafSpec(field: LeafField): ValueSpec<LeafField> {
	return specOf(field).value as unknown as ValueSpec<LeafField>;
}

/** Reads a leaf value, empty when there is none: what the API shows. */
function readLeaf(node: unknown, field: LeafField, languages: Languages): Json {
	const spec = leafSpec(field);
	const stored = pick(node, field, languages);
	const value = stored === undefined ? null : spec.read(stored, field);
	return value ?? spec.empty(field);
}

// ---------------------------------------------------------------------------------------------------
// Reading

/** The values of a list of Fields in a language, by key, as the APIs show them. */
export function readFields(
	values: StoredValues,
	fields: readonly FieldDefinition[],
	languages: Languages,
): Record<string, Json> {
	return Object.fromEntries(fields.map((field) => [field.key, readField(values[field.key], field, languages)]));
}

function readField(node: unknown, field: FieldDefinition, languages: Languages): Json {
	if (field.type === "group") return readFields(groupOf(node).values, field.fields, languages);
	if (field.type === "repeater") {
		return rowsOf(node).map((row) => ({ id: row.id, ...readFields(row.values, field.fields, languages) }));
	}
	return readLeaf(node, field, languages);
}

// ---------------------------------------------------------------------------------------------------
// Writing

/** What writing values needs: the language, who writes, and where problems and references go. */
export type WriteContext = Languages & {
	by: Writer;
	/** Values of the wrong kind; the save is refused when there are any. */
	problems: ContentProblem[];
	/** Entries the values point at, to check against the Site before saving. */
	references: (Reference & { at: string })[];
	/** A new Repeater row's id. */
	newRowId(): string;
};

/**
 * Writes the values given into `values`, by key: a leaf's value in the context's language (a shared
 * Field's under the Default language), null or "" clearing it; a Group's values by key, as here; a
 * Repeater's rows as a whole list (see `writeRows`). Values of the wrong kind are reported at their
 * path (`fields.team[1].name`) and leave the value as it was.
 */
export function writeFields(
	values: StoredValues,
	fields: readonly FieldDefinition[],
	input: Record<string, unknown>,
	context: WriteContext,
	at: string,
	describe: string,
): StoredValues {
	const written = { ...values };
	for (const [key, value] of Object.entries(input)) {
		const field = fields.find((candidate) => candidate.key === key);
		if (!field) {
			context.problems.push({ at: `${at}${key}`, message: `${describe} has no Field ${key}.` });
			continue;
		}
		written[key] = writeField(written[key], field, value, context, `${at}${key}`);
	}
	return written;
}

function writeField(node: unknown, field: FieldDefinition, input: unknown, context: WriteContext, at: string): unknown {
	if (field.type === "group") {
		if (input === null) return clearGroup(groupOf(node), field, context);
		if (typeof input !== "object" || Array.isArray(input)) {
			context.problems.push({ at, message: "A Group's value is its Fields' values, by key." });
			return node;
		}
		const group = groupOf(node);
		return {
			values: writeFields(group.values, field.fields, input as Record<string, unknown>, context, `${at}.`, field.label),
		};
	}
	if (field.type === "repeater") return writeRows(node, field, input, context, at);
	const spec = leafSpec(field);
	let refused = false;
	const value =
		input === null || input === ""
			? null
			: spec.parse(
					input,
					field,
					(message) => {
						refused = true;
						context.problems.push({ at, message });
						return null;
					},
					(reference) => context.references.push({ ...reference, at }),
				);
	return refused ? node : writeLeaf(node, field, value, context);
}

function writeLeaf(
	node: unknown,
	field: FieldDefinition,
	value: Json,
	context: Languages & { by: Writer },
): StoredLeaf {
	const language = field.translatable ? context.language : context.defaultLanguage;
	const byLanguage = { ...(record(node) as StoredLeaf) };
	if (value === null) delete byLanguage[language];
	else if (!sameJson(byLanguage[language]?.value, value)) byLanguage[language] = { value, by: context.by };
	return byLanguage;
}

function clearGroup(group: StoredGroup, field: GroupField, context: WriteContext): StoredGroup {
	const values = { ...group.values };
	for (const inner of field.fields) {
		if (inner.type === "group") values[inner.key] = clearGroup(groupOf(values[inner.key]), inner, context);
		else if (inner.type === "repeater") values[inner.key] = { rows: [] };
		else values[inner.key] = writeLeaf(values[inner.key], inner, null, context);
	}
	return { values };
}

/**
 * Writes a Repeater's rows: the list given is the new list, in order. A row with the id of a row it
 * had keeps that row (and its values in other languages), changing only the values given; a row
 * without an id, or with a new one, is a new row and starts with the Fields' defaults. Rows left out
 * are removed, in every language.
 */
function writeRows(node: unknown, field: RepeaterField, input: unknown, context: WriteContext, at: string): unknown {
	if (input === null) return { rows: [] };
	if (!Array.isArray(input)) {
		context.problems.push({ at, message: "A Repeater's value is a list of rows." });
		return node;
	}
	if (input.length > MAX_ROWS) {
		context.problems.push({ at, message: `A Repeater holds at most ${MAX_ROWS} rows.` });
		return node;
	}
	const before = new Map(rowsOf(node).map((row) => [row.id, row]));
	const ids = new Set<string>();
	const rows: StoredRow[] = [];
	input.forEach((item: unknown, index) => {
		const here = `${at}[${index}]`;
		if (!item || typeof item !== "object" || Array.isArray(item)) {
			context.problems.push({ at: here, message: "A row is its Fields' values, by key." });
			return;
		}
		const { id: givenId, ...values } = item as Record<string, unknown>;
		if (givenId !== undefined && (typeof givenId !== "string" || !ROW_ID.test(givenId))) {
			context.problems.push({
				at: `${here}.id`,
				message: "A row id is 1 to 64 letters, digits, dashes and underscores.",
			});
			return;
		}
		const id = (givenId as string | undefined) ?? context.newRowId();
		if (ids.has(id)) {
			context.problems.push({ at: `${here}.id`, message: `Two rows have the id ${id}.` });
			return;
		}
		ids.add(id);
		const start = before.get(id)?.values ?? defaultValues(field.fields, context);
		rows.push({ id, values: writeFields(start, field.fields, values, context, `${here}.`, field.label) });
	});
	return { rows };
}

/** The defaults of a list of Fields, as stored values: a new Entry's (or a new row's) starting values. */
export function defaultValues(
	fields: readonly FieldDefinition[],
	context: Languages & { by: Writer; newRowId?(): string },
): StoredValues {
	const values: StoredValues = {};
	for (const field of fields) {
		if (field.type === "group") values[field.key] = { values: defaultValues(field.fields, context) };
		else if (field.type !== "repeater" && field.default !== null) {
			values[field.key] = writeLeaf(undefined, field, field.default as Json, context);
		}
	}
	return values;
}

// ---------------------------------------------------------------------------------------------------
// Checking

/** What checking a version found: the rules values break, and the required Fields that are empty. */
export type Findings = {
	/** Everything that keeps the version from being published, in Field order, with its rule. */
	problems: (ContentProblem & { rule: string })[];
	/** The paths of empty required Fields, without the `fields.` prefix (`price`, `team[0].name`). */
	missing: string[];
	/** Entries values point at, to check against the Site (a Relationship's Post Types may have changed). */
	references: (Reference & { at: string; problems: ContentProblem[] })[];
};

/**
 * Checks every value of a list of Fields in a language against its Field's rules and `required`:
 * what publishing needs. A Group is required when one of its Fields must have a value, and the
 * required Fields inside an optional Group count only once it has a value; every row of a Repeater
 * is checked.
 */
export function checkFields(
	values: StoredValues,
	fields: readonly FieldDefinition[],
	languages: Languages,
	findings: Findings,
	at = "fields.",
): void {
	for (const field of fields) {
		const node = values[field.key];
		const path = `${at}${field.key}`;
		const missing = () => {
			findings.problems.push({ at: path, rule: "required", message: `${field.label} needs a value.` });
			findings.missing.push(path.replace(/^fields\./, ""));
		};
		if (field.type === "group") {
			const group = groupOf(node);
			if (isEmpty(group.values, field.fields, languages)) {
				if (field.required) missing();
				continue;
			}
			checkFields(group.values, field.fields, languages, findings, `${path}.`);
			continue;
		}
		if (field.type === "repeater") {
			const rows = rowsOf(node);
			if (rows.length === 0) {
				if (field.required) missing();
				continue;
			}
			if (field.min !== null && rows.length < field.min) {
				findings.problems.push({ at: path, rule: "min", message: `At least ${field.min} rows.` });
			}
			if (field.max !== null && rows.length > field.max) {
				findings.problems.push({ at: path, rule: "max", message: `At most ${field.max} rows.` });
			}
			rows.forEach((row, index) => {
				checkFields(row.values, field.fields, languages, findings, `${path}[${index}].`);
			});
			continue;
		}
		const spec = leafSpec(field);
		const value = readLeaf(node, field, languages);
		if (spec.isEmpty ? spec.isEmpty(value) : value === null) {
			if (field.required) missing();
			continue;
		}
		for (const broken of spec.rules(value, field)) findings.problems.push({ at: path, ...broken });
		if (field.type === "relationship") {
			const ids = (Array.isArray(value) ? value : [value]).filter((id): id is string => typeof id === "string");
			findings.references.push({
				kind: "entries",
				ids,
				postTypes: field.postTypes,
				at: path,
				problems: findings.problems,
			});
		}
		if (field.type === "media" && typeof value === "string") {
			findings.references.push({ kind: "media", ids: [value], at: path, problems: findings.problems });
		}
	}
}

/** Whether every Field of a list is empty in a language. */
function isEmpty(values: StoredValues, fields: readonly FieldDefinition[], languages: Languages): boolean {
	return fields.every((field) => {
		const node = values[field.key];
		if (field.type === "group") return isEmpty(groupOf(node).values, field.fields, languages);
		if (field.type === "repeater") return rowsOf(node).length === 0;
		const spec = leafSpec(field);
		const value = readLeaf(node, field, languages);
		return field.type === "boolean"
			? pick(node, field, languages) === undefined
			: spec.isEmpty
				? spec.isEmpty(value)
				: value === null;
	});
}

// ---------------------------------------------------------------------------------------------------
// Relationships

/** One link a Relationship value makes: the Relationship Field's definition path, and the Entry it points at. */
export type Link = { field: string; targetId: string };

/** Every link the values make, in every language, through Groups and Repeaters. */
export function linksIn(values: StoredValues, fields: readonly FieldDefinition[], at = ""): Link[] {
	const links: Link[] = [];
	for (const field of fields) {
		const node = values[field.key];
		const path = `${at}${field.key}`;
		if (field.type === "group") links.push(...linksIn(groupOf(node).values, field.fields, `${path}.`));
		else if (field.type === "repeater") {
			for (const row of rowsOf(node)) links.push(...linksIn(row.values, field.fields, `${path}.`));
		} else if (field.type === "relationship") {
			for (const entry of Object.values(record(node) as StoredLeaf)) {
				const ids = Array.isArray(entry?.value) ? entry.value : [entry?.value];
				for (const id of ids) if (typeof id === "string") links.push({ field: path, targetId: id });
			}
		}
	}
	const seen = new Set<string>();
	return links.filter((link) => {
		const key = `${link.field} ${link.targetId}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/** The values without any link to `entryId`: what deleting that Entry leaves behind. */
export function withoutLinksTo(
	values: StoredValues,
	fields: readonly FieldDefinition[],
	entryId: string,
): StoredValues {
	const changed = { ...values };
	for (const field of fields) {
		const node = changed[field.key];
		if (node === undefined) continue;
		if (field.type === "group") {
			changed[field.key] = { values: withoutLinksTo(groupOf(node).values, field.fields, entryId) };
		} else if (field.type === "repeater") {
			changed[field.key] = {
				rows: rowsOf(node).map((row) => ({ id: row.id, values: withoutLinksTo(row.values, field.fields, entryId) })),
			};
		} else if (field.type === "relationship") {
			const byLanguage: StoredLeaf = {};
			for (const [language, entry] of Object.entries(record(node) as StoredLeaf)) {
				if (Array.isArray(entry?.value)) {
					const kept = entry.value.filter((id) => id !== entryId);
					if (kept.length > 0)
						byLanguage[language] = kept.length === entry.value.length ? entry : { ...entry, value: kept };
				} else if (entry?.value !== entryId) {
					byLanguage[language] = entry;
				}
			}
			changed[field.key] = byLanguage;
		}
	}
	return changed;
}

/** A new Repeater row's id: 12 random letters and digits. */
export function randomRowId(): string {
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => alphabet[byte % alphabet.length]).join("");
}
