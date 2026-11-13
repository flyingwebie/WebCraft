import { entries, globals, media, mediaFiles } from "@webcraft/db/schema";
import {
	type Block,
	blockPlacement,
	bodyMarkdown,
	designSystemNames,
	ELEMENT_TREE_VERSION,
	type ElementTree,
	mediaReferencesIn,
	type PageMedia,
	type PlacementRenderer,
	pageWords,
	placementsInValues,
	renderBody,
	renderTree,
} from "@webcraft/renderer";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";

import { componentNames } from "../content/body-components.ts";
import type { ComponentSources } from "../content/components.ts";
import { publishedAddresses } from "../content/entry-paths.ts";
import type { FieldDefinition, Json, TextField } from "../content/field-types.ts";
import { type LanguageChain, readFieldsThrough } from "../content/field-values.ts";
import { isPagePostType, parentIn } from "../content/pages.ts";
import type { PostType } from "../content/post-types.ts";
import { globalsParts } from "../content/render-values.ts";
import { storedVersion } from "../content/values.ts";
import { isVisibleIn } from "../content/visibility.ts";
import { publishedDesignSystem } from "../design-system/stylesheet.ts";
import { placeOf, type SiteAddresses } from "../domains/addresses.ts";
import { isUuid, uuidsIn } from "../ids.ts";
import { VARIANT_FORMATS } from "../media/images.ts";
import { focalPointOf, originalUrl, variantsOf } from "../media/library.ts";
import { type MediaText, storedTexts } from "../media/texts.ts";
import { SEO_GROUP, SEO_KEY } from "../seo/entry-seo.ts";
import { pageComponents } from "../site-pages/index.ts";
import type { VisitorScope } from "../tenancy/data-layer.ts";
import type { Exposure } from "./exposure.ts";
import type { BodyFormat, Reading } from "./params.ts";

type EntryRow = typeof entries.$inferSelect;

/** What presenting content needs: the Site, what it exposes, the languages read in and where its pages and files are. */
export type Presenting = {
	scope: VisitorScope;
	components: ComponentSources;
	exposure: Exposure;
	reading: Reading;
	body: BodyFormat;
	/** Where the Site's pages are for visitors (its Primary domain and languages' domains, or its Staging address). */
	addresses: SiteAddresses;
};

/**
 * Which Fields an item shows: every exposed one (`own` null) or those named (`fields=summary,price`),
 * and for Relationships named with fields of their own (`category.title`), each related item's.
 */
export type Selection = { own: ReadonlySet<string> | null; expand: ReadonlyMap<string, ReadonlySet<string>> };

export const ALL_FIELDS: Selection = { own: null, expand: new Map() };

/** The built-in values every Entry answers with, whatever `fields` asks. */
export const ENTRY_BUILT_INS = [
	"id",
	"postType",
	"title",
	"slug",
	"path",
	"url",
	"publishedAt",
	"lastPublishedAt",
] as const;

/** A Media item as the Content API answers it. */
export type ContentMedia = {
	id: string;
	kind: string;
	contentType: string;
	fileName: string;
	size: number;
	width: number | null;
	height: number | null;
	/** The original's absolute address, on the Site's domain. */
	url: string;
	alt: string | null;
	title: string | null;
	caption: string | null;
	focalPoint: { x: number; y: number } | null;
	/** The resized copies (AVIF and WebP), narrowest first; none until the worker made them, and none for SVGs. */
	variants: { type: string; width: number; height: number; url: string }[];
};

const TITLE: TextField = {
	key: "title",
	label: "Title",
	type: "text",
	help: "",
	required: true,
	translatable: true,
	default: null,
	minLength: null,
	maxLength: null,
	pattern: null,
};

/**
 * Media items of the Site that visitors can get (ready, not in the Trash), by id, as the Content API
 * answers them: their texts in the languages read, their addresses absolute.
 */
