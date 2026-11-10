import { entries } from "@webcraft/db/schema";
import {
	cutText,
	mediaReference,
	type PageSeo,
	type SocialImage,
	type TemplateValue,
	textOf,
	type ValueReader,
} from "@webcraft/renderer";
import { inArray } from "drizzle-orm";

import { publishedArchives } from "../content/archives.ts";
import { homePageId, publishedAddresses } from "../content/entry-paths.ts";
import type { Languages } from "../content/field-values.ts";
import { languageOfPath, languagePath, type SiteLanguages } from "../content/languages.ts";
import { isPagePostType, pathText, publishedPageTree } from "../content/pages.ts";
import type { PostType } from "../content/post-types.ts";
import { specialPageId } from "../content/special-pages.ts";
import { pathSegments } from "../content/url-patterns.ts";
import { readValue, storedVersion } from "../content/values.ts";
import { isVisibleIn } from "../content/visibility.ts";
import { placeOf, type SiteAddresses } from "../domains/addresses.ts";
import type { VisitorScope } from "../tenancy/data-layer.ts";
import type { EntrySeo } from "./entry-seo.ts";
import { firstImage, shareableImages } from "./images.ts";
import { applyTitlePattern, DEFAULT_TITLE_PATTERN, DESCRIPTION_CUT, fieldAt, type PostTypeSeo } from "./seo-rules.ts";
import type { SiteSeoSettings } from "./site-settings.ts";
import {
	breadcrumbNode,
	type Crumb,
	imageIdsIn,
	imageObject,
	mappedProperties,
	type Node,
	schemaTypeName,
	siteIds,
	siteNodes,
} from "./structured-data.ts";

/** What reading a page's SEO needs: the Site's Media library and its published content. */
export type SeoScope = Pick<VisitorScope, "select" | "first" | "db" | "where">;

/**
 * What every page of a Site works its SEO out with: the Site's SEO settings and the name titles give
 * it, its languages and Post Types, the Globals (for its organisation's details), and where its pages
 * are for visitors (its Primary domain and languages' domains; the Staging address only while it has
 * no Primary domain), so canonical URLs never point a live Site's visitors, or search engines, at the
 * Staging address.
 */
export type SeoSite = {
	settings: SiteSeoSettings;
	/** The Site's name in titles and structured data: the SEO settings' name, else the Site's own. */
	name: string;
	languages: SiteLanguages;
	addresses: SiteAddresses;
	postTypes: readonly PostType[];
	/** A published Global's value, by its path (`phone`, `contact.email`). */
	globals: ValueReader;
};

/** Where a page is: its language, and the languages it is in besides (its `hreflang` alternates). */
export type SeoPlace = { languages: Languages; alsoIn: readonly string[] };

/**
 * The SEO of an Entry's page (a Page's too): its SEO fields, then the Post Type's fallbacks. `title` is
 * its title as the page shows it (with its page number past the first page of a paginated Loop),
 * `values` what its bindings read (for the description, image and Schema type's Fields), `path` its
 * address in its language as the Site writes it (`/fr/blog/pain-frais`), `page` the page of its
 * paginated Loop.
 */
export type EntryPageSeo = {
	postType: PostType;
	entryId: string;
	seo: EntrySeo;
	title: string;
	values: ValueReader;
	path: string;
	page: number;
	/** The Site's 404 page (or a language's): shown at its own path with 200, never indexed. */
	notFoundPage: boolean;
	/** Whether it answers a path with no page (with 404): it then has no address of its own. */
	answersMissing: boolean;
	dates: { publishedAt: Date | null; lastPublishedAt: Date | null };
};

/**
 * A page that tells search engines nothing but its title and what the Site is, and asks them not to
 * index it: the 404 page, a page of search results, a Form sent back with its errors.
 */
export async function unlistedPageSeo(
	scope: SeoScope,
	site: SeoSite,
	place: SeoPlace,
	title: string,
): Promise<PageSeo> {
	const pages = site.postTypes.find(isPagePostType);
	const images = await shareableImages(
		scope,
		[site.settings.organization.logo],
		place.languages,
		mediaOrigin(site, place.languages),
	);
	return {
		title: titleFor(site.name, site.settings.separator, pages?.seo ?? null, title, null),
		description: null,
		canonical: null,
		noindex: true,
		sharing: null,
		structuredData: await siteGraph(scope, site, place.languages, images),
	};
}

