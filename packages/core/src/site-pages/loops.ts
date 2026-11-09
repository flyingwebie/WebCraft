import { entries, entryLinks, loops, searchDocuments } from "@webcraft/db/schema";
import {
	type ElementTree,
	LOOP_LIMITS,
	type LoopItem,
	type LoopRun,
	loopNamesIn,
	richText,
	SEARCH_LOOP,
	type TemplateValue,
} from "@webcraft/renderer";
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or, type SQL, sql } from "drizzle-orm";
import { draftAddresses } from "../content/draft-paths.ts";
import { entryValues } from "../content/entries.ts";
import { publishedAddresses } from "../content/entry-paths.ts";
import type { FieldDefinition } from "../content/field-types.ts";
import { type Languages, linksIn } from "../content/field-values.ts";
import {
	DATE_BUILT_INS,
	defaultQuery,
	fieldAt,
	type LoopQuery,
	type LoopSort,
	type QueryFilter,
} from "../content/loop-queries.ts";
import { loopItems, type StoredLoopVersion, storedLoopVersion } from "../content/loops.ts";
import type { PostType } from "../content/post-types.ts";
import { entryParts, type Parts, resolvePath, valuesParts } from "../content/render-values.ts";
import { storedVersion } from "../content/values.ts";
import { publishedVisibleIn } from "../content/visibility.ts";
import { searchSnippets, textQuery } from "../search/snippets.ts";
import { publishedIndexable } from "../seo/entry-seo.ts";
import { namesOf, type ReadScope, relatedEntries } from "./related.ts";

/**
 * Running a page's Loops (GLOSSARY.md › Loop): the Loops of the Site its templates and Components
 * name, each run once per page whatever how often or how deep it is placed, so a page never runs one
 * query per item. A query is one parameterised SQL query over the Site's Entries: only published
 * Entries shown in the page's language (`publishedVisibleIn`'s rule), their values read in that
 * language with the Default language's as fallback, one Field at a time (ADR 0003). A page runs at
 * most `LOOP_LIMITS.perPage` Loops; the rest show no items.
 */

/** Where a page's Loops run. */
export type LoopPlace = {
	/**
	 * The Entry (or Page) the page shows: what "related to the current Entry" and "exclude current"
	 * mean; null on Archive pages and the built-in 404 page.
	 */
	current: string | null;
	languages: Languages;
	/** The page visitors asked for where Loops paginate (Archive templates and Pages); null elsewhere. */
	page: number | null;
	/** The page's address in its language (`/fr/blog`), which pagination's links go to. */
	path: string;
	/**
	 * Which versions are read: published Loops over published Entries for pages, or the Drafts of
	 * both for the Data tab (Entries never published included).
	 */
	version: "published" | "draft";
	/**
	 * Site search on the page (the Site's search results page, ADR 0021): what the visitor searches
	 * for and the keys of the Post Types it lists. The built-in `search` Loop runs it.
	 */
	search?: SearchOnPage;
	/**
	 * The state of the page's Filters as its address keeps it (`q=bread`), which links to the other
	 * pages of its paginated Loop keep too.
	 */
	state?: string;
	/** What the page's Filters narrow each Loop of the Site with, by the Loop's name. */
	narrowing?: ReadonlyMap<string, Narrowing>;
};

/** Site search on a page: see `LoopPlace.search`. */
export type SearchOnPage = { query: string; postTypes: readonly string[] };

/** How many hits Site search shows on each page of results. */
export const SEARCH_PAGE_SIZE = 10;

/**
 * Site search's query: the searchable Post Types' published Entries shown in the page's language,
 * `SEARCH_PAGE_SIZE` at a time, the search results page itself left out. It runs narrowed by the
 * visitor's query, best hits first (a Filter's search box narrows its Loop's own query the same way).
 */
export function searchLoopQuery(postTypes: readonly string[]): LoopQuery {
	return {
		...defaultQuery(),
		postTypes: [...postTypes],
		limit: SEARCH_PAGE_SIZE,
		paginate: true,
		excludeCurrent: true,
	};
}

/**
 * What narrows a Loop's query on a page, besides its own filters: a search box's query (ADR 0021),
 * for Site search only Entries search engines may index (not noindex), and a Filter's choices: the
 * conditions its controls add (all of which an Entry must pass) and the order its sort menu chose, in
 * place of the query's own (`relevance`: best search match first).
 */
