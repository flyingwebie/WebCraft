/**
 * Runs, previews and samples of a Module's import source (a WordPress export file): the same
 * pipeline as every source (`pipeline.ts`), over items the Module reads from the file as a stream.
 *
 * A **run** first makes the Structure its settings ask for, once: the Post Types it creates and the
 * Fields it adds, each recorded among its changes (Undo removes them) and written back into the
 * Import's settings, so Run again finds them. Then it goes through the items in the file's order,
 * from where it got to: each Entry item as a Draft with its Source id (looked up within the Post Type
 * its type goes to), its files fetched into the Media library through the guarded fetcher (once per
 * address per Import) with their texts, and a Redirect rule (through the Module keeping them, when
 * one runs on the Site) from where it was on the old site to its new path, and from each file's old
 * address to the Media file. Its Import leftovers go in its report.
 *
 * A **preview** goes through the same items without writing or fetching anything, in the worker:
 * how many Entries each type would create, update or skip, the files it would fetch, the Redirect
 * rules it would make, its leftovers and problems, and the first Entries of each type as they would
 * be (with their Blocks). A **sample** is one of the file's first items read with the settings as
 * they are now, for the Map step's live sample Entry.
 */
import { createHash } from "node:crypto";
import { entries, importFiles, importRunChanges, importRuns, imports } from "@webcraft/db/schema";
import type { ImportedRule, SourceEntry, SourceItem } from "@webcraft/module-sdk";
import type { Block } from "@webcraft/renderer/body";
import { eq, type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { PathTakenError, PostTypeInvalidError } from "../content/errors.ts";
import type { FieldInput } from "../content/field-types.ts";
import { sameJson } from "../content/json.ts";
import { prefixOf } from "../content/languages.ts";
import { isPagePostType, parentIn } from "../content/pages.ts";
import { createPostType, listPostTypes, type PostType, updatePostType } from "../content/post-types.ts";
import { canonicalPath, pathFor, pathSegments } from "../content/url-patterns.ts";
import { readValue, storedVersion } from "../content/values.ts";
import { defineJob, type JobContext } from "../jobs/define.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { ImportFileNotReadyError, ImportInvalidError } from "./errors.ts";
import type { EntryItem, ItemProblem } from "./items.ts";
import { readSource } from "./live.ts";
import {
	countOutcome,
	type Decision,
	decide,
	fetchFile,
	itemKey,
	type Outcome,
	type PipelineContext,
	pipelineContext,
	recordProblems,
	resolveFinds,
	writeItem,
} from "./pipeline.ts";
import { type ConvertedEntry, convertEntry, type FoundLeftover } from "./source-items.ts";
import {
	type EntryTypeTarget,
	type SourceMapping,
	type SourceSettings,
	sourceMapping,
	sourceSettingsSchema,
} from "./source-settings.ts";
import type { SourceFileDetails, SourceSurvey } from "./survey.ts";
import { sourceFor } from "./uploads.ts";

/** How many items one run job goes through before it hands the rest to the next one. */
const ITEMS_PER_JOB = 2000;

/** How many Entries of each type a preview shows. */
export const PREVIEW_ENTRIES_PER_TYPE = 20;

/** How many problems a preview lists. */
const PREVIEW_PROBLEMS = 200;

type FileRow = typeof importFiles.$inferSelect;
type RunRow = typeof importRuns.$inferSelect;
type ImportRow = typeof imports.$inferSelect;

/** What a source's run keeps in its summary, besides the counts every run keeps. */
export type SourceRunSummary = {
	created: number;
	updated: number;
	unchanged: number;
	skipped: number;
	problemRows: number;
	skippedColumns: string[];
	/** Files fetched, and files that couldn't be. */
	media?: number;
	notFetched?: number;
	redirects?: number;
	leftovers?: number;
	/** Items of types that go nowhere. */
	skippedItems?: number;
	skippedTypes?: { type: string; label: string; count: number }[];
	skippedKeys?: { type: string; label: string; keys: string[] }[];
	/** Whether a Module making Redirect rules runs on the Site. */
	redirectsOn?: boolean;
	/** The settings with the Post Types and Fields the run made, once it made them. */
	resolved?: SourceSettings;
};

// ---------------------------------------------------------------------------------------------------
// Starting a run

/** Checks a source's file and settings before a run starts; answers how many items it holds. */
export async function checkSourceRun(
	scope: SiteScope,
	context: Pick<JobContext, "modules">,
	importRow: ImportRow,
	file: FileRow,
): Promise<{ total: number; settings: SourceSettings; summary: SourceRunSummary }> {
	await sourceFor(scope, context.modules, importRow.source);
	if (
		(file.details as SourceFileDetails).live?.importId !== undefined &&
		(file.details as SourceFileDetails).live?.importId !== importRow.id
	)
		throw new ImportFileNotReadyError("source");
	const captured = (file.details as SourceFileDetails).live;
	if (
		captured &&
		captured.connection.revision !== (importRow.connection as import("./live.ts").ImportConnection | null)?.revision
	)
		throw new ImportFileNotReadyError("source");
	const survey = surveyOf(file, importRow.source);
	const settings = sourceSettingsSchema.parse(importRow.settings);
	const mapping = await sourceMapping(scope, settings, survey);
	return {
		total: survey.items,
		settings,
		summary: {
			created: 0,
			updated: 0,
			unchanged: 0,
			skipped: 0,
			problemRows: 0,
			skippedColumns: [],
			...skippedOf(survey, mapping),
			redirectsOn: await context.modules.importRedirectsOn(scope.site),
		},
	};
}

/** A source's file's survey, once it is ready and for this source; `ImportFileNotReadyError` otherwise. */
export function surveyOf(file: FileRow, source: string): SourceSurvey {
	const survey = (file.details as SourceFileDetails).survey;
	if (file.status !== "ready" || file.source !== source || !survey) {
		throw new ImportFileNotReadyError(file.source !== source ? "source" : file.status);
	}
	return survey;
}

/** The types and keys of a file the settings send nowhere: a run skips them and its report lists them. */
function skippedOf(survey: SourceSurvey, mapping: SourceMapping) {
	const skippedTypes: NonNullable<SourceRunSummary["skippedTypes"]> = [];
	const skippedKeys: NonNullable<SourceRunSummary["skippedKeys"]> = [];
	for (const type of survey.types) {
		const target = mapping.entries.get(type.key);
		if (!target && !mapping.media.has(type.key)) {
			skippedTypes.push({ type: type.key, label: type.label, count: type.count });
			continue;
		}
		if (!target) continue;
		const keys = type.keys.filter((key) => !target.keys.has(key.key)).map((key) => key.key);
		if (keys.length > 0) skippedKeys.push({ type: type.key, label: type.label, keys });
	}
	return { skippedTypes, skippedKeys };
}

// ---------------------------------------------------------------------------------------------------
// The run

/** Goes through a source's run in the worker (see the module's comment), as `scope`'s person. */
export async function runSourceImport(
	context: JobContext,
	scope: SiteScope,
	run: RunRow,
	importRow: ImportRow,
	finish: (status: "done" | "stopped" | "failed", failure?: { reason: string }) => Promise<void>,
	next: () => Promise<void>,
): Promise<void> {
	let source: Awaited<ReturnType<typeof sourceFor>>;
	try {
		source = await sourceFor(scope, context.modules, importRow.source);
	} catch {
		return finish("failed", { reason: "access" });
	}
	const file = run.fileId ? await scope.first(importFiles, eq(importFiles.id, run.fileId)) : undefined;
	if (!file) return finish("failed", { reason: "file" });
	let survey: SourceSurvey;
	try {
		survey = surveyOf(file, importRow.source);
	} catch {
		return finish("failed", { reason: "file" });
	}
	const summary = run.summary as SourceRunSummary;
	let mapping: SourceMapping;
	try {
		mapping = await sourceMapping(scope, summary.resolved ?? sourceSettingsSchema.parse(run.settings), survey);
		if (!summary.resolved) mapping = await makeStructure(scope, run, importRow, survey, mapping);
	} catch (error) {
		if (
			error instanceof ImportInvalidError ||
			error instanceof PostTypeInvalidError ||
			error instanceof PathTakenError
		) {
			context.log.warn("An Import run's Structure couldn't be made", { runId: run.id, error });
			return finish("failed", { reason: "settings" });
		}
		throw error;
	}
	const pipeline = await pipelineContext(scope, run.importId, null);
	pipeline.languages = mapping.languages;
	const redirectsOn = summary.redirectsOn === true && (await context.modules.importRedirectsOn(scope.site));
	const paths = new Map<string, string | null>();
	const ruled = new Set<string>();
	let index = 0;
	let gone = 0;
	const items = readSource(source, context.storage, file);
	for await (const item of items) {
		if (item.kind === "type") continue;
		index++;
		if (index <= run.done) {
			// Gone through by an earlier job: only its Source id counts (for repeated items).
			if (item.kind === "entry") {
				const target = mapping.entries.get(item.type);
				if (target) pipeline.seen.set(`source:${itemKey(target.destination.postType.id, item.sourceId)}`, index);
			}
			continue;
		}
		if (gone >= ITEMS_PER_JOB) {
			await next();
			return;
		}
		const current = await scope.first(importRuns, eq(importRuns.id, run.id));
		if (!current || current.stopRequestedAt) return finish("stopped");
		gone++;
		const rules = (asked: ShownRule[], position: number) =>
			redirectsOn ? addRules(context, scope, run.id, position, asked, ruled) : Promise.resolve(0);
		if (item.kind === "media") {
			if (!mapping.media.has(item.type)) {
				await count(scope, run.id, index, { skippedItems: 1 });
				continue;
			}
			const fetched = await fetchFile(pipeline, context.media, run.id, index, item.file.address, item.file);
			if ("mediaId" in fetched) {
				const made = item.path ? await rules([{ from: item.path, to: `media:${fetched.mediaId}` }], index) : 0;
				await count(scope, run.id, index, { media: fetched.fresh ? 1 : 0, redirects: made });
			} else {
				const problem: ItemProblem = {
					column: "file",
					rule: "notFetched",
					params: { ...(fetched.problem ?? {}), address: item.file.address.slice(0, 300) },
				};
				await scope.transaction(async (tx) => {
					await recordProblems(tx, run.id, { position: index, problems: [problem] } as EntryItem);
					await count(tx, run.id, index, { notFetched: 1 });
				});
			}
			continue;
		}
		const target = mapping.entries.get(item.type);
		if (!target) {
			await count(scope, run.id, index, { skippedItems: 1 });
			continue;
		}
		const converted = convertEntry(item, index, target);
		placeUnderParent(pipeline, converted);
		const decision = decide(pipeline, converted.item);
		let media = 0;
		let notFetched = 0;
		let made = 0;
		if (decision.kind === "create" || decision.kind === "update") {
			await resolveFinds(pipeline, converted.item, async (address, ref) => {
				const fetched = await fetchFile(pipeline, context.media, run.id, index, address, ref);
				if (!("mediaId" in fetched)) {
					notFetched++;
					return fetched;
				}
				if (fetched.fresh) media++;
				const from = ref?.path ?? null;
				if (from) made += await rules([{ from, to: `media:${fetched.mediaId}` }], index);
				return fetched;
			});
		}
		const outcome = await writeItem(pipeline, run.id, converted.item, decision);
		let leftovers = 0;
		if (outcome === "created" || outcome === "updated" || outcome === "unchanged") {
			leftovers = converted.leftovers.length;
			const entryId = entryIdOf(pipeline, converted);
			if (entryId && converted.path) {
				const to = await newPathOf(scope, entryId, target.destination.postType, mapping, paths);
				const from = oldPathOf(converted.path);
				// The rule names the Entry, so it follows the Entry to where it is published, a slug changed
				// before then included; the report shows the path it has now.
				if (from && to && from !== to)
					made += await rules([{ from, to: entryTarget(entryId, mapping), shown: to }], index);
			}
		}
		const problems = converted.item.problems.length > 0;
		await scope.transaction(async (tx) => {
			await recordProblems(tx, run.id, {
				...converted.item,
				problems: [...converted.item.problems, ...(leftovers > 0 ? leftoverProblems(converted.leftovers) : [])],
			});
			await countOutcome(tx, run.id, outcome, problems, index, {
				media,
				notFetched,
				redirects: made,
				leftovers,
			});
		});
	}
	return finish("done");
}

/** A Page item's parent Page, when this Import brought it in. */
function placeUnderParent(pipeline: PipelineContext, converted: ConvertedEntry): void {
	const { parent, target, item } = converted;
	if (!parent || !isPagePostType(target.destination.postType)) return;
	const entryId = pipeline.items.get(itemKey(target.destination.postType.id, parent))?.entryId;
	if (entryId) item.values.parentId = entryId;
	else item.problems.push({ column: null, rule: "parentNotFound", params: { parent } });
}

/** The Entry an item went to, once written. */
function entryIdOf(pipeline: PipelineContext, converted: ConvertedEntry): string | null {
	const { target, item } = converted;
	return pipeline.items.get(itemKey(target.destination.postType.id, item.sourceId as string))?.entryId ?? null;
}

/** Leftovers as the report keeps them: problems with the rule `leftover`, at their key. */
function leftoverProblems(leftovers: readonly FoundLeftover[]): ItemProblem[] {
	return leftovers.map((leftover) => ({
		column: leftover.key,
		rule: "leftover",
		params: { text: leftover.text.slice(0, 500), markup: leftover.markup, blockId: leftover.blockId ?? "" },
	}));
}

/** A path on the old site as a Site path (decoded and encoded again, no trailing slash); null for the home page. */
function oldPathOf(raw: string): string | null {
	const segments = pathSegments(raw);
	if (!segments || segments.length === 0) return null;
	return canonicalPath(segments);
}

/**
 * Where a Draft will be once published: its Post Type's URL pattern with its slug, or for a Page its
 * parent's path and its slug; under the language's prefix when it isn't the Default language.
 */
async function newPathOf(
	scope: SiteScope,
	entryId: string,
	postType: PostType,
	mapping: SourceMapping,
	paths: Map<string, string | null>,
): Promise<string | null> {
	const { language, defaultLanguage } = mapping.languages;
	const prefix = language === defaultLanguage ? "" : `/${prefixOf(language)}`;
	const slugAndParent = async (id: string) => {
		const [row] = await scope.select(entries, eq(entries.id, id));
		if (!row) return null;
		const version = storedVersion(row.draft);
		return {
			slug: readValue(version, { key: "slug", language, defaultLanguage }),
			parent: parentIn(version, defaultLanguage),
		};
	};
	if (!isPagePostType(postType)) {
		const own = await slugAndParent(entryId);
		const path = own?.slug ? pathFor(postType.urlPattern, own.slug) : null;
		return path ? `${prefix}${path}` : null;
	}
	const walk = async (id: string, depth: number): Promise<string | null> => {
		if (paths.has(id)) return paths.get(id) ?? null;
		const own = await slugAndParent(id);
		let path: string | null = null;
		if (own?.slug && depth < 12) {
			const above = own.parent ? await walk(own.parent, depth + 1) : "";
			path = above === null ? null : `${above}/${encodeURIComponent(own.slug)}`;
		}
		paths.set(id, path);
		return path;
	};
	const path = await walk(entryId, 0);
	return path ? `${prefix}${path}` : null;
}

/** A rule a run asks for, with the path the report shows for its target when that names an Entry. */
type ShownRule = ImportedRule & { shown?: string };

/** An Entry as a Redirect rule's target: `entry:<id>`, with the language when it isn't the Default one. */
function entryTarget(entryId: string, mapping: SourceMapping): string {
	const { language, defaultLanguage } = mapping.languages;
	return language === defaultLanguage ? `entry:${entryId}` : `entry:${entryId}:${language}`;
}

/** Adds Redirect rules through the Module keeping them, each from a path once a run, recording those added. */
async function addRules(
	context: JobContext,
	scope: SiteScope,
	runId: string,
	position: number,
	asked: readonly ShownRule[],
	ruled: Set<string>,
): Promise<number> {
	const wanted = asked.flatMap((rule) => {
		const from = oldPathOf(rule.from);
		if (!from || ruled.has(from)) return [];
		ruled.add(from);
		return [{ from, to: rule.to, shown: rule.shown }];
	});
	if (wanted.length === 0) return 0;
	const results = await context.modules.addImportedRules(
		scope.site,
		wanted.map(({ from, to }) => ({ from, to })),
	);
	if (!results) return 0;
	let added = 0;
	for (const [index, result] of results.entries()) {
		const rule = wanted[index];
		if (!rule || !("ruleId" in result)) continue;
		added++;
		await scope.insert(importRunChanges, {
			runId,
			position,
			kind: "redirect",
			action: "created",
			ruleId: result.ruleId,
			details: { from: rule.from, to: rule.to, ...(rule.shown ? { shown: rule.shown } : {}) },
		});
	}
	return added;
}

/** Adds to a run's counts, with how many items it has gone through. */
async function count(
	scope: Pick<SiteScope, "db" | "where">,
	runId: string,
	done: number,
	extra: Record<string, number>,
): Promise<void> {
	let summary: SQL = sql`${importRuns.summary}`;
	for (const [key, by] of Object.entries(extra)) {
		if (by === 0) continue;
		const inner = summary;
		summary = sql`jsonb_set(${inner}, ${`{${key}}`}::text[], to_jsonb(coalesce((${inner} ->> ${key}::text)::int, 0) + ${by}))`;
	}
	await scope.db
		.update(importRuns)
		.set({ done, summary })
		.where(scope.where(importRuns, eq(importRuns.id, runId)));
}

// ---------------------------------------------------------------------------------------------------
// Structure

/**
 * Makes the Post Types and Fields a run's settings ask for, once (see the module's comment), and
 * answers the mapping with them in place.
 */
async function makeStructure(
	scope: SiteScope,
	run: RunRow,
	importRow: ImportRow,
	survey: SourceSurvey,
	mapping: SourceMapping,
): Promise<SourceMapping> {
	const settings = sourceSettingsSchema.parse(run.settings);
	const resolved: SourceSettings = structuredClone(settings);
	const planned = [...mapping.entries.values()].filter((target) => target.planned);
	const created = new Map<string, PostType>();
	// A Post Type a new Relationship points at is made first.
	const ordered: EntryTypeTarget[] = [];
	const visit = (target: EntryTypeTarget, seen: Set<string>) => {
		if (ordered.includes(target) || seen.has(target.type)) return;
		seen.add(target.type);
		for (const field of target.newFields) {
			if (field.type !== "relationship") continue;
			const related = planned.find((other) => other.planned?.key === field.postTypes?.[0]);
			if (related && related !== target) visit(related, seen);
		}
		ordered.push(target);
	};
	for (const target of planned) visit(target, new Set());
	for (const target of ordered) {
		const plan = target.planned as NonNullable<EntryTypeTarget["planned"]>;
		const postType = await createPlanned(scope, plan, target.newFields, created);
		created.set(plan.key, postType);
		await scope.insert(importRunChanges, {
			runId: run.id,
			position: 0,
			kind: "postType",
			action: "created",
			postTypeId: postType.id,
			details: { name: postType.name, key: postType.key },
		});
		const entry = resolved.types.find((each) => each.type === target.type);
		if (entry) entry.to = { postTypeId: postType.id };
	}
	for (const target of mapping.entries.values()) {
		if (target.planned || target.newFields.length === 0) continue;
		const postType = (await listPostTypes(scope)).find((each) => each.id === target.destination.postType.id);
		if (!postType) continue;
		await updatePostType(scope, postType.id, {
			fields: [
				...(postType.fields as unknown as FieldInput[]),
				...target.newFields.map((field) => keyed(field, created)),
			],
		});
		for (const field of target.newFields) {
			await scope.insert(importRunChanges, {
				runId: run.id,
				position: 0,
				kind: "field",
				action: "created",
				postTypeId: postType.id,
				details: { key: field.key, label: field.label },
			});
		}
	}
	// New Fields are now the Post Types' own: Run again maps the keys to them.
	for (const type of resolved.types) {
		for (const key of type.keys) {
			if (key.to && typeof key.to === "object") key.to = `fields.${key.to.newField.key}`;
		}
	}
	const summary = { ...(run.summary as SourceRunSummary), resolved };
	await scope.update(importRuns, { summary }, eq(importRuns.id, run.id));
	run.summary = summary;
	// The Import keeps them for its later runs, unless someone changed its settings meanwhile.
	const [current] = await scope.select(imports, eq(imports.id, importRow.id));
	if (current && sameJson(current.settings, run.settings)) {
		await scope.update(imports, { settings: resolved, updatedAt: scope.now() }, eq(imports.id, importRow.id));
	}
	return sourceMapping(scope, resolved, survey);
}

/** Creates a planned Post Type, taking the next free key and URL pattern if another took them meanwhile. */
async function createPlanned(
	scope: SiteScope,
	plan: NonNullable<EntryTypeTarget["planned"]>,
	fields: readonly FieldInput[],
	created: Map<string, PostType>,
): Promise<PostType> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= 10; attempt++) {
		const suffix = attempt === 1 ? "" : `-${attempt}`;
		try {
			return await createPostType(scope, {
				name: plan.name,
				key: `${plan.key}${suffix}`,
				urlPattern: attempt === 1 ? plan.urlPattern : plan.urlPattern.replace(/^\/([^/]+)\//, `/$1${suffix}/`),
				fields: fields.map((field) => keyed(field, created)),
			});
		} catch (error) {
			if (!(error instanceof PostTypeInvalidError) && !(error instanceof PathTakenError)) throw error;
			const clash =
				error instanceof PathTakenError ||
				error.problems.some((problem) => problem.at === "key" || problem.at === "urlPattern");
			if (!clash) throw error;
			lastError = error;
		}
	}
	throw lastError;
}

