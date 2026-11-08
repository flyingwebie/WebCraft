import type { Database } from "@webcraft/db";
import { entries, people, publishedSlugs, sites, templates } from "@webcraft/db/schema";
import { directionOf, type ElementTree, mediaReferencesIn, renderPage, type TreeNode } from "@webcraft/renderer";
import { and, eq, isNotNull } from "drizzle-orm";

import type { InstallConfig } from "../config.ts";
import { entryValues } from "../content/entries.ts";
import { listPostTypes, type PostType } from "../content/post-types.ts";
import { bySpecificity, parseUrlPattern, pathSegments, slugIn, type UrlPattern } from "../content/url-patterns.ts";
import { storedVersion } from "../content/values.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import { type StoredMediaFile, storedFile } from "../media/library.ts";
import { pageMedia } from "../media/page-media.ts";
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
	/**
	 * A Media file of the Site by the name it is served under (`/_media/<name>`): an original or a
	 * variant, never a raw upload. Null when the Site has none by that name.
	 */
	mediaFile(host: SiteHost, name: string): Promise<StoredMediaFile | null>;
};

export function createSitePages(options: {
	database: Database;
	config: InstallConfig;
	data: DataLayer;
	storage: InstallStorage;
}): SitePages {
	const { database, config, data, storage } = options;
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

		mediaFile(host, name) {
			return storedFile(data.visitors(host.site), storage, name);
		},
	};
}

type FoundEntry = { postType: PostType; entry: typeof entries.$inferSelect; template: ElementTree };

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
	const candidates = (await listPostTypes(scope))
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
		return { postType, entry, template: template.published as ElementTree };
	}
	return undefined;
}

async function renderEntryPage(scope: VisitorScope, host: SiteHost, found: FoundEntry): Promise<string> {
	const { postType, entry, template } = found;
	const language = host.defaultLanguage;
	const published = entryValues(storedVersion(entry.published), postType.fields, {
		language,
		defaultLanguage: host.defaultLanguage,
	});
	const authorName = entry.authorId ? await nameOf(scope, entry.authorId) : null;
	// Visitors see the published version: nothing here tells them about the Draft, so its status
	// is "published" and it was last updated when it was last published.
	const builtIns: Record<string, string | null> = {
		title: published.title,
		slug: published.slug,
		status: "published",
		author: authorName,
		createdAt: day(entry.createdAt),
		updatedAt: day(entry.lastPublishedAt),
		publishedAt: day(entry.publishedAt),
		lastPublishedAt: day(entry.lastPublishedAt),
	};
	// A media Field holds the id of a Media item; Templates read it as `media:<id>`, like a fixed image.
	const mediaFields = new Set(postType.fields.filter((field) => field.type === "media").map((field) => field.key));
	const fieldValue = (path: string) => {
		const value = published.fields[path];
		return value && mediaFields.has(path) ? `media:${value}` : value;
	};
	const referenced = [
		...mediaReferencesIn(attributeTexts(template.nodes)),
		...[...mediaFields].map((key) => published.fields[key] ?? ""),
	];
	const shown = await pageMedia(scope, referenced, { language, defaultLanguage: host.defaultLanguage });
	return renderPage({
		site: { name: host.site.name, language, direction: directionOf(language) },
		title: published.title,
		template,
		values: (path) => (Object.hasOwn(builtIns, path) ? builtIns[path] : fieldValue(path)),
		media: (id) => shown.get(id),
	});
}

/** The fixed text of every attribute in a tree, joined: where `media:<id>` references are written. */
function attributeTexts(nodes: readonly TreeNode[]): string {
	let texts = "";
	for (const node of nodes) {
		if (node.type !== "element") continue;
		for (const attribute of node.attributes) {
			for (const part of attribute.value) if (part.type === "text") texts += ` ${part.text}`;
		}
		texts += attributeTexts(node.children);
	}
	return texts;
}

async function nameOf(scope: VisitorScope, personId: string): Promise<string | null> {
	const [row] = await scope.db.select({ name: people.name }).from(people).where(eq(people.id, personId));
	return row?.name ?? null;
}

/** A date as visitors read it until Template markup's date formatter: `2026-03-02`. */
function day(date: Date | null): string | null {
	return date ? date.toISOString().slice(0, 10) : null;
}
