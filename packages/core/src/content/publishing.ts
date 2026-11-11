import { components, entries, gonePaths, popups, publishedSlugs, templates } from "@webcraft/db/schema";
import { parseElementTree } from "@webcraft/renderer";
import { and, eq } from "drizzle-orm";
import { announcePublished, mirrorDraftChange } from "../co-editing/store.ts";
import { publishConsentText } from "../consent/text.ts";
import { isSerializationFailure, isUniqueViolation } from "../db-errors.ts";
import { classCatalogue } from "../design-system/classes.ts";
import { draftDesignSystem, lockDesignSystem } from "../design-system/design-systems.ts";
import { publishDesignSystem, publishGeneratedClasses } from "../design-system/publishing.ts";
import { keepReplacedStylesheet, type SiteStyles, siteStyles } from "../design-system/stylesheet.ts";
import { publishFilter } from "../filters/filters.ts";
import { publishFormDraft, publishFormEmails } from "../forms/forms.ts";
import { saveRevision } from "../history/copies.ts";
import { isUuid } from "../ids.ts";
import { can } from "../permissions/can.ts";
import type { Permission } from "../permissions/roles.ts";
import { PopupPublishRequiredError, popupRow, publishPopup } from "../popups/index.ts";
import { indexPublishedEntry } from "../search/indexing.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError } from "../tenancy/errors.ts";
import { archiveAt, checkArchiveAddressFree, publishedArchives } from "./archives.ts";
import { storedComponentVersion } from "./component-versions.ts";
import {
	type ComponentSources,
	checkPublishedPlacements,
	componentTreeRules,
	lockComponent,
	lockComponents,
	NO_MODULE_COMPONENTS,
	readContext,
	siteComponents,
} from "./components.ts";
import { entryValues, lockEntry, versionFindings } from "./entries.ts";
import {
	EntryIncompleteError,
	EntryInvalidError,
	EntryNotFoundError,
	EntrySlugTakenError,
	PathTakenError,
} from "./errors.ts";
import type { FieldDefinition } from "./field-types.ts";
import { type Findings, findingsInEveryLanguage, type Languages, linksIn } from "./field-values.ts";
import { publishGlobals } from "./globals.ts";
import { itemPermission } from "./item-permission.ts";
import { sameJson } from "./json.ts";
import { checkPathOutsidePrefixes } from "./language-paths.ts";
import { languagePath, type SiteLanguages, siteLanguages } from "./languages.ts";
import { publishLoop } from "./loops.ts";
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
import { migratePropPlacements } from "./prop-migrations.ts";
import { checkReferences, saveLinks } from "./relationships.ts";
import { reviewsOnPublish } from "./review-items.ts";
import { leaveScheduledPublishes } from "./scheduled-items.ts";
import { publishScriptDraft } from "./scripts.ts";
import { checkTemplateForPublish, lockTemplate } from "./templates.ts";
import { pathFor } from "./url-patterns.ts";
import { type EntryVersion, ownValue, storedVersion } from "./values.ts";
import { isVisibleIn } from "./visibility.ts";

/**
 * One item to publish: an Entry, a Template, a Component, a script, a Form, the Globals, the Consent
 * banner's words or the Design system. Publish all publishes a ticked set of them, and a Scheduled publish a frozen version.
 */
export type PublishItem =
	| { kind: "entry"; id: string }
	| { kind: "template"; id: string }
	| { kind: "component"; id: string }
	| { kind: "loop"; id: string }
	| { kind: "filter"; id: string }
	| { kind: "script"; id: string }
	| { kind: "form"; id: string }
	| { kind: "popup"; id: string }
	| { kind: "popupContent"; id: string }
	/** A Form's emails (Content): its Notifications and Auto-reply. */
	| { kind: "formEmails"; id: string }
	| { kind: "globals" }
	| { kind: "consentBanner" }
	| { kind: "designSystem" };

/** A published path that a publish changed: where visitors found an Entry or Page, and where now. */
export type PathChange = { entryId: string; language: string; from: string; to: string };

/**
 * What publishing did. `pathChanges` lists every published path it changed (an Entry's new slug, a
 * Page that moved and every Page under it), so Redirect rules can send the old paths on.
 */
export type Published = { kind: PublishItem["kind"]; id: string; publishedAt: Date; pathChanges: PathChange[] };

