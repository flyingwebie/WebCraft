import { entries, globals, gonePaths, publishedSlugs } from "@webcraft/db/schema";
import { and, asc, eq, inArray, isNotNull, type SQL, sql } from "drizzle-orm";

import { homePageId } from "../content/entry-paths.ts";
import type { FieldDefinition } from "../content/field-types.ts";
import { storedFields } from "../content/fields.ts";
import { languageOfPath, languagePath, type SiteLanguages, siteLanguages } from "../content/languages.ts";
import { defaultQuery } from "../content/loop-queries.ts";
import { candidatePatterns, findPublishedPage, isPagePostType } from "../content/pages.ts";
import type { PostType } from "../content/post-types.ts";
import { listPostTypes } from "../content/post-types.ts";
import { pathFor, pathSegments, slugIn } from "../content/url-patterns.ts";
import { storedVersion } from "../content/values.ts";
import { isVisibleIn } from "../content/visibility.ts";
import { placeOf, type SiteAddresses } from "../domains/addresses.ts";
import { isUuid } from "../ids.ts";
import { searchSnippets } from "../search/snippets.ts";
import { cleanSearchText } from "../search/text-search.ts";
import type { SiteHost } from "../site-pages/index.ts";
import { type LoopPlace, QuerySql, queryRows } from "../site-pages/loops.ts";
import type { VisitorScope } from "../tenancy/data-layer.ts";
import { type CursorPosition, type Cursors, fingerprint } from "./cursor.ts";
import { ContentApiError } from "./errors.ts";
import { type Exposure, exposureOf } from "./exposure.ts";
import { bodyFormatOf, limitOf, QueryParams, type Reading, readingOf } from "./params.ts";
import {
	ALL_FIELDS,
	contentMedia,
	ENTRY_BUILT_INS,
	type Presenting,
	presentEntries,
	presentGlobals,
	type Selection,
} from "./present.ts";
import type { ContentApiSettings } from "./settings.ts";

/** What reading the Content API needs: the Site opened for visitors, the hostname asked, its settings and cursors. */
export type ReadContext = {
	scope: VisitorScope;
	host: SiteHost;
	settings: ContentApiSettings;
	cursors: Cursors;
};

/** An answer of the Content API: its JSON, and whether the page cache may keep it (searches are never kept). */
export type ContentRead = { body: unknown; keep: boolean };

/** How deep search goes: its first 1,000 hits. */
export const CONTENT_SEARCH_DEPTH = 1_000;

/** The operators a filter takes, by what is filtered (`filter.<field>` is equality). */
const FILTER_OPERATORS = ["in", "gt", "gte", "lt", "lte"] as const;
type FilterOperator = "eq" | (typeof FILTER_OPERATORS)[number];

/** Built-in times lists filter on and sort by (besides `title`). */
const BUILT_IN_DATES = ["publishedAt", "lastPublishedAt"] as const;

/** Most values `filter.<field>.in` takes, and most names `fields` takes. */
const MOST_VALUES = 50;
const MOST_FIELDS = 100;

/**
 * Answers a Content API path (after `/_content/v1`) with its query string, as JSON, or throws a
 * `ContentApiError`. Only published content is ever read, through the Site's visitors' scope.
 */
export async function readContent(
	context: ReadContext,
	segments: readonly string[],
	query: URLSearchParams,
): Promise<ContentRead> {
	const [first, ...rest] = segments;
	switch (first) {
		case "languages":
			if (rest.length === 0) return { body: await languagesAnswer(context, query), keep: true };
			break;
		case "schema":
			if (rest.length === 0) return { body: await schemaAnswer(context, query), keep: true };
			break;
		case "globals":
			if (rest.length === 0) return { body: await globalsAnswer(context, query), keep: true };
			break;
		case "media":
			if (rest.length === 1) return { body: await mediaAnswer(context, rest[0] ?? "", query), keep: true };
			break;
		case "search":
			if (rest.length === 0) return { body: await searchAnswer(context, query), keep: false };
			break;
		case "entry":
			if (rest.length === 0) return { body: await entryAtPath(context, query), keep: true };
			break;
		case "entries": {
			const [postTypeKey, second, third, ...more] = rest;
			if (postTypeKey === undefined || more.length > 0) break;
			if (second === undefined) return { body: await listEntries(context, postTypeKey, query), keep: true };
			if (third === undefined) return { body: await entryById(context, postTypeKey, second, query), keep: true };
			if (second === "slug") return { body: await entryBySlug(context, postTypeKey, third, query), keep: true };
			break;
		}
	}
	throw new ContentApiError("NOT_FOUND", "There is no such path in the Content API.");
}

