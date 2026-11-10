import { entries, gonePaths, publishedSlugs } from "@webcraft/db/schema";
import { and, eq, inArray } from "drizzle-orm";

import { indexPublishedEntry } from "../search/indexing.ts";
import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { lockEntry } from "./entries.ts";
import { homePageId } from "./entry-paths.ts";
import { HomePageUnpublishError } from "./errors.ts";
import { siteLanguages } from "./languages.ts";
import { clearPageCache } from "./page-cache.ts";
import { isPagePostType, lockSitePaths, pagesUnder, pathIn, pathText, publishedPageTree } from "./pages.ts";
import { getPostType, type PostType } from "./post-types.ts";
import { saveLinks } from "./relationships.ts";
import { pathFor } from "./url-patterns.ts";
import { storedVersion } from "./values.ts";
import { isVisibleIn } from "./visibility.ts";

/**
 * Unpublishing an Entry (spec story 46, GLOSSARY.md › Scheduled publish): it stops showing. Its pages
 * answer 410 Gone (`gone_paths`), it leaves Loops, Relationships on pages, Site search and anything
 * else reading published Entries, and keeps its Draft and its Revisions, so it can be published again,
 * which brings its pages back. Scheduled publishes do it at their time (`scheduled-publishes.ts`).
 */

/** An Entry a publish unpublished: where it was, in each language it was shown in. */
export type Unpublished = { entryId: string; postTypeId: string; paths: { language: string; path: string }[] };

/**
 * Unpublishes an Entry (open the Site with `entry.publish`), inside the caller's transaction or its
 * own. A Page takes every published Page under it along: their paths start with its own, so they'd
 * have none left. Refuses the Site's home page and a Page above it (`HomePageUnpublishError`) and an
 * Entry that isn't the Site's (`EntryNotFoundError`). An Entry that isn't published has nothing to
 * unpublish: the answer is empty. Each Entry unpublished is in the Audit log (`entry.unpublish`, with
 * its paths; a Page under it names it as `with`), and the Site's page cache is cleared.
 */
export async function unpublishEntry(scope: SiteScope, entryId: string): Promise<Unpublished[]> {
	return scope.transaction(async (tx) => {
		await lockSitePaths(tx);
		const row = await lockEntry(tx, entryId);
		if (row.published === null) return [];
		const postType = await getPostType(tx, row.postTypeId);
		const site = await siteLanguages(tx);
		const ids = isPagePostType(postType)
			? [row.id, ...pagesUnder(await publishedPageTree(tx, postType.id, site.defaultLanguage), row.id)]
			: [row.id];
		const home = await homePageId(tx);
		if (home && ids.includes(home)) throw new HomePageUnpublishError();
		const rows = await tx.select(entries, inArray(entries.id, ids));
		// Where each was, worked out before any slug goes: a Page's path needs those above it.
		const gone: Unpublished[] = [];
		for (const id of ids) {
			const entry = rows.find((candidate) => candidate.id === id);
			if (!entry?.published) continue;
			gone.push({ entryId: id, postTypeId: entry.postTypeId, paths: await pathsOf(tx, postType, entry, site) });
		}
		const now = tx.now();
		for (const { entryId: id, paths } of gone) {
			for (const { language, path } of paths) {
				await tx.db
					.insert(gonePaths)
					.values({ workspaceId: tx.workspace.id, siteId: tx.site.id, entryId: id, language, path, goneAt: now })
					.onConflictDoUpdate({
						target: [gonePaths.siteId, gonePaths.language, gonePaths.path],
						set: { entryId: id, goneAt: now, workspaceId: tx.workspace.id },
					});
			}
			await tx.update(entries, { published: null, unpublishedAt: now }, eq(entries.id, id));
			await tx.delete(publishedSlugs, eq(publishedSlugs.entryId, id));
			await saveLinks(tx, id, "published", []);
			// Site search forgets it: an Entry that isn't published has no documents.
			await indexPublishedEntry(tx, id);
		}
		for (const each of gone) {
			await tx.audit("entry.unpublish", {
				entryId: each.entryId,
				postTypeId: each.postTypeId,
				paths: each.paths,
				...(each.entryId === row.id ? {} : { with: row.id }),
			});
		}
		await clearPageCache(tx);
		return gone;
	});
}

/** Where a published Entry is, in each language it is shown in: the path within the language (no prefix). */
async function pathsOf(
	scope: SiteScope,
	postType: PostType,
	entry: typeof entries.$inferSelect,
	site: Awaited<ReturnType<typeof siteLanguages>>,
): Promise<{ language: string; path: string }[]> {
	const paths: { language: string; path: string }[] = [];
	const version = storedVersion(entry.published);
	for (const language of site.languages) {
		const languages = { language: language.code, defaultLanguage: site.defaultLanguage };
		if (!isVisibleIn(version, languages)) continue;
		let path: string | null = null;
		if (isPagePostType(postType)) {
			const parts = pathIn(await publishedPageTree(scope, postType.id, language.code), entry.id);
			path = parts ? pathText(parts) : null;
		} else {
			const slug = await scope.first(
				publishedSlugs,
				and(eq(publishedSlugs.entryId, entry.id), eq(publishedSlugs.language, language.code)),
			);
			path = slug ? pathFor(postType.urlPattern, slug.slug) : null;
		}
		if (path) paths.push({ language: language.code, path });
	}
	return paths;
}

/**
 * Whether a path in a language is where an unpublished Entry was, and nothing else is published
 * there now: the Site answers it with 410 Gone instead of 404. `path` is within the language, without
 * its prefix (`/blog/fresh-bread`).
 */
export async function isGonePath(scope: Pick<VisitorScope, "first">, language: string, path: string): Promise<boolean> {
	return (await scope.first(gonePaths, and(eq(gonePaths.language, language), eq(gonePaths.path, path)))) !== undefined;
}