export async function contentMedia(
	scope: Pick<VisitorScope, "select">,
	ids: readonly string[],
	chain: LanguageChain,
	origin: string,
): Promise<Map<string, ContentMedia>> {
	const wanted = [...new Set(ids.filter(isUuid).map((id) => id.toLowerCase()))];
	if (wanted.length === 0) return new Map();
	const rows = await scope.select(
		media,
		and(inArray(media.id, wanted), eq(media.status, "ready"), isNull(media.trashedAt)),
	);
	if (rows.length === 0) return new Map();
	const files = await scope.select(
		mediaFiles,
		and(
			inArray(
				mediaFiles.mediaId,
				rows.map((row) => row.id),
			),
			inArray(mediaFiles.role, ["original", "variant"]),
			isNull(mediaFiles.retiredAt),
		),
	);
	const found = new Map<string, ContentMedia>();
	for (const row of rows) {
		const own = files.filter((file) => file.mediaId === row.id);
		const url = originalUrl(row, own);
		if (!url) continue;
		const texts = storedTexts(row.texts);
		const text = (key: MediaText) => {
			const byLanguage = texts.values[key] ?? {};
			const language = chain.languages.find((code) => typeof byLanguage[code]?.value === "string");
			return language === undefined ? null : (byLanguage[language]?.value as string);
		};
		found.set(row.id, {
			id: row.id,
			kind: row.kind,
			contentType: row.contentType,
			fileName: row.fileName,
			size: row.sizeBytes,
			width: row.width,
			height: row.height,
			url: `${origin}${url}`,
			alt: text("alt"),
			title: text("title"),
			caption: text("caption"),
			focalPoint: focalPointOf(row),
			variants: variantsOf(own).map((variant) => ({
				type: `image/${variant.format}`,
				width: variant.width,
				height: variant.height,
				url: `${origin}${variant.url}`,
			})),
		});
	}
	return found;
}

/** A Media item as a body's HTML shows it (the renderer's `PageMedia`), from the Content API's. */
function pageMediaOf(item: ContentMedia): PageMedia {
	return {
		kind: item.kind as PageMedia["kind"],
		url: item.url,
		width: item.width,
		height: item.height,
		focalPoint: item.focalPoint,
		alt: item.alt,
		caption: item.caption,
		sources: VARIANT_FORMATS.map((format) => ({
			type: `image/${format}`,
			candidates: item.variants
				.filter((variant) => variant.type === `image/${format}`)
				.map((variant) => ({ url: variant.url, width: variant.width })),
		})),
	};
}

/** The Fields `own` names, in the Post Type's order (every one when it names none). */
function selected(fields: readonly FieldDefinition[], own: ReadonlySet<string> | null): FieldDefinition[] {
	return own === null ? [...fields] : fields.filter((field) => own.has(field.key));
}

/** Calls `visit` with each leaf Field's value inside values read by `readFieldsThrough`. */
function eachLeaf(
	values: Record<string, Json>,
	fields: readonly FieldDefinition[],
	visit: (field: FieldDefinition, value: Json) => void,
) {
	for (const field of fields) {
		const value = values[field.key];
		if (field.type === "group") {
			eachLeaf((value ?? {}) as Record<string, Json>, field.fields, visit);
		} else if (field.type === "repeater") {
			for (const row of Array.isArray(value) ? value : []) eachLeaf(row as Record<string, Json>, field.fields, visit);
		} else visit(field, value ?? null);
	}
}

/**
 * Values read by `readFieldsThrough` as the API answers them, by key: Groups' and Repeaters' Fields
 * walked through, each leaf Field's value as `leaf` presents it.
 */
function presentValues(
	values: Record<string, Json>,
	fields: readonly FieldDefinition[],
	leaf: (value: Json, field: FieldDefinition) => unknown,
): Record<string, unknown> {
	return Object.fromEntries(
		fields.map((field) => {
			const value = values[field.key] ?? null;
			if (field.type === "group")
				return [field.key, presentValues((value ?? {}) as Record<string, Json>, field.fields, leaf)];
			if (field.type === "repeater") {
				const rows = (Array.isArray(value) ? value : []) as Record<string, Json>[];
				return [field.key, rows.map((row) => ({ id: row.id, ...presentValues(row, field.fields, leaf) }))];
			}
			return [field.key, leaf(value, field)];
		}),
	);
}

