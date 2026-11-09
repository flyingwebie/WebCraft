import type { Database } from "@webcraft/db";
import { entries, globals, people, publishedSlugs, sites, templates } from "@webcraft/db/schema";
import {
	BUILT_IN_SITE_TEMPLATE,
	builtInNotFoundPage,
	type EditModePage,
	type ElementTree,
	type LanguageLink,
	mediaReferencesIn,
	type PageAlternate,
	type PageToRender,
	renderPage,
	type TemplateValue,
	valuePathsOf,
} from "@webcraft/renderer";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import type { InstallConfig } from "../config.ts";
import { editableField } from "../content/editable.ts";
import { entryStatus, entryValues } from "../content/entries.ts";
import { homePageId, publishedAddresses } from "../content/entry-paths.ts";
import type { FieldDefinition } from "../content/field-types.ts";
import { type Languages, linksIn } from "../content/field-values.ts";
import { type BuiltInField, storedFields } from "../content/fields.ts";
import { globalsVersion } from "../content/globals.ts";
import {
	languageNamed,
	languageOfPath,
	languagePath,
	preferredLanguage,
	type SiteLanguage,
	type SiteLanguages,
	siteLanguages,
} from "../content/languages.ts";
import { candidatePatterns, findPublishedPage, isPagePostType } from "../content/pages.ts";
import { listPostTypes, type PostType } from "../content/post-types.ts";
import { publishedEntries } from "../content/relationships.ts";
import { entryParts, globalsParts, type Parts, type RelatedEntry, resolvePath } from "../content/render-values.ts";
import { specialPageId } from "../content/special-pages.ts";
import { canonicalPath, pathSegments, slugIn } from "../content/url-patterns.ts";
import { storedVersion } from "../content/values.ts";
import { isVisibleIn } from "../content/visibility.ts";
import { type SiteStyles, siteStyles, stylesheetFile } from "../design-system/stylesheet.ts";
import { uuidsIn } from "../ids.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import { type StoredMediaFile, storedFile } from "../media/library.ts";
import { pageMedia } from "../media/page-media.ts";
import type { DataLayer, Site, SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { slugOfStagingHostname, stagingUrl } from "./addresses.ts";

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
	 * Where the hostname's pages are, such as `https://bakery.sites.example.com`: what absolute
	 * addresses on the page (`hreflang` alternates) start with.
	 */
	origin: string;
	/** Whether the Site sends a first visit to the home page on to the browser's language (ADR 0010). */
	browserLanguageRedirect: boolean;
	/**
	 * The Site's page cache generation: a page rendered now stays valid until a publish raises it.
	 * Read before the page, so a page is never kept under a newer generation than its content.
	 */
	cacheGeneration: number;
};

/** A language a visitor chose with the Language switcher, and the page to go on to. */
export type LanguageChoice = { language: string; location: string };

/** A rendered page of a Site. */
export type SitePage = { html: string };

/** What a path on a Site answers: its page, or a permanent redirect (the home page's own path goes to `/`). */
export type SiteAnswer = ({ kind: "page" } & SitePage) | { kind: "redirect"; location: string };

/** What a page shows from the content store: see `SitePages.pageContent`. */
export type PageContent = {
	/** The Entry (or Page) the page shows; null on the built-in 404 page. */
	entryId: string | null;
	/** The language the page is in. */
	language: string;
	/** The page in each of the Site's languages, in their order: for Edit mode's language switcher. */
	languages: PageInLanguage[];
	/** Whether the page's Templates read the Globals. */
	readsGlobals: boolean;
	/** Whether the path has no page, so the 404 page shows there. */
	notFound: boolean;
};

/**
 * A page rendered for Edit mode rather than for visitors: the Site opened for the person editing,
 * and what WebCraft adds to `<head>` (its header token, its own scripts and stylesheets).
 */
export type PageEditing = { scope: SiteScope; head: Omit<EditModePage, "region"> };

/**
 * The Site side of the content store, for the web process's Site request pipeline: which Site a
 * hostname belongs to, the page at a path and the Site's 404 page. Only published content is read.
 */