/** A new Relationship pointing at a planned Post Type, pointed at the key it was created with. */
function keyed(field: FieldInput, created: Map<string, PostType>): FieldInput {
	if (field.type !== "relationship") return field;
	return { ...field, postTypes: (field.postTypes ?? []).map((key) => created.get(key)?.key ?? key) };
}

// ---------------------------------------------------------------------------------------------------
// The preview and the sample

/** An Entry as the preview and the Map step's sample show it. */
export type PreviewEntry = {
	type: string;
	sourceId: string;
	position: number;
	/** What the run would do with it. */
	action: Decision["kind"];
	postType: { id: string | null; name: string; isNew: boolean };
	title: string;
	slug: string | null;
	/** Where it will be once published. */
	path: string | null;
	fields: { key: string; label: string; type: string; value: string | null; from: string }[];
	seo: Record<string, string | boolean>;
	body: { key: string; label: string; blocks: Block[] } | null;
	images: { blockId: string; address: string }[];
	leftovers: FoundLeftover[];
	redirect: { from: string; to: string } | null;
	files: string[];
	problems: { column: string | null; rule: string; params: Record<string, string | number> | null }[];
	skippedKeys: string[];
};

/** A media item as the preview and the sample show it. */
export type PreviewMedia = {
	type: string;
	sourceId: string;
	address: string;
	title: string | null;
	alt: string | null;
	caption: string | null;
	redirect: { from: string; to: string } | null;
};