export type Narrowing = {
	search?: string;
	indexableOnly?: boolean;
	where?: SQL;
	sort?: readonly LoopSort[] | "relevance";
};

/** What a page's Loops show. */
export type PageLoops = {
	/** What a Loop of the Site shows on the page, by name; undefined for a name no Loop has. */
	run(name: string): LoopRun | undefined;
	/** The pages of the Loop that paginates on the page, when one does. */
	pagination: { current: number; count: number } | null;
	/** When what the Loops list could change with time alone (a date window relative to now); null when never. */
	changesAt: Date | null;
	/** The values the items show, for finding the Media they read. */
	values: unknown[];
	/** How many Entries a query Loop of the Site matches on the page, across its pages (its offset aside). */
	matched(name: string): number | undefined;
};

/**
 * How long a page whose Loops list Entries by a date window relative to now (the last 12 months,
 * upcoming events) is kept before it is rendered again: the window moves with time, publishing or not.
 */
export const RELATIVE_WINDOW_REFRESH_MS = 5 * 60_000;

/** The highest page number a paginated Loop answers; past it, a page is not found. */
export const MAX_PAGE_NUMBER = 500;

/** The query parameter naming a page of a paginated Loop: `/blog?page=2`. */
export const PAGE_PARAMETER = "page";

/**
 * Which page of a paginated Loop a query asks for: 1 without `page`, the number it gives (1 to
 * `MAX_PAGE_NUMBER`, written without leading zeros), undefined for anything else (a page not found).
 */
export function pageNumberIn(query: URLSearchParams): number | undefined {
	const given = query.getAll(PAGE_PARAMETER);
	if (given.length === 0) return 1;
	const [value = ""] = given;
	if (given.length > 1 || !/^[1-9][0-9]{0,3}$/.test(value)) return undefined;
	const page = Number(value);
	return page <= MAX_PAGE_NUMBER ? page : undefined;
}

/** Runs the Loops of the Site the trees name, for one page. */
export async function pageLoops(
	scope: ReadScope,
	trees: readonly (ElementTree | undefined)[],
	place: LoopPlace,
	postTypes: readonly PostType[],
): Promise<PageLoops> {
	const names = [...new Set(trees.flatMap((tree) => (tree ? loopNamesIn(tree) : [])))];
	const matched = new Map<string, number>();
	const result: PageLoops & { runs: Map<string, LoopRun> } = {
		runs: new Map(),
		run: (name) => result.runs.get(name),
		pagination: null,
		changesAt: null,
		values: [],
		matched: (name) => matched.get(name),
	};
	if (names.length === 0) return result;
	const rows = await scope.select(loops, inArray(loops.name, names));
	let ran = 0;
	for (const name of names) {
		// Site search's built-in Loop, on the search results page.
		if (name === SEARCH_LOOP && place.search && ran < LOOP_LIMITS.perPage) {
			ran++;
			const { query } = place.search;
			if (!query) {
				result.runs.set(name, { items: [], total: 0 });
				continue;
			}
			const paginates = place.page !== null && result.pagination === null;
			const run = await queryItems(
				scope,
				searchLoopQuery(place.search.postTypes),
				place,
				postTypes,
				paginates,
				result.values,
				{ search: query, indexableOnly: true },
			);
			if (paginates && run.pages) result.pagination = { current: run.pages.current, count: run.pages.count };
			result.runs.set(name, run);
			continue;
		}
		const row = rows.find((candidate) => candidate.name === name);
		if (!row) continue;
		const stored = place.version === "draft" ? row.draft : row.published;
		// A Loop never published, or past what one page may run, shows nothing.
		if (stored === null || ran >= LOOP_LIMITS.perPage) {
			result.runs.set(name, { items: [], total: 0 });
			continue;
		}
		ran++;
		const version = storedLoopVersion(stored);
		if (version.source === "items") {
			result.runs.set(name, ownItems(row.id, version, place, result.values));
			continue;
		}
		const paginates = version.query.paginate && place.page !== null && result.pagination === null;
		const run = await queryItems(
			scope,
			version.query,
			place,
			postTypes,
			paginates,
			result.values,
			place.narrowing?.get(name),
		);
		matched.set(name, run.matched);
		if (paginates && run.pages) result.pagination = { current: run.pages.current, count: run.pages.count };
		if (version.query.filters.some(movesWithTime)) {
			const refresh = new Date(scope.now().getTime() + RELATIVE_WINDOW_REFRESH_MS);
			if (!result.changesAt || refresh < result.changesAt) result.changesAt = refresh;
		}
		result.runs.set(name, run);
	}
	return result;
}