export type SitePages = {
	/** The Site a hostname belongs to, or null for a hostname that is no Site's (an unbranded 404). */
	resolveHost(hostname: string): Promise<SiteHost | null>;
	/**
	 * What `pathname` answers on the Site: the published Entry a Post Type's URL pattern finds there,
	 * else the published Page at that path (the home page at `/`); null when there is none. With
	 * `editing`, the page for Edit mode: the same page, showing the Drafts of its Content (its Entry and
	 * the Globals) through the published Templates, its editable regions tagged.
	 */
	render(host: SiteHost, pathname: string, editing?: PageEditing): Promise<SiteAnswer | null>;
	/**
	 * The Site's 404 page, for `pathname` with no page, in the path's language: the Page Staff chose,
	 * once published, else the built-in one, in the Site template. With `editing`, for Edit mode, as
	 * `render` does.
	 */
	notFound(host: SiteHost, pathname: string, editing?: PageEditing): Promise<SitePage>;
	/**
	 * What the page at `pathname` shows from the content store, found as `render` finds it: its Entry
	 * (none on the built-in 404 page) and whether it reads the Globals (`site.x`). For Edit mode's
	 * Publish menu, which lists and publishes the page's changes.
	 */
	pageContent(host: SiteHost, pathname: string): Promise<PageContent>;
	/**
	 * Where the browser-language redirect sends a visitor's first request to the home page: the home
	 * page in the language their browser prefers (`Accept-Language`) among those it is shown in. Null
	 * when that is the Default language, none matches, the Site has the redirect off or no home page.
	 */
	preferredHome(host: SiteHost, acceptLanguage: string | null): Promise<LanguageChoice | null>;
	/**
	 * What a Language switcher link (`/_wc/lang/<path>`) chooses: the language of the path, and the
	 * path to go on to. Undefined for any other path, or one no page could be at.
	 */
	languageChoice(host: SiteHost, pathname: string): Promise<LanguageChoice | undefined>;
	/**
	 * A Media file of the Site by the name it is served under (`/_media/<name>`): an original or a
	 * variant, never a raw upload. Null when the Site has none by that name.
	 */
	mediaFile(host: SiteHost, name: string): Promise<StoredMediaFile | null>;
	/**
	 * A stylesheet of the Site by the name it is served under (`/_wc/css/<name>`): the current
	 * one, or one a publish replaced lately. Null for any other name.
	 */
	stylesheet(host: SiteHost, name: string): Promise<string | null>;
};

/** How many Sites' styles a web process keeps built at most. */
const KEPT_STYLES = 500;

