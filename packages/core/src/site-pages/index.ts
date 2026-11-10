import type { Database } from "@webcraft/db";
import {
	accessibilityStatements,
	components,
	entries,
	globals,
	people,
	publishedSlugs,
	siteDomains,
	sites,
	templates,
} from "@webcraft/db/schema";
import {
	BUILT_IN_SITE_TEMPLATE,
	builtInNotFoundPage,
	builtInSearchTemplate,
	type EditModePage,
	ELEMENT_TREE_VERSION,
	type ElementTree,
	FORM_TOKEN_MARK,
	formWords,
	isComponentInfo,
	type LanguageLink,
	loopNamesIn,
	mediaReferencesIn,
	type PageAlternate,
	type PageSearch,
	type PageToRender,
	type PlacementRenderer,
	pageWords,
	phoneWidthOf,
	placementsIn,
	placementsInValues,
	popupsPlacedIn,
	type QualityCheck,
	renderDocument,
	renderedCheckReport,
	renderedChecks,
	SCRIPT_PATH,
	SEARCH_QUERY_VALUE,
	searchElementIn,
	searchPageTitle,
	type TemplateValue,
	valuePathsOf,
} from "@webcraft/renderer";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { statementLayout, statementTitle } from "../accessibility/statement.ts";

import { type CdnKey, isCdnKey } from "../cdns/registry.ts";
import type { InstallConfig } from "../config.ts";
import { pageConsent } from "../consent/banner.ts";
import { archiveAt, archiveParts, publishedArchives } from "../content/archives.ts";
import {
	type ComponentSources,
	type ComponentVersion,
	NO_MODULE_COMPONENTS,
	type SiteComponents,
	siteComponents,
} from "../content/components.ts";
import { draftAddresses, findDraftEntry, findDraftPage } from "../content/draft-paths.ts";
import { editableField, imageField } from "../content/editable.ts";
import { entryStatus, entryValues } from "../content/entries.ts";
import { homePageId, type PublishedAddress, publishedAddresses } from "../content/entry-paths.ts";
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
import {
	candidatePatterns,
	findPublishedPage,
	isPagePostType,
	pathIn,
	pathText,
	publishedPageTree,
} from "../content/pages.ts";
import { listPostTypes, type PostType } from "../content/post-types.ts";
import { propValue } from "../content/props.ts";
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
import { isGonePath } from "../content/unpublishing.ts";
import { canonicalPath, pathFor, pathSegments, slugIn } from "../content/url-patterns.ts";
import { storedVersion } from "../content/values.ts";
import { isVisibleIn } from "../content/visibility.ts";
import {
	draftStyles,
	type SiteStyles,
	STYLESHEET_PATH,
	siteStyles,
	stylesheetFile,
} from "../design-system/stylesheet.ts";
import { domainOrigin, placeOf, type SiteAddresses, siteAddresses, verifiedDomains } from "../domains/addresses.ts";
import { type StateReader, writeQuery } from "../filters/state.ts";
import { type PageFormsOptions, pageForms, type ShownForm } from "../forms/page-forms.ts";
import { uuidsIn } from "../ids.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import { type StoredMediaFile, storedFile } from "../media/library.ts";
import { pageMedia } from "../media/page-media.ts";
import { pagePopups } from "../popups/page.ts";
import { readEntrySeo } from "../seo/entry-seo.ts";
import { archivePageSeo, entryPageSeo, type SeoPlace, type SeoSite, unlistedPageSeo } from "../seo/page-seo.ts";
import { siteSeoSettings } from "../seo/site-settings.ts";
import { siteAllowedHosts } from "../site-scripts/csp.ts";
import { type LibraryFile, libraryFile, pageLibraries } from "../site-scripts/libraries.ts";
import { outsideScriptCode, pageOutsideScripts } from "../site-scripts/outside-scripts.ts";
import { type CspMode, editModePolicy, isCspMode, pagePolicyHeaders, readHost } from "../site-scripts/policy.ts";
import { retiredScript } from "../site-scripts/retired.ts";
import type { DataLayer, Site, SiteScope } from "../tenancy/data-layer.ts";
import { slugOfStagingHostname, stagingUrl } from "./addresses.ts";
import { pageFilters } from "./filters.ts";
import { PAGE_PARAMETER, type PageLoops, pageHref, pageLoops, type SearchOnPage } from "./loops.ts";
import {
	addressFrom,
	createRedirectAnswers,
	languageOf,
	type MissesOf,
	type RedirectsOf,
	type SiteRedirect,
	sitePathIn,
} from "./redirects.ts";
import { relatedEntries, type ReadScope as ScopeToRead } from "./related.ts";

export { canonicalPath, pathSegments } from "../content/url-patterns.ts";

/** A Module's Site script on a Site where the Module runs: its code, file name and Consent category. */
export type ModuleScriptFile = {
	components?: readonly string[];
	moduleId: string;
	name: string;
	code: string;
	category: string;
	/** Whether it runs before visitors accept its category (it holds back itself what needs it). */
	beforeConsent: boolean;
};
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
	/**
	 * Where the Site's pages are for its visitors, whatever hostname asked: its verified Primary domain
	 * and languages' domains, or the Staging address while it has no Primary domain. Canonical URLs
	 * point there, so a live Site's Staging address never sends search engines to itself. Read only
	 * when a page renders (on the Staging address it takes a query), then kept for the request.
	 */
	visitorAddresses(): Promise<SiteAddresses>;
	/** Whether the Site sends a first visit to the home page on to the browser's language (ADR 0010). */
	browserLanguageRedirect: boolean;
	/** How the Site's Content Security Policy applies (ADR 0023). */
	cspMode: CspMode;
	/** The CDN in front of the Site, whose visitor header counts on connections from its servers; null for none. */
	cdn: CdnKey | null;
	/**
	 * The Site's page cache generation: a page rendered now stays valid until a publish raises it.
	 * Read before the page, so a page is never kept under a newer generation than its content.
	 */
	cacheGeneration: number;
};

/** A language a visitor chose with the Language switcher, and the page to go on to. */
export type LanguageChoice = { language: string; location: string };

/**
 * A rendered page of a Site, with the security headers it is sent with: the Site's Content Security
 * Policy as the page needs it (a body's video players framed), or Edit mode's own. Pages are cached
 * with them, so a change to the policy clears the page cache. `expiresAt` says until when it may be
 * kept: null for as long as nothing is published; else the first moment time alone could change it
 * (a Condition reading `now`, a Loop listing the last 12 months). `forms` are the Forms it shows,
 * numbered as their ids are.
 */
export type SitePage = {
	/** Advisory Checks, only requested by an editor. */
	checks?: QualityCheck[];
	html: string;
	headers: Record<string, string>;
	expiresAt: Date | null;
	forms?: readonly ShownForm[];
};

/**
 * What one answer of a page shows besides the page itself: what its Forms show (whether the page
 * goes into the page cache, one visitor's state of one Form, the Form just sent), and which page of a
 * paginated Loop visitors asked for (`?page=2`; the first when absent).
 */
export type RenderPageOptions = {
	forms?: PageFormsOptions;
	page?: number;
	/**
	 * What the visitor searches for (`q`, as `searchQueryIn` reads it): the Site's search results page
	 * lists its hits, and the page's Search elements show it. Other pages ignore it.
	 */
	search?: string;
	/**
	 * The request's query: what visitors chose in the page's Filters (GLOSSARY.md › Filter), read
	 * through their allow-list. Pages without a Filter ignore it.
	 */
	query?: URLSearchParams;
};

/**
 * What a page's Filters read from its address and what this answer's address chose, in its normal
 * form (`category=bread,pastries&q=rye`, "" for none): the page cache keeps a page under it, and a
 * page with a search in it is never kept.
 */
export type PageFilterState = { reader: StateReader; query: string; search: string | undefined };

/**
 * What a path on a Site answers: its page, or a permanent redirect (the home page's own path goes to
 * `/`; a language's path goes to its own domain, `keepQuery` then keeping the request's query; a page
 * number on a page whose Loops don't paginate goes to the page itself).
 */