/** What a run of a source's file would do, worked out in the worker without writing or fetching anything. */
export type SourcePreview = {
	status: "working" | "ready" | "failed";
	progress: { done: number; total: number };
	counts: { create: number; update: number; skip: number; problemItems: number };
	types: {
		type: string;
		label: string;
		holds: "entries" | "media";
		count: number;
		to: { kind: "postType"; id: string | null; name: string; isNew: boolean } | { kind: "media" } | null;
		create: number;
		update: number;
		skip: number;
	}[];
	newPostTypes: string[];
	/** Files the run would fetch into the Media library. */
	files: number;
	redirects: number;
	/** Whether a Module making Redirect rules runs on the Site: without one, a run makes none. */
	redirectsOn: boolean;
	leftovers: number;
	skippedTypes: NonNullable<SourceRunSummary["skippedTypes"]>;
	skippedKeys: NonNullable<SourceRunSummary["skippedKeys"]>;
	entries: PreviewEntry[];
	media: PreviewMedia[];
	problems: { row: number; column: string | null; rule: string; params: Record<string, string | number> | null }[];
	problemsTotal: number;
};

/** What a source's file keeps of its newest preview: the settings it is for, and the preview. */
type StoredPreview = { key: string; preview: SourcePreview };

/** The key a preview is kept under: its settings and the Import it matches, hashed. */
export function previewKey(settings: SourceSettings, importId: string | null): string {
	return createHash("sha256").update(JSON.stringify({ settings, importId })).digest("hex");
}

