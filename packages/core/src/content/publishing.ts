import { entries, publishedSlugs, templates } from "@webcraft/db/schema";
import { and, eq } from "drizzle-orm";

import { isUniqueViolation } from "../db-errors.ts";
import { lockDesignSystem } from "../design-system/design-systems.ts";
import { publishDesignSystem, publishGeneratedClasses } from "../design-system/publishing.ts";
import { keepReplacedStylesheet, type SiteStyles, siteStyles } from "../design-system/stylesheet.ts";
import { can } from "../permissions/can.ts";
import type { Permission } from "../permissions/roles.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError } from "../tenancy/errors.ts";
import { entryValues, lockEntry, versionFindings } from "./entries.ts";
import { EntryIncompleteError, EntryInvalidError, EntrySlugTakenError, PathTakenError } from "./errors.ts";
import type { FieldDefinition } from "./field-types.ts";
import { type Findings, type Languages, linksIn } from "./field-values.ts";
import { publishGlobals } from "./globals.ts";
import { checkPathOutsidePrefixes } from "./language-paths.ts";
import { languagePath, type SiteLanguages, siteLanguages } from "./languages.ts";
import { clearPageCache } from "./page-cache.ts";
import {
	checkPublishedParent,
	isPagePostType,
	lockSitePaths,
	MAX_PAGE_DEPTH,
	pagesUnder,
	parentIn,
	pathIn,
	pathText,
	patternOwning,
	publishedPageTree,
} from "./pages.ts";
import { getPostType, listPostTypes, type PostType } from "./post-types.ts";
import { checkReferences, saveLinks } from "./relationships.ts";
import { checkTemplateForPublish, lockTemplate } from "./templates.ts";
import { pathFor } from "./url-patterns.ts";
import { type EntryVersion, ownValue, storedVersion } from "./values.ts";

/**
 * One item to publish. Components and Forms join Entries, Templates, the Globals and the Design
 * system; Publish all publishes a ticked set of them, and a Scheduled publish a frozen version.
 */
export type PublishItem =
	| { kind: "entry"; id: string }
	| { kind: "template"; id: string }
	| { kind: "globals" }
	| { kind: "designSystem" };

/** A published path that a publish changed: where visitors found an Entry or Page, and where now. */
export type PathChange = { entryId: string; language: string; from: string; to: string };

/**
 * What publishing did. `pathChanges` lists every published path it changed (an Entry's new slug, a
 * Page that moved and every Page under it), so Redirect rules can send the old paths on.
 */
export type Published = { kind: PublishItem["kind"]; id: string; publishedAt: Date; pathChanges: PathChange[] };

/**
 * The Permission publishing an item needs: Content (Entries, the Globals) takes `entry.publish`
 * (Editors, Owners, Staff); Structure (Templates, the Design system) takes `structure.edit` (Staff only).
 */
export function publishPermission(item: Pick<PublishItem, "kind">): Permission {
	return item.kind === "template" || item.kind === "designSystem" ? "structure.edit" : "entry.publish";
}

/** Items whose publish can change the Site's stylesheet: what it is built from. */
function changesStyles(item: PublishItem): boolean {
	return item.kind === "template" || item.kind === "designSystem";
}

/**
 * Publishes one item: its Draft becomes what visitors see. In one transaction it copies the Draft
 * over the published version, clears the Site's page cache and writes the Audit log, so visitors get
 * the new version with the next request. Open the Site with `publishPermission(item)`; the check runs
 * again here, so every caller (the admin, the worker's Scheduled publishes) holds it.
 *
 * Refuses an Entry (or the Globals) whose values break a rule (`EntryInvalidError`) or whose required
 * values are empty (`EntryIncompleteError`), an Entry whose slug another published Entry of its Post
 * Type has (`EntrySlugTakenError`; for a Page, another published Page under the same parent), a Page
 * whose parent Page isn't published (`PageParentUnpublishedError`) or whose path, or that of a Page
 * under it, a Post Type's URL pattern owns (`PathTakenError`), a Template that no longer fits
 * what it renders (`ElementTreeInvalidError`), and a Design system that can't be used as it is
 * (`DesignSystemInvalidError`). Publishing a Template or the Design system keeps the stylesheet it
 * replaces for a while, for pages loaded just before.
 */