/** The Site's Structure as the Content API shows it. */
async function exposureFor(context: ReadContext): Promise<Exposure> {
	const postTypes = await listPostTypes(context.scope);
	const row = await context.scope.first(globals);
	return exposureOf(context.settings.hidden, postTypes, storedFields(row?.fields));
}

async function addressesOf(context: ReadContext): Promise<SiteAddresses> {
	return context.host.visitorAddresses();
}

// ---------------------------------------------------------------------------------------------------
// Languages and the schema

async function languagesAnswer(context: ReadContext, query: URLSearchParams) {
	new QueryParams(query, () => false).done();
	const site = await siteLanguages(context.scope);
	const addresses = await addressesOf(context);
	return {
		defaultLanguage: site.defaultLanguage,
		languages: site.languages.map((language) => {
			const languages = { language: language.code, defaultLanguage: site.defaultLanguage };
			const place = placeOf(addresses, languages, languagePath(languages, "/"));
			return {
				code: language.code,
				name: language.name,
				direction: language.direction,
				default: language.default,
				url: `${place.origin}${place.path}`,
			};
		}),
	};
}

/** How each exposed Field type is filtered (its operators) and whether it is sorted by. */
function filtersOf(field: FieldDefinition): FilterOperator[] {
	switch (field.type) {
		case "text":
		case "email":
		case "select":
		case "relationship":
			return ["eq", "in"];
		case "number":
			return ["eq", "in", "gt", "gte", "lt", "lte"];
		case "date":
			return field.mode === "time" ? [] : ["eq", "gt", "gte", "lt", "lte"];
		case "boolean":
			return ["eq"];
		default:
			return [];
	}
}

function sortable(field: FieldDefinition): boolean {
	switch (field.type) {
		case "text":
		case "email":
		case "number":
		case "boolean":
			return true;
		case "date":
			return field.mode !== "time";
		case "select":
			return !field.multiple;
		default:
			return false;
	}
}

/** A Field as the schema shows it: its settings that tell a frontend what its values are, and how lists use it. */
function fieldSchema(field: FieldDefinition, topLevel: boolean): Record<string, unknown> {
	const own: Record<string, unknown> = {
		key: field.key,
		label: field.label,
		type: field.type,
		translatable: field.translatable,
		required: field.required,
	};
	switch (field.type) {
		case "select":
			own.options = field.options;
			own.multiple = field.multiple;
			break;
		case "relationship":
			own.postTypes = field.postTypes;
			own.multiple = field.multiple;
			break;
		case "date":
			own.mode = field.mode;
			break;
		case "number":
			own.integer = field.integer;
			break;
		case "group":
		case "repeater":
			own.fields = field.fields.map((inner) => fieldSchema(inner, false));
			break;
	}
	if (topLevel) {
		own.filters = filtersOf(field);
		own.sortable = sortable(field);
	}
	return own;
}

async function schemaAnswer(context: ReadContext, query: URLSearchParams) {
	new QueryParams(query, () => false).done();
	const exposure = await exposureFor(context);
	const site = await siteLanguages(context.scope);
	return {
		defaultLanguage: site.defaultLanguage,
		languages: site.languages.map((language) => language.code),
		builtInFields: [
			{ key: "title", type: "text", translatable: true, filters: [], sortable: true },
			{ key: "slug", type: "text", translatable: true, filters: [], sortable: false },
			{ key: "publishedAt", type: "date", translatable: false, filters: ["gt", "gte", "lt", "lte"], sortable: true },
			{
				key: "lastPublishedAt",
				type: "date",
				translatable: false,
				filters: ["gt", "gte", "lt", "lte"],
				sortable: true,
			},
		],
		postTypes: exposure.postTypes.map((postType) => ({
			key: postType.key,
			name: postType.name,
			pages: isPagePostType(postType),
			urlPattern: isPagePostType(postType) ? null : postType.urlPattern,
			searchable: searchesIn(postType, context.settings),
			fields: postType.fields.map((field) => fieldSchema(field, true)),
		})),
		globals: { fields: exposure.globals.map((field) => fieldSchema(field, false)) },
	};
}

