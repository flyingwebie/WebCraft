import { entries, filters as filterRows, loops } from "@webcraft/db/schema";
import {
	childListsOf,
	controlKey,
	type ElementTree,
	FILTER_LIMITS,
	type FilterControl,
	type FilterControlView,
	type FilterNode,
	type FilterOptionView,
	type FilterText,
	type FilterVersion,
	type FilterView,
	filterTextIn,
	filterWords,
	isStateControl,
	presetDays,
	renderFilter,
	renderFilterPart,
	type TreeNode,
} from "@webcraft/renderer";
import { and, inArray, isNotNull, or, type SQL } from "drizzle-orm";

import { draftAddresses } from "../content/draft-paths.ts";
import { entryValues } from "../content/entries.ts";
import { publishedAddresses } from "../content/entry-paths.ts";
import type { FieldDefinition } from "../content/field-types.ts";
import { fieldAt, type LoopQuery } from "../content/loop-queries.ts";
import { storedLoopVersion } from "../content/loops.ts";
import type { PostType } from "../content/post-types.ts";
import { slugify } from "../content/slugs.ts";
import { storedVersion } from "../content/values.ts";
import { isVisibleIn } from "../content/visibility.ts";
import { storedFilterVersion } from "../filters/definition.ts";
import {
	type FilterState,
	rangeSides,
	readFilterState,
	type StateKey,
	type StateReader,
	writeQuery,
} from "../filters/state.ts";
import { type FacetGroup, facetCounts, type LoopPlace, type Narrowing, type PageLoops, QuerySql } from "./loops.ts";
import type { ReadScope } from "./related.ts";

/**
 * A page's Filters (GLOSSARY.md › Filter): the Filters its templates and the Components they place
 * show (`{{@filter <name> for="<loop>"}}`), at most `FILTER_LIMITS.perPage` of them. For each, the
 * options its controls offer (a select Field's options, the Entries a Relationship may point at, the
 * Loop's Post Types, by slug in the page's language), what the visitor chose in the page's address
 * (read through an allow-list, `state.ts`), the conditions that narrow its Loop's query (OR inside a
 * control, AND across controls), and, once the Loops ran, how many items each option would list
 * (faceted counts: each control's ignore its own choice), counted in SQL.
 */
export type PageFilters = {
	/** What the page's Filters read from its address. */
	reader: StateReader;
	/** What the request's address chose. */
	state: FilterState;
	/** What narrows each filtered Loop, by its name. */
	narrowing: ReadonlyMap<string, Narrowing>;
	/** Whether a Loop of the Site is narrowed by a Filter on the page. */
	filtered(loop: string): boolean;
	/** How each placed Filter renders, once the page's Loops ran (the result count is theirs). */
	render(loops: PageLoops): Promise<RenderedFilters>;
	/** When the page's Filters show something else: the next midnight (UTC) when they offer date presets. */
	changesAt: Date | null;
};

/** The page's Filters once its Loops ran: each placement's HTML, and what each Filter says its result count is. */
export type RenderedFilters = {
	html(node: FilterNode): string;
	announce(filterId: string): string | undefined;
};

/** A page with no Filter. */
const NO_FILTERS_ON_PAGE: PageFilters = {
	reader: { keys: [] },
	state: { values: new Map(), query: "", differs: false, search: undefined },
	narrowing: new Map(),
	filtered: () => false,
	render: async () => ({ html: () => "", announce: () => undefined }),
	changesAt: null,
};

/** One option of a control: its slug in the address, its label, and what it matches in SQL. */
type Option = { slug: string; label: string; match: string };

/** A control on the page: its key (prefixed when the page shows several Filters) and its options. */
type PageControl = { control: FilterControl; key: string; options: Option[]; field?: FieldDefinition };

/** A Filter on the page, read and ready to narrow its Loop. */
type PageFilter = {
	id: string;
	name: string;
	loop: string;
	version: FilterVersion;
	query: LoopQuery;
	listed: PostType[];
	controls: PageControl[];
};

/** Where a page's Filters run. */
export type FilterPlace = Pick<LoopPlace, "languages" | "version" | "path" | "current"> & {
	/** Which version of the Filters the page shows: published, or their Drafts (the Staging address, Code mode). */
	structure: "published" | "draft";
	/** The request's address. */
	params: URLSearchParams;
	/**
	 * What else the page keeps in its address besides its Filters (Site search's `q` on the search
	 * results page): each Filter's form sends it on, and its keys share the address.
	 */
	kept?: readonly (readonly [string, string])[];
	/** Whether the page shares its address with Site search (the search results page): its Filters' keys are then prefixed. */
	shared?: boolean;
	/** The Filter builder's preview: only this Filter shows, in the version it is given (not saved yet). */
	only?: { id: string; version: FilterVersion };
};