/**
 * A source's file's preview for these settings: the one worked out, or working; a new one is queued
 * when there is none for them yet.
 */
export async function sourcePreview(
	scope: SiteScope,
	context: Pick<JobContext, "jobs" | "modules">,
	file: FileRow,
	settings: SourceSettings,
	importId: string | null,
): Promise<SourcePreview> {
	const survey = surveyOf(file, file.source);
	const mapping = await sourceMapping(scope, settings, survey);
	const key = previewKey(settings, importId);
	const stored = file.preview as StoredPreview | null;
	if (stored?.key === key) return stored.preview;
	const preview = emptyPreview(survey, mapping, await context.modules.importRedirectsOn(scope.site));
	await scope.update(importFiles, { preview: { key, preview } satisfies StoredPreview }, eq(importFiles.id, file.id));
	await context.jobs.send(importsPreview, { siteId: scope.site.id, fileId: file.id, key, settings, importId });
	return preview;
}

function emptyPreview(survey: SourceSurvey, mapping: SourceMapping, redirectsOn: boolean): SourcePreview {
	return {
		status: "working",
		progress: { done: 0, total: survey.items },
		counts: { create: 0, update: 0, skip: 0, problemItems: 0 },
		types: survey.types.map((type) => {
			const target = mapping.entries.get(type.key);
			return {
				type: type.key,
				label: type.label,
				holds: type.holds,
				count: type.count,
				to: target
					? {
							kind: "postType" as const,
							id: target.planned ? null : target.destination.postType.id,
							name: target.destination.postType.name,
							isNew: target.planned !== null,
						}
					: mapping.media.has(type.key)
						? { kind: "media" as const }
						: null,
				create: 0,
				update: 0,
				skip: 0,
			};
		}),
		newPostTypes: [...mapping.entries.values()].flatMap((target) => (target.planned ? [target.planned.name] : [])),
		files: 0,
		redirects: 0,
		redirectsOn,
		leftovers: 0,
		...skippedOf(survey, mapping),
		entries: [],
		media: [],
		problems: [],
		problemsTotal: 0,
	};
}