// ---------------------------------------------------------------------------------------------------
// Reading what a request asks

/** The languages, Body format and Fields a request asks for, read against the Site. */
async function readingFor(
	context: ReadContext,
	params: QueryParams,
	options: { fixedLanguage?: string } = {},
): Promise<{ site: SiteLanguages; reading: Reading }> {
	const site = await siteLanguages(context.scope);
	return { site, reading: readingOf(params, site, context.host.language, options.fixedLanguage) };
}

/**
 * `fields`: the Fields an item shows, by key (built-in names are always shown, so naming them changes
 * nothing), and a Relationship's related items' own (`category.title`), one level deep only.
 */
function selectionOf(params: QueryParams, postTypes: readonly PostType[], exposure: Exposure): Selection {
	const asked = params.get("fields");
	if (asked === undefined) return ALL_FIELDS;
	const names = asked
		.split(",")
		.map((name) => name.trim())
		.filter((name) => name !== "");
	if (names.length > MOST_FIELDS) {
		params.add("fields", "tooMany", `Name up to ${MOST_FIELDS} Fields.`);
		return ALL_FIELDS;
	}
	const own = new Set<string>();
	const expand = new Map<string, Set<string>>();
	const builtIn = (name: string) => (ENTRY_BUILT_INS as readonly string[]).includes(name);
	const fieldOf = (types: readonly PostType[], key: string) =>
		types.flatMap((postType) => postType.fields.filter((field) => field.key === key));
	for (const name of names) {
		const [key = "", inner, ...deeper] = name.split(".");
		const found = fieldOf(postTypes, key);
		if (inner === undefined) {
			if (builtIn(key)) continue;
			if (found.length === 0) params.add("fields", "fieldUnknown", `There is no Field ${key} to show.`);
			else own.add(key);
			continue;
		}
		const relationship = found.find((field) => field.type === "relationship");
		if (relationship?.type !== "relationship") {
			params.add(
				"fields",
				found.length === 0 ? "fieldUnknown" : "fieldNotRelationship",
				found.length === 0 ? `There is no Field ${key} to show.` : `${key} isn't a Relationship.`,
			);
			continue;
		}
		if (deeper.length > 0) {
			params.add("fields", "tooDeep", `Relationships are read one level deep: ${name} goes further.`);
			continue;
		}
		const targets = relationship.postTypes.flatMap((targetKey) => exposure.byKey(targetKey) ?? []);
		if (!builtIn(inner) && fieldOf(targets, inner).length === 0) {
			params.add("fields", "fieldUnknown", `What ${key} points at has no Field ${inner}.`);
			continue;
		}
		own.add(key);
		const chosen = expand.get(key) ?? new Set<string>();
		if (!builtIn(inner)) chosen.add(inner);
		expand.set(key, chosen);
	}
	return { own, expand };
}

function presentingOf(
	context: ReadContext,
	exposure: Exposure,
	reading: Reading,
	params: QueryParams,
	addresses: SiteAddresses,
): Presenting {
	return { scope: context.scope, exposure, reading, body: bodyFormatOf(params), addresses };
}

/** An exposed Post Type by key, or `POST_TYPE_NOT_FOUND` (a hidden one is answered as if it didn't exist). */
function postTypeNamed(exposure: Exposure, key: string): PostType {
	const postType = exposure.byKey(key);
	if (!postType)
		throw new ContentApiError("POST_TYPE_NOT_FOUND", `The Site has no Post Type ${key} in its Content API.`);
	return postType;
}

const ENTRY_PARAMETERS = new Set(["lang", "fallback", "body", "fields"]);

// ---------------------------------------------------------------------------------------------------
// One Entry

