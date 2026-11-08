import type { Database } from "@webcraft/db";
import { entries, globals, people, publishedSlugs, sites, templates } from "@webcraft/db/schema";
import { directionOf, type ElementTree, renderPage, type TemplateValue } from "@webcraft/renderer";
import { and, eq, isNotNull } from "drizzle-orm";

import type { InstallConfig } from "../config.ts";
import { entryValues } from "../content/entries.ts";
import { linksIn } from "../content/field-values.ts";
import { publishedGlobals } from "../content/globals.ts";
import { listPostTypes, type PostType } from "../content/post-types.ts";
import { publishedEntries } from "../content/relationships.ts";
import { entryParts, globalsParts, type RelatedEntry, resolvePath } from "../content/render-values.ts";
import {
	bySpecificity,
	parseUrlPattern,
	pathFor,
	pathSegments,
	slugIn,
	type UrlPattern,
} from "../content/url-patterns.ts";
import { storedVersion } from "../content/values.ts";
import { listClasses } from "../design-system/classes.ts";
import type { DataLayer, Site, VisitorScope } from "../tenancy/data-layer.ts";
import { slugOfStagingHostname } from "./addresses.ts";

export { canonicalPath, pathSegments } from "../content/url-patterns.ts";
export { reservedSlugs, stagingHostname, stagingUrl } from "./addresses.ts";

/** A Site found by the hostname a request came in on. */
export type SiteHost = {
	site: Site;
	/** How the hostname reaches the Site: its Staging address. Primary and Redirect domains join it. */
	address: "staging";
	/** The Site's Default language. */
	defaultLanguage: string;
	/**
	 * The Site's page cache generation: a page rendered now stays valid until a publish raises it.
	 * Read before the page, so a page is never kept under a newer generation than its content.
	 */
	cacheGeneration: number;
};

/** A rendered page of a Site. */
export type SitePage = { html: string };

/**
 * The Site side of the content store, for the web process's Site request pipeline: which Site a
 * hostname belongs to, and the page at a path. Only published content is read.
 */
export type SitePages = {
	/** The Site a hostname belongs to, or null for a hostname that is no Site's (an unbranded 404). */
	resolveHost(hostname: string): Promise<SiteHost | null>;
	/** The published page at `pathname` on the Site, or null when there is none. */
	render(host: SiteHost, pathname: string): Promise<SitePage | null>;
};

export function createSitePages(options: { database: Database; config: InstallConfig; data: DataLayer }): SitePages {
	const { database, config, data } = options;
	return {
		async resolveHost(hostname) {
			const slug = slugOfStagingHostname(config, hostname);
			if (!slug) return null;
			const [row] = await database.db.select().from(sites).where(eq(sites.slug, slug));
			if (!row) return null;
			return {
				site: { id: row.id, workspaceId: row.workspaceId, name: row.name, slug: row.slug, createdAt: row.createdAt },
				address: "staging",
				defaultLanguage: row.defaultLanguage,
				cacheGeneration: row.pageCacheGeneration,
			};
		},

		async render(host, pathname) {
			const segments = pathSegments(pathname);
			if (!segments) return null;
			const scope = data.visitors(host.site);
			const found = await findPublishedEntry(scope, segments, host.defaultLanguage);
			if (!found) return null;
			return { html: await renderEntryPage(scope, host, found) };
		},
	};
}

type FoundEntry = {
	postType: PostType;
	postTypes: readonly PostType[];
	entry: typeof entries.$inferSelect;
	template: ElementTree;
};

/**
 * The published Entry at a path: each Post Type's URL pattern is tried, most specific first, and the
 * first one whose slug a published Entry has wins. An Entry whose Entry template isn't published
 * has no page yet.
 */
