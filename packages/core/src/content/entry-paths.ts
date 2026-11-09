import { publishedSlugs, specialPages } from "@webcraft/db/schema";
import { and, eq, inArray, isNull } from "drizzle-orm";

import type { VisitorScope } from "../tenancy/data-layer.ts";
import type { Languages } from "./field-values.ts";
import { languagePath } from "./languages.ts";
import { isPagePostType, pathIn, pathText, publishedPageTree } from "./pages.ts";
import type { PostType } from "./post-types.ts";
import { pathFor } from "./url-patterns.ts";

/** Where visitors find a published Entry in one language: its published slug there, and its path. */
export type PublishedAddress = { slug: string; path: string };

/**
 * Where visitors find each of these published Entries of one Post Type in a language, by id: its
 * Post Type's URL pattern with its published slug in that language, or a Page's parents and slug
 * (the home page at `/`), under the language's prefix. Entries not published have none.
 */
export async function publishedAddresses(
	scope: Pick<VisitorScope, "select" | "first">,
	postType: Pick<PostType, "id" | "builtIn" | "urlPattern">,
	entryIds: readonly string[],
	languages: Languages,
): Promise<Map<string, PublishedAddress>> {
	const found = new Map<string, PublishedAddress>();
	if (entryIds.length === 0) return found;
	if (isPagePostType(postType)) {
		const tree = await publishedPageTree(scope, postType.id, languages.language);
		const home = await homePageId(scope);
		for (const id of entryIds) {
			const page = tree.get(id);
			const parts = pathIn(tree, id);
			if (!page || !parts) continue;
			// The home page is found at `/`; its own path sends visitors there.
			found.set(id, { slug: page.slug, path: languagePath(languages, id === home ? "/" : pathText(parts)) });
		}
		return found;
	}
	const rows = await scope.select(
		publishedSlugs,
		and(
			eq(publishedSlugs.postTypeId, postType.id),
			eq(publishedSlugs.language, languages.language),
			inArray(publishedSlugs.entryId, [...entryIds]),
		),
	);
	for (const row of rows) {
		const path = pathFor(postType.urlPattern, row.slug);
		if (path) found.set(row.entryId, { slug: row.slug, path: languagePath(languages, path) });
	}
	return found;
}

/** The Page the Site shows at `/`, in every language; undefined when it has none. */
export async function homePageId(scope: Pick<VisitorScope, "first">): Promise<string | undefined> {
	return (await scope.first(specialPages, and(eq(specialPages.role, "home"), isNull(specialPages.language))))?.entryId;
}
