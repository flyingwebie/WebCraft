import { type ComponentSources, NO_MODULE_COMPONENTS } from "../content/components.ts";
import { type DraftChange, lockEntry, saveDraft } from "../content/entries.ts";
import { type ContentProblem, EntryInvalidError, GlobalsInvalidError } from "../content/errors.ts";
import type { FieldDefinition, RepeaterField } from "../content/field-types.ts";
import { storedFields } from "../content/fields.ts";
import { lockGlobals, saveGlobalsDraft } from "../content/globals.ts";
import { siteLanguages } from "../content/languages.ts";
import { getPostType } from "../content/post-types.ts";
import { type HistoryItem, historyEditPermission, historyReadPermission } from "../history/items.ts";
import { writeItemDraft } from "../history/restore.ts";
import type { Permission } from "../permissions/roles.ts";
import { SEO_GROUP, SEO_KEY } from "../seo/entry-seo.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { type Json, sameValue } from "./document.ts";

/**
 * Which items can be co-edited live, and how a change someone made in a shared document is saved.
 *
 * A change is saved through the item's own save, as the person who made it, exactly as the admin's
 * forms and the API save it: values of the wrong kind are refused, broken rules are kept and listed,
 * who wrote each value is recorded, and Checkpoints are saved after 10 minutes of activity. Values
 * kept by key and language (an Entry's, the Globals') are saved value by value, one language at a
 * time; Structure (a Template's tree, a Component's Props and tree) as the whole version, through the
 * same saves the builder and Template markup use.
 */

/** The kinds of item people can open live. Their writes go through the shared document whatever writes them. */
export const LIVE_KINDS = [
	"entry",
	"globals",
	"template",
	"component",
] as const satisfies readonly HistoryItem["kind"][];

export type LiveKind = (typeof LIVE_KINDS)[number];

export function isLiveKind(kind: string): kind is LiveKind {
	return (LIVE_KINDS as readonly string[]).includes(kind);
}

/** What opening an item's document needs: whatever reading the item needs. */
export function readPermission(item: HistoryItem): Permission {
	return historyReadPermission(item);
}

/** What changing an item's document needs: whatever changing its Draft needs (Structure: `structure.edit`). */
export function editPermission(item: HistoryItem): Permission {
	return historyEditPermission(item);
}

/**
 * Saves a change someone made in an item's document (`before` to `after`, both as the document holds
 * them) through the item's own save, in the scope's transaction. The scope is opened as that person
 * with `editPermission(item)`. Throws the save's own refusal, which drops the change.
 */