async function findPublishedEntry(
	scope: VisitorScope,
	segments: readonly string[],
	language: string,
): Promise<FoundEntry | undefined> {
	const postTypes = await listPostTypes(scope);
	const candidates = postTypes
		.map((postType) => ({ postType, pattern: parseUrlPattern(postType.urlPattern) }))
		.filter((candidate): candidate is { postType: PostType; pattern: UrlPattern } => !("problem" in candidate.pattern))
		.sort((a, b) => bySpecificity(a.pattern, b.pattern));
	for (const { postType, pattern } of candidates) {
		const slug = slugIn(pattern, segments);
		if (!slug) continue;
		const route = await scope.first(
			publishedSlugs,
			and(
				eq(publishedSlugs.postTypeId, postType.id),
				eq(publishedSlugs.language, language),
				eq(publishedSlugs.slug, slug),
			),
		);
		if (!route) continue;
		const entry = await scope.first(entries, and(eq(entries.id, route.entryId), isNotNull(entries.published)));
		if (!entry) continue;
		const template = await scope.first(
			templates,
			and(eq(templates.kind, "entry"), eq(templates.postTypeId, postType.id), isNotNull(templates.published)),
		);
		if (!template) return undefined;
		return { postType, postTypes, entry, template: template.published as ElementTree };
	}
	return undefined;
}

async function renderEntryPage(scope: VisitorScope, host: SiteHost, found: FoundEntry): Promise<string> {
	const { postType, entry, template } = found;
	const language = host.defaultLanguage;
	const languages = { language, defaultLanguage: host.defaultLanguage };
	const version = storedVersion(entry.published);
	const published = entryValues(version, postType.fields, languages);
	const authorName = entry.authorId ? await nameOf(scope, entry.authorId) : null;
	// Visitors see the published version: nothing here tells them about the Draft, so its status
	// is "published" and it was last updated when it was last published.
	const builtIns: Record<string, TemplateValue> = {
		title: published.title,
		slug: published.slug,
		status: "published",
		author: authorName,
		createdAt: entry.createdAt,
		updatedAt: entry.lastPublishedAt,
		publishedAt: entry.publishedAt,
		lastPublishedAt: entry.lastPublishedAt,
	};
	const site = publishedGlobals(await scope.first(globals), languages);
	const root = entryParts(builtIns, postType.fields, published.fields, {
		related: await relatedEntries(
			scope,
			found,
			linksIn(version.values, postType.fields).map((link) => link.targetId),
			languages,
		),
		site: globalsParts(site.fields, site.values),
	});
	const classNames = new Map((await listClasses(scope)).map((siteClass) => [siteClass.id, siteClass.name]));
	return renderPage({
		site: { name: host.site.name, language, direction: directionOf(language) },
		title: published.title,
		template,
		values: (path) => resolvePath(root, path),
		className: (classId) => classNames.get(classId),
	});
}

/** The published Entries the page's Relationships point at, read in the page's language. */
async function relatedEntries(
	scope: VisitorScope,
	found: FoundEntry,
	ids: readonly string[],
	languages: { language: string; defaultLanguage: string },
): Promise<Map<string, RelatedEntry>> {
	const byId = new Map(found.postTypes.map((postType) => [postType.id, postType]));
	const related = new Map<string, RelatedEntry>();
	for (const row of await publishedEntries(scope, [...new Set(ids)])) {
		const postType = byId.get(row.postTypeId);
		if (!postType) continue;
		const values = entryValues(storedVersion(row.published), postType.fields, languages);
		related.set(row.id, {
			fields: postType.fields,
			values: values.fields,
			builtIns: {
				title: values.title,
				slug: values.slug,
				url: values.slug ? pathFor(postType.urlPattern, values.slug) : null,
				createdAt: row.createdAt,
				updatedAt: row.lastPublishedAt,
				publishedAt: row.publishedAt,
				lastPublishedAt: row.lastPublishedAt,
			},
		});
	}
	return related;
}

async function nameOf(scope: VisitorScope, personId: string): Promise<string | null> {
	const [row] = await scope.db.select({ name: people.name }).from(people).where(eq(people.id, personId));
	return row?.name ?? null;
}