/**
 * The Permission publishing an item needs: Content (Entries, the Globals, the Consent banner's words) takes `entry.publish`
 * (Editors, Owners, Staff); Structure (Templates, Components, scripts, the Design system) takes
 * `structure.edit` (Staff only).
 */
export function publishPermission(item: Pick<PublishItem, "kind">): Permission {
	return itemPermission(item.kind, "entry.publish");
}

/**
 * Checks the person may publish every one of `items` (`publishPermission`), refusing with the first
 * Permission they lack (`PermissionDeniedError`): what `publishItems`, Publish all and "Publish all
 * at…" each open with, before taking any lock.
 */
export function requirePublishPermissions(scope: SiteScope, items: readonly Pick<PublishItem, "kind">[]): void {
	const resource = { level: "site", workspaceId: scope.workspace.id, siteId: scope.site.id } as const;
	for (const permission of new Set(items.map(publishPermission))) {
		if (!can(scope.access.actor, permission, resource)) throw new PermissionDeniedError(permission);
	}
}

/** Items whose publish can change the Site's stylesheet: what it is built from (element trees' Classes). */
function changesStyles(item: PublishItem): boolean {
	return item.kind === "template" || item.kind === "component" || item.kind === "popup" || item.kind === "designSystem";
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
 * under it, a Post Type's URL pattern owns (`PathTakenError`), a Template or Component that no
 * longer fits what it renders (`ElementTreeInvalidError`), such as one placing a Component that
 * isn't published yet, and a Design system that can't be used as it is (`DesignSystemInvalidError`).
 * Publishing a Template, a Component or the Design system keeps the stylesheet it replaces for a
 * while, for pages loaded just before. `sources` gives the Components of the Modules running on the Site.
 */
export async function publish(
	scope: SiteScope,
	item: PublishItem,
	sources: ComponentSources = NO_MODULE_COMPONENTS,
): Promise<Published> {
	const [published] = await publishItems(scope, [item], sources);
	return published as Published;
}

/**
 * The version to publish of an item instead of its Draft, as the item's table stores its Draft (a
 * Scheduled publish's, frozen when it was scheduled); undefined publishes the Draft as it is now.
 */
export type FrozenVersions = (item: PublishItem) => unknown;

/**
 * Publishes several items together, in the order given, all or none (Publish all, ADR 0014): one
 * transaction, the locks every publish needs taken once, before any row lock and always in the same
 * order (the Site's paths, then the Components, then the Design system), so no two publishes ever wait
 * for each other in a circle; one page cache clear, and one replaced stylesheet kept; each item writes
 * its own Audit log entry, as publishing it alone does. Each item needs its own Permission
 * (`publishPermission`). `refusal`, when given, turns the reason an item can't be published into the
 * error that stops them all (a deadlock or serialization failure, Postgres giving up because another
 * transaction conflicted, is never turned: trying again later may just work; a deterministic failure,
 * such as a constraint, is turned like any other refusal, naming the item that caused it).
 *
 * `frozen`, when given, names the version to publish of each item instead of its Draft: a Scheduled
 * publish's, which the worker publishes at its time; every check runs on it as on a Draft. Without it
 * (publishing now), each item published leaves the Scheduled publish it waited in, since a newer
 * version is live already (`leaveScheduledPublishes`). An item In review ends its Review as published
 * (`reviewsOnPublish`), whatever published it.
 */
export async function publishItems(
	scope: SiteScope,
	items: readonly PublishItem[],
	sources: ComponentSources = NO_MODULE_COMPONENTS,
	refusal?: (item: PublishItem, error: unknown) => Error,
	frozen?: FrozenVersions,
): Promise<Published[]> {
	requirePublishPermissions(scope, items);
	return scope.transaction(async (tx) => {
		// Where Entries and Archive templates are depends on the patterns and the Page tree: held first.
		if (items.some((item) => item.kind === "entry" || item.kind === "template")) await lockSitePaths(tx);
		// Which Components are placed where is read under their lock.
		if (items.some((item) => item.kind === "template" || item.kind === "component" || item.kind === "popup"))
			await lockComponents(tx);
		let stylesBefore: SiteStyles | undefined;
		if (items.some(changesStyles)) {
			// Publishes that change the stylesheet take turns, so each reads the stylesheet the one
			// before it left and keeps it for pages loaded in between.
			await lockDesignSystem(tx);
			stylesBefore = await siteStyles(tx);
		}
		const published: Published[] = [];
		for (const item of items) {
			try {
				published.push(await publishItem(tx, item, sources, frozen?.(item)));
			} catch (error) {
				throw refusal && !isSerializationFailure(error) ? refusal(item, error) : error;
			}
			// Each publish saves a Revision of what it published, unless Revisions are off.
			await saveRevision(tx, item);
			// The people editing it live see who published it, once the publish commits.
			await announcePublished(tx, item);
		}
		if (!frozen) await leaveScheduledPublishes(tx, items);
		// An item In review that is published now ends its Review (its Author is emailed).
		await reviewsOnPublish(tx, items, frozen);
		if (stylesBefore) await keepReplacedStylesheet(tx, stylesBefore);
		await clearPageCache(tx);
		return published;
	});
}

/** Publishes one item: its Draft, or `version` when given (as its table stores its Draft). */
async function publishItem(
	scope: SiteScope,
	item: PublishItem,
	sources: ComponentSources,
	version: unknown,
): Promise<Published> {
	switch (item.kind) {
		case "entry":
			return publishEntry(scope, item.id, version);
		case "template":
			return publishTemplate(scope, item.id, sources, version);
		case "component": {
			const popup = isUuid(item.id) ? await scope.first(popups, eq(popups.componentId, item.id)) : undefined;
			if (popup) throw new PopupPublishRequiredError(popup.id);
			return publishComponent(scope, item.id, sources, version);
		}
		case "loop":
			return publishLoop(scope, item.id, version);
		case "filter":
			return publishFilter(scope, item.id, version);
		case "globals":
			return publishGlobals(scope, version);
		case "consentBanner":
			return publishConsentText(scope, version);
		case "designSystem": {
			const published = await publishDesignSystem(scope, version);
			return { kind: "designSystem", id: published.id, publishedAt: published.publishedAt, pathChanges: [] };
		}
		case "script": {
			const published = await publishScriptDraft(scope, item.id, version);
			return { kind: "script", id: published.id, publishedAt: published.publishedAt, pathChanges: [] };
		}
		case "popup": {
			const row = await popupRow(scope, item.id);
			const frozen = version as { settings: unknown; component: unknown } | undefined;
			await publishComponent(scope, row.componentId, sources, frozen?.component);
			await saveRevision(scope, { kind: "component", id: row.componentId });
			await announcePublished(scope, { kind: "component", id: row.componentId });
			if (!frozen) await leaveScheduledPublishes(scope, [{ kind: "component", id: row.componentId }]);
			return publishPopup(scope, item.id, false, frozen?.settings);
		}
		case "popupContent":
			return publishPopup(scope, item.id, item.kind === "popupContent", version);
		case "form": {
			const published = await publishFormDraft(scope, item.id, version);
			return { kind: "form", id: published.id, publishedAt: published.publishedAt, pathChanges: [] };
		}
		case "formEmails": {
			const published = await publishFormEmails(scope, item.id, version);
			return { kind: "formEmails", id: published.id, publishedAt: published.publishedAt, pathChanges: [] };
		}
	}
}

/**
 * Checks an Entry's Draft as publishing would check its values, publishing nothing: refuses values
 * that break a rule (`EntryInvalidError`) and empty required values, the title and slug included
 * (`EntryIncompleteError`). Where it would be published (its slug, its parent Page, its path) is
 * checked when it is published. Submitting it for Review asks it.
 */
export async function checkEntryReady(scope: SiteScope, entryId: string): Promise<void> {
	const row = await scope.first(entries, eq(entries.id, entryId));
	if (!row) throw new EntryNotFoundError();
	const postType = await getPostType(scope, row.postTypeId);
	const findings = publishFindings(storedVersion(row.draft), postType.fields, await siteLanguages(scope));
	await checkReferences(scope, findings.references, "rule");
	if (findings.problems.some((problem) => problem.rule !== "required")) throw new EntryInvalidError(findings.problems);
	if (findings.missing.length > 0) throw new EntryIncompleteError(findings.missing);
}

async function publishEntry(scope: SiteScope, entryId: string, version: unknown): Promise<Published> {
	// Where an Entry is published depends on the patterns and the Page tree: hold them first.
	await lockSitePaths(scope);
	const row = await lockEntry(scope, entryId);
	const postType = await getPostType(scope, row.postTypeId);
	const site = await siteLanguages(scope);
	const { defaultLanguage } = site;
	const draft = storedVersion(version ?? row.draft);
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
		{ published: draft, publishedAt: row.publishedAt ?? now, lastPublishedAt: now, unpublishedAt: null },
		eq(entries.id, row.id),
	);
	// Published again: its old paths answer as pages again, not 410 Gone.
	await scope.delete(gonePaths, eq(gonePaths.entryId, row.id));
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
	// Found by Site search as soon as its page shows; indexing never fails the publish.
	await indexPublishedEntry(scope, row.id);
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
 * What keeps a version from being published, in every language of the Site it is shown in (a
 * language the Entry is hidden in shows none of its values).
 */
function publishFindings(draft: EntryVersion, fields: readonly FieldDefinition[], site: SiteLanguages): Findings {
	return findingsInEveryLanguage(site.languages, site.defaultLanguage, (languages) =>
		isVisibleIn(draft, languages) ? versionFindings(draft, fields, languages) : undefined,
	);
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
	const archives = await publishedArchives(scope, postTypes);
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
		const archive = archiveAt(archives, parts);
		if (archive) {
			throw new PathTakenError(visible(parts), {
				kind: "archive",
				postTypeId: archive.postType.id,
				name: archive.postType.name,
			});
		}
		const from = before.get(id);
		if (from && pathText(from) !== pathText(parts)) {
			changes.push({ entryId: id, language, from: visible(from), to: visible(parts) });
		}
	}
	return { path: visible(pathIn(tree, pageId) ?? []), changes };
}