/** The ids a Relationship value holds (one or a list). */
function idsIn(value: Json): string[] {
	if (typeof value === "string") return [value];
	return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/** The Media a body shows in its image Blocks. */
function bodyImages(value: Json): string[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((block) => {
		const image = block as { type?: unknown; media?: unknown };
		return image.type === "image" && typeof image.media === "string" ? [image.media] : [];
	});
}

/** An Entry as the Content API answers it. */
export type ContentEntry = Record<string, unknown> & { id: string };

/**
 * Published Entries as the Content API answers them, in the order given: their built-in values, their
 * SEO fields and their exposed Fields' values read through the languages asked for (and where each
 * fell back from), Media as their details, Relationships as the ids of published Entries of exposed
 * Post Types shown in the language (or, named in `selection.expand`, as those Entries with their own
 * chosen Fields, one level deep), and Body fields in the format asked for.
 */
export async function presentEntries(
	presenting: Presenting,
	rows: readonly EntryRow[],
	selection: Selection,
	depth = 0,
): Promise<ContentEntry[]> {
	const { scope, exposure, reading } = presenting;
	const languages = { language: reading.language, defaultLanguage: reading.chain.defaultLanguage };
	const read = rows.flatMap((row) => {
		const postType = exposure.byId(row.postTypeId);
		if (!postType || row.published === null) return [];
		const version = storedVersion(row.published);
		const fallbacks: Record<string, string> = {};
		const note = (path: string, language: string) => {
			fallbacks[path] = language;
		};
		const fields = selected(postType.fields, selection.own);
		return [
			{
				row,
				postType,
				version,
				fields,
				fallbacks,
				values: readFieldsThrough(version.values, fields, reading.chain, note),
				title: readFieldsThrough(version.values, [TITLE], reading.chain, note).title as string | null,
				seo: readFieldsThrough(version.values, [SEO_GROUP], reading.chain, (path, language) => note(path, language))[
					SEO_KEY
				] as Record<string, Json>,
			},
		];
	});

	// What the Relationships point at: published Entries of exposed Post Types, shown in the language.
	const targetIds = new Set<string>();
	const mediaIds = new Set<string>();
	for (const item of read) {
		eachLeaf(item.values, item.fields, (field, value) => {
			if (field.type === "relationship") for (const id of idsIn(value)) targetIds.add(id);
			if (field.type === "media" && typeof value === "string") mediaIds.add(value);
			if (field.type === "body" && presenting.body !== "blocks") for (const id of bodyImages(value)) mediaIds.add(id);
		});
		if (typeof item.seo.image === "string") mediaIds.add(item.seo.image);
	}
	const targets = await linkedEntries(presenting, [...targetIds]);
	const expanded = new Map<string, ContentEntry>();
	if (depth === 0) {
		for (const [key, chosen] of selection.expand) {
			const ids = new Set<string>();
			for (const item of read) {
				const field = item.fields.find((candidate) => candidate.key === key);
				if (field?.type !== "relationship") continue;
				for (const id of idsIn(item.values[key] ?? null)) if (targets.has(id)) ids.add(id);
			}
			const related = await presentEntries(
				presenting,
				[...ids].flatMap((id) => targets.get(id) ?? []),
				{ own: chosen, expand: new Map() },
				depth + 1,
			);
			for (const entry of related) expanded.set(`${key}:${entry.id}`, entry);
		}
	}
	const origin = presenting.addresses.main;
	// Component Blocks use the same published Placements as Site pages. Content API exposure still
	// limits the Globals and Relationship Fields their bindings may read.
	const placements = read.flatMap((item) => placementsInValues(item.values));
	let component: PlacementRenderer | undefined;
	let className: ((id: string) => string | undefined) | undefined;
	if (presenting.body === "html" && placements.length > 0) {
		const row = await scope.first(globals);
		const values = row?.published
			? readFieldsThrough(storedVersion(row.published).values, exposure.globals, reading.chain)
			: {};
		const tree: ElementTree = { version: ELEMENT_TREE_VERSION, nodes: placements };
		const placed = await pageComponents(
			scope,
			[tree],
			presenting.components,
			globalsParts(exposure.globals, values, { language: reading.language, name: scope.site.name }),
			languages,
			{ which: "published" },
			exposure.postTypes,
		);
		component = placed.render;
		className = designSystemNames(await publishedDesignSystem(scope)).nameOf;
		for (const id of mediaReferencesIn(JSON.stringify([tree, placed.trees]))) mediaIds.add(id);
		for (const id of uuidsIn(JSON.stringify(values))) mediaIds.add(id);
	}
	const found = await contentMedia(scope, [...mediaIds], reading.chain, origin);
	const words = pageWords(reading.language);
	const mediaOf = (id: string) => {
		const item = found.get(id);
		return item ? pageMediaOf(item) : undefined;
	};
	const html = (blocks: readonly Block[]) =>
		renderBody(blocks, {
			words,
			media: mediaOf,
			component: (block) =>
				renderTree(
					{ version: ELEMENT_TREE_VERSION, nodes: [blockPlacement(block)] },
					{ values: () => undefined, component, className, media: mediaOf, words, language: reading.language },
				),
		});

	// The Markdown copies' converter (ADR 0018: worked out from the Blocks). Links stay as written, as
	// in the HTML; Media images are at their absolute addresses on the Site's domain.
	const names =
		presenting.body === "markdown" && placements.length > 0 ? await componentNames(scope) : new Map<string, string>();
	const markdown = (blocks: readonly Block[]) =>
		bodyMarkdown(blocks, {
			component: (block) => {
				const name = names.get(block.component);
				return name ? { name } : undefined;
			},
			link: (url) => url,
			image: (id) => {
				const item = found.get(id);
				return item ? { url: item.url, alt: item.alt, caption: item.caption } : undefined;
			},
		});

	const present = (value: Json, field: FieldDefinition): unknown => {
		switch (field.type) {
			case "media":
				return typeof value === "string" ? (found.get(value) ?? null) : null;
			case "relationship": {
				const ids = idsIn(value).filter((id) => targets.has(id));
				const shown =
					selection.expand.has(field.key) && depth === 0
						? ids.flatMap((id) => expanded.get(`${field.key}:${id}`) ?? [])
						: ids;
				return field.multiple ? shown : (shown[0] ?? null);
			}
			case "body": {
				const blocks = (Array.isArray(value) ? value : []) as unknown as Block[];
				if (presenting.body === "blocks") return blocks.map(({ source: _, ...block }) => block);
				if (presenting.body === "markdown") return markdown(blocks);
				return html(blocks);
			}
			default:
				return value;
		}
	};

	const byPostType = new Map<string, PostType>();
	for (const item of read) byPostType.set(item.postType.id, item.postType);
	const addresses = new Map<string, { slug: string; path: string }>();
	for (const postType of byPostType.values()) {
		const own = read.filter((item) => item.postType.id === postType.id).map((item) => item.row.id);
		for (const [id, address] of await publishedAddresses(scope, postType, own, languages)) addresses.set(id, address);
	}
	const text = (value: Json | undefined) => (typeof value === "string" && value !== "" ? value : null);
	return read.map((item) => {
		const address = addresses.get(item.row.id);
		const place = address ? placeOf(presenting.addresses, languages, address.path) : null;
		return {
			id: item.row.id,
			postType: item.postType.key,
			language: reading.language,
			title: item.title ?? "",
			slug: address?.slug ?? null,
			path: address?.path ?? null,
			url: place ? `${place.origin}${place.path}` : null,
			...(isPagePostType(item.postType) ? { parent: parentIn(item.version, reading.chain.defaultLanguage) } : {}),
			publishedAt: item.row.publishedAt?.toISOString() ?? null,
			lastPublishedAt: item.row.lastPublishedAt?.toISOString() ?? null,
			seo: {
				title: text(item.seo.title),
				description: text(item.seo.description),
				canonical: text(item.seo.canonical),
				image: typeof item.seo.image === "string" ? (found.get(item.seo.image) ?? null) : null,
				noindex: item.seo.noindex === true,
			},
			fields: presentValues(item.values, item.fields, present),
			fallbacks: item.fallbacks,
		};
	});
}

/** Published Entries of exposed Post Types shown in the language, by id: what Relationships may show. */
export async function linkedEntries(presenting: Presenting, ids: readonly string[]): Promise<Map<string, EntryRow>> {
	const wanted = [...new Set(ids.filter(isUuid))];
	if (wanted.length === 0) return new Map();
	const { reading, exposure } = presenting;
	const languages = { language: reading.language, defaultLanguage: reading.chain.defaultLanguage };
	const rows = await presenting.scope.select(entries, and(inArray(entries.id, wanted), isNotNull(entries.published)));
	return new Map(
		rows
			.filter((row) => exposure.byId(row.postTypeId) && isVisibleIn(storedVersion(row.published), languages))
			.map((row) => [row.id, row]),
	);
}

/** The Globals' published values as the Content API answers them (their exposed Fields, read through the languages asked for). */
export async function presentGlobals(
	presenting: Presenting,
	published: unknown,
	own: ReadonlySet<string> | null,
): Promise<{ fields: Record<string, unknown>; fallbacks: Record<string, string> }> {
	const fields = selected(presenting.exposure.globals, own);
	const fallbacks: Record<string, string> = {};
	const values = published
		? readFieldsThrough(storedVersion(published).values, fields, presenting.reading.chain, (path, language) => {
				fallbacks[path] = language;
			})
		: Object.fromEntries(fields.map((field) => [field.key, null]));
	const mediaIds: string[] = [];
	eachLeaf(values, fields, (field, value) => {
		if (field.type === "media" && typeof value === "string") mediaIds.push(value);
	});
	const found = await contentMedia(presenting.scope, mediaIds, presenting.reading.chain, presenting.addresses.main);
	const present = (value: Json, field: FieldDefinition): unknown =>
		field.type === "media" ? (typeof value === "string" ? (found.get(value) ?? null) : null) : value;
	return {
		fields: presentValues(values, fields, present),
		fallbacks,
	};
}
