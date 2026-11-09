/**
 * The Import pipeline: what a run (and the preview before it) does with each item a source reads.
 *
 * 1. **Decide** where the item goes: an Entry this Import brought in before (by its Source id), else
 *    an existing Entry of the Post Type matching its value (one; several is a problem), else a new
 *    Entry. An Entry this Import brought in that someone edited since (any Draft save by a person, or
 *    a later change by another run) is skipped, never overwritten.
 * 2. **Find** what its values point at: Entries by slug or title, files already in the Media library,
 *    and files to fetch by their `https` address (Import from URL, through the guarded fetcher).
 * 3. **Write** it as a Draft, with the person who started the run as its writer, recording its Source
 *    id and what the run left, so a later run (and Undo) can tell whether anyone touched it since.
 */
import { entries, importItems, importRunChanges, importRunProblems, importRuns, media } from "@webcraft/db/schema";
import type { SourceFileRef } from "@webcraft/module-sdk";
import { and, eq, inArray, isNull, type SQL, sql } from "drizzle-orm";
import { createEntry, lockEntry, saveDraft } from "../content/entries.ts";
import { EntryInvalidError, EntryNotFoundError, EntrySlugTakenError } from "../content/errors.ts";
import type { Json } from "../content/field-types.ts";
import { listPostTypes } from "../content/post-types.ts";
import {
	MediaImportRefusedError,
	MediaQuotaFullError,
	MediaTooLargeError,
	MediaTypeRefusedError,
} from "../media/index.ts";
import type { MediaLibrary } from "../media/library.ts";
import { MEDIA_TEXT_MAX_LENGTH, readText, storedTexts } from "../media/texts.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { matchKey, setAt } from "./csv-source.ts";
import type { EntryItem, ItemDestination, ItemProblem } from "./items.ts";

type ItemRow = typeof importItems.$inferSelect;

/** An Entry as a run last saw it: a hash of its Draft and when the Draft was saved. */
type EntryState = { hash: string; updatedAt: Date };

/** What a run (or a preview) knows about the Site while it goes through the items. */
export type PipelineContext = {
	scope: SiteScope;
	importId: string | null;
	/** Where the source's items go, unless an item names its own destination (a CSV file's one Post Type). */
	mapping: ItemDestination | null;
	/** Existing Entries of the Post Type by their matching value (from their Drafts). */
	index: Map<string, string[]>;
	/**
	 * The Import's items by Post Type and Source id (`itemKey`), and by Entry: a Source id is looked up
	 * within the Post Type its item goes to, so an item whose type now goes elsewhere comes in anew.
	 */
	items: Map<string, ItemRow>;
	itemsByEntry: Map<string, ItemRow>;
	/** The Import's files fetched before, by address. */
	files: Map<string, ItemRow>;
	/** The state of the Entries the Import brought in. */
	states: Map<string, EntryState>;
	/** Matching values met so far in this source, with the item they were first met in. */
	seen: Map<string, number>;
	/** Entries found by slug or title so far, by Post Types and name. */
	found: Map<string, string[]>;
	/** The Site's Post Types' ids by key. */
	postTypeIds: Map<string, string>;
	/** The language a source's items are written in (a CSV file's is its destination's). */
	languages?: { language: string; defaultLanguage: string };
};

/** Where an item goes. */
export type Decision =
	| { kind: "create" }
	| { kind: "update"; entryId: string }
	| { kind: "skip"; entryId: string; reason: "edited" }
	| { kind: "problem" };

/** Where the Import keeps an Entry it brought in: its Post Type and Source id. */
export function itemKey(postTypeId: string | null, sourceId: string): string {
	return `${postTypeId ?? ""}\n${sourceId}`;
}

/** Reads what a run needs to know about the Site before it goes through the items. */
export async function pipelineContext(
	scope: SiteScope,
	importId: string | null,
	mapping: ItemDestination | null,
): Promise<PipelineContext> {
	const index = new Map<string, string[]>();
	if (mapping?.match) {
		const path = matchPath(mapping.match.to);
		const rows = await scope.db
			.select({ id: entries.id, values: sql<unknown>`${entries.draft} #> ${path}` })
			.from(entries)
			.where(scope.where(entries, eq(entries.postTypeId, mapping.postType.id)));
		for (const row of rows) {
			const value = valueIn(row.values, mapping.languages);
			if (value === null || value === "") continue;
			const key = matchKey(value);
			index.set(key, [...(index.get(key) ?? []), row.id]);
		}
	}
	const items = new Map<string, ItemRow>();
	const itemsByEntry = new Map<string, ItemRow>();
	const files = new Map<string, ItemRow>();
	const states = new Map<string, EntryState>();
	if (importId) {
		for (const item of await scope.select(importItems, eq(importItems.importId, importId))) {
			if (item.kind === "media") files.set(item.sourceId, item);
			else {
				items.set(itemKey(item.postTypeId, item.sourceId), item);
				if (item.entryId) itemsByEntry.set(item.entryId, item);
			}
		}
		for (const state of await entryStates(scope, [...itemsByEntry.keys()])) states.set(state.id, state);
	}
	const postTypeIds = new Map((await listPostTypes(scope)).map((postType) => [postType.key, postType.id]));
	return {
		scope,
		importId,
		mapping,
		index,
		items,
		itemsByEntry,
		files,
		states,
		seen: new Map(),
		found: new Map(),
		postTypeIds,
	};
}