function movesWithTime(filter: QueryFilter): boolean {
	return filter.type === "date" && filter.window !== "between";
}

/** A Loop's own items, in the page's language: each reads its Fields' values. */
function ownItems(loopId: string, version: StoredLoopVersion, place: LoopPlace, values: unknown[]): LoopRun {
	const rows = loopItems(version, place.languages);
	values.push(rows);
	const items: LoopItem[] = rows.map((row) => {
		const parts = valuesParts(version.fields, row);
		return {
			read: (path) => (path === "" ? null : resolvePath(parts, path)),
			key: `loop:${loopId}:${String(row.id)}`,
		};
	});
	return { items, total: items.length };
}

/**
 * A query Loop's items: one SQL query for the Entries (and how many match in all), then one per
 * Post Type for their addresses, one for their authors and one for the Entries their Relationships
 * point at: never one per item.
 */
async function queryItems(
	scope: ReadScope,
	query: LoopQuery,
	place: LoopPlace,
	postTypes: readonly PostType[],
	paginates: boolean,
	values: unknown[],
	narrowing: Narrowing = {},
): Promise<LoopRun & { matched: number }> {
	const page = paginates ? (place.page ?? 1) : 1;
	const rows = await queryRows(
		scope,
		query,
		place,
		postTypes,
		query.offset + (page - 1) * query.limit,
		query.limit,
		narrowing,
	);
	const total = rows[0]?.total ?? 0;
	// A hit's snippet: where its text matched the query.
	const snippets =
		narrowing.search === undefined
			? undefined
			: await searchSnippets(
					scope,
					rows.map((row) => row.entry.id),
					place.languages.language,
					narrowing.search,
				);
	const items = await entryItems(
		scope,
		rows.map((row) => row.entry),
		place,
		postTypes,
		values,
		snippets,
	);
	// A page past the last finds no rows to count with: how many match is then asked on its own.
	const matched =
		rows.length > 0 || page === 1
			? Math.max(0, total - query.offset)
			: await countMatching(scope, query, place, postTypes, narrowing);
	if (!paginates) return { items, total: items.length, matched };
	const count = rows.length === 0 && page > 1 ? 0 : Math.max(1, Math.ceil(matched / query.limit));
	return {
		items,
		total: matched,
		matched,
		pages: { current: page, count, href: (target) => pageHref(place.path, target, place.state) },
	};
}

/** How many Entries a query matches, its offset aside. */
async function countMatching(
	scope: ReadScope,
	query: LoopQuery,
	place: LoopPlace,
	postTypes: readonly PostType[],
	narrowing: Narrowing,
): Promise<number> {
	const base = queryBase(scope, query, place, postTypes, narrowing);
	if (!base) return 0;
	const rows = await scope.db.execute<{ count: number }>(
		sql`select count(*)::int as count from ${entries} ${base.join} where ${base.where}`,
	);
	return Math.max(0, Number(rows.rows[0]?.count ?? 0) - query.offset);
}

/**
 * The Entries a query finds, `limit` of them from `offset`, each with how many match in all: one
 * parameterised SQL query. Narrowed by a search, only Entries whose document in the page's language
 * matches it are found, the best match first (Searched fields weighted A count most).
 */
export async function queryRows(
	scope: ReadScope,
	query: LoopQuery,
	place: LoopPlace,
	postTypes: readonly PostType[],
	offset: number,
	limit: number,
	narrowing: Narrowing = {},
): Promise<{ entry: typeof entries.$inferSelect; total: number }[]> {
	const base = queryBase(scope, query, place, postTypes, narrowing);
	if (!base) return [];
	const select = { entry: entries, total: sql<number>`count(*) over ()`.mapWith(Number) };
	const chosen = narrowing.sort;
	const ordered = Array.isArray(chosen) ? { ...query, sort: [...chosen] } : query;
	if (base.matched) {
		// The Site's index in the page's language: one document per Entry, matched through its GIN index.
		const relevance = desc(sql`ts_rank(${searchDocuments.document}, ${base.matched})`);
		return scope.db
			.select(select)
			.from(entries)
			.innerJoin(searchDocuments, base.documents as SQL)
			.where(base.where)
			.orderBy(...(Array.isArray(chosen) ? [] : [relevance]), ...base.sqlOf.order(ordered))
			.limit(limit)
			.offset(offset);
	}
	return scope.db
		.select(select)
		.from(entries)
		.where(base.where)
		.orderBy(...base.sqlOf.order(ordered))
		.limit(limit)
		.offset(offset);
}