/** Works out a preview in the worker. */
export const importsPreview = defineJob({
	name: "imports.preview",
	payload: z.object({
		siteId: z.uuid(),
		fileId: z.uuid(),
		key: z.string(),
		settings: sourceSettingsSchema,
		importId: z.uuid().nullable(),
	}),
	queue: { retryLimit: 0, expireInSeconds: 60 * 60 },
	run: (payload, context) => runPreview(context, payload),
});

async function runPreview(
	context: JobContext,
	payload: { siteId: string; fileId: string; key: string; settings: SourceSettings; importId: string | null },
): Promise<void> {
	const background = await context.data.background(payload.siteId);
	const file = background ? await background.first(importFiles, eq(importFiles.id, payload.fileId)) : undefined;
	if (!background || !file?.uploadedBy) return;
	const stillWanted = async () => {
		const [now] = await background.select(importFiles, eq(importFiles.id, file.id));
		return (now?.preview as StoredPreview | null)?.key === payload.key;
	};
	const save = async (preview: SourcePreview) => {
		await background.transaction(async (tx) => {
			const [now] = await tx.db
				.select()
				.from(importFiles)
				.where(tx.where(importFiles, eq(importFiles.id, file.id)))
				.for("update");
			if ((now?.preview as StoredPreview | null)?.key !== payload.key) return;
			await tx.update(importFiles, { preview: { key: payload.key, preview } }, eq(importFiles.id, file.id));
		});
	};
	let scope: SiteScope;
	try {
		const actor = await context.actors.person(file.uploadedBy);
		scope = await context.data.site({ actor, via: { kind: "admin" } }, payload.siteId, "import.run");
	} catch {
		return;
	}
	const stored = file.preview as StoredPreview | null;
	const preview = stored?.key === payload.key ? stored.preview : null;
	if (preview?.status !== "working") return;
	try {
		const source = await sourceFor(scope, context.modules, file.source);
		const survey = surveyOf(file, file.source);
		const mapping = await sourceMapping(scope, payload.settings, survey);
		const pipeline = await pipelineContext(scope, payload.importId, null);
		pipeline.languages = mapping.languages;
		const files = new Set<string>();
		const ruled = new Set<string>();
		const futurePaths = new Map<string, string | null>();
		const shown = new Map<string, number>();
		const byType = new Map(preview.types.map((type) => [type.type, type]));
		let index = 0;
		for await (const item of readSource(source, context.storage, file)) {
			if (item.kind === "type") continue;
			index++;
			if (index % 500 === 0) {
				if (!(await stillWanted())) return;
				preview.progress.done = index;
				await save(preview);
			}
			if (item.kind === "media") {
				if (!mapping.media.has(item.type)) continue;
				if (!pipeline.files.has(item.file.address)) files.add(item.file.address);
				const from = item.path ? oldPathOf(item.path) : null;
				if (from && !ruled.has(from)) {
					ruled.add(from);
					preview.redirects++;
				}
				if ((shown.get(item.type) ?? 0) < PREVIEW_ENTRIES_PER_TYPE) {
					shown.set(item.type, (shown.get(item.type) ?? 0) + 1);
					preview.media.push(previewMedia(item));
				}
				continue;
			}
			const target = mapping.entries.get(item.type);
			if (!target) continue;
			const { entry, converted, decision } = await readForPreview(pipeline, item, index, target, mapping, futurePaths);
			const typeCounts = byType.get(item.type);
			if (decision.kind === "create" || decision.kind === "update" || decision.kind === "skip") {
				preview.counts[decision.kind]++;
				if (typeCounts) typeCounts[decision.kind]++;
			}
			if (decision.kind === "create" || decision.kind === "update") {
				for (const address of converted.files) if (!pipeline.files.has(address)) files.add(address);
				preview.leftovers += converted.leftovers.length;
				if (entry.redirect && !ruled.has(entry.redirect.from)) {
					ruled.add(entry.redirect.from);
					preview.redirects++;
				}
			}
			if (converted.item.problems.length > 0) preview.counts.problemItems++;
			for (const problem of converted.item.problems) {
				preview.problemsTotal++;
				if (preview.problems.length < PREVIEW_PROBLEMS) {
					preview.problems.push({
						row: index,
						column: problem.column,
						rule: problem.rule,
						params: problem.params ?? null,
					});
				}
			}
			if ((shown.get(item.type) ?? 0) < PREVIEW_ENTRIES_PER_TYPE) {
				shown.set(item.type, (shown.get(item.type) ?? 0) + 1);
				preview.entries.push(entry);
			}
		}
		preview.files = files.size;
		if (!preview.redirectsOn) preview.redirects = 0;
		preview.progress.done = index;
		preview.status = "ready";
		await save(preview);
	} catch (error) {
		context.log.warn("An Import preview couldn't be worked out", { fileId: file.id, error });
		await save({ ...preview, status: "failed" });
	}
}