export function createSitePages(options: {
	database: Database;
	config: InstallConfig;
	data: DataLayer;
	storage: InstallStorage;
}): SitePages {
	const { database, config, data, storage } = options;
	// Each Site's styles, built once per page cache generation: a publish that changes them raises it.
	// The Sites used least recently go first when there are too many.
	const built = new Map<string, { generation: number; styles: Promise<SiteStyles> }>();
	const stylesOf = (host: SiteHost): Promise<SiteStyles> => {
		const kept = built.get(host.site.id);
		if (kept && kept.generation === host.cacheGeneration) {
			built.delete(host.site.id);
			built.set(host.site.id, kept);
			return kept.styles;
		}
		const styles = siteStyles(data.visitors(host.site));
		// A request that read an older generation never replaces newer styles.
		if (kept && kept.generation > host.cacheGeneration) return styles;
		built.delete(host.site.id);
		built.set(host.site.id, { generation: host.cacheGeneration, styles });
		if (built.size > KEPT_STYLES) built.delete(built.keys().next().value as string);
		styles.catch(() => {
			if (built.get(host.site.id)?.styles === styles) built.delete(host.site.id);
		});
		return styles;
	};
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
				origin: stagingUrl(config, row.slug) ?? `https://${hostname}`,
				browserLanguageRedirect: row.browserLanguageRedirect,
				cacheGeneration: row.pageCacheGeneration,
			};
		},

		async render(host, pathname, editing) {
			const view = viewFor(data, host, editing);
			const located = await locate(view.scope, pathname);
			if (!located) return null;
			if (located.kind === "redirect") return located;
			const extras = await languageExtras(view.scope, host, located, located.found);
			return { kind: "page", html: await renderEntryPage(view, host, await stylesOf(host), located, extras) };
		},

		async pageContent(host, pathname) {
			const scope = data.visitors(host.site);
			const located = await locate(scope, pathname);
			const place = located?.kind === "found" ? located : await notFoundPlace(scope, pathname);
			const found = located?.kind === "found" ? located.found : located ? undefined : place.found;
			const siteTemplate = (await publishedSiteTemplate(scope)) ?? BUILT_IN_SITE_TEMPLATE;
			const trees = [siteTemplate, found?.content ?? builtInNotFoundPage(place.language.code).content];
			const places = await languagePlaces(scope, place, found);
			return {
				entryId: found?.entry.id ?? null,
				language: place.language.code,
				languages: places.map(({ language, path }) => ({
					code: language.code,
					name: language.name,
					path,
					current: language.code === place.language.code,
				})),
				readsGlobals: trees.some((tree) => valuePathsOf(tree).some((path) => path.startsWith("site."))),
				notFound: located === null,
			};
		},

		async notFound(host, pathname, editing) {
			const view = viewFor(data, host, editing);
			const place = await notFoundPlace(view.scope, pathname);
			const styles = await stylesOf(host);
			const { languageLinks } = await languageExtras(view.scope, host, place, undefined);
			if (place.found) {
				const located = { ...place, found: place.found };
				return { html: await renderEntryPage(view, host, styles, located, { alternates: [], languageLinks }) };
			}
			const builtIn = builtInNotFoundPage(place.language.code);
			return {
				html: await renderSitePage(view, host, styles, place, { ...builtIn, languageLinks, values: () => undefined }),
			};
		},

		async preferredHome(host, acceptLanguage) {
			if (!host.browserLanguageRedirect) return null;
			const scope = data.visitors(host.site);
			const home = await homePageId(scope);
			const page = home && (await publishedPage(scope, await listPostTypes(scope), home));
			if (!page) return null;
			const site = await siteLanguages(scope);
			const shown = site.languages.filter((language) =>
				isVisibleIn(storedVersion(page.entry.published), {
					language: language.code,
					defaultLanguage: site.defaultLanguage,
				}),
			);
			const language = preferredLanguage(
				acceptLanguage,
				shown.map((candidate) => candidate.code),
			);
			if (!language || language === site.defaultLanguage) return null;
			return { language, location: languagePath({ language, defaultLanguage: site.defaultLanguage }, "/") };
		},

		languageChoice(host, pathname) {
			return languageChoice(data, host, pathname);
		},

		mediaFile(host, name) {
			return storedFile(data.visitors(host.site), storage, name);
		},

		async stylesheet(host, name) {
			return stylesheetFile(data.visitors(host.site), await stylesOf(host), name);
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

/** Where a page is: its language among the Site's, with the Default language values fall back to. */
type Place = { site: SiteLanguages; language: SiteLanguage; languages: Languages };

/** A page found at a path: the Entry it shows, in its language. */
type Located = Place & { kind: "found"; found: FoundEntry };

/**
 * What a path finds on the Site, as visitors find it: in the language its prefix names (the Default
 * language without one), the published Entry a Post Type's URL pattern finds there, else the
 * published Page at that path (the home page at the language's root, its own path redirecting
 * there); null when there is none.
 */
async function locate(
	scope: ReadScope,
	pathname: string,
): Promise<Located | { kind: "redirect"; location: string } | null> {
	const segments = pathSegments(pathname);
	if (!segments || isReservedPath(segments)) return null;
	const site = await siteLanguages(scope);
	const { languages, rest, unprefixed } = languageOfPath(site, segments);
	const place = { site, languages, language: languageNamed(site, languages.language) };
	const postTypes = await listPostTypes(scope);
	const home = await homePageId(scope);
	// Post Types' URL patterns own every path they match; Pages live outside them.
	const found =
		rest.length === 0
			? home && (await publishedPage(scope, postTypes, home))
			: ((await findPublishedEntry(scope, postTypes, rest, languages.language)) ??
				(await findPage(scope, postTypes, rest, languages.language)));
	// An Entry hidden in the language has no page there.
	if (!found || !isVisibleIn(storedVersion(found.entry.published), languages)) {
		return unprefixed ? { kind: "redirect", location: canonicalPath(unprefixed) } : null;
	}
	if (rest.length > 0 && found.entry.id === home) return { kind: "redirect", location: languagePath(languages, "/") };
	return { kind: "found", found, ...place };
}

/** Where a page's links to its other languages go: `hreflang` alternates, and the Language switcher's links. */
type LanguageExtras = { alternates: PageAlternate[]; languageLinks: LanguageLink[] };

/** The page in one of the Site's languages: where it is there (that language's home page where it is hidden). */
export type PageInLanguage = { code: string; name: string; path: string; current: boolean };

/**
 * Where the page is in each of the Site's languages: the published Entry's address in every language
 * it is shown in. They become `hreflang` alternates (`x-default` last, at the Default language's) and
 * the Language switcher's links, which go to a language's home page where the Entry is hidden (and,
 * without an Entry, on the 404 page). None on a Site with one language.
 */
async function languageExtras(
	scope: ReadScope,
	host: SiteHost,
	place: Place,
	found: FoundEntry | undefined,
): Promise<LanguageExtras> {
	const { site } = place;
	const extras: LanguageExtras = { alternates: [], languageLinks: [] };
	if (site.languages.length < 2) return extras;
	for (const { language, path, shown } of await languagePlaces(scope, place, found)) {
		if (shown) extras.alternates.push({ hreflang: language.code, href: `${host.origin}${path}` });
		extras.languageLinks.push({
			code: language.code,
			name: language.name,
			direction: language.direction,
			href: languageChoiceHref(path),
			current: language.code === place.languages.language,
		});
	}
	const fallback = extras.alternates.find((alternate) => alternate.hreflang === site.defaultLanguage);
	if (fallback) extras.alternates.push({ hreflang: "x-default", href: fallback.href });
	if (!found) extras.alternates = [];
	return extras;
}

/**
 * Where the page is in each of the Site's languages: its published Entry's address where it is shown
 * (`shown`), else the language's home page.
 */
async function languagePlaces(
	scope: ReadScope,
	place: Place,
	found: FoundEntry | undefined,
): Promise<{ language: SiteLanguage; path: string; shown: boolean }[]> {
	const { site } = place;
	const published = found && storedVersion(found.entry.published);
	const places: { language: SiteLanguage; path: string; shown: boolean }[] = [];
	for (const language of site.languages) {
		const languages = { language: language.code, defaultLanguage: site.defaultLanguage };
		const visible = found && published && isVisibleIn(published, languages);
		const address = visible
			? (await publishedAddresses(scope, found.postType, [found.entry.id], languages)).get(found.entry.id)
			: undefined;
		places.push({ language, path: address?.path ?? languagePath(languages, "/"), shown: address !== undefined });
	}
	return places;
}

/**
 * Where the Language switcher's links go: `/_wc/lang` and the page's path. The Site pipeline
 * remembers the language of the path in a cookie and sends the visitor on, so the choice is kept
 * without JavaScript.
 */
export const LANGUAGE_CHOICE_PATH = "/_wc/lang";

function languageChoiceHref(path: string): string {
	return `${LANGUAGE_CHOICE_PATH}${path}`;
}

/**
 * The language a Language switcher link chooses and the path it goes on to, for `/_wc/lang/<path>`:
 * any path on the Site in the language its prefix names (the Default language without one).
 * Undefined for anything that isn't a path a page could be at.
 */
async function languageChoice(data: DataLayer, host: SiteHost, pathname: string): Promise<LanguageChoice | undefined> {
	if (pathname !== LANGUAGE_CHOICE_PATH && !pathname.startsWith(`${LANGUAGE_CHOICE_PATH}/`)) return undefined;
	const target = pathname.slice(LANGUAGE_CHOICE_PATH.length) || "/";
	const segments = pathSegments(target);
	if (!segments || isReservedPath(segments) || segments.some((segment) => segment.includes("/"))) return undefined;
	const site = await siteLanguages(data.visitors(host.site));
	return { language: languageOfPath(site, segments).languages.language, location: canonicalPath(segments) };
}

/**
 * The 404 page for a path: in the path's language (the Default language when it names none), the
 * Page Staff chose for that language or else for the Site, once published; no Page for the built-in one.
 */
async function notFoundPlace(scope: ReadScope, pathname: string): Promise<Place & { found?: FoundEntry }> {
	const site = await siteLanguages(scope);
	const { languages } = languageOfPath(site, pathSegments(pathname) ?? []);
	const code = languages.language;
	const place = { site, languages, language: languageNamed(site, code) };
	// The language's own 404 page, else the Site's; each once published and shown in the language.
	const postTypes = await listPostTypes(scope);
	for (const chosen of [await specialPageId(scope, "notFound", code), await specialPageId(scope, "notFound")]) {
		const page = chosen && (await publishedPage(scope, postTypes, chosen));
		if (page && isVisibleIn(storedVersion(page.entry.published), languages)) return { ...place, found: page };
	}
	return place;
}

/**
 * What rendering reads with: the read-only scope of a Site's visitors, or in Edit mode the Site
 * opened for the person editing. Routing (which Entry a path finds) is the same for both.
 */
type ReadScope = Pick<VisitorScope, "select" | "first" | "count" | "where" | "db" | "site" | "now">;

/**
 * How a page is being viewed: by visitors (the published version of its Content) or in Edit mode
 * (the Drafts, with editable regions tagged).
 */
type View = { scope: ReadScope; version: "published" | "draft"; editing?: PageEditing };

function viewFor(data: DataLayer, host: SiteHost, editing: PageEditing | undefined): View {
	return editing
		? { scope: editing.scope, version: "draft", editing }
		: { scope: data.visitors(host.site), version: "published" };
}

/**
 * Edit mode's tags: which bindings mark their element as an editable region. The page's content may
 * edit its Entry's text and rich text Fields (and its title) and the Globals (`site.x`); the Site
 * template, the Globals only. Values through a formatter show something other than what is stored,
 * so they are never typed over.
 */
function editRegions(
	entry: { id: string; fields: readonly FieldDefinition[] } | null,
	globalFields: readonly FieldDefinition[],
): EditModePage["region"] {
	return (value, template) => {
		if (value.format) return undefined;
		if (value.path.startsWith("site.")) {
			const key = value.path.slice("site.".length);
			const editable = editableField(globalFields, key);
			return editable && regionTags("globals", key, editable.type, editable.label);
		}
		if (template !== "content" || !entry) return undefined;
		// The title is a built-in value: the editing bar names it in the person's own language.
		if (value.path === "title") return regionTags(`entry:${entry.id}`, "title", "text", null);
		const editable = editableField(entry.fields, value.path);
		return editable && regionTags(`entry:${entry.id}`, value.path, editable.type, editable.label);
	};
}

/** The attributes of an editable region: what it shows (`data-wc-item`, `data-wc-field`), how and its label. */
function regionTags(item: string, field: string, type: string, label: string | null): [string, string][] {
	const tags: [string, string][] = [
		["data-wc-item", item],
		["data-wc-field", field],
		["data-wc-type", type],
	];
	if (label !== null) tags.push(["data-wc-label", label]);
	return tags;
}

/** A published Entry to render, with what its content renders through: its Entry template or Page layout. */
type FoundEntry = {
	postType: PostType;
	/** Every Post Type of the Site, for what Relationships point at. */
	postTypes: readonly PostType[];
	entry: typeof entries.$inferSelect;
	content: ElementTree;
};

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
	scope: ReadScope,
	postTypes: readonly PostType[],
	segments: readonly string[],
	language: string,
): Promise<FoundEntry | undefined> {
	for (const { postType, pattern } of candidatePatterns(postTypes)) {
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
		return { postType, postTypes, entry, content: template.published as ElementTree };
	}
	return undefined;
}