/** Works out the page's Filters from its trees. */
export async function pageFilters(
	scope: ReadScope,
	trees: readonly (ElementTree | undefined)[],
	place: FilterPlace,
	postTypes: readonly PostType[],
): Promise<PageFilters> {
	const nodes = trees.flatMap((tree) => (tree ? filterNodesIn(tree.nodes) : []));
	// The Loops the page shows: a control shown on its own elsewhere shows only where its Loop does.
	const loopsShown = new Set(trees.flatMap((tree) => (tree ? loopSourcesIn(tree.nodes) : [])));
	const ids = [...new Set(nodes.map((node) => node.filter))].filter((id) => !place.only || id === place.only.id);
	if (ids.length === 0) return NO_FILTERS_ON_PAGE;
	const rows = await scope.select(filterRows, inArray(filterRows.id, ids));
	const loopRows = await scope.select(
		loops,
		inArray(
			loops.name,
			rows.map((row) => row.loop),
		),
	);
	const read: PageFilter[] = [];
	for (const id of ids) {
		const row = rows.find((candidate) => candidate.id === id);
		const stored = place.only ? place.only.version : place.structure === "draft" ? row?.draft : row?.published;
		const loopRow = loopRows.find((candidate) => candidate.name === row?.loop);
		const loopStored = place.version === "draft" ? loopRow?.draft : loopRow?.published;
		// A Filter never published, or one whose Loop has no query, shows nothing and narrows nothing.
		if (!row || stored === null || stored === undefined || !loopStored || read.length >= FILTER_LIMITS.perPage)
			continue;
		const loop = storedLoopVersion(loopStored);
		if (loop.source !== "query") continue;
		read.push({
			id: row.id,
			name: row.name,
			loop: row.loop,
			version: place.only ? place.only.version : storedFilterVersion(stored),
			query: loop.query,
			listed: postTypes.filter((postType) => loop.query.postTypes.includes(postType.key)),
			controls: [],
		});
	}
	if (read.length === 0) return NO_FILTERS_ON_PAGE;
	// Two Filters (or Site search and a Filter) sharing a page keep their keys apart by the Filter's name.
	const prefixed = read.length > 1 || place.shared === true;
	for (const filter of read) {
		for (const control of filter.version.controls) {
			const page = await pageControl(scope, filter, control, place, postTypes);
			if (page)
				filter.controls.push({
					...page,
					key: prefixed && isStateControl(control) ? `${filter.name}.${page.key}` : page.key,
				});
		}
	}
	const reader: StateReader = { keys: read.flatMap((filter) => filter.controls.flatMap(stateKeyOf)) };
	const state = readFilterState(reader, place.params);
	const narrowing = new Map<string, Narrowing>();
	const sqlFor = (filter: PageFilter) => new QuerySql(filter.listed, { ...place, page: null }, scope.now());
	for (const filter of read) narrowing.set(filter.loop, narrowingOf(filter, state, sqlFor(filter)));
	// Date presets count from today: the page shows other days from midnight on.
	const presets = read.some((filter) =>
		filter.version.controls.some((control) => control.type === "range" && control.presets.length > 0),
	);
	const today = scope.now();
	const midnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + 1));
	return {
		reader,
		state,
		narrowing,
		changesAt: presets ? midnight : null,
		filtered: (loop) => narrowing.has(loop),
		render: async (pageLoops) => {
			const views = new Map<string, FilterView>();
			for (const filter of read) {
				views.set(filter.id, await viewOf(scope, filter, state, place, postTypes, pageLoops, sqlFor(filter)));
			}
			const shown = new Map<string, number>();
			const html = (node: FilterNode) => {
				const view = views.get(node.filter);
				const filter = read.find((each) => each.id === node.filter);
				if (!view || !filter) return "";
				const indexOf = (control: string) => filter.controls.findIndex((page) => page.control.id === control);
				// Controls shown on their own: the Filter's form leaves them out, and their fields belong to it.
				const placed = nodes.filter((each) => each.filter === node.filter);
				const apart = new Set(placed.flatMap((each) => (each.control === undefined ? [] : [indexOf(each.control)])));
				const key = node.control === undefined ? node.filter : `${node.filter}#${node.control}`;
				const occurrence = (shown.get(key) ?? 0) + 1;
				shown.set(key, occurrence);
				if (node.control === undefined) return renderFilter(view, occurrence, apart);
				const index = indexOf(node.control);
				if (index < 0 || !loopsShown.has(filter.loop)) return "";
				const form = placed.some((each) => each.control === undefined) ? `wc-filter-${view.name}` : null;
				return renderFilterPart(view, index, occurrence, form);
			};
			return { html, announce: (filterId) => views.get(filterId)?.announce };
		},
	};
}

