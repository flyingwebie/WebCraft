import type { Database } from "@webcraft/db";
import { entries, globals, people, publishedSlugs, siteDomains, sites, templates } from "@webcraft/db/schema";
import {
	BUILT_IN_SITE_TEMPLATE,
	builtInNotFoundPage,
	type EditModePage,
	type ElementTree,
	FORM_TOKEN_MARK,
	formWords,
	isComponentInfo,
	type LanguageLink,
	mediaReferencesIn,
	type PageAlternate,
	type PageToRender,
	type PlacementRenderer,
	placementsIn,
	renderDocument,
	type TemplateValue,
	valuePathsOf,
} from "@webcraft/renderer";
import { and, eq, isNotNull, isNull } from "drizzle-orm";

import type { InstallConfig } from "../config.ts";
import {
	type ComponentSources,
	type ComponentVersion,
	NO_MODULE_COMPONENTS,
	type SiteComponents,
	siteComponents,
} from "../content/components.ts";
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
	prefixOf,
	type SiteLanguage,
	type SiteLanguages,
	siteLanguages,
} from "../content/languages.ts";
import { candidatePatterns, findPublishedPage, isPagePostType } from "../content/pages.ts";
import { listPostTypes, type PostType } from "../content/post-types.ts";
import { propValue } from "../content/props.ts";
import { publishedEntries } from "../content/relationships.ts";
import {
	entryParts,
	globalsParts,
	type Parts,
	placementValues,
	type RelatedEntry,
	resolvePath,
} from "../content/render-values.ts";
import { pageScripts, scriptFile } from "../content/scripts.ts";
import { specialPageId } from "../content/special-pages.ts";
import { canonicalPath, pathSegments, slugIn } from "../content/url-patterns.ts";
import { storedVersion } from "../content/values.ts";
import { isVisibleIn } from "../content/visibility.ts";
import { draftStyles, type SiteStyles, siteStyles, stylesheetFile } from "../design-system/stylesheet.ts";
import { domainOrigin, placeOf, type SiteAddresses, verifiedDomains } from "../domains/addresses.ts";
import { type PageFormsOptions, pageForms, type ShownForm } from "../forms/page-forms.ts";
import { uuidsIn } from "../ids.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import { type StoredMediaFile, storedFile } from "../media/library.ts";
import { pageMedia } from "../media/page-media.ts";
import { siteAllowedHosts } from "../site-scripts/csp.ts";
import { type LibraryFile, libraryFile, pageLibraries } from "../site-scripts/libraries.ts";
import { outsideScriptCode, pageOutsideScripts } from "../site-scripts/outside-scripts.ts";
import { type CspMode, editModePolicy, isCspMode, pagePolicyHeaders, readHost } from "../site-scripts/policy.ts";
import { retiredScript } from "../site-scripts/retired.ts";
import type { DataLayer, Site, SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { slugOfStagingHostname, stagingUrl } from "./addresses.ts";

export { canonicalPath, pathSegments } from "../content/url-patterns.ts";
export { reservedSlugs, stagingHostname, stagingUrl } from "./addresses.ts";

/** A Site found by the hostname a request came in on. */
export type SiteHost = {
	site: Site;
	/**
	 * How the hostname reaches the Site: its Staging address, its verified Primary domain, one of its
	 * verified Redirect domains (which sends every request on to the Primary domain), or a language's
	 * verified domain (which serves that language, `language`, without a prefix).
	 */
	address: "staging" | "primary" | "redirect" | "language";
	/** On a language's domain, the language it serves; null everywhere else. */
	language: string | null;
	/** On a Redirect domain, the Primary domain's origin it sends visitors to; null while the Site has none verified. */
	redirectTo: string | null;
	/** The Site's Default language. */
	defaultLanguage: string;
	/** Where the hostname's pages are, such as `https://bakery.sites.example.com`. */
	origin: string;
	/**
	 * Where the Site's pages are, as pages on this hostname link to them: on the Staging address, every
	 * language on the Staging address itself, under its prefix; on the Site's domains, on its Primary
	 * domain and each language's own (see `SiteAddresses`).
	 */
	addresses: SiteAddresses;
	/** Whether the Site sends a first visit to the home page on to the browser's language (ADR 0010). */
	browserLanguageRedirect: boolean;
	/** How the Site's Content Security Policy applies (ADR 0023). */
	cspMode: CspMode;
	/**
	 * The Site's page cache generation: a page rendered now stays valid until a publish raises it.
	 * Read before the page, so a page is never kept under a newer generation than its content.
	 */
	cacheGeneration: number;
};

/** A language a visitor chose with the Language switcher, and the page to go on to. */
export type LanguageChoice = { language: string; location: string };

/**
 * A rendered page of a Site, with the security headers it is sent with (the Site's Content Security
 * Policy as the page needs it, or Edit mode's own) and the Forms it shows (numbered as their ids
 * are). Pages are cached with their headers, so a change to the policy clears the page cache.
 */
export type SitePage = { html: string; headers: Record<string, string>; forms?: readonly ShownForm[] };

/**
 * What a path on a Site answers: its page, or a permanent redirect (the home page's own path goes to
 * `/`; a language's path goes to its own domain, `keepQuery` then keeping the request's query).
 */
export type SiteAnswer = ({ kind: "page" } & SitePage) | { kind: "redirect"; location: string; keepQuery?: boolean };

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
	/**
	 * The Post Type whose Entry template renders the page's content; null when no Template does (a
	 * Page, arranged with its Page layout, or the 404 page).
	 */
	templatePostTypeId: string | null;
};

