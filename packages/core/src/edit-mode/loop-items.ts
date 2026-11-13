import { entries } from "@webcraft/db/schema";
import { inArray } from "drizzle-orm";

import { draftAddresses } from "../content/draft-paths.ts";
import { editableField, imageField } from "../content/editable.ts";
import { entryValues } from "../content/entries.ts";
import { publishedAddresses } from "../content/entry-paths.ts";
import type { ContentProblem } from "../content/errors.ts";
import type { FieldDefinition, Json } from "../content/field-types.ts";
import { defaultValues, randomRowId, type StoredRow } from "../content/field-values.ts";
import { languagesFor, siteLanguages } from "../content/languages.ts";
import { getLoop, type Loop, rearrangeLoopItems, type StoredLoopVersion, saveLoopItems } from "../content/loops.ts";
import { isPagePostType } from "../content/pages.ts";
import { listPostTypes } from "../content/post-types.ts";
import { getEntryTemplate } from "../content/templates.ts";
import { storedVersion } from "../content/values.ts";
import { isUuid } from "../ids.ts";
import { actingPerson } from "../permissions/can.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { EditFieldInvalidError } from "./errors.ts";

/**
 * Loop items in Edit mode (GLOSSARY.md › Loop item): a Loop's own items are Content, so everyone who
 * edits the Site changes them in place (the Site opened with `entry.edit`), in the Loop's Draft,
 * through the same save as the admin (`saveLoopItems`): values of the wrong kind refused, broken
 * rules kept and listed. A query Loop's items are Entries, changed on their own pages.
 */

/** A Loop item as the page's regions name it: `loop:<loop id>:<item id>`. */
export type LoopItemRef = { loopId: string; itemId: string };

/** Reads `loop:<loop id>:<item id>`; undefined for anything else. */
export function readLoopItem(item: string): LoopItemRef | undefined {
	const [kind, loopId, itemId, ...rest] = item.split(":");
	if (kind !== "loop" || !loopId || !itemId || rest.length > 0) return undefined;
	return { loopId, itemId };
}

/** A Loop's item as Edit mode reads it: `{ id, …its Fields' values }` in a language. */
export type LoopItemValues = Record<string, Json>;

/** A Loop of its own items, its Draft read in `language`; refuses a query Loop. */
export async function ownItemsLoop(scope: SiteScope, loopId: string, language?: string): Promise<Loop> {
	const loop = await getLoop(scope, loopId, language);
	if (loop.draft.source !== "items") throw new EditFieldInvalidError();
	return loop;
}

/** Where an item is in a Loop's Draft; refuses one the Loop doesn't have. */
export function itemIndex(loop: Loop, itemId: string): number {
	const index = loop.draft.items.findIndex((item) => item.id === itemId);
	if (index < 0) throw new EditFieldInvalidError();
	return index;
}

/** What saving a Loop item's values did: the Loop's status, the item as stored, and its problems. */
export type SavedLoopItem = {
	status: Loop["status"];
	item: LoopItemValues;
	problems: ContentProblem[];
};

/**
 * Saves some of a Loop item's values (by key, as the admin's Loop items take them; a Group's by its
 * Fields' keys) in a language, leaving every other item and value as it is.
 */
export async function saveLoopItemValues(
	scope: SiteScope,
	ref: LoopItemRef,
	values: Record<string, unknown>,
	language?: string,
): Promise<SavedLoopItem> {
	const loop = await ownItemsLoop(scope, ref.loopId, language);
	const index = itemIndex(loop, ref.itemId);
	const saved = await saveLoopItems(scope, loop.id, {
		language,
		items: loop.draft.items.map((item) => (item.id === ref.itemId ? { ...values, id: item.id } : { id: item.id })),
	});
	return {
		status: saved.status,
		item: saved.draft.items[index] ?? { id: ref.itemId },
		problems: saved.problems.filter((problem) => problem.at.startsWith(`items[${index}]`)),
	};
}

/**
 * The Field of a Loop's items a region names (`data-wc-field`), when it is typed over in place (text
 * or rich text, `image` false) or shows an image (a media Field, `image` true); refuses anything else.
 */
export async function loopItemField(
	scope: SiteScope,
	ref: LoopItemRef,
	path: string,
	image: boolean,
	language?: string,
): Promise<{ loop: Loop; field: FieldDefinition }> {
	const loop = await ownItemsLoop(scope, ref.loopId, language);
	itemIndex(loop, ref.itemId);
	const editable = (image ? imageField : editableField)(loop.draft.fields, path);
	if (!editable) throw new EditFieldInvalidError();
	return { loop, field: editable.field };
}

/** The value at a path (`address.city`) of an item's values. */
export function itemValueAt(item: LoopItemValues, path: string): Json {
	let current: Json = item;
	for (const name of path.split(".")) {
		current = current && typeof current === "object" && !Array.isArray(current) ? (current[name] ?? null) : null;
	}
	return current;
}

/** The ids of a Loop's items, in order: what each change to them answers. */
export type ItemOrder = { items: string[] };

/** A Loop's own items' rows, refusing a query Loop (its items are Entries). */
function ownRows(rows: readonly StoredRow[], draft: StoredLoopVersion): readonly StoredRow[] {
	if (draft.source !== "items") throw new EditFieldInvalidError();
	return rows;
}

function at(rows: readonly StoredRow[], itemId: string): number {
	const index = rows.findIndex((row) => row.id === itemId);
	if (index < 0) throw new EditFieldInvalidError();
	return index;
}