/** The names of the Loops of the Site a tree's nodes show (`{{@loop <name>}}`). */
function loopSourcesIn(nodes: readonly TreeNode[]): string[] {
	const found: string[] = [];
	for (const node of nodes) {
		if (node.type === "loop") found.push(node.source);
		for (const children of childListsOf(node)) found.push(...loopSourcesIn(children));
	}
	return found;
}

/** The Filters placed in a tree's nodes, in order (never inside a Loop's items, which can't hold one). */
function filterNodesIn(nodes: readonly TreeNode[]): FilterNode[] {
	const found: FilterNode[] = [];
	for (const node of nodes) {
		if (node.type === "filter") found.push(node);
		if (node.type === "loop") {
			if (node.empty) found.push(...filterNodesIn(node.empty));
			continue;
		}
		for (const children of childListsOf(node)) found.push(...filterNodesIn(children));
	}
	return found;
}

/** A control as the page shows it: its options read in the page's language; undefined for one its Loop can't have. */
async function pageControl(
	scope: ReadScope,
	filter: PageFilter,
	control: FilterControl,
	place: FilterPlace,
	postTypes: readonly PostType[],
): Promise<(Omit<PageControl, "key"> & { key: string }) | undefined> {
	const key = isStateControl(control) ? controlKey(control) : "";
	switch (control.type) {
		case "checkboxes":
		case "choice": {
			const options = await optionsOf(scope, filter, control.source, place, postTypes);
			if (!options) return undefined;
			return { control, key, options: options.options, field: options.field };
		}
		case "toggle":
		case "range": {
			const field = fieldAt(filter.listed, control.field)?.found[0]?.field;
			if (!field) return undefined;
			return { control, key, options: [], field };
		}
		case "sort":
			return {
				control,
				key,
				options: control.options.map((option) => ({ slug: option.value, label: "", match: option.value })),
			};
		default:
			return { control, key, options: [] };
	}
}

/**
 * The options a control offers, in their source's order: a select Field's options, the Entries of the
 * Post Types a Relationship Field may point at (by title, shown in the page's language), or the
 * Loop's Post Types; at most `FILTER_LIMITS.options`, each by a slug of its own.
 */
async function optionsOf(
	scope: ReadScope,
	filter: PageFilter,
	source: Extract<FilterControl, { type: "checkboxes" }>["source"],
	place: FilterPlace,
	postTypes: readonly PostType[],
): Promise<{ options: Option[]; field?: FieldDefinition } | undefined> {
	const options: Option[] = [];
	const add = (slug: string, label: string, match: string) => {
		if (slug !== "" && options.length < FILTER_LIMITS.options && !options.some((option) => option.slug === slug)) {
			options.push({ slug, label, match });
		}
	};
	if (source.kind === "postType") {
		for (const postType of filter.listed) add(postType.key, postType.name, postType.id);
		return { options };
	}
	const field = fieldAt(filter.listed, source.field, true)?.found[0]?.field;
	if (field?.type === "select") {
		for (const option of field.options) add(slugify(option.value) || slugify(option.label), option.label, option.value);
		return { options, field };
	}
	if (field?.type !== "relationship") return undefined;
	const targets = postTypes.filter((postType) => field.postTypes.includes(postType.key));
	if (targets.length === 0) return { options, field };
	const draft = place.version === "draft";
	const rows = await scope.select(
		entries,
		and(
			inArray(
				entries.postTypeId,
				targets.map((postType) => postType.id),
			),
			draft ? undefined : isNotNull(entries.published),
		) as SQL,
		{ limit: FILTER_LIMITS.options * 5 },
	);
	const found: { id: string; title: string; slug: string }[] = [];
	for (const postType of targets) {
		const own = rows.filter(
			(row) =>
				row.postTypeId === postType.id &&
				isVisibleIn(storedVersion(draft ? row.draft : row.published), place.languages),
		);
		const located = draft
			? await draftAddresses(
					scope,
					postType,
					own.map((row) => row.id),
					place.languages,
				)
			: await publishedAddresses(
					scope,
					postType,
					own.map((row) => row.id),
					place.languages,
				);
		for (const row of own) {
			const values = entryValues(storedVersion(draft ? row.draft : row.published), postType.fields, place.languages);
			found.push({ id: row.id, title: values.title, slug: located.get(row.id)?.slug ?? values.slug });
		}
	}
	found.sort((a, b) => a.title.localeCompare(b.title, place.languages.language));
	for (const entry of found) add(entry.slug, entry.title, entry.id);
	return { options, field };
}