/** A published Entry row, or why there is none: 404 when it never was (or isn't shown in the language), 410 when it was unpublished. */
async function shownEntry(
	row: typeof entries.$inferSelect | undefined,
	reading: Reading,
): Promise<typeof entries.$inferSelect> {
	if (row && row.published === null && row.unpublishedAt !== null) {
		throw new ContentApiError("ENTRY_GONE", "The Entry was published, then unpublished.");
	}
	const languages = { language: reading.language, defaultLanguage: reading.chain.defaultLanguage };
	if (!row || row.published === null || !isVisibleIn(storedVersion(row.published), languages)) {
		throw new ContentApiError("ENTRY_NOT_FOUND", "There is no such published Entry in this language.");
	}
	return row;
}

async function oneEntry(
	context: ReadContext,
	params: QueryParams,
	find: (exposure: Exposure, reading: Reading) => Promise<typeof entries.$inferSelect | undefined>,
	options: { postTypeKey?: string; fixedLanguage?: string } = {},
) {
	const exposure = await exposureFor(context);
	const postType = options.postTypeKey === undefined ? undefined : postTypeNamed(exposure, options.postTypeKey);
	const { reading } = await readingFor(context, params, options);
	const selection = selectionOf(params, postType ? [postType] : exposure.postTypes, exposure);
	const presenting = presentingOf(context, exposure, reading, params, await addressesOf(context));
	params.done();
	// An Entry of a hidden Post Type is answered as if it didn't exist.
	const found = await find(exposure, reading);
	const row = await shownEntry(found && exposure.byId(found.postTypeId) ? found : undefined, reading);
	const [entry] = await presentEntries(presenting, [row], selection);
	if (!entry) throw new ContentApiError("ENTRY_NOT_FOUND", "There is no such published Entry in this language.");
	return { entry };
}

async function entryById(context: ReadContext, postTypeKey: string, id: string, query: URLSearchParams) {
	const params = new QueryParams(query, (name) => ENTRY_PARAMETERS.has(name));
	return oneEntry(
		context,
		params,
		async (exposure) => {
			if (!isUuid(id)) return undefined;
			const postType = postTypeNamed(exposure, postTypeKey);
			return context.scope.first(entries, and(eq(entries.id, id.toLowerCase()), eq(entries.postTypeId, postType.id)));
		},
		{ postTypeKey },
	);
}

async function entryBySlug(context: ReadContext, postTypeKey: string, slug: string, query: URLSearchParams) {
	const params = new QueryParams(query, (name) => ENTRY_PARAMETERS.has(name));
	const exposure = await exposureFor(context);
	if (isPagePostType(postTypeNamed(exposure, postTypeKey))) {
		params.add("slug", "notForPages", "Pages are found by their path: /entry?path=/about/team.");
	}
	return oneEntry(
		context,
		params,
		async (_exposure, reading) => {
			const postType = postTypeNamed(exposure, postTypeKey);
			const found = await context.scope.first(
				publishedSlugs,
				and(
					eq(publishedSlugs.postTypeId, postType.id),
					eq(publishedSlugs.language, reading.language),
					eq(publishedSlugs.slug, slug),
				),
			);
			if (found) return context.scope.first(entries, eq(entries.id, found.entryId));
			// Where an unpublished Entry was: gone, not missing.
			const path = pathFor(postType.urlPattern, slug);
			const gone = path
				? await context.scope.first(gonePaths, and(eq(gonePaths.language, reading.language), eq(gonePaths.path, path)))
				: undefined;
			return gone ? context.scope.first(entries, eq(entries.id, gone.entryId)) : undefined;
		},
		{ postTypeKey },
	);
}

/**
 * `/entry?path=/fr/blog/pain-frais`: the published Entry at a path on the Site, as visitors find it
 * (its language's prefix naming the language): an Entry under its Post Type's URL pattern, else a
 * Page (the home page at `/`).
 */