/** One of a source's items read for the preview or the sample: what the run would do, without doing it. */
async function readForPreview(
	pipeline: PipelineContext,
	item: SourceEntry,
	position: number,
	target: EntryTypeTarget,
	mapping: SourceMapping,
	futurePaths: Map<string, string | null>,
): Promise<{ entry: PreviewEntry; converted: ConvertedEntry; decision: Decision }> {
	const converted = convertEntry(item, position, target);
	const postType = target.destination.postType;
	if (converted.parent && isPagePostType(postType)) {
		const known =
			pipeline.items.get(itemKey(postType.id, converted.parent))?.entryId ??
			(futurePaths.has(converted.parent) ? "planned" : null);
		if (!known)
			converted.item.problems.push({ column: null, rule: "parentNotFound", params: { parent: converted.parent } });
	}
	const decision = decide(pipeline, converted.item);
	// Its path once published, from its slug (and its parent's, for a Page), as the run would make it.
	const { language, defaultLanguage } = mapping.languages;
	const prefix = language === defaultLanguage ? "" : `/${prefixOf(language)}`;
	const slug = converted.item.values.slug ?? null;
	let path: string | null = null;
	if (slug) {
		if (isPagePostType(postType)) {
			const above = converted.parent ? futurePaths.get(converted.parent) : "";
			path = above === undefined || above === null ? `/${slug}` : `${above}/${slug}`;
			futurePaths.set(item.sourceId, path);
		} else path = pathFor(postType.urlPattern, slug);
	}
	const from = converted.path ? oldPathOf(converted.path) : null;
	const to = path ? `${prefix}${path}` : null;
	return {
		entry: previewEntry(converted, decision, to, from && to && from !== to ? { from, to } : null),
		converted,
		decision,
	};
}