/** Where an item goes: its own destination, or the source's. */
export function destinationOf(context: PipelineContext, item: EntryItem): ItemDestination {
	const destination = item.destination ?? context.mapping;
	if (!destination) throw new TypeError("An Import item has nowhere to go.");
	return destination;
}

/**
 * Where an item goes; row problems it meets are added to the item. An item matches the Entry this
 * Import brought in with its Source id, in the Post Type it goes to; a CSV row also matches an Entry
 * of the Post Type whose Draft has its matching value.
 */
export function decide(context: PipelineContext, item: EntryItem): Decision {
	if (item.problems.some((problem) => problem.row) || !item.sourceId) return { kind: "problem" };
	const destination = destinationOf(context, item);
	if (!item.match && destination.match) return { kind: "problem" };
	const key = item.match ? matchKey(item.match.value) : `source:${itemKey(destination.postType.id, item.sourceId)}`;
	const first = context.seen.get(key);
	if (first !== undefined) {
		item.problems.push({ column: null, rule: "matchedTwice", params: { row: first }, row: true });
		return { kind: "problem" };
	}
	context.seen.set(key, item.position);
	let entryId = context.items.get(itemKey(destination.postType.id, item.sourceId))?.entryId ?? undefined;
	if (!entryId && item.match) {
		const matching = context.index.get(key) ?? [];
		if (matching.length > 1) {
			item.problems.push({ column: null, rule: "matchesSeveral", params: { count: matching.length }, row: true });
			return { kind: "problem" };
		}
		entryId = matching[0];
	}
	if (!entryId) {
		const { language, defaultLanguage } = destination.languages;
		if (language !== defaultLanguage) {
			item.problems.push({ column: null, rule: "translationWithoutEntry", row: true });
			return { kind: "problem" };
		}
		return { kind: "create" };
	}
	const tracked = context.itemsByEntry.get(entryId);
	const state = context.states.get(entryId);
	if (tracked && state && touched(state, tracked)) return { kind: "skip", entryId, reason: "edited" };
	return { kind: "update", entryId };
}

/** Whether an Entry changed since a run left it as `written` says. */
export function touched(state: EntryState, written: { writtenHash: string | null; writtenAt: Date | null }): boolean {
	return state.hash !== written.writtenHash || state.updatedAt.getTime() !== written.writtenAt?.getTime();
}

/**
 * Finds what an item's values point at: Entries by slug or title, or by the Source id this Import
 * gave them (in the Relationship's Post Types), and Media library files by id. Files given by address
 * are fetched only when `fetchFiles` is given (a run; the preview only counts them). Whatever can't be
 * found is a problem at its column, its value left out.
 */
export async function resolveFinds(
	context: PipelineContext,
	item: EntryItem,
	fetchFiles?: (
		address: string,
		ref?: SourceFileRef,
	) => Promise<{ mediaId: string } | { problem: ItemProblem["params"] }>,
): Promise<{ files: number }> {
	let files = 0;
	for (const find of item.finds) {
		const { reading, field, column } = find;
		const put = (value: Json) => (find.apply ? find.apply(value) : setAt(item.values.fields, find.path, value));
		if ("entries" in reading || "sources" in reading) {
			const postTypes = field.type === "relationship" ? field.postTypes : [];
			const ids: string[] = [];
			let failed = false;
			const names = "entries" in reading ? reading.entries : reading.sources;
			for (const name of names) {
				const matching =
					"entries" in reading
						? await entriesNamed(context, postTypes, name)
						: entriesBrought(context, postTypes, name);
				if (matching.length !== 1) {
					item.problems.push({
						column,
						rule: matching.length === 0 ? "entryNotFound" : "entryAmbiguous",
						params: { name },
					});
					failed = true;
					if ("entries" in reading) break;
					continue;
				}
				ids.push(matching[0] as string);
			}
			if ("sources" in reading ? ids.length > 0 : !failed) {
				put(field.type === "relationship" && field.multiple ? ids : (ids[0] ?? null));
			}
		} else if ("media" in reading) {
			const found = await context.scope.first(
				media,
				and(eq(media.id, reading.media.toLowerCase()), isNull(media.trashedAt)),
			);
			if (found) put(found.id);
			else item.problems.push({ column, rule: "mediaNotFound" });
		} else {
			files++;
			if (!fetchFiles) continue;
			const fetched = await fetchFiles(reading.file, reading.ref);
			if ("mediaId" in fetched) put(fetched.mediaId);
			else {
				item.problems.push({
					column,
					rule: "notFetched",
					params: { ...(fetched.problem ?? {}), address: reading.file.slice(0, 300) },
				});
			}
		}
	}
	return { files };
}

