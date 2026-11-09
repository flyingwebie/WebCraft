import { filters, loops } from "@webcraft/db/schema";
import type { FilterCatalogue, FilterVersion } from "@webcraft/renderer";
import { asc, eq } from "drizzle-orm";
import { clientNameOf } from "../audit.ts";

import type { ContentProblem } from "../content/errors.ts";
import { sameJson } from "../content/json.ts";
import { storedLoopVersion } from "../content/loops.ts";
import { listPostTypes } from "../content/post-types.ts";
import type { Published } from "../content/publishing.ts";
import { isUniqueViolation } from "../db-errors.ts";
import { isUuid } from "../ids.ts";
import { personIdOf } from "../permissions/can.ts";
import type { SiteScope, VisitorScope } from "../tenancy/data-layer.ts";
import { checkFilterVersion, type FilterVersionInput, readFilterVersion, storedFilterVersion } from "./definition.ts";
import { FilterInvalidError, FilterNameTakenError, FilterNotFoundError } from "./errors.ts";

/**
 * Filters (GLOSSARY.md): the controls visitors use to narrow, search and sort the items of one query
 * Loop. A Filter is Structure (`structure.edit`, Staff only) with a Draft and a published version,
 * published as one item through `publish` with `{ kind: "filter", id }`. It narrows the query Loop
 * chosen when it is made (a Loop has at most one Filter), and Template markup places it as
 * `{{@filter <name> for="<loop>"}}`. Its labels and other words are kept in every language with it.
 */
export type Filter = {
	id: string;
	siteId: string;
	/** How Template markup names it: lower-case words joined by dashes, such as `shop`. It never changes. */
	name: string;
	/** The query Loop it narrows, by name. It never changes. */
	loop: string;
	status: "draft" | "published" | "changed";
	draft: FilterVersion;
	/** What visitors use; null until it is first published. */
	published: FilterVersion | null;
	createdAt: Date;
	updatedAt: Date;
	publishedAt: Date | null;
	lastPublishedAt: Date | null;
};

export type NewFilter = { name: string; loop: string } & FilterVersionInput;

/** A Filter's name: lower-case letters and digits in words joined by single dashes, at most 64 characters. */
const FILTER_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const FILTER_NAME_MAX_LENGTH = 64;

type FilterRow = typeof filters.$inferSelect;

/** Whether `name` can be a Filter's name. */
export function isFilterName(name: string): boolean {
	return FILTER_NAME.test(name) && name.length <= FILTER_NAME_MAX_LENGTH;
}

/**
 * Creates a Filter on the scope's Site (open it with `structure.edit`) for one of its query Loops,
 * optionally with its controls; it starts as a Draft. The Loop must be a query Loop without a Filter.
 */
export async function createFilter(scope: SiteScope, input: NewFilter): Promise<Filter> {
	const problems: ContentProblem[] = [];
	const name = typeof input.name === "string" ? input.name.trim() : "";
	if (!isFilterName(name)) {
		problems.push({
			at: "name",
			message:
				"A Filter's name is lower-case letters and digits in words joined by dashes (at most 64), starting with a letter, such as shop.",
		});
	}
	const { name: _, loop, ...version } = input;
	return scope.transaction(async (tx) => {
		const context = await loopContext(tx, loop, "draft", problems);
		const draft = context ? readFilterVersion(version, storedFilterVersion(null), context, problems) : null;
		if (problems.length > 0 || !draft) throw new FilterInvalidError(problems);
		if (await tx.first(filters, eq(filters.name, name))) throw new FilterNameTakenError(name);
		if (await tx.first(filters, eq(filters.loop, loop))) throw loopTaken(loop);
		const now = tx.now();
		let row: FilterRow;
		try {
			row = await tx.insert(filters, {
				name,
				loop,
				draft,
				createdAt: now,
				updatedAt: now,
				updatedBy: personIdOf(tx.access.actor),
				updatedVia: clientNameOf(tx.access.via),
			});
		} catch (error) {
			if (isUniqueViolation(error, "filters_site_id_name_unique")) throw new FilterNameTakenError(name);
			if (isUniqueViolation(error, "filters_site_id_loop_unique")) throw loopTaken(loop);
			throw error;
		}
		await tx.audit("filter.create", { filterId: row.id, name, loop });
		return toFilter(row);
	});
}

function loopTaken(loop: string): FilterInvalidError {
	return new FilterInvalidError([
		{ at: "loop", message: `The Loop ${loop} already has a Filter: a Loop has one Filter at most.` },
	]);
}

/**
 * What a Filter's controls are checked against: its query Loop's Post Types, in the Loop's Draft (for
 * a Draft) or its published version (for a publish). Reports a Loop that is missing, isn't a query
 * Loop or (for a publish) isn't published.
 */
async function loopContext(scope: SiteScope, loop: unknown, which: "draft" | "published", problems: ContentProblem[]) {
	if (typeof loop !== "string" || loop === "") {
		problems.push({ at: "loop", message: "A Filter narrows one query Loop of the Site, by name." });
		return undefined;
	}
	const row = await scope.first(loops, eq(loops.name, loop));
	if (!row) {
		problems.push({ at: "loop", message: `The Site has no Loop named ${loop}.` });
		return undefined;
	}
	const stored = which === "draft" ? row.draft : row.published;
	if (stored === null) {
		problems.push({ at: "loop", message: `The Loop ${loop} isn't published yet: publish it first.` });
		return undefined;
	}
	const version = storedLoopVersion(stored);
	if (version.source !== "query") {
		problems.push({
			at: "loop",
			message: `The Loop ${loop} lists its own Loop items: only a Loop with a query over Entries can be filtered.`,
		});
		return undefined;
	}
	return { query: version.query, postTypes: await listPostTypes(scope) };
}