export async function saveLiveChange(
	scope: SiteScope,
	item: HistoryItem,
	before: Json,
	after: Json,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<void> {
	switch (item.kind) {
		case "entry":
			return saveEntryChange(scope, item.id, before, after);
		case "globals":
			return saveGlobalsChange(scope, before, after);
		default:
			// Structure: the whole version, through the item's own save (as a restore writes one).
			await writeItemDraft(scope, item, after, sources);
	}
}

type Node = Record<string, Json>;

function record(value: Json | undefined): Node | null {
	return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function valuesOf(view: Json): Node {
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
function inOrder(out: ByLanguage, defaultLanguage: string): string[] {
	return [...out.keys()].sort((a, b) => (a === defaultLanguage ? -1 : b === defaultLanguage ? 1 : a.localeCompare(b)));
}

type ChangeContext = { defaultLanguage: string; problems: ContentProblem[] };

/**
 * The values someone changed among `fields`, by language, as the saves take them: a leaf's value
 * (null clearing it), a Group's changed Fields by key, a Repeater's whole list of rows (each row with
 * its id and the values changed in that language).
 */
function valueChanges(
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

function fieldChanges(
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

/** The built-in values an Entry keeps beside its Fields. */
const ENTRY_BUILT_INS = new Set(["title", "slug", "parent", "hiddenLanguages", SEO_KEY]);

async function saveEntryChange(scope: SiteScope, entryId: string, before: Json, after: Json): Promise<void> {
	const row = await lockEntry(scope, entryId);
	const postType = await getPostType(scope, row.postTypeId);
	const { defaultLanguage } = await siteLanguages(scope);
	const problems: ContentProblem[] = [];
	const context = { defaultLanguage, problems };
	const was = valuesOf(before);
	const now = valuesOf(after);
	const keys = new Set([...Object.keys(record(before) ?? {}), ...Object.keys(record(after) ?? {})]);
	keys.delete("values");
	for (const key of keys) problems.push({ at: key, message: "An Entry's Draft holds its values only." });

	const changes = new Map<string, DraftChange>();
	const change = (language: string) => {
		let found = changes.get(language);
		if (!found) {
			found = { language };
			changes.set(language, found);
		}
		return found;
	};
	const fieldValues = Object.fromEntries(Object.entries(now).filter(([key]) => !ENTRY_BUILT_INS.has(key)));
	const fieldValuesBefore = Object.fromEntries(Object.entries(was).filter(([key]) => !ENTRY_BUILT_INS.has(key)));
	for (const [language, fields] of valueChanges(fieldValuesBefore, fieldValues, postType.fields, context, "fields.")) {
		change(language).fields = fields;
	}
	for (const key of ["title", "slug"] as const) {
		if (sameValue(was[key] ?? null, now[key] ?? null)) continue;
		const before = record(was[key] ?? null) ?? {};
		const after = record(now[key] ?? null) ?? {};
		for (const language of new Set([...Object.keys(before), ...Object.keys(after)])) {
			if (sameValue(before[language] ?? null, after[language] ?? null)) continue;
			const value = after[language] ?? "";
			if (typeof value !== "string") problems.push({ at: key, message: `A ${key} is text.` });
			else change(language)[key] = value;
		}
	}
	const shared = (key: string) => {
		const before = record(was[key] ?? null) ?? {};
		const after = record(now[key] ?? null) ?? {};
		for (const language of new Set([...Object.keys(before), ...Object.keys(after)])) {
			if (language !== defaultLanguage && !sameValue(before[language] ?? null, after[language] ?? null)) {
				problems.push({ at: key, message: "A shared value is kept in the Default language." });
			}
		}
		return {
			changed: !sameValue(before[defaultLanguage] ?? null, after[defaultLanguage] ?? null),
			value: after[defaultLanguage],
		};
	};
	const parent = shared("parent");
	if (parent.changed) {
		if (parent.value !== undefined && parent.value !== null && typeof parent.value !== "string") {
			problems.push({ at: "parentId", message: "A parent is a Page's id." });
		} else change(defaultLanguage).parentId = parent.value ?? null;
	}
	const hidden = shared("hiddenLanguages");
	if (hidden.changed) {
		const value = hidden.value ?? [];
		if (!Array.isArray(value) || value.some((code) => typeof code !== "string")) {
			problems.push({ at: "hiddenLanguages", message: "Hidden languages are a list of language codes." });
		} else change(defaultLanguage).hiddenLanguages = value as string[];
	}
	if (!sameValue(was[SEO_KEY] ?? null, now[SEO_KEY] ?? null)) {
		for (const [language, seo] of fieldChanges(was[SEO_KEY], now[SEO_KEY], SEO_GROUP, context, SEO_KEY)) {
			change(language).seo = seo as DraftChange["seo"];
		}
	}
	if (problems.length > 0) throw new EntryInvalidError(problems);
	for (const language of [...changes.keys()].sort((a, b) =>
		a === defaultLanguage ? -1 : b === defaultLanguage ? 1 : a.localeCompare(b),
	)) {
		const each = changes.get(language);
		if (each) await saveDraft(scope, entryId, each);
	}
}

async function saveGlobalsChange(scope: SiteScope, before: Json, after: Json): Promise<void> {
	const row = await lockGlobals(scope);
	const { defaultLanguage } = await siteLanguages(scope);
	const problems: ContentProblem[] = [];
	const keys = new Set([...Object.keys(record(before) ?? {}), ...Object.keys(record(after) ?? {})]);
	keys.delete("values");
	for (const key of keys) problems.push({ at: key, message: "The Globals' Draft holds their values only." });
	const changes = valueChanges(
		valuesOf(before),
		valuesOf(after),
		storedFields(row.fields),
		{ defaultLanguage, problems },
		"fields.",
	);
	if (problems.length > 0) throw new GlobalsInvalidError(problems);
	for (const language of inOrder(changes, defaultLanguage)) {
		await saveGlobalsDraft(scope, { language, fields: changes.get(language) ?? {} });
	}
}