/** The published Page at a path: its parent Page's path and its own slug. */
async function findPage(
	scope: ReadScope,
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
	scope: ReadScope,
	postTypes: readonly PostType[],
	pageId: string,
): Promise<FoundEntry | undefined> {
	const pages = postTypes.find(isPagePostType);
	const entry = await scope.first(entries, and(eq(entries.id, pageId), isNotNull(entries.published)));
	if (!pages || entry?.postTypeId !== pages.id) return undefined;
	return { postType: pages, postTypes, entry, content: EMPTY_PAGE_LAYOUT };
}

async function renderEntryPage(
	view: View,
	host: SiteHost,
	styles: SiteStyles,
	located: Place & { found: FoundEntry },
	extras: LanguageExtras,
): Promise<string> {
	const { scope } = view;
	const { found, languages } = located;
	const { postType, entry, content } = found;
	const draft = view.version === "draft";
	const version = storedVersion(draft ? entry.draft : entry.published);
	const published = entryValues(version, postType.fields, languages);
	const authorName = entry.authorId ? await nameOf(scope, entry.authorId) : null;
	// Visitors see the published version: nothing here tells them about the Draft, so its status
	// is "published" and it was last updated when it was last published. Edit mode shows the Draft.
	// Every built-in Field, so adding one to BUILT_IN_FIELDS can't leave it empty on pages.
	const builtIns: Record<BuiltInField, TemplateValue> = {
		title: published.title,
		slug: published.slug,
		status: draft ? entryStatus(entry) : "published",
		author: authorName,
		createdAt: entry.createdAt,
		updatedAt: draft ? entry.updatedAt : entry.lastPublishedAt,
		publishedAt: entry.publishedAt,
		lastPublishedAt: entry.lastPublishedAt,
	};
	const site = await siteParts(view, languages);
	const related = await relatedEntries(
		scope,
		found,
		linksIn(version.values, postType.fields).map((link) => link.targetId),
		languages,
	);
	const root = entryParts(builtIns, postType.fields, published.fields, {
		related,
		site,
	});
	return renderSitePage(
		view,
		host,
		styles,
		located,
		{ title: published.title, ...extras, content, values: (path) => resolvePath(root, path) },
		// Media values the content may read: its own, and its related Entries'.
		[published.fields, [...related.values()].map((entry) => entry.values)],
		{ id: entry.id, fields: postType.fields },
	);
}