async function entryAtPath(context: ReadContext, query: URLSearchParams) {
	const params = new QueryParams(
		query,
		(name) => name === "path" || name === "fallback" || name === "body" || name === "fields",
	);
	const path = params.get("path");
	const segments = path?.startsWith("/") ? pathSegments(path) : undefined;
	if (!segments) params.add("path", "pathInvalid", "Give the Entry's path on the Site, such as /blog/fresh-bread.");
	const site = await siteLanguages(context.scope);
	const located = languageOfPath(site, segments ?? []);
	const language = located.languages.language;
	return oneEntry(
		context,
		params,
		async () => {
			const rest = located.rest;
			const postTypes = await listPostTypes(context.scope);
			const pages = postTypes.find(isPagePostType);
			let entryId: string | undefined;
			if (rest.length === 0) entryId = await homePageId(context.scope);
			else {
				for (const { postType, pattern } of candidatePatterns(postTypes)) {
					const slug = slugIn(pattern, rest);
					if (slug === undefined) continue;
					const found = await context.scope.first(
						publishedSlugs,
						and(
							eq(publishedSlugs.postTypeId, postType.id),
							eq(publishedSlugs.language, language),
							eq(publishedSlugs.slug, slug),
						),
					);
					entryId = found?.entryId;
					break;
				}
				if (entryId === undefined && pages) entryId = await findPublishedPage(context.scope, pages.id, rest, language);
			}
			if (entryId === undefined) {
				const within = `/${rest.join("/")}`;
				const gone = await context.scope.first(
					gonePaths,
					and(eq(gonePaths.language, language), eq(gonePaths.path, within)),
				);
				if (gone) entryId = gone.entryId;
			}
			return entryId ? context.scope.first(entries, eq(entries.id, entryId)) : undefined;
		},
		{ fixedLanguage: language },
	);
}

// ---------------------------------------------------------------------------------------------------
// Lists of Entries

type SortType = "numeric" | "timestamptz" | "boolean" | "text";

/** A list's order: one value, then the Entry's id, so pages never share or skip an item. */
type ListSort = { by: string; direction: "asc" | "desc"; type: SortType };