export async function publish(scope: SiteScope, item: PublishItem): Promise<Published> {
	const permission = publishPermission(item);
	const resource = { level: "site", workspaceId: scope.workspace.id, siteId: scope.site.id } as const;
	if (!can(scope.access.actor, permission, resource)) throw new PermissionDeniedError(permission);
	return scope.transaction(async (tx) => {
		let stylesBefore: SiteStyles | undefined;
		if (changesStyles(item)) {
			// Publishes that change the stylesheet take turns, so each reads the stylesheet the one
			// before it left and keeps it for pages loaded in between.
			await lockDesignSystem(tx);
			stylesBefore = await siteStyles(tx);
		}
		const published = await publishItem(tx, item);
		if (stylesBefore) await keepReplacedStylesheet(tx, stylesBefore);
		await clearPageCache(tx);
		return published;
	});
}

async function publishItem(scope: SiteScope, item: PublishItem): Promise<Published> {
	switch (item.kind) {
		case "entry":
			return publishEntry(scope, item.id);
		case "template":
			return publishTemplate(scope, item.id);
		case "globals":
			return publishGlobals(scope);
		case "designSystem": {
			const published = await publishDesignSystem(scope);
			return { kind: "designSystem", id: published.id, publishedAt: published.publishedAt, pathChanges: [] };
		}
	}
}

async function publishEntry(scope: SiteScope, entryId: string): Promise<Published> {
	// Where an Entry is published depends on the patterns and the Page tree: hold them first.
	await lockSitePaths(scope);
	const row = await lockEntry(scope, entryId);
	const postType = await getPostType(scope, row.postTypeId);
	const site = await siteLanguages(scope);
	const { defaultLanguage } = site;
	const draft = storedVersion(row.draft);
	const findings = publishFindings(draft, postType.fields, site);
	await checkReferences(scope, findings.references, "rule");
	if (findings.problems.some((problem) => problem.rule !== "required")) throw new EntryInvalidError(findings.problems);
	if (findings.missing.length > 0) throw new EntryIncompleteError(findings.missing);
	const values = entryValues(draft, postType.fields, { language: defaultLanguage, defaultLanguage });
	const parentId = isPagePostType(postType) ? parentIn(draft, defaultLanguage) : null;
	const before = await scope.select(publishedSlugs, eq(publishedSlugs.entryId, row.id));
	const slugs = site.languages.map((language) => ({
		languages: { language: language.code, defaultLanguage },
		slug: publishedSlug(draft, language.code, defaultLanguage, before),
	}));
	const paths: NewPaths[] = [];
	for (const { languages, slug } of slugs) {
		paths.push(
			isPagePostType(postType)
				? await pagePaths(scope, postType, row.id, { parentId, slug }, languages, site)
				: await entryPaths(scope, postType, row.id, slug, languages, site),
		);
	}
	const pathChanges = paths.flatMap((path) => path.changes);

	const now = scope.now();
	await scope.update(
		entries,
		{ published: draft, publishedAt: row.publishedAt ?? now, lastPublishedAt: now },
		eq(entries.id, row.id),
	);
	await saveLinks(scope, row.id, "published", linksIn(draft.values, postType.fields));
	await scope.delete(publishedSlugs, eq(publishedSlugs.entryId, row.id));
	for (const { languages, slug } of slugs) {
		try {
			await scope.insert(publishedSlugs, {
				entryId: row.id,
				postTypeId: row.postTypeId,
				language: languages.language,
				slug,
				parentId,
			});
		} catch (error) {
			if (isUniqueViolation(error, "published_slugs_slug_unique")) {
				throw new EntrySlugTakenError(slug, isPagePostType(postType) ? "siblingPages" : "postType", languages);
			}
			throw error;
		}
	}
	await scope.audit("entry.publish", {
		entryId: row.id,
		postTypeId: row.postTypeId,
		title: values.title,
		slug: values.slug,
		path: paths[0]?.path ?? null,
		pathChanges,
	});
	return { kind: "entry", id: row.id, publishedAt: now, pathChanges };
}

/**
 * The slug an Entry is published with in a language. Slugs are translatable but never change on
 * their own once published: a language's own slug when it has one, else the slug it was published
 * with before, else (the first time) the Default language's.
 */
function publishedSlug(
	draft: EntryVersion,
	language: string,
	defaultLanguage: string,
	before: readonly { language: string; slug: string }[],
): string {
	const own = ownValue(draft, "slug", language);
	if (own || language === defaultLanguage) return own ?? "";
	const kept = before.find((row) => row.language === language)?.slug;
	return kept ?? ownValue(draft, "slug", defaultLanguage) ?? "";
}

/**
 * What keeps a version from being published, in every language of the Site: each language's values
 * are checked (a language falls back to the Default language one Field at a time), and each problem is
 * reported once, with its language when it isn't the Default language's.
 */
