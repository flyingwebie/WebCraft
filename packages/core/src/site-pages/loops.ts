import { entries, entryLinks, loops } from "@webcraft/db/schema";
import {
	type ElementTree,
	LOOP_LIMITS,
	type LoopItem,
	type LoopRun,
	loopNamesIn,
	type TemplateValue,
} from "@webcraft/renderer";
import { and, asc, desc, inArray, isNotNull, isNull, ne, or, type SQL, sql } from "drizzle-orm";

import { entryValues } from "../content/entries.ts";
import { publishedAddresses } from "../content/entry-paths.ts";
import type { FieldDefinition } from "../content/field-types.ts";
import { type Languages, linksIn } from "../content/field-values.ts";
import { DATE_BUILT_INS, fieldAt, type LoopQuery, type QueryFilter } from "../content/loop-queries.ts";
import { loopItems, type StoredLoopVersion, storedLoopVersion } from "../content/loops.ts";
import type { PostType } from "../content/post-types.ts";
import { entryParts, type Parts, resolvePath, valuesParts } from "../content/render-values.ts";
import { storedVersion } from "../content/values.ts";
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
};

/**
 * How long a page whose Loops list Entries by a date window relative to now (the last 12 months,
 * upcoming events) is kept before it is rendered again: the window moves with time, publishing or not.
 */
export const RELATIVE_WINDOW_REFRESH_MS = 5 * 60_000;

/** The highest page number a paginated Loop answers; past it, a page is not found. */
export const MAX_PAGE_NUMBER = 500;

/** Runs the Loops of the Site the trees name, for one page. */
export async function pageLoops(
	scope: ReadScope,
	trees: readonly (ElementTree | undefined)[],
	place: LoopPlace,
	postTypes: readonly PostType[],
): Promise<PageLoops> {
	const names = [...new Set(trees.flatMap((tree) => (tree ? loopNamesIn(tree) : [])))];
	const result: PageLoops & { runs: Map<string, LoopRun> } = {
		runs: new Map(),
		run: (name) => result.runs.get(name),
		pagination: null,
		changesAt: null,
		values: [],
	};
	if (names.length === 0) return result;
	const rows = await scope.select(loops, inArray(loops.name, names));
	let ran = 0;
	for (const name of names) {
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
		const run = await queryItems(scope, version.query, place, postTypes, paginates, result.values);
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
): Promise<LoopRun> {
	const page = paginates ? (place.page ?? 1) : 1;
	const rows = await queryRows(scope, query, place, postTypes, query.offset + (page - 1) * query.limit, query.limit);
	const total = rows[0]?.total ?? 0;
	const items = await entryItems(
		scope,
		rows.map((row) => row.entry),
		place,
		postTypes,
		values,
	);
	if (!paginates) return { items, total: items.length };
	const count =
		rows.length === 0 && page > 1 ? 0 : Math.max(1, Math.ceil(Math.max(0, total - query.offset) / query.limit));
	return {
		items,
		total: Math.max(0, total - query.offset),
		pages: { current: page, count, href: (target) => pageHref(place.path, target) },
	};
}

/**
 * The Entries a query finds, `limit` of them from `offset`, each with how many match in all: one
 * parameterised SQL query.
 */
export async function queryRows(
	scope: ReadScope,
	query: LoopQuery,
	place: LoopPlace,
	postTypes: readonly PostType[],
	offset: number,
	limit: number,
): Promise<{ entry: typeof entries.$inferSelect; total: number }[]> {
	const listed = postTypes.filter((postType) => query.postTypes.includes(postType.key));
	if (listed.length === 0) return [];
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
	);
	return scope.db
		.select({ entry: entries, total: sql<number>`count(*) over ()`.mapWith(Number) })
		.from(entries)
		.where(scope.where(entries, condition))
		.orderBy(...sqlOf.order(query))
		.limit(limit)
		.offset(offset);
}

/** A page of a paginated Loop: the page's own address for the first, `?page=N` for the others. */
export function pageHref(path: string, page: number): string {
	return page <= 1 ? path : `${path}?page=${page}`;
}

/** Entries as a Loop's items: their built-in values, Fields, and what their Relationships point at. */
async function entryItems(
	scope: ReadScope,
	rows: readonly (typeof entries.$inferSelect)[],
	place: LoopPlace,
	postTypes: readonly PostType[],
	values: unknown[],
): Promise<LoopItem[]> {
	const { languages } = place;
	const byId = new Map(postTypes.map((postType) => [postType.id, postType]));
	const draft = place.version === "draft";
	const addresses = new Map<string, { slug: string; path: string }>();
	for (const postType of postTypes) {
		const own = rows.filter((row) => row.postTypeId === postType.id).map((row) => row.id);
		for (const [id, address] of await publishedAddresses(scope, postType, own, languages)) addresses.set(id, address);
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
		const parts = entryParts(builtIns, postType.fields, read.fields, { related, site: noSite });
		return [{ read: (path) => (path === "" ? read.title : resolvePath(parts, path)), key: `entry:${row.id}` }];
	});
}

/**
 * The SQL of a query, over one version of Entries in one language: every value a parameter, every
 * key passed as text, so nothing Staff or visitors write becomes SQL.
 */
class QuerySql {
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

	/** Entries shown in the page's language: not hidden there (see `content/visibility.ts`). */
	visible(): SQL {
		const { language, defaultLanguage } = this.place.languages;
		return sql`not coalesce((${this.column} -> 'values' -> 'hiddenLanguages' -> ${defaultLanguage}::text -> 'value') @> jsonb_build_array(${language}::text), false)`;
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

	/**
	 * A leaf Field's stored value (JSON) at a path (`address.city`) in the page's language: each
	 * listed Post Type's own definition says whether it falls back from the Default language
	 * (translatable) or is kept there alone (shared); a Post Type without the Field gives null.
	 */
	private leaf(path: string): SQL {
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