/**
 * The Entries this Import brought in with a Source id, in one of `postTypes` (keys): the items a
 * source's item points at (the terms of a post).
 */
function entriesBrought(context: PipelineContext, postTypes: readonly string[], sourceId: string): string[] {
	const found: string[] = [];
	for (const key of postTypes) {
		const id = context.postTypeIds.get(key);
		const entryId = id ? context.items.get(itemKey(id, sourceId))?.entryId : null;
		if (entryId) found.push(entryId);
	}
	return found;
}

/** How many slugs a source's item tries (`-2`, `-3`, …) when its own is taken. */
const MAX_SLUG_TRIES = 50;

/** What writing an item did. */
export type Outcome = "created" | "updated" | "unchanged" | "skipped" | "problem";

/** Thrown inside a row's transaction when its write changed nothing: nothing of it is saved. */
class Unchanged extends Error {}

/**
 * Writes an item as a Draft for a run (inside one transaction with what it records), or records why
 * it wasn't. A write the content store refuses (a slug another Entry has, a value of the wrong kind)
 * is a row problem.
 */
export async function writeItem(
	context: PipelineContext,
	runId: string,
	item: EntryItem,
	decision: Decision,
): Promise<Outcome> {
	const { scope } = context;
	const destination = destinationOf(context, item);
	const language = destination.languages.language;
	if (decision.kind === "problem") return "problem";
	if (decision.kind === "skip") {
		await scope.insert(importRunChanges, {
			runId,
			position: item.position,
			kind: "entry",
			action: "skipped",
			reason: decision.reason,
			entryId: decision.entryId,
		});
		return "skipped";
	}
	try {
		return await scope.transaction(async (tx) => {
			let entryId: string;
			let before: unknown = null;
			if (decision.kind === "create") {
				const { title = "", slug, fields, seo, parentId } = item.values;
				const entry = await createEntry(tx, {
					postTypeId: destination.postType.id,
					language,
					title,
					...(slug ? { slug } : {}),
					...(seo ? { seo } : {}),
					...(parentId ? { parentId } : {}),
					fields,
				});
				entryId = entry.id;
			} else {
				const row = await lockEntry(tx, decision.entryId);
				before = row.draft;
				await saveDraft(tx, decision.entryId, { language, ...item.values });
				entryId = decision.entryId;
			}
			const [state] = await entryStates(tx, [entryId]);
			const [after] = await tx.select(entries, eq(entries.id, entryId));
			if (!state || !after) throw new Unchanged();
			if (decision.kind === "update" && JSON.stringify(after.draft) === JSON.stringify(before)) throw new Unchanged();
			const sourceId = item.sourceId as string;
			const postTypeId = destination.postType.id;
			const existing = context.items.get(itemKey(postTypeId, sourceId)) ?? context.itemsByEntry.get(entryId);
			const written = { writtenHash: state.hash, writtenAt: state.updatedAt, lastRunId: runId, postTypeId };
			let saved: ItemRow;
			if (existing) {
				[saved] = (await tx.update(
					importItems,
					{ ...written, sourceId, entryId },
					eq(importItems.id, existing.id),
				)) as [ItemRow];
			} else {
				saved = await tx.insert(importItems, {
					importId: context.importId as string,
					kind: "entry",
					sourceId,
					entryId,
					...written,
				});
			}
			await tx.insert(importRunChanges, {
				runId,
				position: item.position,
				kind: "entry",
				action: decision.kind === "create" ? "created" : "updated",
				entryId,
				before: decision.kind === "update" ? before : null,
				writtenHash: state.hash,
				writtenAt: state.updatedAt,
				publishedThen: after.lastPublishedAt,
			});
			remember(context, saved, state);
			return decision.kind === "create" ? "created" : "updated";
		});
	} catch (error) {
		if (error instanceof Unchanged) {
			await scope.insert(importRunChanges, {
				runId,
				position: item.position,
				kind: "entry",
				action: "unchanged",
				entryId: decision.kind === "update" ? decision.entryId : null,
			});
			return "unchanged";
		}
		if (error instanceof EntrySlugTakenError) {
			// A source's own slug another Entry has: the new Entry takes the next free one, and the report says so.
			const slug = item.values.slug;
			if (item.freeSlug && decision.kind === "create" && slug) {
				const [, base = slug, number = "1"] = /^(.*?)(?:-(\d+))?$/.exec(slug) ?? [];
				const next = Number(number) + 1;
				if (next <= MAX_SLUG_TRIES) {
					if (!item.problems.some((problem) => problem.rule === "slugChanged")) {
						item.problems.push({ column: "slug", rule: "slugChanged", params: { slug: item.freeSlug.from } });
					}
					item.values.slug = `${base}-${next}`;
					return writeItem(context, runId, item, decision);
				}
			}
			item.problems.push({ column: null, rule: "slugTaken", params: { slug: error.slug }, row: true });
			return "problem";
		}
		// A value the content store refused, or an Entry deleted since the row was matched to it.
		if (error instanceof EntryInvalidError || error instanceof EntryNotFoundError) {
			item.problems.push({ column: null, rule: "refused", params: { message: error.message }, row: true });
			return "problem";
		}
		throw error;
	}
}