function publishFindings(draft: EntryVersion, fields: readonly FieldDefinition[], site: SiteLanguages): Findings {
	const all: Findings = { problems: [], missing: [], references: [] };
	const seen = new Set<string>();
	for (const language of site.languages) {
		const found = versionFindings(draft, fields, { language: language.code, defaultLanguage: site.defaultLanguage });
		for (const problem of found.problems) {
			const key = `${problem.at} ${problem.rule} ${problem.message}`;
			if (seen.has(key)) continue;
			seen.add(key);
			all.problems.push(language.default ? problem : { ...problem, language: language.code });
		}
		for (const missing of found.missing) if (!all.missing.includes(missing)) all.missing.push(missing);
		for (const reference of found.references) {
			const key = `references ${reference.at} ${reference.ids.join(" ")}`;
			if (seen.has(key)) continue;
			seen.add(key);
			all.references.push({ ...reference, problems: all.problems });
		}
	}
	return all;
}

/** Where a published Entry will be, and which published paths publishing it changes. */
type NewPaths = { path: string; changes: PathChange[] };

/** An Entry's path in a language under its Post Type's URL pattern, before and after publishing its new slug. */
async function entryPaths(
	scope: SiteScope,
	postType: PostType,
	entryId: string,
	slug: string,
	languages: Languages,
	site: SiteLanguages,
): Promise<NewPaths> {
	const before = await scope.first(
		publishedSlugs,
		and(eq(publishedSlugs.entryId, entryId), eq(publishedSlugs.language, languages.language)),
	);
	const pathOf = (value: string) => {
		const path = pathFor(postType.urlPattern, value);
		return path === null ? null : languagePath(languages, path);
	};
	const path = pathOf(slug) ?? "";
	// The Default language's paths stay out of the other languages' prefixes.
	if (languages.language === languages.defaultLanguage) checkPathOutsidePrefixes(site, path.split("/").slice(1), path);
	const from = before ? pathOf(before.slug) : null;
	return {
		path,
		changes: from && from !== path ? [{ entryId, language: languages.language, from, to: path }] : [],
	};
}

/**
 * A Page's path in a language, and those of the Pages under it, before and after it is published
 * under `parentId` with `slug`. Refuses a parent that isn't published or would make a loop, Pages
 * ending up more than `MAX_PAGE_DEPTH` deep, and a path a Post Type's URL pattern owns
 * (`PathTakenError`).
 */
async function pagePaths(
	scope: SiteScope,
	pages: PostType,
	pageId: string,
	next: { parentId: string | null; slug: string },
	languages: Languages,
	site: SiteLanguages,
): Promise<NewPaths> {
	const { language } = languages;
	const tree = await publishedPageTree(scope, pages.id, language);
	if (next.parentId !== null) checkPublishedParent(tree, pageId, next.parentId);
	const moving = [pageId, ...pagesUnder(tree, pageId)];
	const before = new Map(moving.map((id) => [id, pathIn(tree, id)]));
	tree.set(pageId, next);
	const postTypes = await listPostTypes(scope);
	const changes: PathChange[] = [];
	const visible = (parts: readonly string[]) => languagePath(languages, pathText(parts));
	for (const id of moving) {
		const parts = pathIn(tree, id) ?? [];
		if (parts.length > MAX_PAGE_DEPTH) {
			throw new EntryInvalidError([{ at: "parentId", message: `Pages nest at most ${MAX_PAGE_DEPTH} deep.` }]);
		}
		if (languages.language === languages.defaultLanguage) checkPathOutsidePrefixes(site, parts, visible(parts));
		const owner = patternOwning(postTypes, parts);
		if (owner) {
			throw new PathTakenError(visible(parts), {
				kind: "postType",
				id: owner.id,
				name: owner.name,
				urlPattern: owner.urlPattern,
			});
		}
		const from = before.get(id);
		if (from && pathText(from) !== pathText(parts)) {
			changes.push({ entryId: id, language, from: visible(from), to: visible(parts) });
		}
	}
	return { path: visible(pathIn(tree, pageId) ?? []), changes };
}

async function publishTemplate(scope: SiteScope, templateId: string): Promise<Published> {
	const row = await lockTemplate(scope, templateId);
	// What it renders through (the Post Type, the Globals, what Relationships point at, the Classes)
	// may have changed since the Draft was saved.
	const tree = await checkTemplateForPublish(scope, row);
	await publishGeneratedClasses(scope, tree);
	const now = scope.now();
	await scope.update(
		templates,
		{ published: tree, publishedAt: row.publishedAt ?? now, lastPublishedAt: now },
		eq(templates.id, row.id),
	);
	await scope.audit("template.publish", { templateId: row.id, kind: row.kind, postTypeId: row.postTypeId });
	return { kind: "template", id: row.id, publishedAt: now, pathChanges: [] };
}