/**
 * What a query finds, before its order and its page: the Entries of its Post Types shown in the
 * page's language that pass its filters and what narrows it, joined to the search index when a
 * search narrows it. Undefined when it lists no Post Type of the Site.
 */
function queryBase(
	scope: ReadScope,
	query: LoopQuery,
	place: LoopPlace,
	postTypes: readonly PostType[],
	narrowing: Narrowing,
): { sqlOf: QuerySql; where: SQL; join: SQL; documents?: SQL; matched?: SQL } | undefined {
	const listed = postTypes.filter((postType) => query.postTypes.includes(postType.key));
	if (listed.length === 0) return undefined;
	const sqlOf = new QuerySql(listed, place, scope.now());
	const condition = and(
		inArray(
			entries.postTypeId,
			listed.map((postType) => postType.id),
		),
		place.version === "published" ? isNotNull(entries.published) : undefined,
		sqlOf.visible(),
		query.excludeCurrent && place.current ? ne(entries.id, place.current) : undefined,
		sqlOf.filters(query),
		narrowing.indexableOnly ? publishedIndexable(place.languages) : undefined,
		narrowing.where,
	);
	if (narrowing.search === undefined) {
		return { sqlOf, where: scope.where(entries, condition), join: sql`` };
	}
	const { language } = place.languages;
	const matched = textQuery(language, narrowing.search);
	const documents = and(
		eq(searchDocuments.siteId, entries.siteId),
		eq(searchDocuments.entryId, entries.id),
		eq(searchDocuments.language, language),
	) as SQL;
	return {
		sqlOf,
		where: and(
			scope.where(entries, condition),
			scope.where(searchDocuments, sql`${searchDocuments.document} @@ ${matched}`),
		) as SQL,
		join: sql`inner join ${searchDocuments} on ${documents}`,
		documents,
		matched,
	};
}

/** What a facet counts Entries by: a select Field's options, what a Relationship Field points at, or the Post Type. */
export type FacetGroup =
	| { kind: "select"; field: string }
	| { kind: "relationship"; field: string }
	| { kind: "postType" };

/**
 * How many Entries a query finds for each value of a facet (a Filter control's options), as narrowed:
 * one parameterised SQL query, grouped by the value (an option's value, an Entry's or a Post Type's
 * id). Values no Entry has are absent.
 */
export async function facetCounts(
	scope: ReadScope,
	query: LoopQuery,
	place: LoopPlace,
	postTypes: readonly PostType[],
	narrowing: Narrowing,
	group: FacetGroup,
): Promise<Map<string, number>> {
	const base = queryBase(scope, query, place, postTypes, narrowing);
	if (!base) return new Map();
	let value: SQL;
	let join = base.join;
	switch (group.kind) {
		case "postType":
			value = sql`${entries.postTypeId}::text`;
			break;
		case "select": {
			const json = base.sqlOf.leaf(group.field);
			value = sql`jsonb_array_elements_text(case jsonb_typeof(${json}) when 'array' then ${json} when 'string' then jsonb_build_array(${json}) else '[]'::jsonb end)`;
			break;
		}
		case "relationship":
			join = sql`${join} inner join ${entryLinks} on ${entryLinks.siteId} = ${entries.siteId} and ${entryLinks.entryId} = ${entries.id} and ${entryLinks.version} = ${place.version} and ${entryLinks.field} = ${group.field}`;
			value = sql`${entryLinks.targetId}::text`;
			break;
	}
	const rows = await scope.db.execute<{ value: string; count: number }>(
		sql`select found.value, count(distinct found.id)::int as count from (select ${entries.id} as id, ${value} as value from ${entries} ${join} where ${base.where}) as found where found.value is not null group by found.value`,
	);
	return new Map(rows.rows.map((row) => [row.value, Number(row.count)]));
}

/**
 * A page of a paginated Loop: the page's own address for the first, `?page=N` for the others, after
 * the state of the page's Filters when it has one (`?q=bread&page=2`).
 */