/**
 * A page rendered for Edit mode rather than for visitors: the Site opened for the person editing,
 * and what WebCraft adds to `<head>` (its header token, its own scripts and stylesheets). With
 * `code`, the page is rendered for Code mode (ADR 0016): it shows the Drafts of the Site's Structure
 * (its Templates, the Components they place, the Design system), every element tagged with where it
 * comes from. Open `scope` with `structure.edit` for it.
 */
export type PageEditing = {
	scope: SiteScope;
	head: Omit<EditModePage, "region" | "code">;
	code?: boolean;
	/**
	 * Safe mode (ADR 0022): the page runs none of the Site's own scripts (its Libraries, Site script
	 * and page script), so a broken one can't lock anyone out of editing.
	 */
	safe?: boolean;
	/** In Code mode, unsaved changes to show in place of the Drafts, as Staff type them. */
	preview?: CodePreview;
};

/**
 * Unsaved changes Code mode previews (ADR 0016): one Template's or Component's tree read from the
 * markup being typed, in place of its Draft, and the styles the page shows with (the Design system's
 * Draft with what the changes would add to it).
 */
export type CodePreview = {
	source?:
		| { kind: "siteTemplate"; tree: ElementTree }
		| { kind: "entryTemplate"; tree: ElementTree }
		| { kind: "component"; id: string; version: ComponentVersion };
	styles: SiteStyles;
};

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
	render(host: SiteHost, pathname: string, editing?: PageEditing, forms?: PageFormsOptions): Promise<SiteAnswer | null>;
	/**
	 * The Site's 404 page, for `pathname` with no page, in the path's language: the Page Staff chose,
	 * once published, else the built-in one, in the Site template. With `editing`, for Edit mode, as
	 * `render` does.
	 */
	notFound(host: SiteHost, pathname: string, editing?: PageEditing, forms?: PageFormsOptions): Promise<SitePage>;
	/**
	 * A page showing one Form alone, in the Site template, in the path's language: where a Form sent
	 * back with errors goes when the page it came from no longer shows it.
	 */
	formPage(host: SiteHost, pathname: string, formId: string, forms: PageFormsOptions): Promise<SitePage>;
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
	/**
	 * A script of the Site by the name it is served under (`/_wc/js/<name>`): its published Site script
	 * or a page script, an outside script's code, or one of them a change replaced in the last 30 days.
	 */
	script(host: SiteHost, name: string): Promise<string | null>;
	/** One of the Site's Library files by the name it is served under (`/_wc/lib/<name>`), or one replaced in the last 30 days. */
	libraryFile(host: SiteHost, name: string): Promise<LibraryFile | null>;
};

