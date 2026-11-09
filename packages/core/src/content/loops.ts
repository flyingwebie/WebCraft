import { loops } from "@webcraft/db/schema";
import { EXPRESSION_KEYWORDS, type LoopCatalogue, type LoopInfo, SEARCH_LOOP } from "@webcraft/renderer";
import { asc, eq, sql } from "drizzle-orm";

import { isUniqueViolation } from "../db-errors.ts";
import { noteDraftChange } from "../history/checkpoints.ts";
import { isUuid } from "../ids.ts";
import { actingPerson, personIdOf } from "../permissions/can.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import {
	type ContentProblem,
	LoopIncompleteError,
	LoopInvalidError,
	LoopNameTakenError,
	LoopNotFoundError,
} from "./errors.ts";
import type { FieldDefinition, FieldInput, Json, RepeaterField } from "./field-types.ts";
import {
	checkFields,
	type Findings,
	findingsInEveryLanguage,
	type Languages,
	randomRowId,
	readFields,
	type StoredValues,
	writeFields,
} from "./field-values.ts";
import { BUILT_IN_FIELDS, parseFields, storedFields } from "./fields.ts";
import { sameJson } from "./json.ts";
import { languagesFor, siteLanguages } from "./languages.ts";
import { type LoopQuery, parseQuery, storedQuery } from "./loop-queries.ts";
import { listPostTypes } from "./post-types.ts";
import type { Published } from "./publishing.ts";
import { loopItemKnownValues } from "./render-values.ts";

/**
 * Loops (GLOSSARY.md): repeated parts of a Site that render the same markup once per item, placed
 * in Templates and Components by name (`{{@loop latest-posts as post}} … {{@empty}} … {{/loop}}`).
 * A Loop is Structure (`structure.edit`) with a Draft and a published version, published as one item.
 * Its items come from a query over Entries (`loop-queries.ts`) or from its own Loop items, whose
 * Fields Staff define and whose values are kept per language like a Repeater's rows (ADR 0003).
 * A Repeater or Relationship on the current Entry is looped over by its name in markup, with no
 * Loop of its own (`{{@loop gallery as photo}}`).
 */
export type Loop = {
	id: string;
	siteId: string;
	/** How Template markup names it: lower-case words joined by dashes, such as `latest-posts`. */
	name: string;
	status: "draft" | "published" | "changed";
	/** The language the Loop items' values are in. */
	language: string;
	draft: LoopVersionView;
	/** What visitors see; null until it is first published. */
	published: LoopVersionView | null;
	/** What keeps the Draft's Loop items from being published, by path (`items[0].day`), with the rule. */
	problems: ContentProblem[];
	createdAt: Date;
	updatedAt: Date;
	publishedAt: Date | null;
	lastPublishedAt: Date | null;
};

/** Where a Loop's items come from: a query over Entries, or its own Loop items. */
export type LoopSource = "query" | "items";

/** One version of a Loop as the API gives it, its Loop items read in one language. */
export type LoopVersionView = {
	source: LoopSource;
	query: LoopQuery;
	/** The Loop items' Fields, in order. */
	fields: FieldDefinition[];
	/** The Loop items, in order, each `{ id, …its Fields' values }`. */
	items: Record<string, Json>[];
};

/** A Loop version as stored: its Loop items' values under `values.items`, as a Repeater's rows. */
export type StoredLoopVersion = {
	source: LoopSource;
	query: LoopQuery;
	fields: FieldDefinition[];
	values: StoredValues;
};

export type NewLoop = { name: string; source: LoopSource; query?: unknown; fields?: FieldInput[] };

/** A change to a Loop's Draft: each part given replaces that part. */
export type LoopDraftChange = { source?: LoopSource; query?: unknown; fields?: FieldInput[] };

/** A change to a Loop's items, in one language (the Default language unless given): the whole list, as a Repeater's rows. */
export type LoopItemsChange = { language?: string; items: unknown[] };

/** How many Loop items a Loop holds at most. */
export const LOOP_ITEMS_MAX = 200;

/** A Loop's name: lower-case letters and digits in words joined by single dashes, at most 64 characters. */
const LOOP_NAME = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const LOOP_NAME_MAX_LENGTH = 64;

/**
 * Names a Loop can't take: what bindings read from (`site`, `props`, `item`, `loop`, a built-in
 * Field) and the words Conditions use, so `{{@loop name}}` and `name.count` never mean two things.
 */