/** An Entry's page: its SEO fields, falling back to its Post Type's settings, then to the Site's. */
export async function entryPageSeo(
	scope: SeoScope,
	site: SeoSite,
	place: SeoPlace,
	entry: EntryPageSeo,
): Promise<PageSeo> {
	const { postType, seo } = entry;
	const { languages } = place;
	const settings = postType.seo;
	const ownTitle = seo.title ?? entry.title;
	const title = seo.title ?? titleFor(site.name, site.settings.separator, settings, entry.title, postType.name);
	const description = seo.description ?? descriptionFrom(postType, settings, entry.values);
	const address = pageAddress(site, languages, entry.path, entry.page);
	const canonical = entry.answersMissing ? null : seo.canonical ? canonicalOf(site, seo.canonical) : address;
	const sources = { fields: postType.fields, values: entry.values };
	const fieldImage = imageFrom(postType, settings, entry.values);
	const images = await shareableImages(
		scope,
		[
			seo.image,
			fieldImage,
			site.settings.defaultImage,
			site.settings.organization.logo,
			...imageIdsIn(settings.schema.type, settings.schema.properties, sources),
		],
		languages,
		mediaOrigin(site, languages),
	);
	// The Social card (#93) comes after the Post Type's image Field, before the Site's default image.
	const image = firstImage(images, [seo.image, fieldImage, site.settings.defaultImage]);
	const type = settings.schema.type;
	const article = type === "article" || type === "blogPosting";
	const graph = await siteGraph(scope, site, languages, images);
	if (!entry.answersMissing) {
		const ids = siteIds(site.addresses.main);
		const breadcrumbId = `${address}#breadcrumb`;
		graph.push(breadcrumbNode(breadcrumbId, await entryCrumbs(scope, site, languages, entry, address)));
		const mapped = mappedProperties(type, settings.schema.properties, {
			...sources,
			description,
			image,
			images,
			address: (path) => canonicalOf(site, path),
		});
		// A Web page or an FAQ page is the page itself; any other type is what the page is about.
		const ownType = type === "webPage" || type === "faqPage";
		graph.push({
			"@type": ownType ? schemaTypeName(type) : "WebPage",
			"@id": address,
			url: address,
			name: ownTitle,
			...(description ? { description } : {}),
			inLanguage: languages.language,
			isPartOf: { "@id": ids.website },
			breadcrumb: { "@id": breadcrumbId },
			...(image ? { primaryImageOfPage: imageObject(image) } : {}),
			...(ownType ? mapped : {}),
		});
		if (!ownType) {
			graph.push({
				"@type": schemaTypeName(type),
				"@id": `${address}#${schemaTypeName(type).toLowerCase()}`,
				mainEntityOfPage: { "@id": address },
				inLanguage: languages.language,
				...(article ? { publisher: { "@id": ids.organization } } : {}),
				...mapped,
			});
		}
	}
	return {
		title,
		description,
		canonical,
		noindex: seo.noindex || entry.notFoundPage,
		sharing: entry.answersMissing
			? null
			: {
					type: article ? "article" : "website",
					title: ownTitle,
					description,
					url: canonical,
					siteName: site.name,
					locale: openGraphLocale(languages.language),
					alternateLocales: place.alsoIn.map(openGraphLocale),
					image,
					publishedTime: entry.dates.publishedAt?.toISOString() ?? null,
					modifiedTime: entry.dates.lastPublishedAt?.toISOString() ?? null,
				},
		structuredData: graph,
	};
}

/**
 * An Archive page: titled by its Post Type's pattern with the Post Type's name, at its own address
 * (with `?page=N` past the first page), shared with the Site's default image, a collection of the Post
 * Type's Entries in structured data.
 */