/** The key a control keeps its choice under, and what it takes. */
function stateKeyOf(page: PageControl): StateKey[] {
	const { control, key, field } = page;
	switch (control.type) {
		case "search":
			return [{ key, kind: "search" }];
		case "checkboxes":
			return [{ key, kind: "many", values: page.options.map((option) => option.slug) }];
		case "choice":
		case "sort":
			return [{ key, kind: "one", values: page.options.map((option) => option.slug) }];
		case "toggle":
			return [{ key, kind: "toggle" }];
		case "range":
			return [{ key, kind: field?.type === "date" ? "date" : "number" }];
		default:
			return [];
	}
}

/** The options a key's value chose, by slug. */
function chosen(page: PageControl, state: FilterState): Option[] {
	const value = state.values.get(page.key);
	if (value === undefined) return [];
	const slugs = value.split(",");
	return page.options.filter((option) => slugs.includes(option.slug));
}

/** What one control's choice narrows its Loop with; undefined when it chose nothing. */
function conditionOf(page: PageControl, state: FilterState, sql: QuerySql): SQL | undefined {
	const { control } = page;
	const value = state.values.get(page.key);
	if (value === undefined) return undefined;
	switch (control.type) {
		case "checkboxes":
		case "choice": {
			const options = chosen(page, state);
			if (options.length === 0) return undefined;
			const all = control.type === "checkboxes" && control.match === "all";
			const matches = options.map((option) => option.match);
			// An Entry is of one Post Type: all of several finds none.
			if (control.source.kind === "postType") return sql.postTypeIn(all && matches.length > 1 ? [] : matches);
			if (page.field?.type === "relationship") return sql.linksTo(control.source.field, matches, all);
			const field = control.source.field;
			const each = matches.map((match) => sql.selectHas(field, match));
			return (all ? and(...each) : or(...each)) as SQL;
		}
		case "toggle":
			return sql.isTrue(control.field);
		case "range": {
			const kind = page.field?.type === "date" ? "date" : "number";
			const [from, to] = rangeSides(kind, value);
			if (kind === "date") return sql.dayWithin(control.field, from || null, to || null);
			return sql.numberWithin(control.field, from === "" ? null : Number(from), to === "" ? null : Number(to));
		}
		default:
			return undefined;
	}
}

/**
 * What a Filter's choices narrow its Loop with: its search, each control's condition (all of them,
 * but `except`'s, for that control's counts), and its sort.
 */
function narrowingOf(filter: PageFilter, state: FilterState, sql: QuerySql, except?: PageControl): Narrowing {
	const conditions: SQL[] = [];
	let search: string | undefined;
	let sort: Narrowing["sort"];
	for (const page of filter.controls) {
		const { control } = page;
		if (control.type === "search") {
			if (page !== except) search = state.values.get(page.key);
			continue;
		}
		if (control.type === "sort") {
			const choice = control.options.find((option) => option.value === state.values.get(page.key));
			if (choice) sort = choice.by === "relevance" ? "relevance" : [{ by: choice.by, direction: choice.direction }];
			continue;
		}
		if (page === except) continue;
		const condition = conditionOf(page, state, sql);
		if (condition) conditions.push(condition);
	}
	return {
		...(search !== undefined ? { search } : {}),
		...(conditions.length > 0 ? { where: and(...conditions) as SQL } : {}),
		...(sort !== undefined ? { sort } : {}),
	};
}

