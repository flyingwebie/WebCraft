import { entries, postTypes as postTypeRows, templates } from "@webcraft/db/schema";
import { and, eq, isNotNull } from "drizzle-orm";

import type { SiteScope } from "../tenancy/data-layer.ts";
import { ArchiveUnavailableError, PathTakenError } from "./errors.ts";
import { languagePath, siteLanguages } from "./languages.ts";
import { isPagePostType, PAGE_POST_TYPE, pathIn, pathText, patternOwning, publishedPageTree } from "./pages.ts";
import { listPostTypes, type PostType } from "./post-types.ts";
import { parseUrlPattern } from "./url-patterns.ts";
import { readValue, storedVersion } from "./values.ts";

/**
 * Archive templates (GLOSSARY.md): one per Post Type, listing its Entries through Loops. Each answers
 * at its Post Type's **archive address**: the URL pattern's fixed parts before `{slug}` (`/recipes`
 * for `/recipes/{slug}`, `/shop/products` for `/shop/products/{slug}`), in every language under its
 * prefix (`/fr/recipes`). A pattern starting with `{slug}` leaves no address, so its Post Type has no
 * Archive template, nor does the Page Post Type. A published Archive template owns its address as a
 * URL pattern owns its paths: no other pattern may own it and no Page may be published there, each
 * refused with `PATH_TAKEN`, so a path is never answered by both. Changes that take an address take
 * `lockSitePaths` first.
 */

/** The parts of a Post Type's archive address, or null when its URL pattern starts with `{slug}`. */
export function archiveParts(urlPattern: string): string[] | null {
	const pattern = parseUrlPattern(urlPattern);
	if ("problem" in pattern) return null;
	const parts: string[] = [];
	for (const segment of pattern.segments) {
		if (segment.kind === "slug") break;
		parts.push(segment.text);
	}
	return parts.length > 0 ? parts : null;
}

/** The archive address of a Post Type that may have an Archive template; `ArchiveUnavailableError` otherwise. */
export function archiveAddressOf(postType: Pick<PostType, "builtIn" | "urlPattern">): string[] {
	if (isPagePostType(postType)) throw new ArchiveUnavailableError("pages");
	const parts = archiveParts(postType.urlPattern);
	if (!parts) throw new ArchiveUnavailableError("address");
	return parts;
}

/** A published Archive template at its address. */
export type PublishedArchive = { postType: PostType; parts: string[] };

/** The Site's published Archive templates that have an address. */
export async function publishedArchives(
	scope: Pick<SiteScope, "select">,
	postTypes: readonly PostType[],
): Promise<PublishedArchive[]> {
	const rows = await scope.select(templates, and(eq(templates.kind, "archive"), isNotNull(templates.published)));
	return rows
		.flatMap((row) => {
			const postType = postTypes.find((candidate) => candidate.id === row.postTypeId);
			const parts = postType && !isPagePostType(postType) ? archiveParts(postType.urlPattern) : null;
			return postType && parts ? [{ postType, parts }] : [];
		})
		.sort((a, b) => (pathText(a.parts) < pathText(b.parts) ? -1 : 1));
}

/** The published Archive template at a path's parts (without a language prefix), if any. */
export function archiveAt(
	archives: readonly PublishedArchive[],
	parts: readonly string[],
): PublishedArchive | undefined {
	return archives.find(
		(archive) => archive.parts.length === parts.length && archive.parts.every((part, index) => part === parts[index]),
	);
}

/**
 * Refuses publishing a Post Type's Archive template where its address is taken (call it holding
 * `lockSitePaths`): owned by another Post Type's URL pattern, or the path of a published Page in any
 * of the Site's languages.
 */
export async function checkArchiveAddressFree(scope: SiteScope, postType: PostType): Promise<void> {
	const parts = archiveAddressOf(postType);
	const postTypes = await listPostTypes(scope);
	const owner = patternOwning(
		postTypes.filter((candidate) => candidate.id !== postType.id),
		parts,
	);
	if (owner) {
		throw new PathTakenError(
			pathText(parts),
			{ kind: "postType", id: owner.id, name: owner.name, urlPattern: owner.urlPattern },
			"archive",
		);
	}
	await checkNoPageAt(scope, parts, "archive");
}

/**
 * Refuses a Post Type's new URL pattern (call it holding `lockSitePaths`) that would own the address
 * of another Post Type's published Archive template, or, when its own Archive template is published,
 * move its address onto a published Page or a path another pattern owns.
 */
export async function checkPatternLeavesArchives(
	scope: SiteScope,
	urlPattern: string,
	postTypeId?: string,
): Promise<void> {
	const pattern = parseUrlPattern(urlPattern);
	if ("problem" in pattern) return;
	const postTypes = await listPostTypes(scope);
	for (const archive of await publishedArchives(scope, postTypes)) {
		if (archive.postType.id === postTypeId) continue;
		const changed = { ...archive.postType, urlPattern };
		if (patternOwning([{ ...changed, id: postTypeId ?? "new", builtIn: null }], archive.parts)) {
			throw new PathTakenError(pathText(archive.parts), {
				kind: "archive",
				postTypeId: archive.postType.id,
				name: archive.postType.name,
			});
		}
	}
	const own = postTypeId ? postTypes.find((postType) => postType.id === postTypeId) : undefined;
	if (!own) return;
	const published = await scope.first(
		templates,
		and(eq(templates.kind, "archive"), eq(templates.postTypeId, own.id), isNotNull(templates.published)),
	);
	const parts = archiveParts(urlPattern);
	if (!published || !parts) return;
	const owner = patternOwning(
		postTypes.filter((candidate) => candidate.id !== own.id),
		parts,
	);
	if (owner) {
		throw new PathTakenError(
			pathText(parts),
			{ kind: "postType", id: owner.id, name: owner.name, urlPattern: owner.urlPattern },
			"archive",
		);
	}
	await checkNoPageAt(scope, parts, "archive");
}

/** Refuses an address where a published Page is, in any of the Site's languages. */
async function checkNoPageAt(scope: SiteScope, parts: readonly string[], taking: "archive"): Promise<void> {
	const pages = await scope.first(postTypeRows, eq(postTypeRows.builtIn, PAGE_POST_TYPE.builtIn));
	if (!pages) return;
	const site = await siteLanguages(scope);
	for (const language of site.languages) {
		const languages = { language: language.code, defaultLanguage: site.defaultLanguage };
		const tree = await publishedPageTree(scope, pages.id, language.code);
		for (const pageId of tree.keys()) {
			const at = pathIn(tree, pageId);
			if (!at || pathText(at) !== pathText(parts)) continue;
			const row = await scope.first(entries, eq(entries.id, pageId));
			const title = readValue(storedVersion(row?.published), { key: "title", ...languages }) ?? "";
			throw new PathTakenError(languagePath(languages, pathText(parts)), { kind: "page", id: pageId, title }, taking);
		}
	}
}