const RESERVED_LOOP_NAMES: ReadonlySet<string> = new Set([
	...BUILT_IN_FIELDS.map((field) => field.toLowerCase()),
	...EXPRESSION_KEYWORDS,
	"site",
	"props",
	"item",
	"loop",
	"url",
	"id",
	// Site search's built-in Loop, on the search results page (ADR 0021).
	SEARCH_LOOP,
]);

/** Keys a Loop item's Field can't take: an item's `id`, and the words Conditions use. */
const RESERVED_ITEM_KEYS: ReadonlySet<string> = new Set(["id", ...EXPRESSION_KEYWORDS]);

type LoopRow = typeof loops.$inferSelect;

/** Whether `name` can be a Loop's name. */
export function isLoopName(name: string): boolean {
	return LOOP_NAME.test(name) && name.length <= LOOP_NAME_MAX_LENGTH && !RESERVED_LOOP_NAMES.has(name);
}

/** The field the Loop items' values are kept under in a version: a Repeater of the Loop's Fields. */
export function itemsField(fields: readonly FieldDefinition[]): RepeaterField {
	return {
		key: "items",
		label: "Loop items",
		type: "repeater",
		help: "",
		required: false,
		translatable: false,
		default: null,
		fields: [...fields],
		min: null,
		max: null,
	};
}

/**
 * Creates a Loop on the scope's Site (open it with `structure.edit`): its name, where its items come
 * from and, for Loop items, their Fields. It starts as a Draft with no items.
 */
export async function createLoop(scope: SiteScope, input: NewLoop): Promise<Loop> {
	const problems: ContentProblem[] = [];
	const name = input.name.trim();
	if (!isLoopName(name)) {
		problems.push({
			at: "name",
			message:
				"A Loop's name is lower-case letters and digits in words joined by dashes (at most 64), starting with a letter, such as latest-posts; it can't be a name bindings read from.",
		});
	}
	const draft = await nextVersion(scope, emptyVersion(input.source), input, problems);
	if (problems.length > 0) throw new LoopInvalidError(problems);
	try {
		return await scope.transaction(async (tx) => {
			if (await tx.first(loops, eq(loops.name, name))) throw new LoopNameTakenError(name);
			const now = tx.now();
			const row = await tx.insert(loops, {
				name,
				draft,
				createdAt: now,
				updatedAt: now,
				updatedBy: personIdOf(tx.access.actor),
			});
			await tx.audit("loop.create", { loopId: row.id, name });
			return toLoop(row, await defaultLanguages(tx));
		});
	} catch (error) {
		if (isUniqueViolation(error, "loops_site_id_name_unique")) throw new LoopNameTakenError(name);
		throw error;
	}
}

/** The Loops of the scope's Site, by name. */
export async function listLoops(scope: SiteScope): Promise<Loop[]> {
	const languages = await defaultLanguages(scope);
	const rows = await scope.select(loops, undefined, { orderBy: [asc(loops.name)] });
	return rows.map((row) => toLoop(row, languages));
}

/** One Loop of the scope's Site, its Loop items in `language` (the Default language unless given). */
export async function getLoop(scope: SiteScope, loopId: string, language?: string): Promise<Loop> {
	const languages = await loopLanguages(scope, language);
	const row = isUuid(loopId) ? await scope.first(loops, eq(loops.id, loopId)) : undefined;
	if (!row) throw new LoopNotFoundError();
	return toLoop(row, languages);
}

/**
 * Saves a change to a Loop's Draft (open the Site with `structure.edit`): where its items come from,
 * its query, its Loop items' Fields (the full list; a Field keeps its type). Visitors see nothing of
 * it until it is published.
 */
export async function saveLoopDraft(scope: SiteScope, loopId: string, change: LoopDraftChange): Promise<Loop> {
	return scope.transaction(async (tx) => {
		const row = await lockLoop(tx, loopId);
		const problems: ContentProblem[] = [];
		const draft = await nextVersion(tx, storedLoopVersion(row.draft), change, problems);
		if (problems.length > 0) throw new LoopInvalidError(problems);
		const [saved] = await tx.update(
			loops,
			{ draft, updatedAt: tx.now(), updatedBy: personIdOf(tx.access.actor) },
			eq(loops.id, row.id),
		);
		await noteLoopChange(tx, row, draft);
		return toLoop(saved ?? row, await defaultLanguages(tx));
	});
}

/**
 * Saves a Loop's items in its Draft, in one language: the whole list, in order, as a Repeater's rows
 * (an item with an `id` it had keeps its values in other languages; one without is new). Loop items
 * are Content: open the Site with `entry.edit`. Values of the wrong kind are refused; broken rules
 * are kept and listed in `problems`.
 */