function previewEntry(
	converted: ConvertedEntry,
	decision: Decision,
	path: string | null,
	redirect: { from: string; to: string } | null,
): PreviewEntry {
	const { item, target } = converted;
	const postType = target.destination.postType;
	const fields: PreviewEntry["fields"] = [];
	let body: PreviewEntry["body"] = null;
	for (const [key, place] of target.keys) {
		if (place.kind !== "field") continue;
		const field = place.field;
		if (field.type === "body") {
			const blocks = item.values.fields[field.key];
			if (Array.isArray(blocks)) body = { key: field.key, label: field.label, blocks: blocks as Block[] };
			continue;
		}
		const find = item.finds.find((each) => each.path[0] === field.key);
		const value = item.values.fields[field.key];
		fields.push({
			key: field.key,
			label: field.label,
			type: field.type,
			from: key,
			value: find
				? "file" in find.reading
					? find.reading.file
					: "sources" in find.reading
						? find.reading.sources.join(", ")
						: "entries" in find.reading
							? find.reading.entries.join(", ")
							: find.reading.media
				: value === undefined || value === null
					? null
					: typeof value === "string"
						? value
						: JSON.stringify(value),
		});
	}
	const seo: Record<string, string | boolean> = {};
	for (const [part, value] of Object.entries(item.values.seo ?? {})) {
		if (typeof value === "string" || typeof value === "boolean") seo[part] = value;
	}
	const seoImage = item.finds.find((each) => each.column && target.keys.get(each.column)?.kind === "seo");
	if (seoImage && "file" in seoImage.reading) seo.image = seoImage.reading.file;
	return {
		type: target.type,
		sourceId: item.sourceId as string,
		position: item.position,
		action: decision.kind,
		postType: { id: target.planned ? null : postType.id, name: postType.name, isNew: target.planned !== null },
		title: item.values.title ?? "",
		slug: item.values.slug ?? null,
		path,
		fields,
		seo,
		body,
		images: converted.images.map(({ blockId, address }) => ({ blockId, address })),
		leftovers: converted.leftovers,
		redirect,
		files: converted.files,
		problems: item.problems.map((problem) => ({
			column: problem.column,
			rule: problem.rule,
			params: problem.params ?? null,
		})),
		skippedKeys: converted.skippedKeys,
	};
}

