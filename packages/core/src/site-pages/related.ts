import { people } from "@webcraft/db/schema";
import { inArray } from "drizzle-orm";

import { entryValues } from "../content/entries.ts";
import { publishedAddresses } from "../content/entry-paths.ts";
import type { Languages } from "../content/field-values.ts";
import type { PostType } from "../content/post-types.ts";
import { publishedEntries } from "../content/relationships.ts";
import type { RelatedEntry } from "../content/render-values.ts";
import { storedVersion } from "../content/values.ts";
import { isVisibleIn } from "../content/visibility.ts";
import type { VisitorScope } from "../tenancy/data-layer.ts";

/** What reading published Entries on a page needs of the Site: a visitor's queries, or the person editing's. */
export type ReadScope = Pick<VisitorScope, "select" | "first" | "count" | "where" | "db" | "site" | "now">;

/** The published Entries the page's Relationships point at, read in the page's language. */
export async function relatedEntries(
	scope: Pick<VisitorScope, "select" | "first">,
	postTypes: readonly PostType[],
	ids: readonly string[],
	languages: Languages,
): Promise<Map<string, RelatedEntry & { postTypeId: string }>> {
	const byId = new Map(postTypes.map((postType) => [postType.id, postType]));
	const related = new Map<string, RelatedEntry & { postTypeId: string }>();
	// Entries hidden in the page's language have no place on it.
	const rows = (await publishedEntries(scope, [...new Set(ids)])).filter((row) =>
		isVisibleIn(storedVersion(row.published), languages),
	);
	const addresses = new Map<string, { slug: string; path: string }>();
	for (const postType of postTypes) {
		const own = rows.filter((row) => row.postTypeId === postType.id).map((row) => row.id);
		for (const [id, address] of await publishedAddresses(scope, postType, own, languages)) addresses.set(id, address);
	}
	for (const row of rows) {
		const postType = byId.get(row.postTypeId);
		if (!postType) continue;
		const values = entryValues(storedVersion(row.published), postType.fields, languages);
		const address = addresses.get(row.id);
		related.set(row.id, {
			postTypeId: postType.id,
			fields: postType.fields,
			values: values.fields,
			builtIns: {
				title: values.title,
				slug: address?.slug ?? values.slug,
				url: address?.path ?? null,
				createdAt: row.createdAt,
				updatedAt: row.lastPublishedAt,
				publishedAt: row.publishedAt,
				lastPublishedAt: row.lastPublishedAt,
			},
		});
	}
	return related;
}

/** The names of people by id (an Entry's author), in one query. */
export async function namesOf(scope: Pick<VisitorScope, "db">, ids: readonly string[]): Promise<Map<string, string>> {
	const unique = [...new Set(ids)];
	if (unique.length === 0) return new Map();
	const rows = await scope.db
		.select({ id: people.id, name: people.name })
		.from(people)
		.where(inArray(people.id, unique));
	return new Map(rows.map((row) => [row.id, row.name]));
}