/** The Site's Globals as `site.x` reads them: published for visitors, the Draft in Edit mode. */
async function siteParts(view: View, languages: Languages): Promise<Parts> {
	const site = globalsVersion(await view.scope.first(globals), languages, view.version);
	return globalsParts(site.fields, site.values);
}

/**
 * A page of the Site in its Site template (the published one, or the built-in one), with the names
 * of its Classes and its stylesheet from the published Design system. The Site template reads the
 * Globals as `site.x`.
 */
async function renderSitePage(
	view: View,
	host: SiteHost,
	styles: SiteStyles,
	place: Place,
	page: Pick<PageToRender, "title" | "alternates" | "languageLinks" | "content" | "values">,
	contentValues: unknown = null,
	/** The Entry the page's content shows, whose values Edit mode may tag; none on the built-in 404 page. */
	entry: { id: string; fields: readonly FieldDefinition[] } | null = null,
): Promise<string> {
	const { scope, editing } = view;
	const { languages, language } = place;
	const globalsRow = await scope.first(globals);
	const globalValues = globalsVersion(globalsRow, languages, view.version);
	const site = globalsParts(globalValues.fields, globalValues.values);
	const siteRoot: Parts = { text: undefined, part: (name) => (name === "site" ? site : undefined) };
	const siteTemplate = await publishedSiteTemplate(scope);
	// The Media the page may show: `media:<id>` written in either template, and every media value the
	// page reads (its content's, the Globals'). Ids that aren't the Site's ready Media find nothing.
	const shown = await pageMedia(
		scope,
		[
			...mediaReferencesIn(JSON.stringify([page.content, siteTemplate ?? null])),
			...uuidsIn(JSON.stringify([contentValues, globalValues.values])),
		],
		languages,
	);
	return renderPage({
		...page,
		site: { name: host.site.name, language: language.code, direction: language.direction },
		siteTemplate,
		siteValues: (path) => resolvePath(siteRoot, path),
		className: styles.className,
		media: (id) => shown.get(id),
		styles: { stylesheet: styles.stylesheet.href, darkMode: styles.designSystem.darkMode },
		editMode: editing && { ...editing.head, region: editRegions(entry, storedFields(globalsRow?.fields)) },
	});
}

