import type { Database } from "@webcraft/db";
import { entries, people, publishedSlugs, sites, templates } from "@webcraft/db/schema";
import {
	builtInNotFoundPage,
	directionOf,
	type ElementTree,
	type PageToRender,
	renderPage,
	richText,
	type TemplateValue,
} from "@webcraft/renderer";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import type { InstallConfig } from "../config.ts";
import { entryValues } from "../content/entries.ts";
import { findPublishedPage, isPagePostType } from "../content/pages.ts";
import { listPostTypes, type PostType } from "../content/post-types.ts";
import { specialPageId } from "../content/special-pages.ts";
import { bySpecificity, parseUrlPattern, pathSegments, slugIn, type UrlPattern } from "../content/url-patterns.ts";
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

/** What a path on a Site answers: its page, or a permanent redirect (the home page's own path goes to `/`). */
export type SiteAnswer = ({ kind: "page" } & SitePage) | { kind: "redirect"; location: string };

/**
 * The Site side of the content store, for the web process's Site request pipeline: which Site a
 * hostname belongs to, the page at a path and the Site's 404 page. Only published content is read.
 */
export type SitePages = {
	/** The Site a hostname belongs to, or null for a hostname that is no Site's (an unbranded 404). */
	resolveHost(hostname: string): Promise<SiteHost | null>;
	/**
	 * What `pathname` answers on the Site: the published Entry a Post Type's URL pattern finds there,
	 * else the published Page at that path (the home page at `/`); null when there is none.
	 */
	render(host: SiteHost, pathname: string): Promise<SiteAnswer | null>;
	/**
	 * The Site's 404 page, for a path with no page: the Page Staff chose, once published, else the
	 * built-in one, in the Site template.
	 */
	notFound(host: SiteHost): Promise<SitePage>;
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
			if (!segments || isReservedPath(segments)) return null;
			const scope = data.visitors(host.site);
			const postTypes = await listPostTypes(scope);
			const home = await specialPageId(scope, "home");
			// Post Types' URL patterns own every path they match; Pages live outside them.
			const found =
				segments.length === 0
					? home && (await publishedPage(scope, postTypes, home))
					: ((await findPublishedEntry(scope, postTypes, segments, host.defaultLanguage)) ??
						(await findPage(scope, postTypes, segments, host.defaultLanguage)));
			if (!found) return null;
			if (segments.length > 0 && found.entry.id === home) return { kind: "redirect", location: "/" };
			return { kind: "page", html: await renderEntryPage(scope, host, found) };
		},

		async notFound(host) {
			const scope = data.visitors(host.site);
			const chosen = await specialPageId(scope, "notFound");
			const found = chosen && (await publishedPage(scope, await listPostTypes(scope), chosen));
			if (found) return { html: await renderEntryPage(scope, host, found) };
			const builtIn = builtInNotFoundPage(host.defaultLanguage);
			return { html: await renderSitePage(scope, host, { ...builtIn, values: () => undefined }) };
		},
	};
}

/**
 * Paths the Install keeps on every Site, outside Pages and Post Types: everything under a first part
 * starting with `_` (`/_webcraft/…`, `/_media/…`, `/_content/v1/…`, `/_wc/m/<module>/…`) and every
 * path naming a file, with a dot in it (`/sitemap.xml`, `/robots.txt`, `/llms.txt`, Markdown copies
 * such as `/about.md`). No slug or URL pattern part can start with `_` or hold a dot, so no Page or
 * Entry is ever there. Each feature answers its own paths; until then they are a plain 404.
 */
export function isReservedPath(segments: readonly string[]): boolean {
	return (segments[0]?.startsWith("_") ?? false) || segments.some((segment) => segment.includes("."));
}

/** A published Entry to render, with what its content renders through: its Entry template or Page layout. */
type FoundEntry = { postType: PostType; entry: typeof entries.$inferSelect; content: ElementTree };

/**
 * A Page's layout: the Components placed in its content area. Pages get their Page layout with
 * Components; until then a Page's content is empty.
 */
const EMPTY_PAGE_LAYOUT: ElementTree = { version: 1, nodes: [] };

/**
 * The published Entry at a path: each Post Type's URL pattern is tried, most specific first, and the
 * first one whose slug a published Entry has wins. An Entry whose Entry template isn't published
 * has no page yet.
 */
async function findPublishedEntry(
	scope: VisitorScope,
	postTypes: readonly PostType[],
	segments: readonly string[],
	language: string,
): Promise<FoundEntry | undefined> {
	const candidates = postTypes
		.filter((postType) => !isPagePostType(postType))
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
		return { postType, entry, content: template.published as ElementTree };
	}
	return undefined;
}

/** The published Page at a path: its parent Page's path and its own slug. */
async function findPage(
	scope: VisitorScope,
	postTypes: readonly PostType[],
	segments: readonly string[],
	language: string,
): Promise<FoundEntry | undefined> {
	const pages = postTypes.find(isPagePostType);
	if (!pages) return undefined;
	const pageId = await findPublishedPage(scope, pages.id, segments, language);
	if (!pageId) return undefined;
	return publishedPage(scope, postTypes, pageId);
}

/** A published Page of the Site, by id, ready to render; undefined when it isn't one. */
async function publishedPage(
	scope: VisitorScope,
	postTypes: readonly PostType[],
	pageId: string,
): Promise<FoundEntry | undefined> {
	const pages = postTypes.find(isPagePostType);
	const entry = await scope.first(entries, and(eq(entries.id, pageId), isNotNull(entries.published)));
	return pages && entry?.postTypeId === pages.id ? { postType: pages, entry, content: EMPTY_PAGE_LAYOUT } : undefined;
}

async function renderEntryPage(scope: VisitorScope, host: SiteHost, found: FoundEntry): Promise<string> {
	const { postType, entry, content } = found;
	const language = host.defaultLanguage;
	const published = entryValues(storedVersion(entry.published), postType.fields, {
		language,
		defaultLanguage: host.defaultLanguage,
	});
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
	const fields: Record<string, TemplateValue> = {};
	for (const field of postType.fields) {
		const value = published.fields[field.key] ?? null;
		fields[field.key] = field.type === "richText" && value !== null ? richText(value) : value;
	}
	return renderSitePage(scope, host, {
		title: published.title,
		content,
		values: (path) => (Object.hasOwn(builtIns, path) ? builtIns[path] : fields[path]),
	});
}

/** A page of the Site in its Site template (the published one, or the built-in one), with its Classes. */
async function renderSitePage(
	scope: VisitorScope,
	host: SiteHost,
	page: Pick<PageToRender, "title" | "content" | "values">,
): Promise<string> {
	const language = host.defaultLanguage;
	const classNames = new Map((await listClasses(scope)).map((siteClass) => [siteClass.id, siteClass.name]));
	return renderPage({
		...page,
		site: { name: host.site.name, language, direction: directionOf(language) },
		siteTemplate: await publishedSiteTemplate(scope),
		className: (classId) => classNames.get(classId),
	});
}

/** The Site template visitors see, or undefined while none is published (pages get the built-in one). */
async function publishedSiteTemplate(scope: VisitorScope): Promise<ElementTree | undefined> {
	const row = await scope.first(
		templates,
		and(eq(templates.kind, "site"), isNull(templates.postTypeId), isNotNull(templates.published)),
	);
	return (row?.published as ElementTree | null) ?? undefined;
}

async function nameOf(scope: VisitorScope, personId: string): Promise<string | null> {
	const [row] = await scope.db.select({ name: people.name }).from(people).where(eq(people.id, personId));
	return row?.name ?? null;
}