export function pageHref(path: string, page: number, state = ""): string {
	const query = [state, page > 1 ? `page=${page}` : ""].filter((part) => part !== "").join("&");
	return query ? `${path}?${query}` : path;
}

/** Entries as a Loop's items: their built-in values, Fields, and what their Relationships point at. */
async function entryItems(
	scope: ReadScope,
	rows: readonly (typeof entries.$inferSelect)[],
	place: LoopPlace,
	postTypes: readonly PostType[],
	values: unknown[],
	snippets?: ReadonlyMap<string, string>,
): Promise<LoopItem[]> {
	const { languages } = place;
	const byId = new Map(postTypes.map((postType) => [postType.id, postType]));
	const draft = place.version === "draft";
	const addresses = new Map<string, { slug: string; path: string }>();
	for (const postType of postTypes) {
		const own = rows.filter((row) => row.postTypeId === postType.id).map((row) => row.id);
		// Drafts are where their Drafts would be published (the Staging address, the Data tab).
		const located = draft
			? await draftAddresses(scope, postType, own, languages)
			: await publishedAddresses(scope, postType, own, languages);
		for (const [id, address] of located) addresses.set(id, address);
	}
	const authors = await namesOf(
		scope,
		rows.flatMap((row) => (row.authorId ? [row.authorId] : [])),
	);
	const versions = new Map(rows.map((row) => [row.id, storedVersion(draft ? row.draft : row.published)]));
	const related = await relatedEntries(
		scope,
		postTypes,
		rows.flatMap((row) => {
			const postType = byId.get(row.postTypeId);
			const version = versions.get(row.id);
			return postType && version ? linksIn(version.values, postType.fields).map((link) => link.targetId) : [];
		}),
		languages,
		place.version,
	);
	values.push([...related.values()].map((entry) => entry.values));
	const noSite: Parts = { text: null, part: () => undefined };
	return rows.flatMap((row) => {
		const postType = byId.get(row.postTypeId);
		const version = versions.get(row.id);
		if (!postType || !version) return [];
		const read = entryValues(version, postType.fields, languages);
		values.push(read.fields);
		const address = addresses.get(row.id);
		const builtIns: Record<string, TemplateValue> = {
			title: read.title,
			slug: address?.slug ?? read.slug,
			url: address?.path ?? null,
			author: row.authorId ? (authors.get(row.authorId) ?? null) : null,
			createdAt: row.createdAt,
			updatedAt: draft ? row.updatedAt : row.lastPublishedAt,
			publishedAt: row.publishedAt,
			lastPublishedAt: row.lastPublishedAt,
		};
		// A search hit's snippet, as HTML holding only WebCraft's own highlights.
		if (snippets) builtIns.snippet = richText(snippets.get(row.id) ?? "");
		const parts = entryParts(builtIns, postType.fields, read.fields, { related, site: noSite });
		return [{ read: (path) => (path === "" ? read.title : resolvePath(parts, path)), key: `entry:${row.id}` }];
	});
}

/**
 * The SQL of a query, over one version of Entries in one language: every value a parameter, every
 * key passed as text, so nothing Staff or visitors write becomes SQL.
 */
export class QuerySql {
	private readonly column: typeof entries.draft | typeof entries.published;
	private readonly listed: readonly PostType[];
	private readonly place: LoopPlace;
	private readonly now: Date;

	constructor(listed: readonly PostType[], place: LoopPlace, now: Date) {
		this.listed = listed;
		this.place = place;
		this.now = now;
		this.column = place.version === "draft" ? entries.draft : entries.published;
	}

	/**
	 * Entries shown in the page's language: not hidden there, by the one rule every list asks
	 * (`publishedVisibleIn`, `content/visibility.ts`), read from the Drafts for the Data tab.
	 */
	visible(): SQL {
		const { language, defaultLanguage } = this.place.languages;
		if (this.place.version === "published") return publishedVisibleIn(this.place.languages);
		return sql`not coalesce((${entries.draft} -> 'values' -> 'hiddenLanguages' -> ${defaultLanguage}::text -> 'value') @> jsonb_build_array(${language}::text), false)`;
	}

	filters(query: LoopQuery): SQL | undefined {
		const each = query.filters.map((filter) => this.filter(filter));
		if (each.length === 0) return undefined;
		return query.match === "any" ? or(...each) : and(...each);
	}