export type SiteAnswer =
	| ({ kind: "page" } & SitePage & {
				/** The pages of the Loop that paginates on the page, when one does. */
				pagination: { current: number; count: number } | null;
				/** What the page's Filters read, and what this answer chose. */
				filters: PageFilterState;
				/**
				 * Whether it is the Site's search results page (ADR 0021): it shows one visitor's search,
				 * so it is never kept in the page cache, nor indexed by search engines.
				 */
				searchPage?: boolean;
			})
	| {
			kind: "redirect";
			location: string;
			keepQuery?: boolean;
			/**
			 * A Filter's choices sent in another form than their normal one (a plain form's fields): the
			 * page sends the visitor on to its normal address, for now (the Filter may change).
			 */
			temporary?: boolean;
	  };

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
	/** The Loops of the Site the page's Templates (and the Components they place) name. */
	loops: string[];
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
	/** A Draft rendered for Checks, with the same composition and values as a page. */
	checkEntry(
		scope: SiteScope,
		entryId: string,
		language: string,
	): Promise<{ checks: QualityCheck[]; bodies: string[]; templateKind: "entry" | "search" | "page" }>;
	checkArchive(scope: SiteScope, postTypeId: string, language: string): Promise<QualityCheck[]>;
	/** The Site a hostname belongs to, or null for a hostname that is no Site's (an unbranded 404). */
	resolveHost(hostname: string): Promise<SiteHost | null>;
	/** Whether `pathname` is the Site's search results page, in any of its languages (ADR 0021). */
	isSearchPage(host: SiteHost, pathname: string): Promise<boolean>;
	/**
	 * Whether a path with no page is where an Entry was until it was unpublished (a Scheduled publish):
	 * the Site answers it 410 Gone, with its 404 page, instead of 404. In the language the hostname and
	 * the path name, as visitors find pages.
	 */
	gone(host: SiteHost, pathname: string): Promise<boolean>;
	/** The language a path on a hostname is in, with its direction (the Default language when it names none). */
	languageAt(host: SiteHost, pathname: string): Promise<{ code: string; direction: "ltr" | "rtl" }>;
	/**
	 * What `pathname` answers on the Site: the published Entry a Post Type's URL pattern finds there,
	 * else the published Page at that path (the home page at `/`); null when there is none. With
	 * `editing`, the page for Edit mode: the same page, showing the Drafts of its Content (its Entry and
	 * the Globals) through the published Templates, its editable regions tagged. `options.page` is the
	 * page of a paginated Loop visitors asked for (`?page=2`): Pages (and Archive pages) show it; a page
	 * past the Loop's last is null, and one where no Loop paginates redirects to the page itself.
	 * `options.forms` is what the page's Forms show in this answer.
	 */
	render(
		host: SiteHost,
		pathname: string,
		editing?: PageEditing,
		options?: RenderPageOptions,
	): Promise<SiteAnswer | null>;
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
	/**
	 * Where the Site's Redirect rules send a request for `pathname` (SDK 1.5), ahead of its pages: a
	 * 301 or 302 to a path on this hostname, or to an address on another (of the Site's or elsewhere),
	 * without the request's query. Null when no rule applies, no Module keeping them runs on the Site,
	 * or the path is one the Install keeps (`/_…`). Answers are kept with the Site's page cache
	 * generation, so each path is asked once until the Site's pages change.
	 */
	redirect(host: SiteHost, pathname: string): Promise<SiteRedirect | null>;
	/**
	 * Notes a visitor's request for `pathname`, which the Site's 404 page answered, in the Site's 404
	 * log (when a Module keeping one runs there), with the host of the page that linked to it. It
	 * waits for nothing: the miss is handed over later, in the background.
	 */
	noteMiss(host: SiteHost, pathname: string, referrerHost: string | null): void;
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
	/** The Site scripts of the Modules running on a Site (SDK 1.3). */
	moduleScripts?: (site: Site) => Promise<ModuleScriptFile[]>;
	/** The Module keeping Redirect rules, asked through the Module host (SDK 1.5). None, when absent. */
	redirects?: RedirectsOf;
	/** The Module keeping the 404 log, handed misses through the Module host (SDK 1.5). None, when absent. */
	misses?: MissesOf;
}): SitePages {
	const { database, config, data, storage } = options;
	const moduleHosts = options.moduleHosts ?? (async () => []);
	const moduleScripts = options.moduleScripts ?? (async () => []);
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
		// The Staging address serves its Drafts' stylesheet as the Site's own file; Code mode, as Edit mode's.
		if (view.staging) return draftStyles(view.scope, {}, STYLESHEET_PATH);
		return view.editing?.preview?.styles ?? draftStyles(view.scope);
	};
	/** The same Draft composition used by Staging, without requiring a public hostname. */
	const checkView = async (scope: SiteScope): Promise<{ view: View; host: SiteHost; site: SiteLanguages }> => {
		const site = await siteLanguages(scope);
		const origin = stagingUrl(config, scope.site.slug) ?? `https://${config.adminHost}`;
		const addresses = { main: origin, languages: {} };
		const host: SiteHost = {
			site: scope.site,
			address: "staging",
			language: null,
			redirectTo: null,
			origin,
			addresses,
			visitorAddresses: async () => addresses,
			defaultLanguage: site.defaultLanguage,
			browserLanguageRedirect: false,
			cspMode: "strict",
			cdn: null,
			cacheGeneration: 0,
		};
		const view: View = {
			scope,
			host,
			sources,
			version: "draft",
			structure: "draft",
			entries: "draft",
			routing: "draft",
			staging: true,
			page: "/",
			query: new URLSearchParams(),
			pageNumber: 1,
			formsOf: forms,
			moduleHosts,
			moduleScripts,
			checkMarkup: true,
		};
		return { view, host, site };
	};
	const redirectAnswers = createRedirectAnswers();
	return {
		async checkEntry(scope, entryId, code) {
			const { view, host, site } = await checkView(scope);
			const languages = { language: code, defaultLanguage: site.defaultLanguage };
			const entry = await scope.first(entries, eq(entries.id, entryId));
			const postTypes = await listPostTypes(scope);
			const postType = postTypes.find((p) => p.id === entry?.postTypeId);
			if (!entry || !postType || !isVisibleIn(storedVersion(entry.draft), languages))
				return { checks: [], bodies: [], templateKind: "entry" };
			const template = await scope.first(
				templates,
				and(eq(templates.kind, "entry"), eq(templates.postTypeId, postType.id)),
			);
			const content = (template?.draft as ElementTree | undefined) ?? EMPTY_PAGE_LAYOUT;

			const place: Located = {
				kind: "found",
				site,
				languages,
				language: languageNamed(site, code),
				found: { entry, postType, postTypes, content, contentDraft: content },
			};
			const templateKind =
				(await specialPageId(scope, "search")) === entry.id ? "search" : isPagePostType(postType) ? "page" : "entry";
			const styles = await viewStyles(view);
			const extras = { alternates: [], languageLinks: [] };
			const rendered =
				templateKind === "search"
					? await renderSearchPage(view, host, styles, place, extras, { page: 1, path: "/", query: "", state: "" })
					: await renderEntryPage(view, host, styles, place, extras, { page: null, path: "/" });
			return { ...renderedCheckReport(rendered.html, { language: code, complete: true }), templateKind };
		},
		async checkArchive(scope, postTypeId, code) {
			const { view, host, site } = await checkView(scope);
			const postType = (await listPostTypes(scope)).find((p) => p.id === postTypeId);
			const parts = postType && archiveParts(postType.urlPattern);
			if (!parts) return [];
			const path = languagePath({ language: code, defaultLanguage: site.defaultLanguage }, pathText(parts));
			const archive = await locateArchive(scope, host, path, true, "draft");
			if (!archive) return [];
			const rendered = await renderArchivePage(view, host, await viewStyles(view), archive, 1);
			return renderedChecks(rendered.html, { language: code, complete: true });
		},
		async resolveHost(hostname) {
			const slug = slugOfStagingHostname(config, hostname);
			if (slug) {
				const [row] = await database.db.select().from(sites).where(eq(sites.slug, slug));
				if (!row) return null;
				const origin = stagingUrl(config, row.slug) ?? `https://${hostname}`;
				// The Staging address shows every language under its prefix, on itself.
				const addresses = { main: origin, languages: {} };
				let live: Promise<SiteAddresses> | undefined;
				const visitorAddresses = () => {
					live ??= siteAddresses(database.db, config, row).then((found) => found ?? addresses);
					return live;
				};
				return hostOf(row, {
					address: "staging",
					language: null,
					redirectTo: null,
					origin,
					addresses,
					visitorAddresses,
				});
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
				visitorAddresses: async () => addresses,
			});
		},

		async isSearchPage(host, pathname) {
			const drafts = showsDrafts(host);
			const scope = drafts ? data.staging(host.site) : data.visitors(host.site);
			const searchPageId = await specialPageId(scope, "search");
			if (!searchPageId) return false;
			const located = await locate(scope, host, pathname, false, drafts ? "draft" : "published");
			return located?.kind === "found" && located.found.entry.id === searchPageId;
		},

		async gone(host, pathname) {
			const segments = pathSegments(pathname);
			if (!segments || isReservedPath(segments)) return false;
			const scope = data.visitors(host.site);
			const onHost = pathOnHost(await siteLanguages(scope), host, segments, false);
			if (onHost.kind !== "path") return false;
			return isGonePath(scope, onHost.languages.language, canonicalPath(onHost.rest));
		},

		async languageAt(host, pathname) {
			const scope = data.visitors(host.site);
			const site = await siteLanguages(scope);
			const code = await languageOnHost(scope, host, pathname);
			return { code, direction: languageNamed(site, code).direction };
		},

		async render(host, pathname, editing, options = {}) {
			const page = options.page ?? 1;
			const view = viewFor(data, host, editing, sources, {
				pathname,
				pageNumber: page,
				query: options.query,
				options: options.forms,
				forms,
				moduleHosts,
				moduleScripts,
			});
			const archive = await locateArchive(view.scope, host, pathname, editing !== undefined, view.structure);
			if (archive) {
				const rendered = await renderArchivePage(view, host, await viewStyles(view), archive, page);
				if (rendered.redirect) return { kind: "redirect", ...rendered.redirect };
				if (page > 1 && !rendered.pagination) {
					return { kind: "redirect", location: pageHref(archive.path, 1, rendered.filters.query) };
				}
				if (rendered.pagination && page > rendered.pagination.count) return null;
				return { kind: "page", ...rendered };
			}
			const located = await locate(view.scope, host, pathname, editing !== undefined, view.routing);
			if (!located) return null;
			if (located.kind === "redirect") return located;
			const extras = await languageExtras(view.scope, host, located, located.found, view.entries);
			const path = canonicalPath(pathSegments(pathname) ?? []);
			if ((await specialPageId(view.scope, "search")) === located.found.entry.id) {
				// The Site's search results page: its Page shows the Search results template's hits.
				const query = options.search ?? "";
				const state = query ? new URLSearchParams({ q: query }).toString() : "";
				const rendered = await renderSearchPage(view, host, await viewStyles(view), located, extras, {
					page,
					path,
					query,
					state,
				});
				if (rendered.redirect) return { kind: "redirect", ...rendered.redirect };
				if (page > 1 && !rendered.pagination) {
					return {
						kind: "redirect",
						location: pageHref(path, 1, writeQuery([...pairsOf(state), ...pairsOf(rendered.filters.query)])),
					};
				}
				if (rendered.pagination && page > rendered.pagination.count) return null;
				return { kind: "page", ...rendered, searchPage: true };
			}
			// Loops paginate on Pages; on an Entry's page they show their first page.
			const paginates = isPagePostType(located.found.postType);
			const rendered = await renderEntryPage(view, host, await viewStyles(view), located, extras, {
				page: paginates ? page : null,
				path,
			});
			if (rendered.redirect) return { kind: "redirect", ...rendered.redirect };
			if (page > 1 && !rendered.pagination)
				return { kind: "redirect", location: pageHref(path, 1, rendered.filters.query) };
			if (rendered.pagination && page > rendered.pagination.count) return null;
			return { kind: "page", ...rendered };
		},

		async pageContent(host, pathname) {
			const scope = data.visitors(host.site);
			const archive = await locateArchive(scope, host, pathname, true, "published");
			if (archive) {
				const siteTemplate = (await publishedSiteTemplate(scope)) ?? BUILT_IN_SITE_TEMPLATE;
				const placed = await placedComponents(scope, [siteTemplate, archive.content], sources);
				const trees = [siteTemplate, archive.content, ...[...placed.used.values()].map((version) => version.tree)];
				return {
					entryId: null,
					language: archive.language.code,
					languages: archivePlaces(archive).map(({ language, path }) => ({
						code: language.code,
						name: language.name,
						path,
						current: language.code === archive.language.code,
					})),
					readsGlobals: trees.some((tree) => valuePathsOf(tree).some((path) => path.startsWith("site."))),
					loops: [...new Set(trees.flatMap((tree) => loopNamesIn(tree)))],
					notFound: false,
					// Code mode opens Entry templates and the Site template so far; an Archive page's Template is a later step.
					templatePostTypeId: null,
				};
			}
			const located = await locate(scope, host, pathname, true, "publishedThenDraft");
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
				loops: [...new Set(trees.flatMap((tree) => loopNamesIn(tree)))],
				notFound: located === null,
				templatePostTypeId: found && !isPagePostType(found.postType) ? found.postType.id : null,
			};
		},

		async notFound(host, pathname, editing, formOptions) {
			const view = viewFor(data, host, editing, sources, {
				pathname,
				options: formOptions,
				forms,
				moduleHosts,
				moduleScripts,
			});
			const place = await notFoundPlace(view.scope, host, pathname, view.entries);
			const styles = await viewStyles(view);
			const { languageLinks } = await languageExtras(view.scope, host, place, undefined, view.entries);
			const path = canonicalPath(pathSegments(pathname) ?? []);
			if (place.found) {
				const located = { ...place, found: place.found };
				return renderEntryPage(
					view,
					host,
					styles,
					located,
					{ alternates: [], languageLinks },
					{ page: null, path, notFound: true },
				);
			}
			const builtIn = builtInNotFoundPage(place.language.code);
			const seo = await unlistedPageSeo(
				view.scope,
				await seoSiteOf(view, host, place),
				seoPlace(place, []),
				builtIn.title,
			);
			return renderSitePage(view, host, styles, place, {
				page: { ...builtIn, seo, languageLinks, values: () => undefined },
				loops: { current: null, page: null, path },
			});
		},

		async formPage(host, pathname, formId, formOptions) {
			const view = viewFor(data, host, undefined, sources, {
				pathname,
				options: formOptions,
				forms,
				moduleHosts,
				moduleScripts,
			});
			const place = await notFoundPlace(view.scope, host, pathname, view.entries);
			const styles = await viewStyles(view);
			const { languageLinks } = await languageExtras(view.scope, host, place, undefined, view.entries);
			const title = formWords(place.language.code).problemTitle;
			return renderSitePage(view, host, styles, place, {
				page: {
					title,
					seo: await unlistedPageSeo(view.scope, await seoSiteOf(view, host, place), seoPlace(place, []), title),
					languageLinks,
					content: { version: 1, nodes: [{ type: "form", form: formId }] },
					values: () => undefined,
				},
				loops: { current: null, page: null, path: canonicalPath(pathSegments(pathname) ?? []) },
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
			if (showsDrafts(host)) {
				// The Staging address's pages link the stylesheet of the Design system's Draft and the Drafts' trees.
				const drafts = await draftStyles(data.staging(host.site), {}, STYLESHEET_PATH);
				if (name === `${drafts.stylesheet.hash}.css`) return drafts.stylesheet.css;
			}
			return stylesheetFile(data.visitors(host.site), await stylesOf(host), name);
		},

		async script(host, name) {
			const ofModule = (await moduleScripts(host.site)).find((script) => script.name === name);
			if (ofModule) return ofModule.code;
			const scope = data.visitors(host.site);
			const published = await scriptFile(scope, name, "published");
			if (published !== null) return published;
			// The Staging address's pages run the Drafts of the Site script and page scripts.
			if (showsDrafts(host)) {
				const draft = await scriptFile(data.staging(host.site), name, "draft");
				if (draft !== null) return draft;
			}
			const hash = /^([0-9a-f]{16})\.js$/.exec(name)?.[1];
			if (!hash) return null;
			return (await outsideScriptCode(scope, hash)) ?? (await retiredScript(scope, hash));
		},

		libraryFile(host, name) {
			return libraryFile(data.visitors(host.site), storage, name);
		},

		async redirect(host, pathname) {
			const redirects = options.redirects;
			const segments = pathSegments(pathname);
			if (!redirects || !segments || segments[0]?.startsWith("_")) return null;
			const key = `${host.origin}${canonicalPath(segments)}`;
			const kept = redirectAnswers.get(host, key);
			if (kept !== undefined) return kept;
			const scope = data.visitors(host.site);
			const site = await siteLanguages(scope);
			const request = sitePathIn(site, host, segments);
			// Rules name Site paths, as the Staging address writes them, whatever hostname asked.
			const asStaging: SiteHost = { ...host, address: "staging", language: null };
			const target = await redirects(host.site, request, {
				hasPage: async (path) =>
					(await locateArchive(scope, asStaging, path, true, "published")) !== undefined ||
					(await locate(scope, asStaging, path, true, "published"))?.kind === "found",
				languageOf: (path) => languageOf(site, path),
				mediaPath: async (mediaId) => {
					const languages = { language: site.defaultLanguage, defaultLanguage: site.defaultLanguage };
					return (await pageMedia(scope, [mediaId], languages)).get(mediaId.toLowerCase())?.url ?? null;
				},
				entryPath: (entryId, language) => publishedEntryPath(scope, site, entryId, language),
			});
			const location = target && addressFrom(site, host, target.to);
			// A rule never sends a request to its own address (whatever query it adds), which would loop.
			const [there = ""] = (location ?? "").split(/[?#]/);
			const answer =
				target && location && there !== key.slice(host.origin.length) && there !== key
					? { location, status: target.status }
					: null;
			redirectAnswers.set(host, key, answer);
			return answer;
		},

		noteMiss(host, pathname, referrerHost) {
			const misses = options.misses;
			const segments = pathSegments(pathname);
			if (!misses?.keeps || !segments || isReservedPath(segments)) return;
			const scope = data.visitors(host.site);
			const at = scope.now();
			siteLanguages(scope)
				.then((site) => misses.note(host.site, { ...sitePathIn(site, host, segments), referrerHost, at }))
				.catch(() => {
					// The 404 log is a guide, never a reason for a 404 to fail.
				});
		},
	};
}

/** A Site found by a hostname, with how the hostname reaches it. */
function hostOf(
	row: typeof sites.$inferSelect,
	how: Pick<SiteHost, "address" | "language" | "redirectTo" | "origin" | "addresses" | "visitorAddresses">,
): SiteHost {
	return {
		site: { id: row.id, workspaceId: row.workspaceId, name: row.name, slug: row.slug, createdAt: row.createdAt },
		...how,
		defaultLanguage: row.defaultLanguage,
		// Only where `/` is the Default language's home page: never on a language's own domain.
		browserLanguageRedirect: how.address !== "language" && row.browserLanguageRedirect,
		cspMode: isCspMode(row.cspMode) ? row.cspMode : "strict",
		cdn: isCdnKey(row.cdn) ? row.cdn : null,
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
/**
 * Where an Entry is published now in a language (null: the Default language), as a Site path with
 * the language's prefix: a Page by its place in the published Page tree, any other Entry by its Post
 * Type's URL pattern and published slug. Null while it isn't published there, or for a language the
 * Site doesn't have.
 */
async function publishedEntryPath(
	scope: ReadScope,
	site: SiteLanguages,
	entryId: string,
	language: string | null,
): Promise<string | null> {
	const code = language
		? site.languages.find((each) => each.code.toLowerCase() === language.toLowerCase())?.code
		: site.defaultLanguage;
	if (!code) return null;
	const [row] = await scope.select(entries, eq(entries.id, entryId));
	if (!row || row.published === null) return null;
	const postType = (await listPostTypes(scope)).find((each) => each.id === row.postTypeId);
	if (!postType) return null;
	const languages = { language: code, defaultLanguage: site.defaultLanguage };
	if (isPagePostType(postType)) {
		const parts = pathIn(await publishedPageTree(scope, postType.id, code), entryId);
		return parts ? languagePath(languages, pathText(parts)) : null;
	}
	const slug = await scope.first(
		publishedSlugs,
		and(eq(publishedSlugs.entryId, entryId), eq(publishedSlugs.language, code)),
	);
	const path = slug ? pathFor(postType.urlPattern, slug.slug) : null;
	return path ? languagePath(languages, path) : null;
}

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

/**
 * The published Entry a path finds on a hostname, as visitors find it (`locate`): for what is worked
 * out from a page without rendering it, such as its Markdown copy. A path that moved answers where
 * it went (another of the Site's domains, the home page's root); null where no Entry is.
 */
export async function publishedEntryAt(
	scope: ReadScope,
	host: SiteHost,
	pathname: string,
): Promise<
	| {
			kind: "found";
			entry: typeof entries.$inferSelect;
			postType: PostType;
			postTypes: readonly PostType[];
			languages: Languages;
	  }
	| { kind: "redirect"; location: string }
	| null
> {
	const located = await locate(scope, host, pathname, false, "published");
	if (!located) return null;
	if (located.kind === "redirect") return { kind: "redirect", location: located.location };
	const { entry, postType, postTypes } = located.found;
	return { kind: "found", entry, postType, postTypes, languages: located.languages };
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
	routing: Routing = "published",
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
	const published =
		routing === "draft"
			? undefined
			: rest.length === 0
				? home && (await publishedPage(scope, postTypes, home))
				: ((await findPublishedEntry(scope, postTypes, rest, languages.language)) ??
					(await findPage(scope, postTypes, rest, languages.language)));
	// An Entry hidden in the language has no page there.
	let found = published && isVisibleIn(storedVersion(published.entry.published), languages) ? published : undefined;
	// The Staging address finds Entries by their Drafts' addresses; Edit mode also reaches those never published.
	if (!found && routing !== "published") {
		found = await draftAt(scope, postTypes, rest, languages, home, routing === "draft" ? "draft" : "published");
	}
	if (!found) return unprefixed ? { kind: "redirect", location: canonicalPath(unprefixed) } : null;
	if (rest.length > 0 && found.entry.id === home) return { kind: "redirect", location: hostPath(host, languages, "/") };
	return { kind: "found", found, ...place };
}

/**
 * The Entry whose Draft would be published at a path's parts in the language (`draft-paths.ts`): an
 * Entry of the Post Type whose URL pattern matches, through its Entry template (its Draft with
 * `templates: "draft"`, as the Staging address shows it; its published version otherwise), else the
 * Page at that Draft path; at the root, the home page. Never published ones too; hidden ones in the
 * language aren't.
 */
async function draftAt(
	scope: ReadScope,
	postTypes: readonly PostType[],
	rest: readonly string[],
	languages: Languages,
	home: string | undefined,
	which: "published" | "draft",
): Promise<FoundEntry | undefined> {
	if (rest.length === 0) return home ? draftPage(scope, postTypes, home, languages) : undefined;
	for (const { postType, pattern } of candidatePatterns(postTypes)) {
		const slug = slugIn(pattern, rest);
		if (!slug) continue;
		const entry = await findDraftEntry(scope, postType.id, slug, languages);
		if (!entry) continue;
		const template = await scope.first(
			templates,
			and(eq(templates.kind, "entry"), eq(templates.postTypeId, postType.id)),
		);
		const published = (template?.published as ElementTree | null | undefined) ?? undefined;
		const draft = (template?.draft as ElementTree | undefined) ?? undefined;
		if (!draft || (which === "published" && !published)) return undefined;
		return { postType, postTypes, entry, content: published ?? draft, contentDraft: draft };
	}
	const pages = postTypes.find(isPagePostType);
	const pageId = pages && (await findDraftPage(scope, pages.id, rest, languages));
	return pageId ? draftPage(scope, postTypes, pageId, languages) : undefined;
}

/** A Page of the Site by id as its Draft would show it, published or not; undefined when it isn't one, or is hidden in the language. */
async function draftPage(
	scope: ReadScope,
	postTypes: readonly PostType[],
	pageId: string,
	languages: Languages,
): Promise<FoundEntry | undefined> {
	const pages = postTypes.find(isPagePostType);
	const entry = await scope.first(entries, eq(entries.id, pageId));
	if (!pages || entry?.postTypeId !== pages.id || !isVisibleIn(storedVersion(entry.draft), languages)) return undefined;
	return { postType: pages, postTypes, entry, content: EMPTY_PAGE_LAYOUT, contentDraft: EMPTY_PAGE_LAYOUT };
}

/** Where Entries are, as a view lists them: at their published addresses, or on the Staging address at their Drafts'. */
function addressesOf(
	which: "published" | "draft",
): (
	scope: ReadScope,
	postType: PostType,
	ids: readonly string[],
	languages: Languages,
) => Promise<Map<string, PublishedAddress>> {
	return which === "draft" ? draftAddresses : publishedAddresses;
}

/** An Archive page: the published Archive template at its Post Type's address, in the path's language. */
type LocatedArchive = Place & {
	postType: PostType;
	content: ElementTree;
	/** Its address in the page's language (`/fr/recipes`). */
	path: string;
	parts: readonly string[];
};

/**
 * The published Archive template whose address a path is, in the language the hostname and the path
 * name (`pathOnHost`); undefined when there is none, or when the path moved to another of the Site's
 * addresses (`locate` answers that). Its address is fixed parts only, more specific than any URL
 * pattern, and no Page can be published there.
 */
async function locateArchive(
	scope: ReadScope,
	host: SiteHost,
	pathname: string,
	editing: boolean,
	which: "published" | "draft",
): Promise<LocatedArchive | undefined> {
	const segments = pathSegments(pathname);
	if (!segments || segments.length === 0 || isReservedPath(segments)) return undefined;
	const site = await siteLanguages(scope);
	const onHost = pathOnHost(site, host, segments, editing);
	if (onHost.kind === "moved" || onHost.rest.length === 0) return undefined;
	const { languages, rest } = onHost;
	// The Staging address shows Archive templates by their Drafts, published or not.
	const archive = archiveAt(await publishedArchives(scope, await listPostTypes(scope), which), rest);
	if (!archive) return undefined;
	const row = await scope.first(
		templates,
		and(
			eq(templates.kind, "archive"),
			eq(templates.postTypeId, archive.postType.id),
			which === "published" ? isNotNull(templates.published) : undefined,
		),
	);
	if (!row) return undefined;
	return {
		site,
		languages,
		language: languageNamed(site, languages.language),
		postType: archive.postType,
		content: (which === "published" ? row.published : row.draft) as ElementTree,
		parts: archive.parts,
		path: hostPath(host, languages, pathText(archive.parts)),
	};
}

/** An Archive page's address in each of the Site's languages (it is shown in all of them), under each one's prefix. */
function archivePlaces(archive: LocatedArchive): { language: SiteLanguage; path: string }[] {
	return archive.site.languages.map((language) => ({
		language,
		path: languagePath(
			{ language: language.code, defaultLanguage: archive.site.defaultLanguage },
			pathText(archive.parts),
		),
	}));
}

/**
 * An Archive page: its Archive template in the Site template, titled with its Post Type's name (and
 * the page's number past the first), with `hreflang` alternates to the same page in every language
 * (each at its own address, on this hostname or another of the Site's domains) and the Language
 * switcher's links to the Archive page there. Its Loops paginate.
 */
async function renderArchivePage(
	view: View,
	host: SiteHost,
	styles: SiteStyles,
	archive: LocatedArchive,
	page: number,
): Promise<RenderedPage> {
	const alternates: PageAlternate[] = [];
	const languageLinks: LanguageLink[] = [];
	if (archive.site.languages.length > 1) {
		for (const { language, path } of archivePlaces(archive)) {
			const there = placeOf(
				host.addresses,
				{ language: language.code, defaultLanguage: archive.site.defaultLanguage },
				path,
			);
			const href = `${there.origin}${there.path}`;
			alternates.push({ hreflang: language.code, href: `${there.origin}${pageHref(there.path, page)}` });
			languageLinks.push({
				code: language.code,
				name: language.name,
				direction: language.direction,
				href: there.origin === host.origin ? languageChoiceHref(there.path) : href,
				current: language.code === archive.language.code,
			});
		}
		const fallback = alternates.find((alternate) => alternate.hreflang === archive.site.defaultLanguage);
		if (fallback) alternates.push({ hreflang: "x-default", href: fallback.href });
	}
	const site = await siteParts(view, archive, host.site.name);
	const root: Parts = { text: null, part: (name) => (name === "site" ? site : undefined) };
	const title = pagedTitle(archive.postType.name, page, archive.language.code);
	const seo = await archivePageSeo(view.scope, await seoSiteOf(view, host, archive), seoPlace(archive, alternates), {
		postType: archive.postType,
		title,
		path: languagePath(archive.languages, pathText(archive.parts)),
		page,
	});
	return renderSitePage(view, host, styles, archive, {
		page: {
			title,
			seo,
			alternates,
			languageLinks,
			content: archive.content,
			values: (path) => resolvePath(root, path),
		},
		loops: { current: null, page, path: archive.path },
	});
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
	which: "published" | "draft" = "published",
): Promise<LanguageExtras> {
	const { site } = place;
	const extras: LanguageExtras = { alternates: [], languageLinks: [] };
	if (site.languages.length < 2) return extras;
	for (const { language, path, shown } of await languagePlaces(scope, place, found, which)) {
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
	which: "published" | "draft" = "published",
): Promise<{ language: SiteLanguage; path: string; shown: boolean }[]> {
	const { site } = place;
	const version =
		found && (which === "draft" ? storedVersion(found.entry.draft) : storedVersion(found.entry.published));
	const places: { language: SiteLanguage; path: string; shown: boolean }[] = [];
	for (const language of site.languages) {
		const languages = { language: language.code, defaultLanguage: site.defaultLanguage };
		const visible = found && found.entry[which] !== null && version && isVisibleIn(version, languages);
		const address = visible
			? (await addressesOf(which)(scope, found.postType, [found.entry.id], languages)).get(found.entry.id)
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
	which: "published" | "draft" = "published",
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
		if (!chosen) continue;
		// On the Staging address, the chosen Page as its Draft shows it, published or not.
		const page =
			which === "draft"
				? await draftPage(scope, postTypes, chosen, languages)
				: await publishedPage(scope, postTypes, chosen);
		if (page && (which === "draft" || isVisibleIn(storedVersion(page.entry.published), languages))) {
			return { ...place, found: page };
		}
	}
	return place;
}

/**
 * What rendering reads with: the read-only scope of a Site's visitors, or in Edit mode the Site
 * opened for the person editing. Routing (which Entry a path finds) is the same for both.
 */
type ReadScope = ScopeToRead;

/**
 * How a page is being viewed: by visitors (the published version of its Content and Structure), in
 * Edit mode (the Drafts of its Content through the published Structure, with editable regions
 * tagged) or in Code mode (the Drafts of both, every element tagged).
 */
type View = {
	checkMarkup?: boolean;
	host: SiteHost;
	scope: ReadScope;
	/** Which version of the page's Content shows: its Entry's and the Globals'. */
	version: "published" | "draft";
	/** Which version of the Site's Structure shows: its Templates', Components' and Design system's. */
	structure: "published" | "draft";
	/**
	 * Which Entries the page lists and links to, and where they are: the published ones at their
	 * published addresses, or on the Staging address every Entry's Draft at its Draft address (Loops,
	 * Relationships, the page's own address and its languages').
	 */
	entries: "published" | "draft";
	/** How a path finds its page: see `Routing`. */
	routing: Routing;
	/**
	 * Whether the page is for the Staging address (ADR 0014): the Site with all its Drafts, never
	 * indexed, and never the canonical address of a page.
	 */
	staging: boolean;
	editing?: PageEditing;
	/** Where the Components of the Modules running on the Site come from. */
	sources: ComponentSources;
	/**
	 * The page's address on its hostname, which its Forms send back with what visitors fill in: its
	 * path, and `?page=N` past the first page of a paginated Loop, so a Form sent back with errors
	 * shows that page again.
	 */
	page: string;
	/** What this answer shows in the page's Forms (whether it is cached, one visitor's state of one Form). */
	forms?: PageFormsOptions;
	/** The request's query, which the page's Filters read (GLOSSARY.md › Filter). */
	query: URLSearchParams;
	/** Which page of a paginated Loop the answer shows (1 for the first). */
	pageNumber: number;
	/** Whether Forms run on the Site, and their time-trap tokens. */
	formsOf: FormsOfSite;
	/** The outside hosts of the Modules running on the Site. */
	moduleHosts: (site: Site) => Promise<string[]>;
	/** The Site scripts of the Modules running on the Site. */
	moduleScripts: (site: Site) => Promise<ModuleScriptFile[]>;
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
		/** Which page of a paginated Loop the answer shows; the first when absent. */
		pageNumber?: number;
		/** The request's query, which the page's Filters read. */
		query?: URLSearchParams;
		options?: PageFormsOptions;
		forms: FormsOfSite;
		moduleHosts: (site: Site) => Promise<string[]>;
		moduleScripts: (site: Site) => Promise<ModuleScriptFile[]>;
	},
): View {
	const segments = pathSegments(request.pathname);
	const common = {
		host,
		sources,
		page: pageHref(segments ? canonicalPath(segments) : "/", request.pageNumber ?? 1),
		query: request.query ?? new URLSearchParams(),
		pageNumber: request.pageNumber ?? 1,
		forms: request.options,
		formsOf: request.forms,
		moduleHosts: request.moduleHosts,
		moduleScripts: request.moduleScripts,
	};
	if (editing) {
		return {
			...common,
			scope: editing.scope,
			version: "draft",
			structure: editing.code ? "draft" : "published",
			entries: "published",
			routing: "publishedThenDraft",
			staging: false,
			editing,
		};
	}
	// The Staging address shows the Site with all its Drafts: Content and Structure (ADR 0014).
	if (showsDrafts(host)) {
		return {
			...common,
			scope: data.staging(host.site),
			version: "draft",
			structure: "draft",
			entries: "draft",
			routing: "draft",
			staging: true,
		};
	}
	return {
		...common,
		scope: data.visitors(host.site),
		version: "published",
		structure: "published",
		entries: "published",
		routing: "published",
		staging: false,
	};
}

/**
 * Whether a hostname shows the Site with all its Drafts: its Staging address does (ADR 0014), once the
 * Site request pipeline let the request through its access check. Its answers are never indexed,
 * never kept in the page cache, and left out of sitemaps; sitemaps, `robots.txt` and `llms.txt` (#92)
 * answer with this rule.
 */
export function showsDrafts(host: Pick<SiteHost, "address">): boolean {
	return host.address === "staging";
}

/**
 * How a path finds its page: `published`, as visitors find it (published Entries at their published
 * addresses); `draft`, as the Staging address shows the Site with all its Drafts (every Entry, never
 * published ones too, at the address its Draft would be published at, through the Templates' Drafts);
 * `publishedThenDraft`, as Edit mode does (the published page at the path, else an Entry whose Draft
 * would be published there, so Pages never published yet can be edited in place).
 */
type Routing = "published" | "draft" | "publishedThenDraft";

/**
 * Edit mode's tags: which bindings mark their element as an editable region. The page's content may
 * edit its Entry's text and rich text Fields (and its title) and the Globals (`site.x`); the Site
 * template, the Globals only. Values through a formatter show something other than what is stored,
 * so they are never typed over.
 */
function editRegions(
	entry: { id: string; fields: readonly FieldDefinition[] } | null,
	globalFields: readonly FieldDefinition[],
	loops: Pick<PageLoops, "byId">,
): EditModePage["region"] {
	return (value, template, place) => {
		if (value.format) return undefined;
		// An image's `src` shows a media Field; everything else is typed over.
		const editableIn = place.image ? imageField : editableField;
		if (place.item) {
			// Inside a Loop: a Loop's own item's values are regions of that item (`loop:<id>:<item id>`);
			// a query Loop's items are Entries, changed on their own pages; what is around the Loop
			// repeats with every item.
			const { alias, key } = place.item;
			const [kind, loopId] = key?.split(":") ?? [];
			if (kind !== "loop" || !key || !value.path.startsWith(`${alias}.`)) return undefined;
			const shown = loopId ? loops.byId(loopId) : undefined;
			const path = value.path.slice(alias.length + 1);
			const editable = shown?.source === "items" ? editableIn(shown.fields, path) : undefined;
			return editable && regionTags(key, path, editable.type, editable.label);
		}
		if (value.path.startsWith("site.")) {
			const key = value.path.slice("site.".length);
			const editable = editableIn(globalFields, key);
			return editable && regionTags("globals", key, editable.type, editable.label);
		}
		if (template !== "content" || !entry) return undefined;
		if (place.block !== undefined) {
			// An image Block of the Entry's body: the image is the region, the body's text the block editor's.
			const body = entry.fields.find((field) => field.key === value.path && field.type === "body");
			return body && regionTags(`entry:${entry.id}`, body.key, "media", body.label);
		}
		// The title is a built-in value: the editing bar names it in the person's own language.
		if (value.path === "title" && !place.image) return regionTags(`entry:${entry.id}`, "title", "text", null);
		// The body: its element is the block editor's region (#79).
		const body = place.image
			? undefined
			: entry.fields.find((field) => field.key === value.path && field.type === "body");
		if (body) return regionTags(`entry:${entry.id}`, body.key, "body", body.label);
		const editable = editableIn(entry.fields, value.path);
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
	where: { page: number | null; path: string; notFound?: boolean },
): Promise<RenderedPage> {
	const { scope } = view;
	const { found, languages } = located;
	const { postType, entry } = found;
	const previewed = view.editing?.preview?.source;
	const content =
		(isPagePostType(postType) ? await statementLayout(scope, entry.id) : undefined) ??
		(view.structure === "published"
			? found.content
			: previewed?.kind === "entryTemplate"
				? previewed.tree
				: found.contentDraft);
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
	const site = await siteParts(view, located, host.site.name);
	const related = await relatedEntries(
		scope,
		found.postTypes,
		linksIn(version.values, postType.fields).map((link) => link.targetId),
		languages,
		view.entries,
	);
	const root = entryParts(builtIns, postType.fields, published.fields, {
		related,
		site,
	});
	// Past a Page's first page, its title says which, and its alternates are that page in each language.
	const page = where.page ?? 1;
	const title = pagedTitle(published.title, page, located.language.code);
	const address = (await addressesOf(view.entries)(scope, postType, [entry.id], languages)).get(entry.id);
	const seo = await entryPageSeo(scope, await seoSiteOf(view, host, located), seoPlace(located, extras.alternates), {
		postType,
		entryId: entry.id,
		version: view.entries,
		seo: readEntrySeo(version.values, languages),
		title,
		values: (path) => resolvePath(root, path),
		path: address?.path ?? where.path,
		page,
		notFoundPage: where.notFound === true || (await isNotFoundPage(scope, entry.id, languages.language)),
		answersMissing: where.notFound === true,
		dates: { publishedAt: entry.publishedAt, lastPublishedAt: entry.lastPublishedAt },
	});
	return renderSitePage(view, host, styles, located, {
		page: {
			title,
			seo,
			alternates: extras.alternates.map((alternate) => ({ ...alternate, href: pageHref(alternate.href, page) })),
			languageLinks: extras.languageLinks,
			content,
			values: (path) => resolvePath(root, path),
		},
		// Media values the content may read: its own, and its related Entries'.
		contentValues: [published.fields, [...related.values()].map((entry) => entry.values)],
		entry: { id: entry.id, fields: postType.fields },
		loops: { current: entry.id, ...where },
	});
}

/**
 * The Site's search results page (ADR 0021): its Page, showing the Search results template (the
 * Staff's published one, else the built-in one) instead of a Page layout. Its Loop `search` lists the
 * hits for the visitor's query among the searchable Post Types' Entries, `search.query` reads the
 * query, and its title says what it shows hits for. Its pages keep the query (`?q=bread&page=2`).
 */
async function renderSearchPage(
	view: View,
	host: SiteHost,
	styles: SiteStyles,
	located: Located,
	extras: LanguageExtras,
	where: { page: number; path: string; query: string; state: string },
): Promise<RenderedPage> {
	const { scope } = view;
	const { found, languages } = located;
	const content = (await searchTemplateOf(scope, view.structure)) ?? builtInSearchTemplate(located.language.code);
	const version = storedVersion(view.version === "draft" ? found.entry.draft : found.entry.published);
	const title = entryValues(version, found.postType.fields, languages).title;
	const site = await siteParts(view, located, host.site.name);
	const root: Parts = { text: null, part: (name) => (name === "site" ? site : undefined) };
	const search: SearchOnPage = { query: where.query, postTypes: await searchedPostTypes(scope, found.postTypes) };
	const shownTitle = pagedTitle(
		searchPageTitle(title, where.query, located.language.code),
		where.page,
		located.language.code,
	);
	return renderSitePage(view, host, styles, located, {
		page: {
			title: shownTitle,
			// One visitor's search: never indexed (`X-Robots-Tag` says so too).
			seo: await unlistedPageSeo(scope, await seoSiteOf(view, host, located), seoPlace(located, []), shownTitle),
			alternates: extras.alternates,
			languageLinks: extras.languageLinks,
			content,
			values: (path) => (path === SEARCH_QUERY_VALUE ? where.query : resolvePath(root, path)),
		},
		loops: { current: found.entry.id, page: where.page, path: where.path, search, state: where.state },
		searchQuery: where.query,
	});
}

/** The Site's Search results template as visitors see it (published), or its Draft in Code mode; undefined for none. */
async function searchTemplateOf(scope: ReadScope, which: "published" | "draft"): Promise<ElementTree | undefined> {
	const row = await scope.first(templates, and(eq(templates.kind, "search"), isNull(templates.postTypeId)));
	const tree = which === "draft" ? row?.draft : row?.published;
	return (tree as ElementTree | null | undefined) ?? undefined;
}

/**
 * The Post Types Site search lists, by key: those Staff mark searchable whose Entries have pages (the
 * Page Post Type, and Post Types with a published Entry template), so every hit links somewhere.
 */
async function searchedPostTypes(scope: ReadScope, postTypes: readonly PostType[]): Promise<string[]> {
	const rendered = new Set(
		(await scope.select(templates, and(eq(templates.kind, "entry"), isNotNull(templates.published)))).map(
			(row) => row.postTypeId,
		),
	);
	return postTypes
		.filter((postType) => postType.searchable && (isPagePostType(postType) || rendered.has(postType.id)))
		.map((postType) => postType.key);
}

/**
 * Where a page's Search elements send visitors: the Site's search results page in the page's
 * language (on this hostname, or the address of the language's own domain), with the query they show.
 * Undefined while the Site has none published and shown in the language: they then show nothing.
 */
async function searchOnPage(
	scope: ReadScope,
	host: SiteHost,
	language: string,
	query: string,
): Promise<PageSearch | undefined> {
	const pageId = await specialPageId(scope, "search");
	const action = pageId && (await pageLocation(scope, host, pageId, language));
	return action ? { action, query } : undefined;
}

/** The Site's Globals as `site.x` reads them (published for visitors, the Draft in Edit mode), with the page's language. */
async function siteParts(view: View, place: Place, name: string): Promise<Parts> {
	const site = globalsVersion(await view.scope.first(globals), place.languages, view.version);
	return globalsParts(site.fields, site.values, { language: place.language.code, name });
}

/** What every page of the Site works its SEO out with (`SeoSite`), read as the page's view reads. */
async function seoSiteOf(view: View, host: SiteHost, place: Place): Promise<SeoSite> {
	const settings = await siteSeoSettings(view.scope);
	// The Globals visitors see, even in Edit mode: structured data is what the Site says once published.
	const globalsRow = await view.scope.first(globals);
	const published = globalsVersion(globalsRow, place.languages, "published");
	const globalParts = globalsParts(published.fields, published.values);
	return {
		settings,
		name: settings.siteName ?? host.site.name,
		languages: place.site,
		addresses: await host.visitorAddresses(),
		postTypes: await listPostTypes(view.scope),
		globals: (path) => resolvePath(globalParts, path),
	};
}

/** A page's language and the other languages it is in (its `hreflang` alternates, `x-default` aside). */
function seoPlace(place: Place, alternates: readonly PageAlternate[]): SeoPlace {
	const code = place.languages.language;
	return {
		languages: place.languages,
		alsoIn: alternates
			.map((alternate) => alternate.hreflang)
			.filter((hreflang) => hreflang !== "x-default" && hreflang !== code),
	};
}

/** Whether a Page is the Site's 404 page, or a language's: at its own path it shows with 200, never indexed. */
async function isNotFoundPage(scope: ReadScope, entryId: string, language: string): Promise<boolean> {
	return (
		(await specialPageId(scope, "notFound")) === entryId ||
		(await specialPageId(scope, "notFound", language)) === entryId
	);
}

/** A page's title, with its number past the first page of its paginated Loop (`Recipes · Page 2`). */
function pagedTitle(title: string, page: number, language: string): string {
	return page > 1 ? `${title} · ${pageWords(language).pageNumber.replace("{n}", String(page))}` : title;
}

/**
 * A page rendered, with until when it may be kept, the pages of its paginated Loop and what its
 * Filters read; or, when the request sent its Filters' choices in another form than their normal one,
 * where to send it instead (`redirect`), and nothing rendered.
 */
type RenderedPage = SitePage & {
	pagination: { current: number; count: number } | null;
	filters: PageFilterState;
	redirect?: { location: string; temporary: boolean };
};

/**
 * A page of the Site in its Site template (the published one, or the built-in one), with the names
 * of its Classes and its stylesheet from the published Design system. The Site template reads the
 * Globals as `site.x`; both templates and the Components they place read the Loops of the Site
 * they name, run once for the page (`pageLoops`).
 */
async function renderSitePage(
	view: View,
	host: SiteHost,
	styles: SiteStyles,
	place: Place,
	options: {
		page: Pick<PageToRender, "title" | "seo" | "alternates" | "languageLinks" | "content" | "values">;
		/** Values the content reads, for the Media it may show. */
		contentValues?: unknown;
		/** The Entry the page's content shows, whose values Edit mode may tag; none on the built-in 404 page. */
		entry?: { id: string; fields: readonly FieldDefinition[] } | null;
		/**
		 * Where the page's Loops run: its Entry, which page of a paginated Loop, and its address; on the
		 * search results page, the visitor's search and the state its page links keep.
		 */
		loops: { current: string | null; page: number | null; path: string; search?: SearchOnPage; state?: string };
		/** What the page's Search elements show in their box: the query, on the search results page. */
		searchQuery?: string;
	},
): Promise<RenderedPage> {
	const { scope, editing } = view;
	const { page } = options;
	const { languages, language } = place;
	const globalsRow = await scope.first(globals);
	const globalValues = globalsVersion(globalsRow, languages, view.version);
	const site = globalsParts(globalValues.fields, globalValues.values, {
		language: language.code,
		name: host.site.name,
	});
	const siteRoot: Parts = { text: undefined, part: (name) => (name === "site" ? site : undefined) };
	const previewed = editing?.preview?.source;
	const siteTemplate =
		view.structure === "published"
			? await publishedSiteTemplate(scope)
			: previewed?.kind === "siteTemplate"
				? previewed.tree
				: await draftSiteTemplate(scope);
	// Components placed in the bodies the page shows render as Placements too: load them with the rest.
	const bodyPlacements: ElementTree = {
		version: ELEMENT_TREE_VERSION,
		nodes: placementsInValues(options.contentValues),
	};
	const moduleScripts = editing ? [] : await view.moduleScripts(host.site);

	const baseTrees = [page.content, siteTemplate, bodyPlacements];
	const initialPlaced = await pageComponents(scope, baseTrees, view.sources, site, languages, {
		which: view.structure,
		replace: previewed?.kind === "component" ? { id: previewed.id, version: previewed.version } : undefined,
	});
	const attachedIds = new Set(
		[...baseTrees, ...initialPlaced.trees].flatMap((tree) => (tree ? popupsPlacedIn(tree) : [])),
	);
	const widths = styles.designSystem.tokens.breakpoints.map((b) => b.width).sort((a, b) => a - b);
	const phoneWidth = phoneWidthOf(styles.designSystem.tokens.breakpoints);
	const popupOptions = {
		on: !editing && moduleScripts.some((s) => s.moduleId === "popups"),
		which: view.version,
		languages,
		path: options.loops.path,
		entryId: options.loops.current,
		phoneWidth,
		tabletWidth: widths.find((w) => w > phoneWidth) ?? Math.max(1024, phoneWidth + 1),
		attachedIds,
	};
	let popupPage = await pagePopups(scope, popupOptions);
	let placed = initialPlaced;
	// Popup Components can attach other Popups. Resolve their ordinary Component trees until no
	// new attachment is found; the growing set also bounds cycles to one template per Popup.
	while (popupPage.items.length) {
		placed = await pageComponents(
			scope,
			[...baseTrees, ...popupPage.items.map((p) => p.tree)],
			view.sources,
			site,
			languages,
			{ which: view.structure },
		);
		const before = attachedIds.size;
		for (const tree of placed.trees) for (const id of popupsPlacedIn(tree)) attachedIds.add(id);
		if (attachedIds.size === before) break;
		popupPage = await pagePopups(scope, popupOptions);
	}
	const postTypes = await listPostTypes(scope);
	const trees = [page.content, siteTemplate, ...placed.trees];
	// The page's Filters: what the visitor chose in its address narrows their Loops. Site search's
	// query is kept beside them on the search results page.
	const kept: [string, string][] = options.loops.search?.query ? [["q", options.loops.search.query]] : [];
	const filters = await pageFilters(
		scope,
		trees,
		{
			languages,
			version: view.entries,
			path: options.loops.path,
			current: options.loops.current,
			structure: view.structure,
			params: view.query,
			kept,
			shared: options.loops.search !== undefined,
		},
		postTypes,
	);
	const filterState: PageFilterState = {
		reader: filters.reader,
		query: filters.state.query,
		search: filters.state.search,
	};
	// A page's first page asked for by number (`?page=1`) goes on to the page itself for good; Filters'
	// choices sent in another form, to their normal address for now. Both keep the choices.
	const firstPageAsked = view.pageNumber === 1 && view.query.has(PAGE_PARAMETER);
	if (filters.state.differs || firstPageAsked) {
		const state = writeQuery([...filters.state.values, ...kept]);
		const location = pageHref(options.loops.path, view.pageNumber, state);
		return {
			html: "",
			headers: {},
			expiresAt: null,
			pagination: null,
			filters: filterState,
			redirect: { location, temporary: filters.state.differs },
		};
	}
	// Loops show published Entries through their published versions, in Edit mode and Code mode too;
	// the Staging address shows the Loops' Drafts over every Entry's Draft.
	const loops = await pageLoops(
		scope,
		trees,
		{
			...options.loops,
			languages,
			version: view.entries,
			items: editing ? "draft" : undefined,
			narrowing: filters.narrowing,
			state: writeQuery([...filters.state.values, ...kept]),
		},
		postTypes,
	);
	const filterHtml = await filters.render(loops);
	// The Media the page may show: `media:<id>` written in either template or a Component it places,
	// and every media value the page reads (its content's, the Globals', its Loops' items'). Ids that
	// aren't the Site's ready Media find nothing.
	const shown = await pageMedia(
		scope,
		[
			...mediaReferencesIn(JSON.stringify([page.content, siteTemplate ?? null, placed.trees])),
			...uuidsIn(JSON.stringify([page.content, siteTemplate ?? null, placed.trees])),
			...uuidsIn(JSON.stringify([options.contentValues ?? null, popupPage.items, globalValues.values, loops.values])),
		],
		languages,
	);
	// The page's Search elements send visitors to the search results page, when the Site has one.
	const searching = [page.content, siteTemplate, ...placed.trees].some((tree) => tree && searchElementIn(tree));
	const search = searching ? await searchOnPage(scope, host, language.code, options.searchQuery ?? "") : undefined;
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
	let expiresAt =
		loops.changesAt && filters.changesAt
			? new Date(Math.min(loops.changesAt.getTime(), filters.changesAt.getTime()))
			: (loops.changesAt ?? filters.changesAt);
	if (popupPage.changesAt && (!expiresAt || popupPage.changesAt < expiresAt)) expiresAt = popupPage.changesAt;
	const time = {
		now: scope.now(),
		changesAt(instant: Date) {
			if (!expiresAt || instant < expiresAt) expiresAt = instant;
		},
	};
	// Safe mode runs none of the Site's own scripts; outside scripts never run in Edit mode at all.
	const ownScripts = !editing?.safe;
	const formHtml: string[] = [];
	const document: PageToRender = {
		checkMarkup: view.checkMarkup,
		footerLink: await statementFooter(view, place),
		...page,
		title: invalid ? `${formWords(language.code).errorPrefix} ${page.title}` : page.title,
		// A page sent back with a Form's errors is one visitor's: never indexed. Nor is a filtered or
		// sorted one, which points search engines at the page without its choices.
		seo: stagingSeo(
			view,
			filteredSeo(
				page.seo && invalid
					? { ...page.seo, title: `${formWords(language.code).errorPrefix} ${page.seo.title}`, noindex: true }
					: page.seo,
				filters.state.values.size > 0,
			),
		),
		site: { name: host.site.name, language: language.code, direction: language.direction },
		siteTemplate,
		siteValues: (path) => resolvePath(siteRoot, path),
		className: styles.className,
		media: (id) => shown.get(id),
		styles: { stylesheet: styles.stylesheet.href, darkMode: styles.designSystem.darkMode },
		libraries: ownScripts ? await pageLibraries(scope) : [],
		scripts: ownScripts
			? await pageScripts(scope, options.entry?.id ?? null, view.structure, view.staging ? SCRIPT_PATH : undefined)
			: [],
		outsideScripts: await pageOutsideScripts(scope),
		// Like outside scripts, Modules' Site scripts never run in Edit mode.
		moduleScripts: editing
			? []
			: moduleScripts
					.filter((script) => script.moduleId !== "popups" || popupPage.items.length > 0)
					.map((script) => ({
						moduleId: script.moduleId,
						src: `${SCRIPT_PATH}${script.name}`,
						consentCategory: script.category,
						beforeConsent: script.beforeConsent,
						components: script.components,
					})),
		// People editing are never asked for consent (ADR 0022).
		consent: editing ? undefined : await pageConsent(scope, languages, view.version),
		editMode: editing && {
			...editing.head,
			region: editRegions(options.entry ?? null, storedFields(globalsRow?.fields), loops),
			loop: (name) => {
				const shown = loops.info(name);
				return shown && [`loop:${shown.id}`, shown.source, shown.name];
			},
			code: view.structure === "draft",
		},
		component: placed.render,
		form: (id) => {
			const html = forms.render(id);
			formHtml.push(html);
			return html;
		},
		popups: { siteId: host.site.id, items: popupPage.items, reveal: Boolean(view.forms?.state || view.forms?.sent) },
		search,
		formScripts: forms.outsideScripts,
		loop: loops.run,
		filter: filterHtml.html,
		filtered: filters.filtered,
		time,
	};
	const rendered = renderDocument(document);
	let formIndex = 0;
	const checks = editing?.code
		? renderedChecks(renderDocument({ ...document, checkMarkup: true, form: () => formHtml[formIndex++] ?? "" }).html, {
				language: language.code,
				complete: true,
			})
		: undefined;
	const hosts = await policyHosts(view, forms.captchaHost);
	const headers = editing
		? { "content-security-policy": editModePolicy(hosts) }
		: pagePolicyHeaders({ mode: host.cspMode, hosts, frames: rendered.frames });
	return {
		html: rendered.html,
		...(checks ? { checks } : {}),
		headers,
		expiresAt,
		pagination: loops.pagination,
		forms: forms.shown,
		filters: filterState,
	};
}

/**
 * A filtered or sorted page's SEO (GLOSSARY.md › Filter): `noindex, follow`, its canonical URL the
 * page without its Filters' choices (a paginated filtered page's too), so search engines never index
 * endless variants but still follow the links.
 */
function filteredSeo(seo: PageToRender["seo"], filtered: boolean): PageToRender["seo"] {
	if (!filtered || !seo) return seo;
	return { ...seo, noindex: true, follow: true, canonical: seo.canonical?.replace(/\?.*$/, "") ?? null };
}

/** The pairs of a query string. */
function pairsOf(query: string): [string, string][] {
	return [...new URLSearchParams(query)];
}

/**
 * A page's SEO on the Staging address (ADR 0014): never indexed, and never anyone's canonical address.
 * While the Site has no domain its pages' canonical URLs would point at the Staging address itself,
 * so they have none there; once it has a Primary domain they point there, as on the domain.
 */
function stagingSeo(view: View, seo: PageToRender["seo"]): PageToRender["seo"] {
	if (!view.staging || !seo) return seo;
	const own = seo.canonical?.startsWith(`${view.host.origin}/`) || seo.canonical === view.host.origin;
	return { ...seo, noindex: true, canonical: own ? null : seo.canonical };
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
export async function pageComponents(
	scope: ReadScope,
	trees: readonly (ElementTree | undefined)[],
	sources: ComponentSources,
	site: Parts,
	languages: { language: string; defaultLanguage: string },
	shown: { which: "published" | "draft"; replace?: { id: string; version: ComponentVersion } },
	/** The Content API limits Relationship Props to its exposed Post Types and Fields. */
	exposedPostTypes?: readonly PostType[],
): Promise<{ trees: ElementTree[]; render: PlacementRenderer }> {
	const { catalogue, used } = await placedComponents(scope, trees, sources, shown.which, shown.replace);
	const shownTrees = [...used.values()].map((version) => version.tree);
	const related = await relatedOfProps(scope, [...trees, ...shownTrees], catalogue, languages, exposedPostTypes);
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
	exposedPostTypes?: readonly PostType[],
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
	const postTypes = exposedPostTypes ?? (await listPostTypes(scope));
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

async function nameOf(scope: ReadScope, personId: string): Promise<string | null> {
	const [row] = await scope.db.select({ name: people.name }).from(people).where(eq(people.id, personId));
	return row?.name ?? null;
}

async function statementFooter(view: View, place: Place): Promise<{ href: string; label: string } | undefined> {
	const settings = await view.scope.first(accessibilityStatements);
	if (!settings?.enabled) return undefined;
	const component = await view.scope.first(components, eq(components.id, settings.componentId));
	if (!component || (view.structure === "published" && !component.published)) return undefined;
	const row = await view.scope.first(entries, eq(entries.id, settings.pageId));
	if (!row || (view.version === "published" && !row.published)) return undefined;
	const version = storedVersion(view.version === "published" ? row.published : row.draft);
	if (!isVisibleIn(version, place.languages)) return undefined;
	const postType = (await listPostTypes(view.scope)).find((p) => p.id === row.postTypeId);
	if (!postType) return undefined;
	const address = (await addressesOf(view.version)(view.scope, postType, [row.id], place.languages)).get(row.id);
	if (!address) return undefined;
	const destination = placeOf(view.host.addresses, place.languages, address.path);
	const href = destination.origin === view.host.origin ? destination.path : `${destination.origin}${destination.path}`;
	return {
		href,
		label: entryValues(version, postType.fields, place.languages).title || statementTitle(place.languages.language),
	};
}
