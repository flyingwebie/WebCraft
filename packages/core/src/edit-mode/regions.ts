import { media } from "@webcraft/db/schema";
import { eq } from "drizzle-orm";

import { editableField, imageField } from "../content/editable.ts";
import { getEntry, saveDraft } from "../content/entries.ts";
import type { ContentProblem } from "../content/errors.ts";
import type { FieldDefinition, Json } from "../content/field-types.ts";
import { getGlobals, saveGlobalsDraft } from "../content/globals.ts";
import { getPostType } from "../content/post-types.ts";
import { isUuid } from "../ids.ts";
import { MediaInTrashError, MediaInvalidError, MediaNotFoundError } from "../media/errors.ts";
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

/** A new image for an image region: a Media image of the Site's library, or null for none. */
export type ImageChange = {
	/** `entry:<id>` or `globals`, as the region's `data-wc-item` says. */
	item: string;
	/** The media Field's path within it, as `data-wc-field` says. */
	field: string;
	/** The Media item's id, or null to empty the region. */
	media: string | null;
	/** For an image Block of a body (`field` the Body field), the Block's id, as `data-wc-block` says. */
	block?: string;
	/** The language of the page the region is on (the Default language when absent). */
	language?: string;
};

/** What choosing an image did: the item's status, the Media item now shown, and the value's problems. */
export type SavedImage = {
	status: "draft" | "published" | "changed";
	media: string | null;
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
function nested(path: string, value: string | null): Record<string, unknown> {
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

/**
 * Puts a new image in an image region's media Field, in the Draft (the Site opened with
 * `entry.edit`), through the same saves as the admin. The image must be one of the Site's Media
 * library's images, out of the Trash; null empties the region.
 */
export async function saveImage(scope: SiteScope, change: ImageChange): Promise<SavedImage> {
	const item = readEditItem(change.item);
	const { language } = change;
	const fields =
		item.kind === "globals"
			? (await getGlobals(scope, language)).fields
			: (await getPostType(scope, (await getEntry(scope, item.id, language)).postTypeId)).fields;
	if (change.block === undefined && !imageField(fields, change.field)) throw new EditFieldInvalidError();
	if (change.media !== null) await checkImage(scope, change.media);
	if (change.block !== undefined) {
		if (item.kind !== "entry") throw new EditFieldInvalidError();
		return saveBlockImage(scope, item.id, fields, { ...change, block: change.block });
	}
	const values = nested(change.field, change.media);
	if (item.kind === "globals") {
		const saved = await saveGlobalsDraft(scope, { language, fields: values });
		return {
			status: saved.status,
			media: mediaIdOf(valueAt(saved.draft, change.field)),
			problems: problemsAt(saved.problems, `fields.${change.field}`),
		};
	}
	const saved = await saveDraft(scope, item.id, { language, fields: values });
	return {
		status: saved.status,
		media: mediaIdOf(valueAt(saved.draft.fields, change.field)),
		problems: problemsAt(saved.problems, `fields.${change.field}`),
	};
}

/** Refuses what an image region can't show: anything but an image of the Site's library, out of the Trash. */
export async function checkImage(scope: SiteScope, mediaId: string): Promise<void> {
	const row = isUuid(mediaId) ? await scope.first(media, eq(media.id, mediaId)) : undefined;
	if (!row) throw new MediaNotFoundError();
	if (row.trashedAt) throw new MediaInTrashError();
	if (row.kind !== "image") throw new MediaInvalidError([{ at: "media", message: "An image region shows an image." }]);
}

function mediaIdOf(value: Json): string | null {
	return typeof value === "string" ? value : null;
}

/**
 * Puts a new image in one image Block of an Entry's body, in the page's language: the body's Blocks
 * as that language shows them (the Default language's while it has none of its own), with only that
 * Block's image changed, saved as the admin's block editor saves a body.
 */
async function saveBlockImage(
	scope: SiteScope,
	entryId: string,
	fields: readonly FieldDefinition[],
	change: ImageChange & { block: string },
): Promise<SavedImage> {
	const body = fields.find((field) => field.key === change.field && field.type === "body");
	if (!body) throw new EditFieldInvalidError();
	const entry = await getEntry(scope, entryId, change.language);
	const blocks = entry.draft.fields[body.key];
	const list = Array.isArray(blocks) ? blocks : [];
	const at = list.findIndex(
		(block) =>
			block !== null &&
			typeof block === "object" &&
			!Array.isArray(block) &&
			block.id === change.block &&
			block.type === "image",
	);
	if (at < 0) throw new EditFieldInvalidError();
	const next = list.map((block, index) =>
		index === at && block && typeof block === "object" && !Array.isArray(block)
			? { ...block, media: change.media }
			: block,
	);
	const saved = await saveDraft(scope, entryId, { language: change.language, fields: { [body.key]: next } });
	const stored = saved.draft.fields[body.key];
	const kept = Array.isArray(stored)
		? stored.find((block) => block && typeof block === "object" && !Array.isArray(block) && block.id === change.block)
		: undefined;
	return {
		status: saved.status,
		media: kept && typeof kept === "object" && !Array.isArray(kept) ? mediaIdOf(kept.media ?? null) : null,
		problems: saved.problems.filter((problem) => problem.at.startsWith(`fields.${body.key}[${at}]`)),
	};
}