	order(query: LoopQuery): SQL[] {
		const orders: SQL[] = [];
		for (const sort of query.sort) {
			const value = this.sortValue(sort.by);
			if (!value) continue;
			orders.push(sort.direction === "asc" ? sql`${value} asc nulls last` : sql`${value} desc nulls last`);
		}
		if (query.sort.length === 0) orders.push(desc(sql`coalesce(${entries.publishedAt}, ${entries.createdAt})`));
		// The same order every time, so pages never share or skip an item.
		orders.push(desc(entries.createdAt), asc(entries.id));
		return orders;
	}

	private filter(filter: QueryFilter): SQL {
		switch (filter.type) {
			case "field":
				return this.fieldFilter(filter);
			case "relationship":
				return this.relationshipFilter(filter);
			case "date":
				return this.dateFilter(filter);
			case "status":
				return or(
					...filter.statuses.map((status) =>
						status === "draft"
							? isNull(entries.published)
							: status === "published"
								? sql`(${entries.published} is not null and ${entries.draft} = ${entries.published})`
								: sql`(${entries.published} is not null and ${entries.draft} <> ${entries.published})`,
					),
				) as SQL;
		}
	}

	private fieldFilter(filter: Extract<QueryFilter, { type: "field" }>): SQL {
		const found = fieldAt(this.listed, filter.field)?.found[0];
		if (!found) return sql`false`;
		const field = found.field;
		const json = this.leaf(filter.field);
		const { operator, value } = filter;
		if (operator === "empty") return isEmpty(json);
		if (operator === "notEmpty") return sql`not ${isEmpty(json)}`;
		const equals = (): SQL => {
			switch (field.type) {
				case "number":
					return sql`${number(json)} = ${value}::numeric`;
				case "boolean":
					return sql`${boolean(json)} = ${value}::boolean`;
				case "date":
					return sql`${date(json)} = ${dayOrTime(String(value))}::timestamptz`;
				case "select":
					return sql`(${json} = to_jsonb(${value}::text) or (jsonb_typeof(${json}) = 'array' and ${json} @> jsonb_build_array(${value}::text)))`;
				default:
					return sql`${text(json)} = ${value}::text`;
			}
		};
		switch (operator) {
			case "equals":
				return sql`coalesce(${equals()}, false)`;
			case "notEquals":
				return sql`not coalesce(${equals()}, false)`;
			case "contains": {
				const haystack =
					field.type === "richText" ? sql`regexp_replace(${text(json)}, '<[^>]*>', '', 'g')` : text(json);
				return sql`coalesce(strpos(lower(${haystack}), lower(${value}::text)) > 0, false)`;
			}
			default: {
				const comparison = { lessThan: "<", atMost: "<=", greaterThan: ">", atLeast: ">=" }[operator];
				const left = field.type === "date" ? date(json) : number(json);
				const right = field.type === "date" ? sql`${dayOrTime(String(value))}::timestamptz` : sql`${value}::numeric`;
				return sql`coalesce(${left} ${sql.raw(comparison)} ${right}, false)`;
			}
		}
	}

	private relationshipFilter(filter: Extract<QueryFilter, { type: "relationship" }>): SQL {
		const current = this.place.current;
		const version = this.place.version;
		const links = sql`select 1 from ${entryLinks} where ${entryLinks.siteId} = ${entries.siteId} and ${entryLinks.entryId} = ${entries.id} and ${entryLinks.version} = ${version} and ${entryLinks.field} = ${filter.field}`;
		switch (filter.to) {
			case "current":
				return current ? sql`exists (${links} and ${entryLinks.targetId} = ${current}::uuid)` : sql`false`;
			case "sharedWithCurrent": {
				if (!current) return sql`false`;
				const theirs = sql`select own.target_id from ${entryLinks} as own where own.site_id = ${entries.siteId} and own.entry_id = ${current}::uuid and own.version = ${version} and own.field = ${filter.field}`;
				return sql`exists (${links} and ${entryLinks.targetId} in (${theirs}))`;
			}
			case "entries": {
				const chosen = sql.join(
					filter.entries.map((id) => sql`${id}::uuid`),
					sql`, `,
				);
				return sql`exists (${links} and ${entryLinks.targetId} in (${chosen}))`;
			}
		}
	}