/** How many Sites' styles a web process keeps built at most. */
const KEPT_STYLES = 500;

export function createSitePages(options: {
	database: Database;
	config: InstallConfig;
	data: DataLayer;
	storage: InstallStorage;
	/** The Components of the Modules running on each Site. */
	components?: ComponentSources;
	/** Whether Forms run on a Site: a Module keeping their Submissions runs there. Never, when absent. */
	formsOn?: (site: Site) => Promise<boolean>;
	/** A time-trap token for a Form on a page of the Site handed out now. */
	formToken?: (site: Site) => Promise<string>;
	/** The outside hosts of the Modules running on a Site, which its policy allows. */
	moduleHosts?: (site: Site) => Promise<string[]>;
}): SitePages {
	const { database, config, data, storage } = options;
	const moduleHosts = options.moduleHosts ?? (async () => []);
	const sources = options.components ?? NO_MODULE_COMPONENTS;
	const forms = {
		on: options.formsOn ?? (async () => false),
		token: options.formToken ?? (async () => ""),
	};
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
	/** The styles a page is shown with: the published ones (built once per generation), or the Drafts' in Code mode. */
	const viewStyles = async (view: View): Promise<SiteStyles> => {
		if (view.structure !== "draft") return stylesOf(view.host);
		return view.editing?.preview?.styles ?? draftStyles(view.scope);
	};
	return {
		async resolveHost(hostname) {
			const slug = slugOfStagingHostname(config, hostname);
			if (slug) {
				const [row] = await database.db.select().from(sites).where(eq(sites.slug, slug));
				if (!row) return null;
				const origin = stagingUrl(config, row.slug) ?? `https://${hostname}`;
				// The Staging address shows every language under its prefix, on itself.
				const addresses = { main: origin, languages: {} };
				return hostOf(row, { address: "staging", language: null, redirectTo: null, origin, addresses });
			}
			// A domain serves its Site only once verified (ADR 0015).
			const [found] = await database.db
				.select({ domain: siteDomains, site: sites })
				.from(siteDomains)
				.innerJoin(sites, and(eq(sites.id, siteDomains.siteId), eq(sites.workspaceId, siteDomains.workspaceId)))
				.where(and(eq(siteDomains.name, hostname), isNotNull(siteDomains.verifiedAt)));
			if (!found) return null;
			const { domain, site } = found;
			const origin = domainOrigin(config, hostname);
			const verified = await verifiedDomains(database.db, site);
			const primary = verified.primary && domainOrigin(config, verified.primary);
			const addresses: SiteAddresses = {
				main: primary ?? stagingUrl(config, site.slug) ?? origin,
				languages: Object.fromEntries(verified.languages.map((own) => [own.language, domainOrigin(config, own.name)])),
			};
			const address = domain.role === "primary" || domain.role === "redirect" ? domain.role : "language";
			return hostOf(site, {
				address,
				language: address === "language" ? domain.language : null,
				redirectTo: address === "redirect" ? primary : null,
				origin,
				addresses,
			});
		},

		async render(host, pathname, editing, formOptions) {
			const view = viewFor(data, host, editing, sources, { pathname, options: formOptions, forms, moduleHosts });
			const located = await locate(view.scope, host, pathname, editing !== undefined);
			if (!located) return null;
			if (located.kind === "redirect") return located;
			const extras = await languageExtras(view.scope, host, located, located.found);
			return { kind: "page", ...(await renderEntryPage(view, host, await viewStyles(view), located, extras)) };
		},

		async pageContent(host, pathname) {
			const scope = data.visitors(host.site);
			const located = await locate(scope, host, pathname, true);
			const place = located?.kind === "found" ? located : await notFoundPlace(scope, host, pathname);
			const found = located?.kind === "found" ? located.found : located ? undefined : place.found;
			const siteTemplate = (await publishedSiteTemplate(scope)) ?? BUILT_IN_SITE_TEMPLATE;
			const content = found?.content ?? builtInNotFoundPage(place.language.code).content;
			// What the page reads includes what the Components it places read.
			const placed = await placedComponents(scope, [siteTemplate, content], sources);
			const trees = [siteTemplate, content, ...[...placed.used.values()].map((version) => version.tree)];
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
				templatePostTypeId: found && !isPagePostType(found.postType) ? found.postType.id : null,
			};
		},

		async notFound(host, pathname, editing, formOptions) {
			const view = viewFor(data, host, editing, sources, { pathname, options: formOptions, forms, moduleHosts });
			const place = await notFoundPlace(view.scope, host, pathname);
			const styles = await viewStyles(view);
			const { languageLinks } = await languageExtras(view.scope, host, place, undefined);
			if (place.found) {
				const located = { ...place, found: place.found };
				return renderEntryPage(view, host, styles, located, { alternates: [], languageLinks });
			}
			const builtIn = builtInNotFoundPage(place.language.code);
			return renderSitePage(view, host, styles, place, { ...builtIn, languageLinks, values: () => undefined });
		},

		async formPage(host, pathname, formId, formOptions) {
			const view = viewFor(data, host, undefined, sources, { pathname, options: formOptions, forms, moduleHosts });
			const place = await notFoundPlace(view.scope, host, pathname);
			const styles = await viewStyles(view);
			const { languageLinks } = await languageExtras(view.scope, host, place, undefined);
			return renderSitePage(view, host, styles, place, {
				title: formWords(place.language.code).problemTitle,
				languageLinks,
				content: { version: 1, nodes: [{ type: "form", form: formId }] },
				values: () => undefined,
			});
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
			const place = placeOf(
				host.addresses,
				{ language, defaultLanguage: site.defaultLanguage },
				languagePath({ language, defaultLanguage: site.defaultLanguage }, "/"),
			);
			return { language, location: place.origin === host.origin ? place.path : `${place.origin}${place.path}` };
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

		async script(host, name) {
			const scope = data.visitors(host.site);
			const published = await scriptFile(scope, name, "published");
			if (published !== null) return published;
			const hash = /^([0-9a-f]{16})\.js$/.exec(name)?.[1];
			if (!hash) return null;
			return (await outsideScriptCode(scope, hash)) ?? (await retiredScript(scope, hash));
		},

		libraryFile(host, name) {
			return libraryFile(data.visitors(host.site), storage, name);
		},
	};
}