/** Keeps what the run just wrote, so later items of the same run see it. */
function remember(context: PipelineContext, item: ItemRow, state: EntryState): void {
	context.items.set(itemKey(item.postTypeId, item.sourceId), item);
	if (item.entryId) {
		context.itemsByEntry.set(item.entryId, item);
		context.states.set(item.entryId, state);
	}
}

/**
 * Fetches a file into the Media library for a run (Import from URL, through the guarded fetcher), or
 * finds the one this Import fetched before from the same address. Recorded as the run's, so Undo
 * puts it in the Trash with the run.
 */
export async function fetchFile(
	context: PipelineContext,
	library: MediaLibrary,
	runId: string,
	position: number,
	address: string,
	ref?: SourceFileRef,
): Promise<{ mediaId: string; fresh: boolean } | { problem: ItemProblem["params"] }> {
	const { scope } = context;
	const known = context.files.get(address);
	if (known?.mediaId) {
		const kept = await scope.first(media, and(eq(media.id, known.mediaId), isNull(media.trashedAt)));
		if (kept) {
			if (ref) await fillTexts(context, library, kept, ref);
			return { mediaId: kept.id, fresh: false };
		}
	}
	let mediaId: string;
	try {
		mediaId = (await library.importUrl(scope, address)).id;
	} catch (error) {
		if (error instanceof MediaImportRefusedError) {
			return { problem: { problem: error.problem, ...(error.status === undefined ? {} : { status: error.status }) } };
		}
		if (error instanceof MediaTooLargeError) return { problem: { problem: "size" } };
		if (error instanceof MediaTypeRefusedError) return { problem: { problem: "type" } };
		if (error instanceof MediaQuotaFullError) return { problem: { problem: "quota" } };
		throw error;
	}
	await scope.transaction(async (tx) => {
		const item = known
			? (await tx.update(importItems, { mediaId, lastRunId: runId }, eq(importItems.id, known.id)))[0]
			: await tx.insert(importItems, {
					importId: context.importId as string,
					kind: "media",
					sourceId: address,
					mediaId,
					lastRunId: runId,
				});
		if (item) context.files.set(address, item);
		await tx.insert(importRunChanges, { runId, position, kind: "media", action: "created", mediaId });
	});
	if (ref) {
		const fetched = await scope.first(media, eq(media.id, mediaId));
		if (fetched) await fillTexts(context, library, fetched, ref);
	}
	return { mediaId, fresh: true };
}

/**
 * Gives a fetched file the title, alt text and caption the source gives it, in the run's language,
 * where it has none yet: never over what someone wrote.
 */