export async function archivePageSeo(
	scope: SeoScope,
	site: SeoSite,
	place: SeoPlace,
	archive: { postType: PostType; title: string; path: string; page: number },
): Promise<PageSeo> {
	const { languages } = place;
	const address = pageAddress(site, languages, archive.path, archive.page);
	const images = await shareableImages(
		scope,
		[site.settings.defaultImage, site.settings.organization.logo],
		languages,
		mediaOrigin(site, languages),
	);
	const image = firstImage(images, [site.settings.defaultImage]);
	const ids = siteIds(site.addresses.main);
	const breadcrumbId = `${address}#breadcrumb`;
	const crumbs = [
		await homeCrumb(scope, site, languages),
		{ name: archive.postType.name, item: pageAddress(site, languages, archive.path, 1) },
	];
	return {
		title: titleFor(site.name, site.settings.separator, archive.postType.seo, archive.title, archive.postType.name),
		description: null,
		canonical: address,
		noindex: false,
		sharing: {
			type: "website",
			title: archive.title,
			description: null,
			url: address,
			siteName: site.name,
			locale: openGraphLocale(languages.language),
			alternateLocales: place.alsoIn.map(openGraphLocale),
			image,
		},
		structuredData: [
			...(await siteGraph(scope, site, languages, images)),
			breadcrumbNode(breadcrumbId, crumbs),
			{
				"@type": "CollectionPage",
				"@id": address,
				url: address,
				name: archive.title,
				inLanguage: languages.language,
				isPartOf: { "@id": ids.website },
				breadcrumb: { "@id": breadcrumbId },
			},
		],
	};
}

/** The WebSite and the organisation behind it, as every page says them in its language. */
async function siteGraph(
	scope: SeoScope,
	site: SeoSite,
	languages: Languages,
	images: ReadonlyMap<string, SocialImage>,
): Promise<Node[]> {
	const logo = site.settings.organization.logo;
	return siteNodes({
		main: site.addresses.main,
		name: site.name,
		home: pageAddress(site, languages, languagePath(languages, "/"), 1),
		language: languages.language,
		organization: site.settings.organization,
		logo: logo ? (images.get(logo.toLowerCase()) ?? null) : null,
		search: await searchAddress(scope, site, languages),
		globals: site.globals,
	});
}

/** The Site's search results page in a language, for visitors; null while it has none shown there. */
async function searchAddress(scope: SeoScope, site: SeoSite, languages: Languages): Promise<string | null> {
	const pages = site.postTypes.find(isPagePostType);
	const searchId = await specialPageId(scope, "search");
	if (!pages || !searchId) return null;
	const [row] = await scope.select(entries, inArray(entries.id, [searchId]));
	if (!row?.published || !isVisibleIn(storedVersion(row.published), languages)) return null;
	const found = (await publishedAddresses(scope, pages, [searchId], languages)).get(searchId);
	return found ? pageAddress(site, languages, found.path, 1) : null;
}

/** The first crumb of every page: the home page (by its title, else the Site's name) at the language's root. */
async function homeCrumb(scope: SeoScope, site: SeoSite, languages: Languages): Promise<Crumb> {
	const homeId = await homePageId(scope);
	const [row] = homeId ? await scope.select(entries, inArray(entries.id, [homeId])) : [];
	const title = row?.published ? readValue(storedVersion(row.published), { key: "title", ...languages }) : null;
	return { name: title || site.name, item: pageAddress(site, languages, languagePath(languages, "/"), 1) };
}

/**
 * An Entry's breadcrumbs: the home page, then the Archive page of its Post Type when it has one
 * published, or a Page's parent Pages, then the page itself.
 */