export async function saveLoopItems(scope: SiteScope, loopId: string, change: LoopItemsChange): Promise<Loop> {
	return scope.transaction(async (tx) => {
		const languages = await loopLanguages(tx, change.language);
		const row = await lockLoop(tx, loopId);
		const draft = storedLoopVersion(row.draft);
		if (change.items.length > LOOP_ITEMS_MAX) {
			throw new LoopInvalidError([{ at: "items", message: `A Loop holds at most ${LOOP_ITEMS_MAX} Loop items.` }]);
		}
		const problems: ContentProblem[] = [];
		const values = writeFields(
			draft.values,
			[itemsField(draft.fields)],
			{ items: change.items },
			{
				...languages,
				by: { kind: "person", personId: actingPerson(tx.access.actor) },
				problems,
				references: [],
				newRowId: randomRowId,
			},
			"",
			"The Loop",
		);
		if (problems.length > 0) throw new LoopInvalidError(problems);
		const [saved] = await tx.update(
			loops,
			{ draft: { ...draft, values }, updatedAt: tx.now(), updatedBy: personIdOf(tx.access.actor) },
			eq(loops.id, row.id),
		);
		await noteLoopChange(tx, row, { ...draft, values });
		return toLoop(saved ?? row, languages);
	});
}

/** Notes a change to a Loop's Draft for its history: who changed what, and Checkpoints. */
async function noteLoopChange(scope: SiteScope, row: LoopRow, draft: unknown): Promise<void> {
	await noteDraftChange(
		scope,
		{ kind: "loop", id: row.id },
		{ content: row.draft, changedAt: row.updatedAt, changedBy: row.updatedBy },
		draft,
	);
}

/**
 * Publishes a Loop's Draft, inside `publish`'s transaction: its query must still fit the Site's Post
 * Types (`LoopInvalidError`), a query Loop must list at least one Post Type, and its Loop items must
 * keep their Fields' rules in every language (`LoopInvalidError`, `LoopIncompleteError`).
 */
export async function publishLoop(scope: SiteScope, loopId: string): Promise<Published> {
	const row = await lockLoop(scope, loopId);
	const draft = storedLoopVersion(row.draft);
	const problems: ContentProblem[] = [];
	const postTypes = await listPostTypes(scope);
	const query = parseQuery(draft.query, postTypes, problems);
	if (draft.source === "query" && query.postTypes.length === 0) {
		problems.push({ at: "query.postTypes", message: "A query Loop lists the Entries of at least one Post Type." });
	}
	if (problems.length > 0) throw new LoopInvalidError(problems);
	const site = await siteLanguages(scope);
	const findings = findingsInEveryLanguage(site.languages, site.defaultLanguage, (languages) =>
		itemFindings(draft, languages),
	);
	if (findings.problems.some((problem) => problem.rule !== "required")) throw new LoopInvalidError(findings.problems);
	if (findings.missing.length > 0) throw new LoopIncompleteError(findings.missing);
	const published: StoredLoopVersion = { ...draft, query };
	const now = scope.now();
	await scope.update(
		loops,
		{ draft: published, published, publishedAt: row.publishedAt ?? now, lastPublishedAt: now },
		eq(loops.id, row.id),
	);
	await scope.audit("loop.publish", { loopId: row.id, name: row.name });
	return { kind: "loop", id: row.id, publishedAt: now, pathChanges: [] };
}

/** Reads a Loop for a change or a publish, holding it until the transaction ends. */
export async function lockLoop(scope: SiteScope, loopId: string): Promise<LoopRow> {
	const [row] = isUuid(loopId)
		? await scope.db
				.select()
				.from(loops)
				.where(scope.where(loops, eq(loops.id, loopId)))
				.for("update")
		: [];
	if (!row) throw new LoopNotFoundError();
	return row;
}

/** Reads a stored Loop version; anything missing takes its default. */
export function storedLoopVersion(value: unknown): StoredLoopVersion {
	const raw = (value ?? {}) as Partial<StoredLoopVersion>;
	return {
		source: raw.source === "items" ? "items" : "query",
		query: storedQuery(raw.query),
		fields: storedFields(raw.fields),
		values: raw.values && typeof raw.values === "object" && !Array.isArray(raw.values) ? raw.values : {},
	};
}

/** A Loop version's items read in a language: `{ id, …values }` each. */
export function loopItems(version: StoredLoopVersion, languages: Languages): Record<string, Json>[] {
	const read = readFields(version.values, [itemsField(version.fields)], languages).items;
	return Array.isArray(read) ? (read as Record<string, Json>[]) : [];
}