function sortOf(params: QueryParams, postType: PostType): ListSort {
	const asked = params.get("sort") ?? "-publishedAt";
	const direction = asked.startsWith("-") ? "desc" : "asc";
	const by = asked.replace(/^[-+]/, "");
	if (by === "title") return { by, direction, type: "text" };
	if ((BUILT_IN_DATES as readonly string[]).includes(by)) return { by, direction, type: "timestamptz" };
	const field = postType.fields.find((candidate) => candidate.key === by);
	if (!field) {
		params.add("sort", "fieldUnknown", `There is no Field ${by} to sort by.`);
		return { by: "publishedAt", direction: "desc", type: "timestamptz" };
	}
	if (!sortable(field)) {
		params.add("sort", "sortUnsupported", `Entries can't be sorted by ${by}.`);
		return { by: "publishedAt", direction: "desc", type: "timestamptz" };
	}
	const type: SortType =
		field.type === "number"
			? "numeric"
			: field.type === "date"
				? "timestamptz"
				: field.type === "boolean"
					? "boolean"
					: "text";
	return { by, direction, type };
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;
const NUMBER = /^-?\d{1,15}(\.\d{1,15})?$/;

/** The next day's start after a day (`2026-03-02` gives `2026-03-03T00:00:00.000Z`). */
function nextDay(day: string): string {
	return new Date(Date.parse(`${day}T00:00:00Z`) + 24 * 60 * 60 * 1000).toISOString();
}

/** Each `filter.<field>[.<operator>]` as a condition on the list, checked against the exposed Fields. */
async function listFilters(
	context: ReadContext,
	params: QueryParams,
	postType: PostType,
	sqlOf: QuerySql,
	exposure: Exposure,
	reading: Reading,
): Promise<SQL[]> {
	const conditions: SQL[] = [];
	for (const [name, raw] of params.named("filter.")) {
		const [, key = "", operator = "eq", ...more] = name.split(".");
		const field = postType.fields.find((candidate) => candidate.key === key);
		const builtIn = (BUILT_IN_DATES as readonly string[]).includes(key);
		if (!field && !builtIn) {
			params.add(name, "fieldUnknown", `There is no Field ${key} to filter on.`);
			continue;
		}
		const allowed: readonly string[] = field ? filtersOf(field) : ["gt", "gte", "lt", "lte"];
		if (more.length > 0 || !allowed.includes(operator)) {
			params.add(name, "filterUnsupported", `${key} can't be filtered on with ${operator}.`);
			continue;
		}
		const values = operator === "in" ? raw.split(",").map((value) => value.trim()) : [raw];
		if (values.length > MOST_VALUES || values.some((value) => value === "" || value.length > 2_000)) {
			params.add(name, values.length > MOST_VALUES ? "tooMany" : "valueInvalid", `Give 1 to ${MOST_VALUES} values.`);
			continue;
		}
		const type = builtIn ? "date" : (field?.type ?? "text");
		const invalid = (message: string) => params.add(name, "valueInvalid", message);
		const value = builtIn ? sqlOf.valueOf(key) : field ? sqlOf.valueOf(key) : undefined;
		switch (type) {
			case "number": {
				if (values.some((text) => !NUMBER.test(text))) {
					invalid("Give a number, such as 4 or -2.5.");
					continue;
				}
				const literals = values.map((text) => sql`${text}::numeric`);
				conditions.push(compare(value, operator, literals));
				break;
			}
			case "date": {
				const [text = ""] = values;
				if (!DAY.test(text) && !(TIME.test(text) && !Number.isNaN(Date.parse(text)))) {
					invalid("Give a day (2026-03-02) or a time (2026-03-02T09:30:00Z).");
					continue;
				}
				const at = (instant: string) => sql`${instant}::timestamptz`;
				if (DAY.test(text)) {
					const start = at(`${text}T00:00:00Z`);
					const end = at(nextDay(text));
					const day = {
						eq: sql`(${value} >= ${start} and ${value} < ${end})`,
						gte: sql`${value} >= ${start}`,
						gt: sql`${value} >= ${end}`,
						lt: sql`${value} < ${start}`,
						lte: sql`${value} < ${end}`,
					}[operator as "eq"];
					conditions.push(sql`coalesce(${day}, false)`);
				} else {
					conditions.push(compare(value, operator, [at(new Date(Date.parse(text)).toISOString())]));
				}
				break;
			}
			case "boolean": {
				const [text = ""] = values;
				if (text !== "true" && text !== "false") {
					invalid("Give true or false.");
					continue;
				}
				conditions.push(sql`${value} = ${text}::boolean`);
				break;
			}
			case "select":
				conditions.push(
					sql`(${sql.join(
						values.map((option) => sqlOf.selectHas(key, option)),
						sql` or `,
					)})`,
				);
				break;
			case "relationship": {
				if (values.some((id) => !isUuid(id))) {
					invalid("Give Entry ids.");
					continue;
				}
				// Only Entries the API shows count: another one's id matches nothing.
				const targets =
					field?.type === "relationship" ? field.postTypes.flatMap((target) => exposure.byKey(target)?.id ?? []) : [];
				const shown =
					targets.length === 0
						? []
						: (
								await context.scope.select(
									entries,
									and(
										inArray(
											entries.id,
											values.map((id) => id.toLowerCase()),
										),
										inArray(entries.postTypeId, targets),
										isNotNull(entries.published),
									),
								)
							)
								.filter((row) =>
									isVisibleIn(storedVersion(row.published), {
										language: reading.language,
										defaultLanguage: reading.chain.defaultLanguage,
									}),
								)
								.map((row) => row.id);
				conditions.push(shown.length === 0 ? sql`false` : sqlOf.linksTo(key, shown, false));
				break;
			}
			default:
				conditions.push(
					compare(
						value,
						operator,
						values.map((text) => sql`${text}::text`),
					),
				);
		}
	}
	return conditions;
}

/** A value compared with literals: equal to one (`eq`, `in`) or past one (`gt`, `gte`, `lt`, `lte`); never true for no value. */
function compare(value: SQL | undefined, operator: string, literals: SQL[]): SQL {
	if (!value) return sql`false`;
	const [first = sql`null`] = literals;
	const by: Record<string, SQL> = {
		eq: sql`${value} = ${first}`,
		in: sql`${value} in (${sql.join(literals, sql`, `)})`,
		gt: sql`${value} > ${first}`,
		gte: sql`${value} >= ${first}`,
		lt: sql`${value} < ${first}`,
		lte: sql`${value} <= ${first}`,
	};
	return sql`coalesce(${by[operator] ?? sql`false`}, false)`;
}

function placeFor(reading: Reading): LoopPlace {
	return {
		current: null,
		languages: { language: reading.language, defaultLanguage: reading.chain.defaultLanguage },
		chain: reading.chain.languages,
		page: null,
		path: "",
		version: "published",
	};
}

async function listEntries(context: ReadContext, postTypeKey: string, query: URLSearchParams) {
	const params = new QueryParams(
		query,
		(name) =>
			ENTRY_PARAMETERS.has(name) ||
			name === "sort" ||
			name === "limit" ||
			name === "cursor" ||
			name.startsWith("filter."),
	);
	const exposure = await exposureFor(context);
	const postType = postTypeNamed(exposure, postTypeKey);
	const { reading } = await readingFor(context, params);
	const selection = selectionOf(params, [postType], exposure);
	const presenting = presentingOf(context, exposure, reading, params, await addressesOf(context));
	const limit = limitOf(params);
	const sort = sortOf(params, postType);
	const place = placeFor(reading);
	const sqlOf = new QuerySql([postType], place, context.scope.now());
	const conditions = await listFilters(context, params, postType, sqlOf, exposure, reading);
	const fingerprintOf = await fingerprint({
		postType: postType.id,
		chain: reading.chain.languages,
		sort,
		filters: params.named("filter.").sort(([a], [b]) => a.localeCompare(b)),
	});
	const cursorText = params.get("cursor");
	let after: CursorPosition | undefined;
	if (cursorText !== undefined) {
		after = await context.cursors.read(fingerprintOf, cursorText);
		if (!after || !("after" in after))
			params.add("cursor", "cursorInvalid", "Send a cursor this list gave, with the same query.");
	}
	params.done();

	const value = sqlOf.valueOf(sort.by) ?? sql`null`;
	const where = context.scope.where(
		entries,
		and(eq(entries.postTypeId, postType.id), isNotNull(entries.published), sqlOf.visible(), ...conditions),
	);
	const order = [
		sort.direction === "asc" ? sql`${value} asc nulls last` : sql`${value} desc nulls last`,
		asc(entries.id),
	];
	let past: SQL | undefined;
	if (after && "after" in after) {
		const { value: last, id } = after.after;
		const literal = sql`${last}::${sql.raw(sort.type)}`;
		past =
			last === null
				? sql`(${value} is null and ${entries.id} > ${id}::uuid)`
				: sql`(${value} ${sql.raw(sort.direction === "asc" ? ">" : "<")} ${literal} or (${value} = ${literal} and ${entries.id} > ${id}::uuid) or ${value} is null)`;
	}
	const rows = await context.scope.db
		.select({ entry: entries, sortKey: sql<string | null>`(${value})::text` })
		.from(entries)
		.where(and(where, past))
		.orderBy(...order)
		.limit(limit + 1);
	const [counted] = await context.scope.db
		.select({ total: sql<number>`count(*)::int`.mapWith(Number) })
		.from(entries)
		.where(where);
	const shown = rows.slice(0, limit);
	const last = shown.at(-1);
	const next =
		rows.length > limit && last
			? await context.cursors.make(fingerprintOf, { after: { value: last.sortKey, id: last.entry.id } })
			: null;
	return {
		items: await presentEntries(
			presenting,
			shown.map((row) => row.entry),
			selection,
		),
		total: counted?.total ?? 0,
		next,
	};
}

// ---------------------------------------------------------------------------------------------------
// The Globals and Media

async function globalsAnswer(context: ReadContext, query: URLSearchParams) {
	const params = new QueryParams(query, (name) => name === "lang" || name === "fallback" || name === "fields");
	const exposure = await exposureFor(context);
	const { reading } = await readingFor(context, params);
	let own: Set<string> | null = null;
	const asked = params.get("fields");
	if (asked !== undefined) {
		own = new Set();
		for (const key of asked
			.split(",")
			.map((name) => name.trim())
			.filter((name) => name !== "")) {
			if (exposure.globals.some((field) => field.key === key)) own.add(key);
			else params.add("fields", "fieldUnknown", `The Globals have no Field ${key} to show.`);
		}
	}
	const presenting = presentingOf(context, exposure, reading, params, await addressesOf(context));
	params.done();
	const row = await context.scope.first(globals);
	return {
		language: reading.language,
		publishedAt: row?.publishedAt?.toISOString() ?? null,
		lastPublishedAt: row?.lastPublishedAt?.toISOString() ?? null,
		...(await presentGlobals(presenting, row?.published ?? null, own)),
	};
}

async function mediaAnswer(context: ReadContext, id: string, query: URLSearchParams) {
	const params = new QueryParams(query, (name) => name === "lang" || name === "fallback");
	const { reading } = await readingFor(context, params);
	params.done();
	const addresses = await addressesOf(context);
	const found = isUuid(id)
		? (await contentMedia(context.scope, [id], reading.chain, addresses.main)).get(id.toLowerCase())
		: undefined;
	if (!found) throw new ContentApiError("MEDIA_NOT_FOUND", "The Site has no such Media item ready.");
	return { media: found, language: reading.language };
}

// ---------------------------------------------------------------------------------------------------
// Search

/**
 * Whether the Content API's search lists a Post Type: one Site search lists (`searchable`) whose
 * Searched fields are all exposed, since a hit (and its snippet) would otherwise show what Staff hid.
 */
function searchesIn(postType: PostType, settings: ContentApiSettings): boolean {
	if (!postType.searchable) return false;
	const hidden = settings.hidden.fields[postType.id] ?? [];
	return !postType.searchedFields.some(({ field }) =>
		hidden.some((path) => field === path || field.startsWith(`${path}.`)),
	);
}

async function searchAnswer(context: ReadContext, query: URLSearchParams) {
	const params = new QueryParams(query, (name) =>
		["q", "postType", "lang", "fallback", "limit", "cursor"].includes(name),
	);
	const exposure = await exposureFor(context);
	const { reading } = await readingFor(context, params);
	const q = cleanSearchText(params.get("q") ?? "");
	if (q === "") params.add("q", "queryMissing", "Give the words to search for.");
	const searching = exposure.postTypes.filter((postType) => searchesIn(postType, context.settings));
	let listed = searching;
	const asked = params.get("postType");
	if (asked !== undefined) {
		const keys = asked.split(",").map((key) => key.trim());
		listed = searching.filter((postType) => keys.includes(postType.key));
		for (const key of keys) {
			if (!searching.some((postType) => postType.key === key)) {
				params.add("postType", "fieldUnknown", `Search doesn't list a Post Type ${key}.`);
			}
		}
	}
	const limit = limitOf(params);
	const fingerprintOf = await fingerprint({
		q,
		chain: reading.chain.languages,
		postTypes: listed.map((postType) => postType.id),
	});
	let offset = 0;
	const cursorText = params.get("cursor");
	if (cursorText !== undefined) {
		const position = await context.cursors.read(fingerprintOf, cursorText);
		if (!position || !("offset" in position))
			params.add("cursor", "cursorInvalid", "Send a cursor this search gave, with the same query.");
		else offset = position.offset;
	}
	if (offset >= CONTENT_SEARCH_DEPTH)
		params.add("cursor", "tooFar", `Search answers its first ${CONTENT_SEARCH_DEPTH} hits.`);
	params.done();
	const addresses = await addressesOf(context);
	const presenting = presentingOf(context, exposure, reading, params, addresses);
	const loop = { ...defaultQuery(), postTypes: listed.map((postType) => postType.key) };
	const take = Math.min(limit, CONTENT_SEARCH_DEPTH - offset);
	const rows = await queryRows(context.scope, loop, placeFor(reading), listed, offset, take + 1, {
		search: q,
		indexableOnly: true,
	});
	const shown = rows.slice(0, take);
	const snippets = await searchSnippets(
		context.scope,
		shown.map((row) => row.entry.id),
		reading.language,
		q,
	);
	const items = await presentEntries(
		presenting,
		shown.map((row) => row.entry),
		{ own: new Set(), expand: new Map() },
	);
	const next =
		rows.length > take && offset + take < CONTENT_SEARCH_DEPTH
			? await context.cursors.make(fingerprintOf, { offset: offset + take })
			: null;
	return {
		items: items.map(({ fields: _, fallbacks: __, seo: ___, ...hit }) => ({
			...hit,
			snippet: snippets.get(hit.id) ?? "",
		})),
		total: Math.min(rows[0]?.total ?? 0, CONTENT_SEARCH_DEPTH),
		next,
	};
}
