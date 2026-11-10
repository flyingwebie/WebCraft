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
import { personValue } from "./translation-sources.ts";
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
/** A Repeater's row (or a Loop item), as stored: its id and its Fields' values in every language. */
export type StoredRow = { id: string; values: StoredValues };

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

/** A Repeater's rows (or a Loop's items) as stored, from its stored value. */
export function rowsOf(node: unknown): StoredRow[] {
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

/**
 * Calls the handler for the Field's kind. The one place that tells Groups, Repeaters and leaf Fields
 * apart: every walk over values gives a handler for each, so a new kind can't be missed.
 */
function byKind<Result>(
	field: FieldDefinition,
	handlers: {
		group(field: GroupField): Result;
		repeater(field: RepeaterField): Result;
		leaf(field: LeafField): Result;
	},
): Result {
	if (field.type === "group") return handlers.group(field);
	if (field.type === "repeater") return handlers.repeater(field);
	return handlers.leaf(field);
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
	return byKind<Json>(field, {
		group: (group) => readFields(groupOf(node).values, group.fields, languages),
		repeater: (repeater) =>
			rowsOf(node).map((row) => ({ id: row.id, ...readFields(row.values, repeater.fields, languages) })),
		leaf: (leaf) => readLeaf(node, leaf, languages),
	});
}

/**
 * Languages to read values in, in order: the language asked for, then each one a missing value falls
 * back to (the Content API's `fallback`). A shared Field's value is always the one kept under the
 * Default language.
 */
export type LanguageChain = { languages: readonly string[]; defaultLanguage: string };

/**
 * The values of a list of Fields read through a chain of languages, by key, as the APIs show them:
 * each Translatable leaf's value in the first language of the chain that has one, one Field at a
 * time (ADR 0003), and each shared Field's own. `fellBack` hears each value read from a language
 * other than the first, with its path (`summary`, `address.city`, `team[0].name`).
 */
export function readFieldsThrough(
	values: StoredValues,
	fields: readonly FieldDefinition[],
	chain: LanguageChain,
	fellBack: (path: string, language: string) => void = () => {},
	at = "",
): Record<string, Json> {
	return Object.fromEntries(
		fields.map((field) => {
			const path = `${at}${field.key}`;
			const node = values[field.key];
			const read = byKind<Json>(field, {
				group: (group) => readFieldsThrough(groupOf(node).values, group.fields, chain, fellBack, `${path}.`),
				repeater: (repeater) =>
					rowsOf(node).map((row, index) => ({
						id: row.id,
						...readFieldsThrough(row.values, repeater.fields, chain, fellBack, `${path}[${index}].`),
					})),
				leaf: (leaf) => {
					const spec = leafSpec(leaf);
					const byLanguage = record(node) as StoredLeaf;
					const language = leaf.translatable
						? chain.languages.find((code) => byLanguage[code] !== undefined)
						: chain.defaultLanguage;
					const stored = language === undefined ? undefined : byLanguage[language]?.value;
					const value = stored === undefined ? null : spec.read(stored, leaf);
					if (value !== null && leaf.translatable && language !== undefined && language !== chain.languages[0]) {
						fellBack(path, language);
					}
					return value ?? spec.empty(leaf);
				},
			});
			return [field.key, read];
		}),
	);
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
	return byKind<unknown>(field, {
		group: (group) => writeGroup(node, group, input, context, at),
		repeater: (repeater) => writeRows(node, repeater, input, context, at),
		leaf: (leaf) => writeLeafInput(node, leaf, input, context, at),
	});
}

function writeGroup(node: unknown, field: GroupField, input: unknown, context: WriteContext, at: string): unknown {
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

function writeLeafInput(node: unknown, field: LeafField, input: unknown, context: WriteContext, at: string): unknown {
	const spec = leafSpec(field);
	const language = field.translatable ? context.language : context.defaultLanguage;
	const previous = (record(node) as StoredLeaf)[language]?.value as Json | undefined;
	let refused = false;
	const value =
		input === null || input === ""
			? null
			: spec.parse(
					input,
					field,
					(message, within = "") => {
						refused = true;
						context.problems.push({ at: `${at}${within}`, message });
						return null;
					},
					(reference) => context.references.push({ ...reference, at }),
					previous,
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
	else if (!sameJson(byLanguage[language]?.value, value)) {
		byLanguage[language] = personValue(byLanguage, { ...context, language }, field.type, value, context.by);
	}
	return byLanguage;
}

function clearGroup(group: StoredGroup, field: GroupField, context: WriteContext): StoredGroup {
	const values = { ...group.values };
	for (const inner of field.fields) {
		values[inner.key] = byKind<unknown>(inner, {
			group: (group) => clearGroup(groupOf(values[inner.key]), group, context),
			repeater: () => ({ rows: [] }),
			leaf: (leaf) => writeLeaf(values[inner.key], leaf, null, context),
		});
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
		const value = byKind<unknown>(field, {
			group: (group) => ({ values: defaultValues(group.fields, context) }),
			// A Repeater starts with no rows; its rows start with their Fields' defaults.
			repeater: () => undefined,
			leaf: (leaf) => (leaf.default === null ? undefined : writeLeaf(undefined, leaf, leaf.default as Json, context)),
		});
		if (value !== undefined) values[field.key] = value;
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
		byKind<void>(field, {
			group: (group) => {
				const stored = groupOf(node);
				if (isEmpty(stored.values, group.fields, languages)) {
					if (group.required) missing();
					return;
				}
				checkFields(stored.values, group.fields, languages, findings, `${path}.`);
			},
			repeater: (repeater) => {
				const rows = rowsOf(node);
				if (rows.length === 0) {
					if (repeater.required) missing();
					return;
				}
				if (repeater.min !== null && rows.length < repeater.min) {
					findings.problems.push({ at: path, rule: "min", message: `At least ${repeater.min} rows.` });
				}
				if (repeater.max !== null && rows.length > repeater.max) {
					findings.problems.push({ at: path, rule: "max", message: `At most ${repeater.max} rows.` });
				}
				rows.forEach((row, index) => {
					checkFields(row.values, repeater.fields, languages, findings, `${path}[${index}].`);
				});
			},
			leaf: (leaf) => checkLeaf(node, leaf, languages, findings, path, missing),
		});
	}
}

function checkLeaf(
	node: unknown,
	field: LeafField,
	languages: Languages,
	findings: Findings,
	path: string,
	missing: () => void,
): void {
	const spec = leafSpec(field);
	const value = readLeaf(node, field, languages);
	if (spec.isEmpty ? spec.isEmpty(value) : value === null) {
		if (field.required) missing();
		return;
	}
	for (const { within = "", ...broken } of spec.rules(value, field)) {
		findings.problems.push({ at: `${path}${within}`, ...broken });
	}
	for (const { within, ...reference } of spec.references?.(value, field) ?? []) {
		findings.references.push({ ...reference, at: `${path}${within}`, problems: findings.problems });
	}
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

/** Whether every Field of a list is empty in a language. */
function isEmpty(values: StoredValues, fields: readonly FieldDefinition[], languages: Languages): boolean {
	return fields.every((field) => {
		const node = values[field.key];
		return byKind(field, {
			group: (group) => isEmpty(groupOf(node).values, group.fields, languages),
			repeater: () => rowsOf(node).length === 0,
			leaf: (leaf) => {
				if (leaf.type === "boolean") return pick(node, leaf, languages) === undefined;
				const spec = leafSpec(leaf);
				const value = readLeaf(node, leaf, languages);
				return spec.isEmpty ? spec.isEmpty(value) : value === null;
			},
		});
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
		byKind<void>(field, {
			group: (group) => {
				links.push(...linksIn(groupOf(node).values, group.fields, `${path}.`));
			},
			repeater: (repeater) => {
				for (const row of rowsOf(node)) links.push(...linksIn(row.values, repeater.fields, `${path}.`));
			},
			leaf: (leaf) => {
				if (leaf.type !== "relationship") return;
				for (const entry of Object.values(record(node) as StoredLeaf)) {
					const ids = Array.isArray(entry?.value) ? entry.value : [entry?.value];
					for (const id of ids) if (typeof id === "string") links.push({ field: path, targetId: id });
				}
			},
		});
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
		changed[field.key] = byKind<unknown>(field, {
			group: (group) => ({ values: withoutLinksTo(groupOf(node).values, group.fields, entryId) }),
			repeater: (repeater) => ({
				rows: rowsOf(node).map((row) => ({ id: row.id, values: withoutLinksTo(row.values, repeater.fields, entryId) })),
			}),
			leaf: (leaf) => (leaf.type === "relationship" ? withoutLink(node, entryId) : node),
		});
	}
	return changed;
}

/** A Relationship's stored values without `entryId`, in every language; a language left with none goes. */
function withoutLink(node: unknown, entryId: string): StoredLeaf {
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
	return byLanguage;
}

/** A new Repeater row's id: 12 random letters and digits. */
export function randomRowId(): string {
	const alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
	return Array.from(crypto.getRandomValues(new Uint8Array(12)), (byte) => alphabet[byte % alphabet.length]).join("");
}

// ---------------------------------------------------------------------------------------------------
// Changing the Default language

/**
 * The values with every shared Field's value moved from the old Default language to the new one,
 * where shared values are kept; Translatable fields keep their values in each language as they are.
 * A shared Field without a value under the old Default language has none under the new one either.
 */
export function moveSharedValues(
	values: StoredValues,
	fields: readonly FieldDefinition[],
	from: string,
	to: string,
): StoredValues {
	const moved = { ...values };
	for (const field of fields) {
		const node = moved[field.key];
		if (node === undefined) continue;
		moved[field.key] = byKind<unknown>(field, {
			group: (group) => ({ values: moveSharedValues(groupOf(node).values, group.fields, from, to) }),
			repeater: (repeater) => ({
				rows: rowsOf(node).map((row) => ({
					id: row.id,
					values: moveSharedValues(row.values, repeater.fields, from, to),
				})),
			}),
			leaf: (leaf) => (leaf.translatable ? node : moveLanguage(node, from, to)),
		});
	}
	return moved;
}

/** A value kept per language with the old Default language's value under the new one's key instead. */
export function moveLanguage(node: unknown, from: string, to: string): Record<string, unknown> {
	const byLanguage = { ...record(node) };
	const value = byLanguage[from];
	delete byLanguage[from];
	if (value === undefined) delete byLanguage[to];
	else byLanguage[to] = value;
	return byLanguage;
}

/**
 * What keeps a version from being published, in every language it is shown in: each language's
 * values are checked (`check` answers undefined for a language the version isn't shown in), each
 * problem reported once, with its language when it isn't the Default language's. A value a language
 * falls back to is the Default language's, so its problem is the Default language's too.
 */
export function findingsInEveryLanguage(
	languages: readonly { code: string; default: boolean }[],
	defaultLanguage: string,
	check: (languages: Languages) => Findings | undefined,
): Findings {
	const all: Findings = { problems: [], missing: [], references: [] };
	const seen = new Set<string>();
	for (const language of languages) {
		const found = check({ language: language.code, defaultLanguage });
		if (!found) continue;
		for (const problem of found.problems) {
			const key = `${problem.at} ${problem.rule} ${problem.message}`;
			if (seen.has(key)) continue;
			seen.add(key);
			all.problems.push(language.default ? problem : { ...problem, language: language.code });
		}
		for (const missing of found.missing) if (!all.missing.includes(missing)) all.missing.push(missing);
		for (const reference of found.references) {
			const key = `references ${reference.at} ${reference.ids.join(" ")}`;
			if (seen.has(key)) continue;
			seen.add(key);
			all.references.push({ ...reference, problems: all.problems });
		}
	}
	return all;
}