function emptyVersion(source: LoopSource): StoredLoopVersion {
	return { source, query: parseQuery({}, [], []), fields: [], values: {} };
}

async function nextVersion(
	scope: SiteScope,
	current: StoredLoopVersion,
	change: LoopDraftChange,
	problems: ContentProblem[],
): Promise<StoredLoopVersion> {
	const next = { ...current };
	if (change.source !== undefined) {
		if (change.source === "query" || change.source === "items") next.source = change.source;
		else problems.push({ at: "source", message: "A Loop's items come from a query or from its own Loop items." });
	}
	const postTypes = await listPostTypes(scope);
	if (change.query !== undefined) next.query = parseQuery(change.query, postTypes, problems);
	if (change.fields !== undefined) {
		next.fields = parseFields(
			change.fields,
			problems,
			{
				postTypeKeys: new Set(postTypes.map((postType) => postType.key)),
				owner: "loop",
				reservedKeys: RESERVED_ITEM_KEYS,
			},
			current.fields,
		);
	}
	return next;
}

function itemFindings(version: StoredLoopVersion, languages: Languages): Findings {
	const findings: Findings = { problems: [], missing: [], references: [] };
	checkFields(version.values, [itemsField(version.fields)], languages, findings, "");
	return findings;
}

async function defaultLanguages(scope: Pick<SiteScope, "db" | "site">): Promise<Languages> {
	return loopLanguages(scope);
}

/** The Site's language `language` names (the Default language when absent); `LoopInvalidError` for one it doesn't have. */
async function loopLanguages(scope: Pick<SiteScope, "db" | "site">, language?: string): Promise<Languages> {
	const languages = languagesFor(await siteLanguages(scope), language);
	if (!languages) throw new LoopInvalidError([{ at: "language", message: `The Site has no language ${language}.` }]);
	return languages;
}

function viewOf(version: StoredLoopVersion, languages: Languages): LoopVersionView {
	return { source: version.source, query: version.query, fields: version.fields, items: loopItems(version, languages) };
}

export function toLoop(row: LoopRow, languages: Languages): Loop {
	const draft = storedLoopVersion(row.draft);
	return {
		id: row.id,
		siteId: row.siteId,
		name: row.name,
		status: row.published === null ? "draft" : sameJson(row.draft, row.published) ? "published" : "changed",
		language: languages.language,
		draft: viewOf(draft, languages),
		published: row.published === null ? null : viewOf(storedLoopVersion(row.published), languages),
		problems: itemFindings(draft, languages).problems,
		createdAt: row.createdAt,
		updatedAt: row.updatedAt,
		publishedAt: row.publishedAt,
		lastPublishedAt: row.lastPublishedAt,
	};
}

/** Every published Loop of the Site, by name: what pages render. */
export async function publishedLoops(
	scope: Pick<SiteScope, "select">,
): Promise<Map<string, { id: string; version: StoredLoopVersion }>> {
	const rows = await scope.select(loops, sql`${loops.published} is not null`);
	return new Map(rows.map((row) => [row.name, { id: row.id, version: storedLoopVersion(row.published) }]));
}

/** Every Loop of the Site by name, in its Draft or its published version (null while unpublished). */
export async function siteLoops(
	scope: Pick<SiteScope, "select">,
	version: "draft" | "published",
): Promise<Map<string, StoredLoopVersion | null>> {
	const rows = await scope.select(loops);
	return new Map(
		rows.map((row) => [
			row.name,
			version === "draft"
				? storedLoopVersion(row.draft)
				: row.published === null
					? null
					: storedLoopVersion(row.published),
		]),
	);
}

/**
 * The Loops of the Site a tree may name, with what their items may be read as: their Drafts for a
 * Draft being saved, their published versions for a publish (a Loop never published is refused
 * there, as a Component is).
 */
export async function loopCatalogue(
	scope: Pick<SiteScope, "select">,
	version: "draft" | "published",
): Promise<LoopCatalogue> {
	const found = await siteLoops(scope, version);
	const postTypes = await listPostTypes(scope);
	const infos = new Map<string, LoopInfo | { refused: string }>();
	for (const [name, loop] of found) {
		infos.set(
			name,
			loop === null
				? { refused: `The Loop ${name} isn't published yet: publish it first.` }
				: {
						isKnownValue: loopItemKnownValues({
							source: loop.source,
							listed: loop.query.postTypes,
							fields: loop.fields,
							postTypes,
						}),
					},
		);
	}
	return { byName: (name) => infos.get(name) };
}
