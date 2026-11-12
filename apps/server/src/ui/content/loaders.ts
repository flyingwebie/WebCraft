import type { ApiClient } from "@webcraft/api";
import { storedBlocks } from "@webcraft/renderer/body";

import type { MediaItem } from "../media/preview.ts";
import { type FieldDefinition, type FieldValues, groupValues, type Json, rowsOf } from "./model.ts";
import type { RelationshipTargets } from "./RelationshipPicker.tsx";

/** The keys of the Post Types any Relationship among these Fields (and inside Groups and Repeaters) points at. */
function relationshipKeys(fields: readonly FieldDefinition[]): Set<string> {
	const keys = new Set<string>();
	for (const field of fields) {
		if (field.type === "relationship") for (const key of field.postTypes) keys.add(key);
		if ("fields" in field) for (const key of relationshipKeys(field.fields)) keys.add(key);
	}
	return keys;
}

/** The Entries each Relationship among the Fields can point at, by Post Type key, in the language shown. */
export async function loadRelationshipTargets(
	api: ApiClient,
	siteId: string,
	fields: readonly FieldDefinition[],
	language?: string,
): Promise<RelationshipTargets> {
	const wanted = relationshipKeys(fields);
	if (wanted.size === 0) return {};
	const { postTypes } = await api.postTypes.list({ siteId });
	const targets = await Promise.all(
		postTypes
			.filter((postType) => wanted.has(postType.key))
			.map(async (postType) => {
				const { entries } = await api.entries.list({ siteId, postTypeId: postType.id, language });
				return [
					postType.key,
					{
						name: postType.name,
						entries: entries.map((entry) => ({ id: entry.id, title: entry.draft.title, status: entry.status })),
					},
				] as const;
			}),
	);
	return Object.fromEntries(targets);
}

/** The ids of the files media Fields (and Body fields' images) hold among these values. */
function mediaIds(fields: readonly FieldDefinition[], values: FieldValues): string[] {
	return fields.flatMap((field) => {
		const value: Json = values[field.key] ?? null;
		if (field.type === "media") return typeof value === "string" ? [value] : [];
		if (field.type === "body") {
			return storedBlocks(value).flatMap((block) => (block.type === "image" && block.media ? [block.media] : []));
		}
		if (field.type === "group") return mediaIds(field.fields, groupValues(value));
		if (field.type === "repeater") return rowsOf(value).flatMap((row) => mediaIds(field.fields, row));
		return [];
	});
}

/** What the admin shows of the files media Fields hold, by id; files no longer in the library are left out. */
export async function loadMedia(
	api: { media: Pick<ApiClient["media"], "get"> },
	siteId: string,
	fields: readonly FieldDefinition[],
	values: FieldValues,
	/** Other files the screen shows, such as an Entry's social image. */
	more: readonly (string | null | undefined)[] = [],
): Promise<Record<string, MediaItem>> {
	const ids = [...new Set([...mediaIds(fields, values), ...more.filter((id): id is string => Boolean(id))])];
	const items = await Promise.all(
		ids.map((mediaId) =>
			api.media.get({ siteId, mediaId }).then(
				({ media }) => media,
				() => null,
			),
		),
	);
	return Object.fromEntries(items.filter((item): item is MediaItem => item !== null).map((item) => [item.id, item]));
}