/** How a Filter shows on the page: its words in the page's language, its options' counts and states, its chips. */
async function viewOf(
	scope: ReadScope,
	filter: PageFilter,
	state: FilterState,
	place: FilterPlace,
	postTypes: readonly PostType[],
	pageLoops: PageLoops,
	sql: QuerySql,
): Promise<FilterView> {
	const { language } = place.languages;
	const words = filterWords(language);
	const text = (value: FilterText | null, fallback: string) => (value ? filterTextIn(value, language) : fallback);
	const own = new Set(filter.controls.map((page) => page.key));
	// The rest of the page's address: other Filters' choices, and what else the page keeps.
	const others: (readonly [string, string])[] = [
		...[...state.values].filter(([key]) => !own.has(key)),
		...(place.kept ?? []),
	];
	const href = (values: Iterable<readonly [string, string]>) => {
		const query = writeQuery([...values, ...others]);
		return query ? `${place.path}?${query}` : place.path;
	};
	const mine = [...state.values].filter(([key]) => own.has(key));
	const total = pageLoops.matched(filter.loop) ?? 0;
	const countControl = filter.controls.find((page) => page.control.type === "count")?.control;
	const counted = countText(total, language, countControl?.type === "count" ? countControl : null);
	const loopPlace: LoopPlace = { ...place, page: null };
	const views: FilterControlView[] = [];
	for (const page of filter.controls) {
		const { control, key } = page;
		const label = "label" in control ? control.label : null;
		switch (control.type) {
			case "search":
				views.push({
					type: "search",
					name: key,
					label: text(label, words.search),
					placeholder: control.placeholder ? filterTextIn(control.placeholder, language) : null,
					value: state.values.get(key) ?? "",
				});
				break;
			case "checkboxes":
			case "choice": {
				const picked = new Set(chosen(page, state).map((option) => option.slug));
				const needsCounts = control.counts || control.empty !== "show";
				const counts = needsCounts
					? await countsOf(scope, filter, page, state, loopPlace, postTypes, sql)
					: new Map<string, number>();
				// Each option with how many items it would list (which ordering by count needs even where it isn't shown).
				let listed = page.options.map((option) => {
					const count = counts.get(option.match) ?? 0;
					const checked = picked.has(option.slug);
					const view: FilterOptionView = {
						value: option.slug,
						label: option.label,
						count: control.counts ? count : null,
						checked,
						disabled: needsCounts && control.empty === "disable" && count === 0 && !checked,
					};
					return { view, count };
				});
				if (needsCounts && control.empty === "hide") {
					listed = listed.filter((option) => option.view.checked || option.count > 0);
				}
				if (control.order === "label") listed.sort((a, b) => a.view.label.localeCompare(b.view.label, language));
				if (control.order === "count") listed.sort((a, b) => b.count - a.count);
				const options = listed.map((option) => option.view);
				views.push(
					control.type === "checkboxes"
						? {
								type: "checkboxes",
								name: key,
								label: filterTextIn(control.label, language),
								options,
								showFirst: control.showFirst,
								showMore: words.showMore,
							}
						: {
								type: "choice",
								name: key,
								label: filterTextIn(control.label, language),
								display: control.display,
								allLabel: text(control.allLabel, words.all),
								options,
							},
				);
				break;
			}
			case "toggle":
				views.push({
					type: "toggle",
					name: key,
					label: filterTextIn(control.label, language),
					checked: state.values.has(key),
				});
				break;
			case "range": {
				const kind = page.field?.type === "date" ? "date" : "number";
				const value = state.values.get(key) ?? "";
				const [min, max] = rangeSides(kind, value);
				// Presets keep the page's other choices, as chips do; they count from the day the page is shown.
				const others = mine.filter(([other]) => other !== key);
				views.push({
					type: "range",
					name: key,
					label: filterTextIn(control.label, language),
					kind,
					minLabel: text(control.minLabel, words.from),
					maxLabel: text(control.maxLabel, words.to),
					min,
					max,
					slider: kind === "number" ? control.slider : null,
					presets:
						kind === "date"
							? control.presets.map((preset) => {
									const [from, to] = presetDays(preset, scope.now());
									return {
										label: words.presets[preset],
										href: href([...others, [key, `${from}..${to}`]]),
										from,
										to,
										current: value === `${from}..${to}`,
									};
								})
							: [],
				});
				break;
			}
			case "sort":
				views.push({
					type: "sort",
					name: key,
					label: text(label, words.sort),
					defaultLabel: text(control.defaultLabel, words.sortDefault),
					options: control.options.map((option) => ({
						value: option.value,
						label: filterTextIn(option.label, language),
						selected: state.values.get(key) === option.value,
					})),
				});
				break;
			case "chips":
				views.push({
					type: "chips",
					label: text(control.label, words.activeFilters),
					resetLabel: text(control.resetLabel, words.reset),
					resetHref: href([]),
					chips: chipsOf(filter, state, mine, language).map((chip) => ({
						label: chip.label,
						removeLabel: words.remove.replace("{label}", chip.label),
						href: href(chip.keep),
					})),
				});
				break;
			case "count":
				views.push({ type: "count", text: counted });
				break;
		}
	}
	const chips = filter.controls.find((page) => page.control.type === "chips")?.control;
	return {
		name: filter.name,
		action: place.path,
		mode: filter.version.mode,
		layout: filter.version.layout,
		phone: filter.version.phone,
		label: text(filter.version.label, words.filters),
		applyLabel: text(filter.version.applyLabel, words.apply),
		drawer: {
			close: words.close,
			reset: text(chips?.type === "chips" ? chips.resetLabel : null, words.reset),
			resetHref: href([]),
			show: words.show.replace(
				"{results}",
				total === 0 ? countText(0, language, countControl?.type === "count" ? countControl : null, "other") : counted,
			),
		},
		chosen: words.chosen,
		keep: others,
		choices: mine,
		controls: views,
		announce: counted,
	};
}

