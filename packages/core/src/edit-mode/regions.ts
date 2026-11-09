import { editableField } from "../content/editable.ts";
import { getEntry, saveDraft } from "../content/entries.ts";
import type { ContentProblem } from "../content/errors.ts";
import type { Json } from "../content/field-types.ts";
import { getGlobals, saveGlobalsDraft } from "../content/globals.ts";
import { getPostType } from "../content/post-types.ts";
import { isUuid } from "../ids.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { EditFieldInvalidError } from "./errors.ts";

/**
 * What an editable region shows: an Entry (`entry:<id>`) or the Globals (`globals`), as the
 * renderer tags it in `data-wc-item`.
 */
export type EditItem = { kind: "entry"; id: string } | { kind: "globals" };

/** A change made in place: the new value of one editable region. */
export type RegionChange = {
	/** `entry:<id>` or `globals`, as the region's `data-wc-item` says. */
	item: string;
	/** The binding's path within the item, as `data-wc-field` says: `title`, `intro`, `address.city`. */
	field: string;
	/** Plain text, or rich text's HTML (cleaned on save). */
	value: string;
	/** The language of the page the region is on: the value is saved in it (the Default language when absent). */
	language?: string;
};

/** What saving a region did: the item's status, the value as stored, and its problems. */
export type SavedRegion = {
	status: "draft" | "published" | "changed";
	/** The value as stored: trimmed text, cleaned rich text. */
	value: Json;
	/** What keeps the value from being published (an empty required value, a broken rule). */
	problems: ContentProblem[];
};

/** Reads an item as a region names it; refuses anything else. */
export function readEditItem(item: string): EditItem {
	if (item === "globals") return { kind: "globals" };
	const id = item.startsWith("entry:") ? item.slice("entry:".length) : "";
	if (!isUuid(id)) throw new EditFieldInvalidError();
	return { kind: "entry", id };
}

/**
 * Saves the new value of one editable region to the Draft (the Site opened with `entry.edit`),
 * through the same path as the admin (`saveDraft`, `saveGlobalsDraft`): its rules, cleaning and
 * problems are the same. Only text and rich text values (and an Entry's title) are changed in place.
 */
export async function saveRegion(scope: SiteScope, change: RegionChange): Promise<SavedRegion> {
	const item = readEditItem(change.item);
	const { language } = change;
	if (item.kind === "globals") {
		const globals = await getGlobals(scope, language);
		if (!editableField(globals.fields, change.field)) throw new EditFieldInvalidError();
		const saved = await saveGlobalsDraft(scope, { language, fields: nested(change.field, change.value) });
		return {
			status: saved.status,
			value: valueAt(saved.draft, change.field),
			problems: problemsAt(saved.problems, `fields.${change.field}`),
		};
	}
	const entry = await getEntry(scope, item.id, language);
	if (change.field === "title") {
		const saved = await saveDraft(scope, item.id, { language, title: change.value });
		return { status: saved.status, value: saved.draft.title, problems: problemsAt(saved.problems, "title") };
	}
	const postType = await getPostType(scope, entry.postTypeId);
	if (!editableField(postType.fields, change.field)) throw new EditFieldInvalidError();
	const saved = await saveDraft(scope, item.id, { language, fields: nested(change.field, change.value) });
	return {
		status: saved.status,
		value: valueAt(saved.draft.fields, change.field),
		problems: problemsAt(saved.problems, `fields.${change.field}`),
	};
}

/** A value given at a path, as a change to Fields takes it: `address.city` is `{ address: { city } }`. */
function nested(path: string, value: string): Record<string, unknown> {
	return path.split(".").reduceRight<unknown>((inner, name) => ({ [name]: inner }), value) as Record<string, unknown>;
}

/** The value at a path among Fields' values, as the API gives them. */
function valueAt(values: Record<string, Json>, path: string): Json {
	let current: Json = values;
	for (const name of path.split(".")) {
		current = current && typeof current === "object" && !Array.isArray(current) ? (current[name] ?? null) : null;
	}
	return current;
}

/** The problems of one value. */
function problemsAt(problems: readonly ContentProblem[], at: string): ContentProblem[] {
	return problems.filter((problem) => problem.at === at);
}