/** A Site found by a hostname, with how the hostname reaches it. */
function hostOf(
	row: typeof sites.$inferSelect,
	how: Pick<SiteHost, "address" | "language" | "redirectTo" | "origin" | "addresses">,
): SiteHost {
	return {
		site: { id: row.id, workspaceId: row.workspaceId, name: row.name, slug: row.slug, createdAt: row.createdAt },
		...how,
		defaultLanguage: row.defaultLanguage,
		// Only where `/` is the Default language's home page: never on a language's own domain.
		browserLanguageRedirect: how.address !== "language" && row.browserLanguageRedirect,
		cspMode: isCspMode(row.cspMode) ? row.cspMode : "strict",
		cacheGeneration: row.pageCacheGeneration,
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

/** The language a path on a hostname is in (the Default language when it names none). */
export async function languageOnHost(scope: ReadScope, host: SiteHost, pathname: string): Promise<string> {
	const site = await siteLanguages(scope);
	const onHost = pathOnHost(site, host, pathSegments(pathname) ?? [], true);
	return onHost.kind === "path" ? onHost.languages.language : site.defaultLanguage;
}

/**
 * Where one of the Site's published Pages is in a language, as a link from this hostname: a path
 * here, or an address on another of the Site's domains. Null when the Page isn't published or is
 * hidden in the language.
 */
export async function pageLocation(
	scope: ReadScope,
	host: SiteHost,
	pageId: string,
	language: string,
): Promise<string | null> {
	const postTypes = await listPostTypes(scope);
	const page = await publishedPage(scope, postTypes, pageId);
	if (!page) return null;
	const { defaultLanguage } = await siteLanguages(scope);
	const languages = { language, defaultLanguage };
	if (!isVisibleIn(storedVersion(page.entry.published), languages)) return null;
	const address = (await publishedAddresses(scope, page.postType, [pageId], languages)).get(pageId);
	if (!address) return null;
	const there = placeOf(host.addresses, languages, address.path);
	return there.origin === host.origin ? there.path : `${there.origin}${there.path}`;
}

/** Where a page is: its language among the Site's, with the Default language values fall back to. */
type Place = { site: SiteLanguages; language: SiteLanguage; languages: Languages };

/** A page found at a path: the Entry it shows, in its language. */
type Located = Place & { kind: "found"; found: FoundEntry };

/**
 * What a path is on the hostname it came in on (ADR 0010): a path in one of the Site's languages, or
 * an address that moved to another of the Site's addresses.
 *
 * - On the Staging address (and in Edit mode), every language is under its prefix, as `languageOfPath`
 *   reads it.
 * - On the Primary domain the same, except that a language with a verified domain of its own lives
 *   there: its prefix moves to that domain, without the prefix.
 * - On a language's own domain, every path is in that language, without a prefix; a path starting
 *   with a language's prefix (its own included) moves to where that language's path is.
 */
type PathOnHost = ({ kind: "path" } & ReturnType<typeof languageOfPath>) | { kind: "moved"; location: string };

function pathOnHost(site: SiteLanguages, host: SiteHost, segments: readonly string[], editing: boolean): PathOnHost {
	const { defaultLanguage } = site;
	if (host.address === "language" && host.language) {
		const [first, ...rest] = segments;
		const named =
			first === undefined ? undefined : site.languages.find((language) => prefixOf(language.code) === first);
		if (!named) return { kind: "path", languages: { language: host.language, defaultLanguage }, rest: segments };
		const languages = { language: named.code, defaultLanguage };
		const place = placeOf(host.addresses, languages, languagePath(languages, canonicalPath(rest)));
		return { kind: "moved", location: `${place.origin}${place.path}` };
	}
	const read = languageOfPath(site, segments);
	const own = host.addresses.languages[read.languages.language];
	if (host.address === "primary" && !editing && own && read.languages.language !== defaultLanguage) {
		return { kind: "moved", location: `${own}${canonicalPath(read.rest)}` };
	}
	return { kind: "path", ...read };
}

/**
 * The path of a language's page on this hostname: without a prefix on the language's own domain,
 * under its prefix everywhere else.
 */
function hostPath(host: SiteHost, languages: Languages, path: string): string {
	return host.address === "language" && host.language === languages.language ? path : languagePath(languages, path);
}

/**
 * What a path finds on the Site, as visitors find it: in the language the hostname and the path name
 * (`pathOnHost`), the published Entry a Post Type's URL pattern finds there, else the published Page
 * at that path (the home page at the language's root, its own path redirecting there); null when
 * there is none. `editing`: Edit mode keeps every language on the hostname it is on.
 */
async function locate(
	scope: ReadScope,
	host: SiteHost,
	pathname: string,
	editing: boolean,
): Promise<Located | { kind: "redirect"; location: string; keepQuery?: boolean } | null> {
	const segments = pathSegments(pathname);
	if (!segments || isReservedPath(segments)) return null;
	const site = await siteLanguages(scope);
	const onHost = pathOnHost(site, host, segments, editing);
	if (onHost.kind === "moved") return { kind: "redirect", location: onHost.location, keepQuery: true };
	const { languages, rest, unprefixed } = onHost;
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
	if (rest.length > 0 && found.entry.id === home) return { kind: "redirect", location: hostPath(host, languages, "/") };
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
		// Each language at its own address: on this hostname, or on another of the Site's domains.
		const there = placeOf(host.addresses, { language: language.code, defaultLanguage: site.defaultLanguage }, path);
		const href = `${there.origin}${there.path}`;
		if (shown) extras.alternates.push({ hreflang: language.code, href });
		extras.languageLinks.push({
			code: language.code,
			name: language.name,
			direction: language.direction,
			href: there.origin === host.origin ? languageChoiceHref(there.path) : href,
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
	const onHost = pathOnHost(site, host, segments, false);
	if (onHost.kind === "moved") return undefined;
	return { language: onHost.languages.language, location: canonicalPath(segments) };
}

/**
 * The 404 page for a path: in the path's language (the Default language when it names none), the
 * Page Staff chose for that language or else for the Site, once published; no Page for the built-in one.
 */
async function notFoundPlace(
	scope: ReadScope,
	host: SiteHost,
	pathname: string,
): Promise<Place & { found?: FoundEntry }> {
	const site = await siteLanguages(scope);
	const onHost = pathOnHost(site, host, pathSegments(pathname) ?? [], true);
	const languages =
		onHost.kind === "path"
			? onHost.languages
			: { language: site.defaultLanguage, defaultLanguage: site.defaultLanguage };
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
 * How a page is being viewed: by visitors (the published version of its Content and Structure), in
 * Edit mode (the Drafts of its Content through the published Structure, with editable regions
 * tagged) or in Code mode (the Drafts of both, every element tagged).
 */
type View = {
	host: SiteHost;
	scope: ReadScope;
	/** Which version of the page's Content shows: its Entry's and the Globals'. */
	version: "published" | "draft";
	/** Which version of the Site's Structure shows: its Templates', Components' and Design system's. */
	structure: "published" | "draft";
	editing?: PageEditing;
	/** Where the Components of the Modules running on the Site come from. */
	sources: ComponentSources;
	/** The page's path on its hostname, which its Forms send back with what visitors fill in. */
	page: string;
	/** What this answer shows in the page's Forms (whether it is cached, one visitor's state of one Form). */
	forms?: PageFormsOptions;
	/** Whether Forms run on the Site, and their time-trap tokens. */
	formsOf: FormsOfSite;
	/** The outside hosts of the Modules running on the Site. */
	moduleHosts: (site: Site) => Promise<string[]>;
};

/** Whether Forms run on a Site, and a time-trap token for a page handed out now. */
type FormsOfSite = { on: (site: Site) => Promise<boolean>; token: (site: Site) => Promise<string> };

function viewFor(
	data: DataLayer,
	host: SiteHost,
	editing: PageEditing | undefined,
	sources: ComponentSources,
	request: {
		pathname: string;
		options?: PageFormsOptions;
		forms: FormsOfSite;
		moduleHosts: (site: Site) => Promise<string[]>;
	},
): View {
	const segments = pathSegments(request.pathname);
	const common = {
		host,
		sources,
		page: segments ? canonicalPath(segments) : "/",
		forms: request.options,
		formsOf: request.forms,
		moduleHosts: request.moduleHosts,
	};
	return editing
		? {
				...common,
				scope: editing.scope,
				version: "draft",
				structure: editing.code ? "draft" : "published",
				editing,
			}
		: { ...common, scope: data.visitors(host.site), version: "published", structure: "published" };
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
	/** What the content renders through, as published: its Entry template, a Page's layout. */
	content: ElementTree;
	/** The same in its Draft, as Code mode shows it. */
	contentDraft: ElementTree;
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
		return {
			postType,
			postTypes,
			entry,
			content: template.published as ElementTree,
			contentDraft: template.draft as ElementTree,
		};
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
	return { postType: pages, postTypes, entry, content: EMPTY_PAGE_LAYOUT, contentDraft: EMPTY_PAGE_LAYOUT };
}

async function renderEntryPage(
	view: View,
	host: SiteHost,
	styles: SiteStyles,
	located: Place & { found: FoundEntry },
	extras: LanguageExtras,
): Promise<SitePage> {
	const { scope } = view;
	const { found, languages } = located;
	const { postType, entry } = found;
	const previewed = view.editing?.preview?.source;
	const content =
		view.structure === "published"
			? found.content
			: previewed?.kind === "entryTemplate"
				? previewed.tree
				: found.contentDraft;
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
		found.postTypes,
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
): Promise<SitePage> {
	const { scope, editing } = view;
	const { languages, language } = place;
	const globalsRow = await scope.first(globals);
	const globalValues = globalsVersion(globalsRow, languages, view.version);
	const site = globalsParts(globalValues.fields, globalValues.values);
	const siteRoot: Parts = { text: undefined, part: (name) => (name === "site" ? site : undefined) };
	const previewed = editing?.preview?.source;
	const siteTemplate =
		view.structure === "published"
			? await publishedSiteTemplate(scope)
			: previewed?.kind === "siteTemplate"
				? previewed.tree
				: await draftSiteTemplate(scope);
	const placed = await pageComponents(scope, [page.content, siteTemplate], view.sources, site, languages, {
		which: view.structure,
		replace: previewed?.kind === "component" ? { id: previewed.id, version: previewed.version } : undefined,
	});
	// The Media the page may show: `media:<id>` written in either template or a Component it places,
	// and every media value the page reads (its content's, the Globals'). Ids that aren't the Site's
	// ready Media find nothing.
	const shown = await pageMedia(
		scope,
		[
			...mediaReferencesIn(JSON.stringify([page.content, siteTemplate ?? null, placed.trees])),
			...uuidsIn(JSON.stringify([contentValues, globalValues.values])),
		],
		languages,
	);
	const formsOn = await view.formsOf.on(host.site);
	const forms = await pageForms(scope, {
		on: formsOn,
		which: view.structure,
		language: language.code,
		page: view.page,
		token: !formsOn ? "" : view.forms?.cached ? FORM_TOKEN_MARK : await view.formsOf.token(host.site),
		forms: view.forms,
		editMode: editing !== undefined,
	});
	// A page sent back with a Form's errors says so first in its title.
	const invalid = view.forms?.state?.state.kind === "invalid";
	// Safe mode runs none of the Site's own scripts; outside scripts never run in Edit mode at all.
	const ownScripts = !editing?.safe;
	const rendered = renderDocument({
		...page,
		title: invalid ? `${formWords(language.code).errorPrefix} ${page.title}` : page.title,
		site: { name: host.site.name, language: language.code, direction: language.direction },
		siteTemplate,
		siteValues: (path) => resolvePath(siteRoot, path),
		className: styles.className,
		media: (id) => shown.get(id),
		styles: { stylesheet: styles.stylesheet.href, darkMode: styles.designSystem.darkMode },
		libraries: ownScripts ? await pageLibraries(scope) : [],
		scripts: ownScripts ? await pageScripts(scope, entry?.id ?? null, view.structure) : [],
		outsideScripts: await pageOutsideScripts(scope),
		editMode: editing && {
			...editing.head,
			region: editRegions(entry, storedFields(globalsRow?.fields)),
			code: view.structure === "draft",
		},
		component: placed.render,
		form: forms.render,
		formScripts: forms.outsideScripts,
	});
	const hosts = await policyHosts(view, forms.captchaHost);
	const headers = editing
		? { "content-security-policy": editModePolicy(hosts) }
		: pagePolicyHeaders({ mode: host.cspMode, hosts, frames: rendered.frames });
	return { html: rendered.html, headers, forms: forms.shown };
}

/**
 * The hosts a page's policy allows: the Site's allowed hosts, its running Modules' outside hosts, and
 * its CAPTCHA provider's host when the page shows a Form (its widget's script, frame and requests).
 */
async function policyHosts(view: View, captchaHost: () => string | null): Promise<string[]> {
	const captcha = captchaHost();
	const hosts = [
		...(await siteAllowedHosts(view.scope)),
		...(await view.moduleHosts(view.host.site)),
		...(captcha ? [captcha] : []),
	];
	return hosts.flatMap((host) => {
		try {
			return [readHost(host)];
		} catch {
			return [];
		}
	});
}

/**
 * The published Components the trees place, directly or through other Components, that can show on
 * the Site (a Component that isn't published, or a Module's that doesn't run there, shows nothing).
 * Components are Structure: in Edit mode, pages show their published versions; Code mode shows their
 * Drafts (`which`).
 */
async function placedComponents(
	scope: ReadScope,
	trees: readonly (ElementTree | undefined)[],
	sources: ComponentSources,
	which: "published" | "draft" = "published",
	replace?: { id: string; version: ComponentVersion },
): Promise<{ catalogue: SiteComponents; used: Map<string, ComponentVersion> }> {
	const catalogue = await siteComponents(scope, which, sources, { replace });
	const used = new Map<string, ComponentVersion>();
	const visit = (tree: ElementTree) => {
		for (const placement of placementsIn(tree.nodes)) {
			if (used.has(placement.component) || !isComponentInfo(catalogue.byId(placement.component))) continue;
			const version = catalogue.version(placement.component);
			if (!version) continue;
			used.set(placement.component, version);
			visit(version.tree);
		}
	};
	for (const tree of trees) if (tree) visit(tree);
	return { catalogue, used };
}

/**
 * How a page's Placements render: each Component's published tree, reading its Prop values
 * (`props.x`) and the Globals (`site.x`). Relationship Props written as Entry ids show those
 * published Entries of their Post Types.
 */
async function pageComponents(
	scope: ReadScope,
	trees: readonly (ElementTree | undefined)[],
	sources: ComponentSources,
	site: Parts,
	languages: { language: string; defaultLanguage: string },
	shown: { which: "published" | "draft"; replace?: { id: string; version: ComponentVersion } },
): Promise<{ trees: ElementTree[]; render: PlacementRenderer }> {
	const { catalogue, used } = await placedComponents(scope, trees, sources, shown.which, shown.replace);
	const shownTrees = [...used.values()].map((version) => version.tree);
	const related = await relatedOfProps(scope, [...trees, ...shownTrees], catalogue, languages);
	return {
		trees: shownTrees,
		render: (componentId, props, outer) => {
			const version = used.get(componentId);
			if (!version) return undefined;
			return {
				tree: version.tree,
				values: placementValues(version.props, props, outer, { site, related, read: propValue }),
			};
		},
	};
}

/** The published Entries Relationship Props written as Entry ids point at, with their Post Type's key. */
async function relatedOfProps(
	scope: ReadScope,
	trees: readonly (ElementTree | undefined)[],
	catalogue: SiteComponents,
	languages: { language: string; defaultLanguage: string },
): Promise<Map<string, RelatedEntry & { postTypeKey: string }>> {
	const ids: string[] = [];
	for (const tree of trees) {
		for (const placement of placementsIn(tree?.nodes ?? [])) {
			const props = catalogue.version(placement.component)?.props ?? [];
			for (const given of placement.props) {
				const prop = props.find((candidate) => candidate.key === given.name);
				if (prop?.type !== "relationship" || given.value.some((part) => part.type === "value")) continue;
				const value = propValue(prop, given.value.map((part) => (part.type === "text" ? part.text : "")).join(""));
				ids.push(...(Array.isArray(value) ? value : [value]).filter((id): id is string => typeof id === "string"));
			}
		}
	}
	if (ids.length === 0) return new Map();
	const postTypes = await listPostTypes(scope);
	const keys = new Map(postTypes.map((postType) => [postType.id, postType.key]));
	const related = new Map<string, RelatedEntry & { postTypeKey: string }>();
	for (const [id, entry] of await relatedEntries(scope, postTypes, ids, languages)) {
		related.set(id, { ...entry, postTypeKey: keys.get(entry.postTypeId) ?? "" });
	}
	return related;
}

/** The Site template's Draft, as Code mode shows it, or undefined while the Site has none (the built-in one shows). */
async function draftSiteTemplate(scope: ReadScope): Promise<ElementTree | undefined> {
	const row = await scope.first(templates, and(eq(templates.kind, "site"), isNull(templates.postTypeId)));
	return (row?.draft as ElementTree | undefined) ?? undefined;
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

async function nameOf(scope: ReadScope, personId: string): Promise<string | null> {
	const [row] = await scope.db.select({ name: people.name }).from(people).where(eq(people.id, personId));
	return row?.name ?? null;
}