/** The Site template visitors see, or undefined while none is published (pages get the built-in one). */
async function publishedSiteTemplate(scope: ReadScope): Promise<ElementTree | undefined> {
	const row = await scope.first(
		templates,
		and(eq(templates.kind, "site"), isNull(templates.postTypeId), isNotNull(templates.published)),
	);
	return (row?.published as ElementTree | null) ?? undefined;
}

/** The published Entries the page's Relationships point at, read in the page's language. */
async function relatedEntries(
	scope: ReadScope,
	found: FoundEntry,
	ids: readonly string[],
	languages: Languages,
): Promise<Map<string, RelatedEntry>> {
	const byId = new Map(found.postTypes.map((postType) => [postType.id, postType]));
	const related = new Map<string, RelatedEntry>();
	// Entries hidden in the page's language have no place on it.
	const rows = (await publishedEntries(scope, [...new Set(ids)])).filter((row) =>
		isVisibleIn(storedVersion(row.published), languages),
	);
	const addresses = new Map<string, { slug: string; path: string }>();
	for (const postType of found.postTypes) {
		const own = rows.filter((row) => row.postTypeId === postType.id).map((row) => row.id);
		for (const [id, address] of await publishedAddresses(scope, postType, own, languages)) addresses.set(id, address);
	}
	for (const row of rows) {
		const postType = byId.get(row.postTypeId);
		if (!postType) continue;
		const values = entryValues(storedVersion(row.published), postType.fields, languages);
		const address = addresses.get(row.id);
		related.set(row.id, {
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

async function nameOf(scope: ReadScope, personId: string): Promise<string | null> {
	const [row] = await scope.db.select({ name: people.name }).from(people).where(eq(people.id, personId));
	return row?.name ?? null;
}