	private dateFilter(filter: Extract<QueryFilter, { type: "date" }>): SQL {
		const value = this.dateValue(filter.field);
		if (!value) return sql`false`;
		const at = (instant: Date) => sql`${instant.toISOString()}::timestamptz`;
		const now = this.now;
		switch (filter.window) {
			case "past":
				return sql`coalesce(${value} < ${at(now)}, false)`;
			case "future":
				return sql`coalesce(${value} > ${at(now)}, false)`;
			case "last":
				return sql`coalesce(${value} between ${at(shift(now, -(filter.amount ?? 0), filter.unit))} and ${at(now)}, false)`;
			case "next":
				return sql`coalesce(${value} between ${at(now)} and ${at(shift(now, filter.amount ?? 0, filter.unit))}, false)`;
			case "between": {
				const from = filter.from ? sql`${value} >= ${at(new Date(`${filter.from}T00:00:00Z`))}` : sql`true`;
				const to = filter.to ? sql`${value} < ${at(shift(new Date(`${filter.to}T00:00:00Z`), 1, "days"))}` : sql`true`;
				return sql`coalesce(${from} and ${to}, false)`;
			}
		}
	}

	/** A built-in date, or a date Field's value as a time. */
	private dateValue(field: string): SQL | undefined {
		if ((DATE_BUILT_INS as readonly string[]).includes(field)) return this.builtIn(field);
		return fieldAt(this.listed, field) ? date(this.leaf(field)) : undefined;
	}

	private sortValue(by: string): SQL | undefined {
		if (by === "title") return text(this.translatable(sql`${this.column} -> 'values' -> 'title'`));
		if ((DATE_BUILT_INS as readonly string[]).includes(by)) return this.builtIn(by);
		const found = fieldAt(this.listed, by)?.found[0];
		if (!found) return undefined;
		const json = this.leaf(by);
		switch (found.field.type) {
			case "number":
				return number(json);
			case "date":
				return date(json);
			case "boolean":
				return boolean(json);
			default:
				return text(json);
		}
	}

	private builtIn(field: string): SQL {
		switch (field) {
			case "createdAt":
				return sql`${entries.createdAt}`;
			case "publishedAt":
				return sql`${entries.publishedAt}`;
			case "lastPublishedAt":
				return sql`${entries.lastPublishedAt}`;
			default:
				// What visitors see was last updated when it was last published.
				return this.place.version === "draft" ? sql`${entries.updatedAt}` : sql`${entries.lastPublishedAt}`;
		}
	}

	/** Entries of the listed Post Types with these ids (a Filter's Post Type options). */
	postTypeIn(ids: readonly string[]): SQL {
		return ids.length === 0 ? sql`false` : (inArray(entries.postTypeId, [...ids]) as SQL);
	}

	/** Entries whose select Field at `path` has `value` (one of its choices). */
	selectHas(path: string, value: string): SQL {
		const json = this.leaf(path);
		return sql`coalesce((${json} = to_jsonb(${value}::text) or (jsonb_typeof(${json}) = 'array' and ${json} @> jsonb_build_array(${value}::text))), false)`;
	}

	/** Entries whose Relationship Field at `path` points at one of `targets` (`all`: at every one). */
	linksTo(path: string, targets: readonly string[], all: boolean): SQL {
		const each = (ids: readonly string[]) =>
			sql`exists (select 1 from ${entryLinks} where ${entryLinks.siteId} = ${entries.siteId} and ${entryLinks.entryId} = ${entries.id} and ${entryLinks.version} = ${this.place.version} and ${entryLinks.field} = ${path} and ${entryLinks.targetId} in (${sql.join(
				ids.map((id) => sql`${id}::uuid`),
				sql`, `,
			)}))`;
		if (targets.length === 0) return sql`false`;
		return all ? (and(...targets.map((target) => each([target]))) as SQL) : each(targets);
	}

	/** Entries whose true/false Field at `path` is true. */
	isTrue(path: string): SQL {
		return sql`${boolean(this.leaf(path))} = true`;
	}

	/** Entries whose number at `path` is within `from` and `to` (either may be absent), both included. */
	numberWithin(path: string, from: number | null, to: number | null): SQL {
		const value = number(this.leaf(path));
		return sql`coalesce(${from === null ? sql`true` : sql`${value} >= ${from}::numeric`} and ${to === null ? sql`true` : sql`${value} <= ${to}::numeric`}, false)`;
	}