async function fillTexts(
	context: PipelineContext,
	library: MediaLibrary,
	row: typeof media.$inferSelect,
	ref: SourceFileRef,
): Promise<void> {
	const languages = (context.mapping ?? null)?.languages ?? context.languages;
	if (!languages) return;
	const texts = storedTexts(row.texts);
	const change: { title?: string; alt?: string; caption?: string } = {};
	for (const key of ["title", "alt", "caption"] as const) {
		const given = ref[key]?.trim();
		if (given && !readText(texts, key, languages)) change[key] = given.slice(0, MEDIA_TEXT_MAX_LENGTH[key]);
	}
	if (Object.keys(change).length === 0) return;
	await library.update(context.scope, row.id, { language: languages.language, ...change });
}

/** Records an item's problems in the run's report. */
export async function recordProblems(scope: SiteScope, runId: string, item: EntryItem): Promise<void> {
	for (const [ordinal, problem] of item.problems.entries()) {
		await scope.insert(importRunProblems, {
			runId,
			position: item.position,
			ordinal,
			column: problem.column,
			rule: problem.rule,
			params: problem.params ?? null,
		});
	}
}

/**
 * Counts one item's outcome in the run's summary, with how many items the run has gone through, in
 * the same transaction as the item's write when given one.
 */
export async function countOutcome(
	scope: Pick<SiteScope, "db" | "where">,
	runId: string,
	outcome: Outcome,
	hasProblems: boolean,
	done: number,
	extra: Record<string, number> = {},
): Promise<void> {
	const counts: Record<string, number> = { ...extra };
	if (outcome !== "problem") counts[outcome] = (counts[outcome] ?? 0) + 1;
	if (hasProblems || outcome === "problem") counts.problemRows = (counts.problemRows ?? 0) + 1;
	let summary: SQL = sql`${importRuns.summary}`;
	for (const [key, by] of Object.entries(counts)) {
		if (by === 0) continue;
		const inner = summary;
		summary = sql`jsonb_set(${inner}, ${`{${key}}`}::text[], to_jsonb(coalesce((${inner} ->> ${key}::text)::int, 0) + ${by}))`;
	}
	await scope.db
		.update(importRuns)
		.set({ done, summary })
		.where(scope.where(importRuns, eq(importRuns.id, runId)));
}

/** Entries' states: a hash of the Draft and when it was saved. */
export async function entryStates(
	scope: Pick<SiteScope, "db" | "where">,
	ids: readonly string[],
): Promise<(EntryState & { id: string; lastPublishedAt: Date | null; published: boolean })[]> {
	if (ids.length === 0) return [];
	return scope.db
		.select({
			id: entries.id,
			hash: sql<string>`md5(${entries.draft}::text)`,
			updatedAt: entries.updatedAt,
			lastPublishedAt: entries.lastPublishedAt,
			published: sql<boolean>`${entries.published} is not null`,
		})
		.from(entries)
		.where(scope.where(entries, inArray(entries.id, [...ids])));
}

/** The Entries of `postTypes` (keys) whose slug, else whose title, is `name`, in any language and any case. */
async function entriesNamed(context: PipelineContext, postTypes: readonly string[], name: string): Promise<string[]> {
	const cacheKey = `${postTypes.join(",")}\u0000${name.toLocaleLowerCase()}`;
	const cached = context.found.get(cacheKey);
	if (cached) return cached;
	const ids = postTypes.flatMap((key) => context.postTypeIds.get(key) ?? []);
	if (ids.length === 0) return [];
	const named = (key: "slug" | "title") =>
		sql`exists (select 1 from jsonb_each(${entries.draft} -> 'values' -> ${key}::text) as written where lower(written.value ->> 'value') = lower(${name.trim()}))`;
	const bySlug = await context.scope.db
		.select({ id: entries.id })
		.from(entries)
		.where(context.scope.where(entries, and(inArray(entries.postTypeId, ids), named("slug"))));
	const found =
		bySlug.length > 0
			? bySlug
			: await context.scope.db
					.select({ id: entries.id })
					.from(entries)
					.where(context.scope.where(entries, and(inArray(entries.postTypeId, ids), named("title"))));
	const result = found.map((row) => row.id);
	context.found.set(cacheKey, result);
	return result;
}

/** Where a matching value is stored in a Draft: `{values,title}`, `{values,<key>}`. */
function matchPath(to: string): string {
	const key = to.startsWith("fields.") ? to.slice("fields.".length) : to;
	return `{values,${key}}`;
}

/** A stored value in a language, falling back to the Default language (shared Fields keep theirs there). */
function valueIn(stored: unknown, languages: { language: string; defaultLanguage: string }): Json {
	if (!stored || typeof stored !== "object") return null;
	const byLanguage = stored as Record<string, { value?: Json } | undefined>;
	return byLanguage[languages.language]?.value ?? byLanguage[languages.defaultLanguage]?.value ?? null;
}