/** The Filters of the scope's Site, by name. */
export async function listFilters(scope: SiteScope): Promise<Filter[]> {
	const rows = await scope.select(filters, undefined, { orderBy: [asc(filters.name)] });
	return rows.map(toFilter);
}

/** One Filter of the scope's Site. */
export async function getFilter(scope: SiteScope, filterId: string): Promise<Filter> {
	const row = isUuid(filterId) ? await scope.first(filters, eq(filters.id, filterId)) : undefined;
	if (!row) throw new FilterNotFoundError();
	return toFilter(row);
}

/**
 * Saves a change to a Filter's Draft (open the Site with `structure.edit`): its mode, words and
 * controls, each part given replacing that part, checked against its Loop's Draft. Visitors see
 * nothing of it until it is published.
 */
export async function saveFilterDraft(scope: SiteScope, filterId: string, change: FilterVersionInput): Promise<Filter> {
	return scope.transaction(async (tx) => {
		const row = await lockFilter(tx, filterId);
		const problems: ContentProblem[] = [];
		const context = await loopContext(tx, row.loop, "draft", problems);
		const draft = context
			? readFilterVersion(change, storedFilterVersion(row.draft), context, problems)
			: storedFilterVersion(row.draft);
		if (problems.length > 0) throw new FilterInvalidError(problems);
		const [saved] = await tx.update(
			filters,
			{ draft, updatedAt: tx.now(), updatedBy: personIdOf(tx.access.actor), updatedVia: clientNameOf(tx.access.via) },
			eq(filters.id, row.id),
		);
		return toFilter(saved ?? row);
	});
}

/**
 * Publishes a Filter's Draft, inside `publish`'s transaction: its Loop must be a published query Loop,
 * and every control must still fit the Loop's published Post Types (`FilterInvalidError`).
 */
export async function publishFilter(scope: SiteScope, filterId: string): Promise<Published> {
	const row = await lockFilter(scope, filterId);
	const draft = storedFilterVersion(row.draft);
	const problems: ContentProblem[] = [];
	const context = await loopContext(scope, row.loop, "published", problems);
	if (context) checkFilterVersion(draft, context, problems);
	if (problems.length > 0) throw new FilterInvalidError(problems);
	const now = scope.now();
	await scope.update(
		filters,
		{ published: draft, publishedAt: row.publishedAt ?? now, lastPublishedAt: now },
		eq(filters.id, row.id),
	);
	await scope.audit("filter.publish", { filterId: row.id, name: row.name, loop: row.loop });
	return { kind: "filter", id: row.id, publishedAt: now, pathChanges: [] };
}

/** Reads a Filter for a change or a publish, holding it until the transaction ends. */
async function lockFilter(scope: SiteScope, filterId: string): Promise<FilterRow> {
	const [row] = isUuid(filterId)
		? await scope.db
				.select()
				.from(filters)
				.where(scope.where(filters, eq(filters.id, filterId)))
				.for("update")
		: [];
	if (!row) throw new FilterNotFoundError();
	return row;
}

function toFilter(row: FilterRow): Filter {
	return {
		id: row.id,
		siteId: row.siteId,
		name: row.name,
		loop: row.loop,
		status: row.published === null ? "draft" : sameJson(row.draft, row.published) ? "published" : "changed",
		draft: storedFilterVersion(row.draft),
		published: row.published === null ? null : storedFilterVersion(row.published),
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		publishedAt: row.publishedAt,
		lastPublishedAt: row.lastPublishedAt,
	};
}

/** The Site's Filters in one version, for reading, checking, printing and rendering trees that place them. */
export type SiteFilters = FilterCatalogue & {
	/** The name of a Filter of the Site, as `{{@filter <name>}}` writes it. */
	nameOf(filterId: string): string | undefined;
	/** The version a placed Filter shows; undefined for one never published (in a published tree). */
	version(filterId: string): FilterVersion | undefined;
};

/**
 * The Site's Filters in one version: Drafts (what Drafts of Templates and Components place) or
 * published (what published ones place; a Filter never published can't be placed there yet).
 */
export async function siteFilters(
	scope: Pick<SiteScope | VisitorScope, "select">,
	which: "draft" | "published",
): Promise<SiteFilters> {
	const rows = await scope.select(filters);
	const byId = new Map(rows.map((row) => [row.id, row]));
	const byName = new Map(rows.map((row) => [row.name, row]));
	const versionOf = (row: FilterRow | undefined): FilterVersion | undefined => {
		if (!row) return undefined;
		const stored = which === "draft" ? row.draft : row.published;
		return stored === null ? undefined : storedFilterVersion(stored);
	};
	const found = (row: FilterRow | undefined) => {
		if (!row) return undefined;
		if (!versionOf(row)) return { refused: `The Filter ${row.name} isn't published yet: publish it first.` };
		return { id: row.id, name: row.name, loop: row.loop };
	};
	return {
		named: (name) => found(byName.get(name)),
		byId: (filterId) => found(byId.get(filterId)),
		nameOf: (filterId) => byId.get(filterId)?.name,
		version: (filterId) => versionOf(byId.get(filterId)),
	};
}

/** Filters are refused in a tree that can't name the Site's Filters, such as a Module's Component. */
export const NO_FILTERS: FilterCatalogue = {
	named: () => ({ refused: "Filters belong to one Site: a Module's Component can't place one." }),
	byId: () => ({ refused: "Filters belong to one Site: a Module's Component can't place one." }),
};