async function entryCrumbs(
	scope: SeoScope,
	site: SeoSite,
	languages: Languages,
	entry: EntryPageSeo,
	address: string,
): Promise<Crumb[]> {
	const home = await homeCrumb(scope, site, languages);
	if (entry.entryId === (await homePageId(scope))) return [home];
	const crumbs: Crumb[] = [home];
	const { postType } = entry;
	if (isPagePostType(postType)) {
		const tree = await publishedPageTree(scope, postType.id, languages.language);
		const parents: string[] = [];
		let id = tree.get(entry.entryId)?.parentId ?? null;
		while (id && !parents.includes(id)) {
			parents.unshift(id);
			id = tree.get(id)?.parentId ?? null;
		}
		if (parents.length > 0) {
			const rows = await scope.select(entries, inArray(entries.id, parents));
			const paths = await publishedAddresses(scope, postType, parents, languages);
			for (const parent of parents) {
				const row = rows.find((candidate) => candidate.id === parent);
				const path = paths.get(parent)?.path;
				const name = row?.published ? readValue(storedVersion(row.published), { key: "title", ...languages }) : null;
				if (name && path) crumbs.push({ name, item: pageAddress(site, languages, path, 1) });
			}
		}
	} else {
		const archive = (await publishedArchives(scope, [postType]))[0];
		if (archive) {
			const path = languagePath(languages, pathText(archive.parts));
			crumbs.push({ name: postType.name, item: pageAddress(site, languages, path, 1) });
		}
	}
	crumbs.push({ name: entry.title, item: address });
	return crumbs;
}

/** A page's whole title: its Post Type's title pattern (the Page Post Type's for other pages) filled in. */
/**
 * The title of a page without an SEO title of its own: the Post Type's title pattern (the default one
 * without a Post Type) filled with the page's title, the Site's name, the Post Type and the separator.
 * The SEO check works out the same title, so its warnings are about what the page shows.
 */
export function titleFor(
	siteName: string,
	separator: string,
	settings: PostTypeSeo | null,
	title: string,
	postType: string | null,
): string {
	return applyTitlePattern(settings?.titlePattern ?? DEFAULT_TITLE_PATTERN, {
		title,
		site: siteName,
		postType: postType ?? "",
		separator,
	});
}

/**
 * The description of an Entry without one of its own: its Summary (the Post Type's Summary field,
 * `descriptionField` in its SEO settings), else the start of its Body field, as plain text cut cleanly
 * at a word; null when neither has text.
 */
export function descriptionFrom(postType: PostType, settings: PostTypeSeo, values: ValueReader): string | null {
	const body = postType.fields.find((field) => field.type === "body")?.key;
	for (const path of [settings.descriptionField, body]) {
		if (!path) continue;
		const text = textOf(values(path)).replace(/\s+/g, " ").trim();
		if (text !== "") return cutText(text, DESCRIPTION_CUT);
	}
	return null;
}

/** The Media id the Post Type's image Field gives: a media Field's file, or a Body field's first image. */
export function imageFrom(postType: PostType, settings: PostTypeSeo, values: ValueReader): string | null {
	if (!settings.imageField) return null;
	const located = fieldAt(postType.fields, settings.imageField);
	if (!located) return null;
	const value: TemplateValue = values(
		located.field.type === "body" ? `${settings.imageField}.image` : settings.imageField,
	);
	return typeof value === "string" ? (mediaReference(value) ?? null) : null;
}

/** A page's address for visitors: its path (in its language) where the Site's pages are, `?page=N` past the first. */
function pageAddress(site: Pick<SeoSite, "addresses">, languages: Languages, path: string, page: number): string {
	const there = placeOf(site.addresses, languages, path);
	return `${there.origin}${there.path}${page > 1 ? `?page=${page}` : ""}`;
}

/**
 * A canonical URL an Entry gives: an address as written, or a path on the Site, at the address of
 * the language the path is in (under its prefix on the Primary domain, or on its own domain).
 */
export function canonicalOf(site: Pick<SeoSite, "addresses" | "languages">, canonical: string): string {
	if (!canonical.startsWith("/")) return canonical;
	const cut = canonical.search(/[?#]/);
	const path = cut < 0 ? canonical : canonical.slice(0, cut);
	const rest = cut < 0 ? "" : canonical.slice(cut);
	const segments = pathSegments(path) ?? [];
	const { languages } = languageOfPath(site.languages, segments);
	const there = placeOf(site.addresses, languages, path);
	return `${there.origin}${there.path}${rest}`;
}

/** Where a page's Media files are for other sites: its language's own domain, else the Site's main address. */
function mediaOrigin(site: SeoSite, languages: Languages): string {
	return site.addresses.languages[languages.language] ?? site.addresses.main;
}

/** A language as Open Graph writes it: `en`, `pt_BR`. */
function openGraphLocale(language: string): string {
	return language.replace("-", "_");
}