/**
 * How many items each of a control's options would list: the Loop's query narrowed by every other
 * control's choice (OR inside a control, so its own choice never zeroes its other options) or, for
 * checkboxes matching all their options, by its own choice too. Keyed by what each option matches.
 */
async function countsOf(
	scope: ReadScope,
	filter: PageFilter,
	page: PageControl,
	state: FilterState,
	place: LoopPlace,
	postTypes: readonly PostType[],
	sql: QuerySql,
): Promise<Map<string, number>> {
	const { control } = page;
	if (control.type !== "checkboxes" && control.type !== "choice") return new Map();
	const allOfThem = control.type === "checkboxes" && control.match === "all";
	const narrowing = narrowingOf(filter, state, sql, allOfThem ? undefined : page);
	const group: FacetGroup =
		control.source.kind === "postType"
			? { kind: "postType" }
			: page.field?.type === "relationship"
				? { kind: "relationship", field: control.source.field }
				: { kind: "select", field: control.source.field };
	return facetCounts(scope, filter.query, place, postTypes, narrowing, group);
}

/** How many items the Loop lists, in the count control's words (or WebCraft's) in the page's language. */
function countText(
	total: number,
	language: string,
	control: Extract<FilterControl, { type: "count" }> | null,
	/** `other` words the number even when it is 0 ("Show 0 products"), instead of the no-results words. */
	form?: "other",
): string {
	const words = filterWords(language);
	const pick = (value: FilterText | null | undefined, fallback: string) =>
		(value ? filterTextIn(value, language) : fallback).replaceAll("{count}", String(total));
	if (form === "other") return pick(control?.other, words.other);
	if (total === 0) return pick(control?.none, words.none);
	const one = new Intl.PluralRules(language).select(total) === "one";
	return one ? pick(control?.one, words.one.replace("1", "{count}")) : pick(control?.other, words.other);
}

/** The chips of a Filter's choices: what each says, and the choices left once it is removed. */
function chipsOf(
	filter: PageFilter,
	state: FilterState,
	mine: readonly (readonly [string, string])[],
	language: string,
): { label: string; keep: (readonly [string, string])[] }[] {
	const without = (key: string, value?: string) =>
		mine.flatMap(([other, current]): (readonly [string, string])[] => {
			if (other !== key) return [[other, current]];
			if (value === undefined) return [];
			const rest = current.split(",").filter((slug) => slug !== value);
			return rest.length > 0 ? [[other, rest.join(",")]] : [];
		});
	const chips: { label: string; keep: (readonly [string, string])[] }[] = [];
	for (const page of filter.controls) {
		const { control, key } = page;
		const value = state.values.get(key);
		if (value === undefined) continue;
		switch (control.type) {
			case "search":
				chips.push({ label: `“${value}”`, keep: without(key) });
				break;
			case "checkboxes":
				for (const option of chosen(page, state)) chips.push({ label: option.label, keep: without(key, option.slug) });
				break;
			case "choice":
				for (const option of chosen(page, state)) chips.push({ label: option.label, keep: without(key) });
				break;
			case "toggle":
				chips.push({ label: filterTextIn(control.label, language), keep: without(key) });
				break;
			case "range": {
				const kind = page.field?.type === "date" ? "date" : "number";
				const [from, to] = rangeSides(kind, value);
				const shown = from && to ? `${from}–${to}` : from ? `≥ ${from}` : `≤ ${to}`;
				chips.push({ label: `${filterTextIn(control.label, language)}: ${shown}`, keep: without(key) });
				break;
			}
		}
	}
	return chips;
}