function previewMedia(item: Extract<SourceItem, { kind: "media" }>): PreviewMedia {
	const from = item.path ? oldPathOf(item.path) : null;
	return {
		type: item.type,
		sourceId: item.sourceId,
		address: item.file.address,
		title: item.file.title ?? null,
		alt: item.file.alt ?? null,
		caption: item.file.caption ?? null,
		redirect: from ? { from, to: item.file.address.split("/").pop() ?? item.file.address } : null,
	};
}

/** One of a file's first items of a type, read with these settings: the Map step's live sample Entry. */
export async function sourceSample(
	scope: SiteScope,
	file: FileRow,
	input: { settings: SourceSettings; type: string; index: number; importId: string | null },
): Promise<{ entry: PreviewEntry | null; media: PreviewMedia | null; of: number; count: number }> {
	const survey = surveyOf(file, file.source);
	const type = survey.types.find((each) => each.key === input.type);
	if (!type) return { entry: null, media: null, of: 0, count: 0 };
	const sample = type.samples[input.index];
	const answer = { of: type.samples.length, count: type.count };
	if (!sample || sample.kind === "type") return { entry: null, media: null, ...answer };
	if (sample.kind === "media") return { entry: null, media: previewMedia(sample), ...answer };
	const mapping = await sourceMapping(scope, input.settings, survey);
	const target = mapping.entries.get(type.key);
	if (!target) return { entry: null, media: null, ...answer };
	const pipeline = await pipelineContext(scope, input.importId, null);
	pipeline.languages = mapping.languages;
	const { entry } = await readForPreview(pipeline, sample, input.index + 1, target, mapping, new Map());
	return { entry, media: null, ...answer };
}

export type { Outcome };