/** Publishes a Template; `publish` has taken the Components' lock, so what it may place holds still. */
async function publishTemplate(
	scope: SiteScope,
	templateId: string,
	sources: ComponentSources,
	version: unknown,
): Promise<Published> {
	// An Archive template takes its address: hold the Site's paths before any row.
	await lockSitePaths(scope);
	const row = await lockTemplate(scope, templateId);
	if (row.kind === "archive") await checkArchiveAddressFree(scope, await getPostType(scope, row.postTypeId ?? ""));
	// What it renders through (the Post Type, the Globals, what Relationships point at, the Classes,
	// the published Components it places) may have changed since the Draft was saved.
	const tree = await checkTemplateForPublish(scope, version === undefined ? row : { ...row, draft: version }, sources);
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

/**
 * Publishes a Component's Draft, its Props and tree together: every copy changes at once, wherever
 * it is placed. Checked again first, against the published versions of the Components it places
 * (each must be published) and what it reads (the Globals, the Post Types, the Classes). `publish`
 * has taken the Components' lock.
 */
async function publishComponent(
	scope: SiteScope,
	componentId: string,
	sources: ComponentSources,
	version: unknown,
): Promise<Published> {
	const row = await lockComponent(scope, componentId, sources);
	const draft = storedComponentVersion(version ?? row.draft);
	const catalogue = await siteComponents(scope, "published", sources, { self: row.id });
	const { ids } = classCatalogue(await draftDesignSystem(scope));
	const tree = parseElementTree(draft.tree, {
		...componentTreeRules(draft.props, await readContext(scope, "published"), catalogue),
		classIds: ids,
	});
	await migratePropPlacements(
		scope,
		row.id,
		storedComponentVersion(row.draft),
		draft,
		"publish",
		row.published === null ? null : storedComponentVersion(row.published),
	);
	// Every copy changes: each must still fit where it is placed and published.
	await checkPublishedPlacements(scope, row.id, { props: draft.props, tree }, sources);
	// Its generated Classes go live with it, as a Template's do.
	await publishGeneratedClasses(scope, tree);
	const now = scope.now();
	await scope.update(
		components,
		{
			...(sameJson(storedComponentVersion(row.draft).props, draft.props)
				? { draft: { props: draft.props, tree: storedComponentVersion(row.draft).tree } }
				: {}),
			published: { props: draft.props, tree },
			publishedAt: row.publishedAt ?? now,
			lastPublishedAt: now,
		},
		eq(components.id, row.id),
	);
	if (sameJson(storedComponentVersion(row.draft).props, draft.props)) {
		await mirrorDraftChange(scope, { kind: "component", id: row.id }, row.draft, {
			props: draft.props,
			tree: storedComponentVersion(row.draft).tree,
		});
	}
	await scope.audit("component.publish", { componentId: row.id, name: row.name });
	return { kind: "component", id: row.id, publishedAt: now, pathChanges: [] };
}
