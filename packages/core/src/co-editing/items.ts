import { type ComponentSources, NO_MODULE_COMPONENTS } from "../content/components.ts";
import { type DraftChange, lockEntry, saveDraft } from "../content/entries.ts";
import { type ContentProblem, EntryInvalidError, GlobalsInvalidError } from "../content/errors.ts";
import { storedFields } from "../content/fields.ts";
import { lockGlobals, saveGlobalsDraft } from "../content/globals.ts";
import { siteLanguages } from "../content/languages.ts";
import { getPostType } from "../content/post-types.ts";
import { type HistoryItem, historyEditPermission, historyReadPermission } from "../history/items.ts";
import { writeItemDraft } from "../history/restore.ts";
import type { Permission } from "../permissions/roles.ts";
import { POPUP_FIELDS, PopupInvalidError, savePopupContent } from "../popups/index.ts";
import { SEO_GROUP, SEO_KEY } from "../seo/entry-seo.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { type Json, sameValue } from "./document.ts";
import { fieldChanges, inOrder, record, valueChanges, valuesOf } from "./value-changes.ts";

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
	"designSystem",
	"template",
	"component",
	"popup",
	"popupContent",
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
		case "popupContent": {
			const { defaultLanguage } = await siteLanguages(scope);
			const problems: ContentProblem[] = [];
			const changes = valueChanges(
				valuesOf(before),
				valuesOf(after),
				POPUP_FIELDS,
				{ defaultLanguage, problems },
				"values.",
			);
			if (problems.length) throw new PopupInvalidError(problems);
			for (const language of inOrder(changes, defaultLanguage))
				await savePopupContent(scope, item.id, { language, values: changes.get(language) ?? {} });
			return;
		}
		case "globals":
			return saveGlobalsChange(scope, before, after);
		default:
			// Structure: the whole version, through the item's own save (as a restore writes one).
			await writeItemDraft(scope, item, after, sources);
	}
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
	keys.delete("layout");
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
	if (!sameValue(record(before)?.layout ?? null, record(after)?.layout ?? null))
		change(defaultLanguage).layout = record(after)?.layout ?? { placements: [] };
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
