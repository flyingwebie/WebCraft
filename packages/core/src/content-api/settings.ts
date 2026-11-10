import { contentApiSettings } from "@webcraft/db/schema";

import type { VisitorScope } from "../tenancy/data-layer.ts";

/**
 * What Staff hid from a Site's Content API: whole Post Types (by id), single Fields of a Post Type
 * (by Post Type id, each a Field's path: `summary`, `address.city`, `steps.text`) and single Fields
 * of the Globals. Hidden things never appear anywhere the API answers: lists, Entries, Relationships,
 * filters, sorts, search and the schema. Everything else is exposed, including what is added later.
 */
export type ContentApiHidden = {
	postTypes: string[];
	fields: Record<string, string[]>;
	globals: string[];
};

/** A Site's Content API settings: off by default, nothing hidden. */
export type ContentApiSettings = { enabled: boolean; hidden: ContentApiHidden };

export function noneHidden(): ContentApiHidden {
	return { postTypes: [], fields: {}, globals: [] };
}

/** The Site's Content API settings, as stored (off, nothing hidden, until Staff change them). */
export async function readContentApiSettings(scope: Pick<VisitorScope, "first">): Promise<ContentApiSettings> {
	const row = await scope.first(contentApiSettings);
	return { enabled: row?.enabled ?? false, hidden: storedHidden(row?.hidden) };
}

/** What a stored `hidden` value holds, read leniently: anything malformed counts as nothing hidden. */
export function storedHidden(value: unknown): ContentApiHidden {
	const record = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
	const strings = (list: unknown) =>
		Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
	const fields: Record<string, string[]> = {};
	const byPostType = record.fields;
	if (byPostType && typeof byPostType === "object" && !Array.isArray(byPostType)) {
		for (const [postTypeId, paths] of Object.entries(byPostType)) {
			const list = strings(paths);
			if (list.length > 0) fields[postTypeId] = list;
		}
	}
	return { postTypes: strings(record.postTypes), fields, globals: strings(record.globals) };
}