const order = (loop: Loop): string[] => loop.draft.items.map((item) => String(item.id));

/** Moves an item to another place (`to`, from 0), in every language. */
export async function moveLoopItem(scope: SiteScope, loopId: string, itemId: string, to: number): Promise<ItemOrder> {
	const { loop } = await rearrangeLoopItems(scope, loopId, (stored, draft) => {
		const rows = [...ownRows(stored, draft)];
		const [moved] = rows.splice(at(rows, itemId), 1);
		if (moved) rows.splice(Math.max(0, Math.min(to, rows.length)), 0, moved);
		return { rows, result: null };
	});
	return { items: order(loop) };
}

/** Copies an item, its values in every language, right after it. */
export async function duplicateLoopItem(
	scope: SiteScope,
	loopId: string,
	itemId: string,
): Promise<ItemOrder & { item: string }> {
	const { loop, result } = await rearrangeLoopItems(scope, loopId, (stored, draft) => {
		const rows = [...ownRows(stored, draft)];
		const index = at(rows, itemId);
		const copy: StoredRow = { id: randomRowId(), values: structuredClone(rows[index]?.values ?? {}) };
		rows.splice(index + 1, 0, copy);
		return { rows, result: copy.id };
	});
	return { items: order(loop), item: result };
}

/** Removes an item in every language, answering it as stored and where it was, to put it back. */
export async function removeLoopItem(
	scope: SiteScope,
	loopId: string,
	itemId: string,
): Promise<ItemOrder & { removed: { row: StoredRow; index: number } }> {
	const { loop, result } = await rearrangeLoopItems(scope, loopId, (stored, draft) => {
		const rows = [...ownRows(stored, draft)];
		const index = at(rows, itemId);
		const [row] = rows.splice(index, 1);
		return { rows, result: { row: row as StoredRow, index } };
	});
	return { items: order(loop), removed: result };
}

/** Puts a removed item back where it was (or last, if the Loop is shorter now); once only. */
export async function restoreLoopItem(
	scope: SiteScope,
	loopId: string,
	removed: { row: StoredRow; index: number },
): Promise<ItemOrder & { item: string }> {
	const { loop } = await rearrangeLoopItems(scope, loopId, (stored, draft) => {
		const rows = [...ownRows(stored, draft)];
		if (rows.some((row) => row.id === removed.row.id)) throw new EditFieldInvalidError();
		rows.splice(Math.min(removed.index, rows.length), 0, removed.row);
		return { rows, result: null };
	});
	return { items: order(loop), item: removed.row.id };
}

/** Adds a new item with its Fields' defaults after one (`after`), or first without one. */
export async function addLoopItem(
	scope: SiteScope,
	loopId: string,
	after: string | null,
): Promise<ItemOrder & { item: string }> {
	const { defaultLanguage } = await siteLanguages(scope);
	const by = { kind: "person" as const, personId: actingPerson(scope.access.actor) };
	const { loop, result } = await rearrangeLoopItems(scope, loopId, (stored, draft) => {
		const rows = [...ownRows(stored, draft)];
		const index = after === null ? 0 : at(rows, after) + 1;
		const added: StoredRow = {
			id: randomRowId(),
			values: defaultValues(draft.fields, { language: defaultLanguage, defaultLanguage, by }),
		};
		rows.splice(index, 0, added);
		return { rows, result: added.id };
	});
	return { items: order(loop), item: result };
}

/** Where a query Loop's item (an Entry) is changed: its own page in Edit mode, else its editor in the admin. */
export type EntryLink = { id: string; title: string; href: string; page: boolean };

/**
 * Where each of these Entries of the Site is changed, for the "Edit this Entry" link on a query
 * Loop's items: its page (published, else where its Draft would be) in the language, which Edit mode
 * opens on the same domain; for an Entry with no page (its Entry template isn't published), its
 * editor in the admin. Entries the Site doesn't have are left out.
 */
export async function entryLinks(
	scope: SiteScope,
	adminOrigin: string,
	entryIds: readonly string[],
	language?: string,
): Promise<EntryLink[]> {
	const ids = [...new Set(entryIds.filter(isUuid))];
	if (ids.length === 0) return [];
	const languages = languagesFor(await siteLanguages(scope), language);
	if (!languages) throw new EditFieldInvalidError();
	const rows = await scope.select(entries, inArray(entries.id, ids));
	const found = new Map<string, EntryLink>();
	for (const postType of await listPostTypes(scope)) {
		const own = rows.filter((row) => row.postTypeId === postType.id);
		if (own.length === 0) continue;
		const hasPages = isPagePostType(postType) || Boolean((await getEntryTemplate(scope, postType.id))?.published);
		const ownIds = own.map((row) => row.id);
		const published = hasPages ? await publishedAddresses(scope, postType, ownIds, languages) : new Map();
		const drafts = hasPages ? await draftAddresses(scope, postType, ownIds, languages) : new Map();
		for (const row of own) {
			const path = published.get(row.id)?.path ?? drafts.get(row.id)?.path;
			const editor = new URL(`/sites/${scope.site.id}/entries/${postType.id}/${row.id}`, adminOrigin).toString();
			found.set(row.id, {
				id: row.id,
				title: entryValues(storedVersion(row.draft), [], languages).title,
				href: path ?? editor,
				page: path !== undefined,
			});
		}
	}
	return ids.flatMap((id) => {
		const link = found.get(id);
		return link ? [link] : [];
	});
}