	/** Entries whose date at `path` falls on a day from `from` to `to` (days, UTC; either may be absent), both included. */
	dayWithin(path: string, from: string | null, to: string | null): SQL {
		const value = date(this.leaf(path));
		const start = from === null ? sql`true` : sql`${value} >= ${`${from}T00:00:00Z`}::timestamptz`;
		const end =
			to === null
				? sql`true`
				: sql`${value} < ${shift(new Date(`${to}T00:00:00Z`), 1, "days").toISOString()}::timestamptz`;
		return sql`coalesce(${start} and ${end}, false)`;
	}

	/**
	 * A leaf Field's stored value (JSON) at a path (`address.city`) in the page's language: each
	 * listed Post Type's own definition says whether it falls back from the Default language
	 * (translatable) or is kept there alone (shared); a Post Type without the Field gives null.
	 */
	leaf(path: string): SQL {
		const cases: SQL[] = [];
		for (const postType of this.listed) {
			const chain = chainOf(postType.fields, path.split("."));
			const leaf = chain?.at(-1);
			if (!chain || !leaf) continue;
			let node = sql`${this.column}`;
			for (const field of chain) node = sql`(${node} -> 'values' -> ${field.key}::text)`;
			const value = leaf.translatable
				? this.translatable(node)
				: sql`(${node} -> ${this.place.languages.defaultLanguage}::text -> 'value')`;
			cases.push(sql`when ${postType.id}::uuid then ${value}`);
		}
		if (cases.length === 0) return sql`null::jsonb`;
		return sql`(case ${entries.postTypeId} ${sql.join(cases, sql` `)} end)`;
	}

	/** A translatable value in the page's language, else the Default language's. */
	private translatable(node: SQL): SQL {
		const { language, defaultLanguage } = this.place.languages;
		return sql`(coalesce(${node} -> ${language}::text, ${node} -> ${defaultLanguage}::text) -> 'value')`;
	}
}

/** The Fields a path walks through (Groups, then the leaf), or undefined when it names none. */
function chainOf(fields: readonly FieldDefinition[], names: readonly string[]): FieldDefinition[] | undefined {
	const [name, ...rest] = names;
	const field = fields.find((candidate) => candidate.key === name);
	if (!field) return undefined;
	if (rest.length === 0) return field.type === "group" || field.type === "repeater" ? undefined : [field];
	if (field.type !== "group") return undefined;
	const inner = chainOf(field.fields, rest);
	return inner ? [field, ...inner] : undefined;
}

function text(json: SQL): SQL {
	return sql`(${json} #>> '{}')`;
}

function number(json: SQL): SQL {
	return sql`(case when jsonb_typeof(${json}) = 'number' then (${json} #>> '{}')::numeric end)`;
}

/** A true/false value; unset reads false. */
function boolean(json: SQL): SQL {
	return sql`coalesce(case when jsonb_typeof(${json}) = 'boolean' then (${json} #>> '{}')::boolean end, false)`;
}

/** A date Field's value as a time: a day (`2026-03-02`) at midnight UTC, or a time (`2026-03-02T09:30:00Z`). */
function date(json: SQL): SQL {
	const value = text(json);
	return sql`(case when ${value} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then (${value})::date::timestamp at time zone 'UTC' when ${value} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' then (${value})::timestamptz end)`;
}

/** No value: missing, null, blank text, an empty list. */
function isEmpty(json: SQL): SQL {
	return sql`(${json} is null or ${json} in ('null'::jsonb, '""'::jsonb, '[]'::jsonb, '{}'::jsonb))`;
}

/** A filter's day (`2026-03-02`, midnight UTC) or time, written as Postgres reads it. */
function dayOrTime(value: string): string {
	return value.length === 10 ? `${value}T00:00:00Z` : value;
}

/** A time moved by whole days, weeks, months or years, in UTC. */
function shift(from: Date, amount: number, unit: string | null): Date {
	const moved = new Date(from.getTime());
	switch (unit) {
		case "weeks":
			moved.setUTCDate(moved.getUTCDate() + amount * 7);
			break;
		case "months":
			moved.setUTCMonth(moved.getUTCMonth() + amount);
			break;
		case "years":
			moved.setUTCFullYear(moved.getUTCFullYear() + amount);
			break;
		default:
			moved.setUTCDate(moved.getUTCDate() + amount);
	}
	return moved;
}
