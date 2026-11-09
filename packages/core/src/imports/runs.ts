/**
 * Imports and their runs: creating an Import, starting a run (a background job), its progress, Stop,
 * the preview before a run, and the Import report afterwards.
 */
import {
	entries,
	importFiles,
	importItems,
	importRunChanges,
	importRunProblems,
	importRuns,
	imports,
	people,
	postTypes,
} from "@webcraft/db/schema";
import { and, asc, count, desc, eq, inArray, isNotNull, isNull, ne } from "drizzle-orm";
import { z } from "zod";

import { siteLanguages } from "../content/languages.ts";
import { readValue, storedVersion } from "../content/values.ts";
import { isUuid } from "../ids.ts";
import { defineJob, type JobContext, type JobQueue } from "../jobs/define.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import type { ModuleHost } from "../modules/host.ts";
import { actingPerson } from "../permissions/can.ts";
import type { BackgroundScope, SiteScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError, SiteNotFoundError } from "../tenancy/errors.ts";
import { type CsvDetails, type CsvSeparator, csvColumns, csvRecords } from "./csv.ts";
import { type CsvSettings, csvItem, csvMapping, csvSettingsSchema, matchKey, skippedColumns } from "./csv-source.ts";
import {
	ImportFileNotReadyError,
	ImportInvalidError,
	ImportNotFoundError,
	ImportPostTypeFixedError,
	ImportRunNotFoundError,
	ImportRunningError,
	type UndoRefusal,
} from "./errors.ts";
import { deleteFile, openFile, ownFile } from "./files.ts";
import type { ImportLeftover, ItemProblem } from "./items.ts";
import {
	countOutcome,
	decide,
	fetchFile,
	pipelineContext,
	recordProblems,
	resolveFinds,
	writeItem,
} from "./pipeline.ts";
import { checkSourceRun, runSourceImport, type SourceRunSummary } from "./source-runs.ts";
import { type SourceSettings, sourceMapping, sourceSettingsSchema } from "./source-settings.ts";
import { undoState } from "./undo.ts";
import { sourceFor } from "./uploads.ts";

/** How long an Import report is kept after its run ends. */
export const IMPORT_REPORT_LIFETIME_MS = 90 * 24 * 60 * 60_000;

/** The kinds of source WebCraft itself reads: CSV files. Modules add theirs (`<module id>.<key>`). */
export const IMPORT_SOURCES = ["csv"] as const;

/** An Import's source: `csv`, or a Module's import source such as `wordpress-import.export`. */
export type ImportSource = string;

/** An Import's settings, as its source reads them. */
export type ImportSettings = CsvSettings | SourceSettings;

/** Where a run stands. */
export type ImportRunStatus = "waiting" | "running" | "stopped" | "done" | "failed" | "undone";

/** What a run did, by kind. */
export type ImportCounts = {
	created: number;
	updated: number;
	unchanged: number;
	skipped: number;
	/** Rows with at least one problem (whether or not the rest of the row was imported). */
	problemRows: number;
};

type PersonRef = { id: string; name: string } | null;

/** A run as the Import list and the run screen show it. */
export type ImportRunSummary = {
	id: string;
	importId: string;
	number: number;
	status: ImportRunStatus;
	/** Someone asked it to stop: it finishes the row it is on, keeping what's done. */
	stopRequested: boolean;
	startedBy: PersonRef;
	startedAt: Date;
	finishedAt: Date | null;
	fileName: string;
	progress: { done: number; total: number };
	counts: ImportCounts;
};

/** A problem in the Import report, at its row and column (null for the whole row), with its rule. */
export type ImportProblem = {
	row: number;
	column: string | null;
	rule: string;
	params: Record<string, string | number> | null;
};

/** An Entry the run created, updated or skipped, at its row. */
export type ImportChange = {
	row: number;
	entryId: string | null;
	/** Its Post Type, while it exists. */
	postTypeId: string | null;
	title: string | null;
	/** Why it was skipped: `edited` (someone changed it since an earlier run). */
	reason: string | null;
};

/** How many of each list a report shows; the counts say how many there are in all. */
const REPORT_LIST_LIMIT = 200;

/** An Import run's Import report. */
export type ImportRunReport = ImportRunSummary & {
	importName: string;
	source: ImportSource;
	postType: { id: string; name: string } | null;
	/** The language the run wrote values in. */
	language: string | null;
	/** Columns of the file the run skipped (mapped to nothing). */
	skippedColumns: string[];
	/** The first problems, in row order; `problemsTotal` says how many there are. */
	problems: ImportProblem[];
	problemsTotal: number;
	/** The first Entries it created, updated and skipped, in row order. */
	created: ImportChange[];
	updated: ImportChange[];
	skipped: ImportChange[];
	/** How many files it fetched into the Media library. */
	files: number;
	/** Its Import leftovers, for a source that has them (none in a CSV file): the first, and how many. */
	leftovers: ImportLeftover[];
	leftoversTotal: number;
	/** A Module source's run: files it couldn't fetch, Redirect rules it made, Post Types and Fields it created, what it skipped. */
	notFetched: { row: number; address: string; problem: string | null }[];
	notFetchedTotal: number;
	redirects: { on: boolean; count: number; rules: { from: string; to: string }[] };
	structure: {
		postTypes: { id: string | null; name: string }[];
		fields: { postType: string; key: string; label: string }[];
	};
	skippedTypes: { type: string; label: string; count: number }[];
	skippedKeys: { type: string; label: string; keys: string[] }[];
	skippedItems: number;
	failure: { reason: string } | null;
	undoneAt: Date | null;
	undoneBy: PersonRef;
	/** Whether the run can be undone, and why not. */
	undo: { available: boolean; reason: UndoRefusal | null };
	/** When the report is purged: 90 days after the run ended. */
	expiresAt: Date | null;
};

/** An Import: its source, its settings, and its runs. */
export type Import = {
	id: string;
	name: string;
	source: ImportSource;
	settings: ImportSettings;
	postType: { id: string; name: string } | null;
	createdBy: PersonRef;
	createdAt: Date;
	updatedAt: Date;
	/** How many runs it has had, reports purged since included. */
	runs: number;
	/** How many Entries it brought in and keeps track of: while it has any, it keeps its Post Type. */
	entries: number;
	/** Its newest run whose report is kept, if any. */
	lastRun: ImportRunSummary | null;
};

/** What a run would do with a file, worked out without writing anything. */
export type ImportPreview = {
	rows: number;
	/** How many rows would create Drafts, update Drafts, be skipped (edited since), and have problems. */
	counts: { create: number; update: number; skip: number; problemRows: number };
	/** How many files the run would fetch into the Media library. */
	files: number;
	skippedColumns: string[];
	/** The first problems, in row order; `problemsTotal` says how many there are. */
	problems: ImportProblem[];
	problemsTotal: number;
};

/** A new Import. */
export type NewImport = { name: string; source: ImportSource; settings: ImportSettings };

type ImportRow = typeof imports.$inferSelect;
type RunRow = typeof importRuns.$inferSelect;

/** The summary a run keeps: its counts and the columns it skipped (and, for a Module's source, more). */
type RunSummaryJson = ImportCounts & { skippedColumns: string[] } & Partial<SourceRunSummary>;

/** How many rows one job goes through before it hands the rest to the next one. */
const ROWS_PER_JOB = 500;

export const importRunPayload = z.object({ siteId: z.uuid(), runId: z.uuid() });

/**
 * Runs an Import run in the worker, as the person who started it (their access is checked again):
 * goes through the source's rows from where it got to, writing each as a Draft, until it is done or
 * someone asks it to stop. A big file is gone through by several jobs in a row.
 */
export const importsRun = defineJob({
	name: "imports.run",
	payload: importRunPayload,
	queue: { retryLimit: 0, expireInSeconds: 60 * 60 },
	run: ({ siteId, runId }, context) => runImport(context, siteId, runId),
});

/**
 * An Import's settings checked against the Site for its source: a CSV file's, or a Module source's
 * (the source must run on the Site, for a person who may import from it).
 */
async function checkedSettings(
	scope: SiteScope,
	modules: ModuleHost,
	source: ImportSource,
	settings: unknown,
): Promise<ImportSettings> {
	if (source === "csv") {
		const parsed = csvSettingsSchema.safeParse(settings);
		if (!parsed.success) throw settingsKind();
		await csvMapping(scope, parsed.data);
		return parsed.data;
	}
	await sourceFor(scope, modules, source);
	const parsed = sourceSettingsSchema.safeParse(settings);
	if (!parsed.success) throw settingsKind();
	await sourceMapping(scope, parsed.data, null);
	return parsed.data;
}

function settingsKind(): ImportInvalidError {
	return new ImportInvalidError([
		{ at: "settings", rule: "settingsKind", message: "These settings aren't for this Import's source." },
	]);
}

/** Creates an Import (logged `import.create`). Its settings must fit the Site. */
export async function createImport(scope: SiteScope, modules: ModuleHost, input: NewImport): Promise<Import> {
	const settings = await checkedSettings(scope, modules, input.source, input.settings);
	const now = scope.now();
	return scope.transaction(async (tx) => {
		const row = await tx.insert(imports, {
			name: input.name.trim(),
			source: input.source,
			settings,
			createdBy: actingPerson(tx.access.actor),
			createdAt: now,
			updatedAt: now,
		});
		await tx.audit("import.create", { importId: row.id, name: row.name, source: row.source });
		return (await importViews(tx, [row]))[0] as Import;
	});
}

/**
 * Changes an Import's name or settings; later runs use them. Its Post Type stays while it keeps track
 * of Entries it brought in (`ImportPostTypeFixedError`).
 */
export async function updateImport(
	scope: SiteScope,
	modules: ModuleHost,
	importId: string,
	change: { name?: string; settings?: ImportSettings },
): Promise<Import> {
	const row = await findImport(scope, importId);
	let settings: ImportSettings | undefined;
	if (change.settings) {
		settings = await checkedSettings(scope, modules, row.source, change.settings);
		if (row.source === "csv") {
			const before = csvSettingsSchema.safeParse(row.settings);
			const movesPostType = !before.success || before.data.postTypeId !== (settings as CsvSettings).postTypeId;
			if (movesPostType && (await trackedEntries(scope, [row.id])).has(row.id)) throw new ImportPostTypeFixedError();
		}
	}
	const [saved] = await scope.update(
		imports,
		{
			...(change.name !== undefined ? { name: change.name.trim() } : {}),
			...(settings ? { settings } : {}),
			updatedAt: scope.now(),
		},
		eq(imports.id, row.id),
	);
	return (await importViews(scope, [saved as ImportRow]))[0] as Import;
}

/** One Import, with its runs, newest first. */
export async function getImport(
	scope: SiteScope,
	importId: string,
): Promise<{ import: Import; runs: ImportRunSummary[] }> {
	const row = await findImport(scope, importId);
	const [view] = await importViews(scope, [row]);
	const runs = await scope.select(importRuns, eq(importRuns.importId, row.id), {
		orderBy: [desc(importRuns.number)],
	});
	return { import: view as Import, runs: await runSummaries(scope, runs) };
}

/** The Site's Imports, newest first, each with its newest run. */
export async function listImports(scope: SiteScope): Promise<Import[]> {
	const rows = await scope.select(imports, undefined, { orderBy: [desc(imports.createdAt), asc(imports.id)] });
	return importViews(scope, rows);
}

/**
 * Starts a run of an Import with an uploaded file (logged `import.run`): it waits for the worker, then
 * runs in the background. One run of an Import at a time (`ImportRunningError`).
 */
export async function startRun(
	scope: SiteScope,
	jobs: JobQueue,
	modules: ModuleHost,
	importId: string,
	fileId: string,
): Promise<ImportRunReport> {
	const run = await scope.transaction(async (tx) => {
		const [row] = isUuid(importId)
			? await tx.db
					.select()
					.from(imports)
					.where(tx.where(imports, eq(imports.id, importId)))
					.for("update")
			: [];
		if (!row) throw new ImportNotFoundError();
		const going = await tx.first(
			importRuns,
			and(eq(importRuns.importId, row.id), inArray(importRuns.status, ["waiting", "running"])),
		);
		if (going) throw new ImportRunningError(going.id);
		const file = await ownFile(tx, fileId);
		let settings: ImportSettings;
		let total: number;
		let summary: RunSummaryJson;
		if (row.source === "csv") {
			if (file.source !== "csv") throw new ImportFileNotReadyError("source");
			settings = csvSettingsSchema.parse(row.settings);
			const mapping = await csvMapping(tx, settings);
			const details = file.details as CsvDetails;
			total = details.rows;
			summary = {
				created: 0,
				updated: 0,
				unchanged: 0,
				skipped: 0,
				problemRows: 0,
				skippedColumns: skippedColumns(
					mapping,
					details.columns.map((column) => column.name),
				),
			};
		} else {
			({ settings, total, summary } = await checkSourceRun(tx, { modules }, row, file));
		}
		const number = row.runs + 1;
		await tx.update(imports, { runs: number }, eq(imports.id, row.id));
		const created = await tx.insert(importRuns, {
			importId: row.id,
			number,
			status: "waiting",
			startedBy: actingPerson(tx.access.actor),
			settings,
			fileId: file.id,
			fileName: file.fileName,
			total,
			summary,
			startedAt: tx.now(),
		});
		await tx.audit("import.run", {
			importId: row.id,
			runId: created.id,
			number: created.number,
			fileName: file.fileName,
		});
		return created;
	});
	await jobs.send(importsRun, { siteId: scope.site.id, runId: run.id });
	return runReport(scope, run.id);
}

/**
 * Stops a run (logged `import.stop`): a waiting one at once; a running one finishes the row it is on,
 * keeping what's done, and its report says it was stopped. A run that ended is left as it is.
 */
export async function stopRun(scope: SiteScope, storage: InstallStorage, runId: string): Promise<ImportRunReport> {
	const run = await findRun(scope, runId);
	if (run.status === "waiting" || run.status === "running") {
		await scope.transaction(async (tx) => {
			const now = tx.now();
			if (run.status === "waiting") {
				await tx.update(
					importRuns,
					{ status: "stopped", stopRequestedAt: now, finishedAt: now, expiresAt: reportExpiry(now), fileId: null },
					eq(importRuns.id, run.id),
				);
			} else {
				await tx.update(
					importRuns,
					{ stopRequestedAt: now },
					and(eq(importRuns.id, run.id), isNull(importRuns.stopRequestedAt)),
				);
			}
			await tx.audit("import.stop", { importId: run.importId, runId: run.id, number: run.number });
		});
		if (run.status === "waiting" && run.fileId) await removeFile(scope, storage, run.fileId);
	}
	return runReport(scope, run.id);
}

/**
 * What a run would do with an uploaded file and these settings, worked out without writing anything
 * or fetching any file: how many rows create, update or skip Drafts, and the problems in it. With
 * `importId`, rows match what that Import brought in before (as Run again does).
 */
export async function previewRun(
	scope: SiteScope,
	storage: InstallStorage,
	input: { fileId: string; settings: CsvSettings; importId?: string | null },
): Promise<ImportPreview> {
	const file = await ownFile(scope, input.fileId);
	const mapping = await csvMapping(scope, input.settings);
	const importId = input.importId ? (await findImport(scope, input.importId)).id : null;
	const context = await pipelineContext(scope, importId, mapping);
	const details = file.details as CsvDetails;
	const preview: ImportPreview = {
		rows: details.rows,
		counts: { create: 0, update: 0, skip: 0, problemRows: 0 },
		files: 0,
		skippedColumns: skippedColumns(
			mapping,
			details.columns.map((column) => column.name),
		),
		problems: [],
		problemsTotal: 0,
	};
	const stream = await openFile(storage, file);
	if (!stream) return preview;
	let header: string[] | null = null;
	for await (const record of csvRecords(stream, { separator: details.separator })) {
		if (!header) {
			header = csvColumns(record.cells);
			continue;
		}
		const item = csvItem(record, header, mapping);
		const decision = decide(context, item);
		if (decision.kind === "create" || decision.kind === "update") {
			preview.files += (await resolveFinds(context, item)).files;
		}
		if (decision.kind === "create") preview.counts.create++;
		else if (decision.kind === "update") preview.counts.update++;
		else if (decision.kind === "skip") preview.counts.skip++;
		if (item.problems.length > 0) preview.counts.problemRows++;
		for (const problem of item.problems) {
			preview.problemsTotal++;
			if (preview.problems.length < REPORT_LIST_LIMIT) preview.problems.push(problemView(item.position, problem));
		}
	}
	return preview;
}

/** A run's Import report. */
export async function runReport(scope: SiteScope, runId: string): Promise<ImportRunReport> {
	const run = await findRun(scope, runId);
	const parent = await scope.first(imports, eq(imports.id, run.importId));
	const [summary] = await runSummaries(scope, [run]);
	const settings = csvSettingsSchema.safeParse(run.settings);
	const postTypeId = settings.success ? settings.data.postTypeId : null;
	const sourceSettings = settings.success ? null : sourceSettingsSchema.safeParse(run.settings);
	const postType = postTypeId ? await scope.first(postTypes, eq(postTypes.id, postTypeId)) : undefined;
	const ofRun = (extra: ReturnType<typeof eq>) => and(eq(importRunProblems.runId, run.id), extra);
	const problems = await scope.select(importRunProblems, ofRun(ne(importRunProblems.rule, "leftover")), {
		orderBy: [asc(importRunProblems.position), asc(importRunProblems.ordinal)],
		limit: REPORT_LIST_LIMIT,
	});
	const problemsTotal = await scope.count(importRunProblems, ofRun(ne(importRunProblems.rule, "leftover")));
	const { defaultLanguage } = await siteLanguages(scope);
	const changes = async (action: string) =>
		changeViews(
			scope,
			defaultLanguage,
			await scope.select(
				importRunChanges,
				and(
					eq(importRunChanges.runId, run.id),
					eq(importRunChanges.kind, "entry"),
					eq(importRunChanges.action, action),
				),
				{ orderBy: [asc(importRunChanges.position)], limit: REPORT_LIST_LIMIT },
			),
		);
	const files = await scope.count(
		importRunChanges,
		and(eq(importRunChanges.runId, run.id), eq(importRunChanges.kind, "media")),
	);
	const json = run.summary as RunSummaryJson;
	const undoneBy = run.undoneBy ? ((await names(scope, [run.undoneBy])).get(run.undoneBy) ?? null) : null;
	return {
		...(summary as ImportRunSummary),
		importName: parent?.name ?? "",
		source: (parent?.source ?? "csv") as ImportSource,
		postType: postType ? { id: postType.id, name: postType.name } : null,
		language: settings.success ? settings.data.language : sourceSettings?.success ? sourceSettings.data.language : null,
		skippedColumns: json.skippedColumns ?? [],
		problems: problems.map((problem) => ({
			row: problem.position,
			column: problem.column,
			rule: problem.rule,
			params: (problem.params as ImportProblem["params"]) ?? null,
		})),
		problemsTotal,
		created: await changes("created"),
		updated: await changes("updated"),
		skipped: await changes("skipped"),
		files,
		...(await sourceReport(scope, run, defaultLanguage)),
		failure: (run.failure as { reason: string } | null) ?? null,
		undoneAt: run.undoneAt,
		undoneBy: run.undoneBy && undoneBy ? { id: run.undoneBy, name: undoneBy } : null,
		undo: await undoState(scope, run),
		expiresAt: run.expiresAt,
	};
}

/**
 * What a Module source's run adds to its report: its Import leftovers (with the Entry each is in),
 * the files it couldn't fetch, the Redirect rules it made, the Post Types and Fields it created, and
 * the types and keys it skipped. A CSV run has none of them.
 */
async function sourceReport(scope: SiteScope, run: RunRow, defaultLanguage: string) {
	const json = run.summary as RunSummaryJson;
	const ofRun = (extra: ReturnType<typeof eq>) => and(eq(importRunProblems.runId, run.id), extra);
	const leftoverRows = await scope.select(importRunProblems, ofRun(eq(importRunProblems.rule, "leftover")), {
		orderBy: [asc(importRunProblems.position), asc(importRunProblems.ordinal)],
		limit: REPORT_LIST_LIMIT,
	});
	const positions = [...new Set(leftoverRows.map((row) => row.position))];
	const entryChanges =
		positions.length > 0
			? await scope.select(
					importRunChanges,
					and(
						eq(importRunChanges.runId, run.id),
						eq(importRunChanges.kind, "entry"),
						inArray(importRunChanges.position, positions),
					),
				)
			: [];
	const views = await changeViews(scope, defaultLanguage, entryChanges);
	const byPosition = new Map(views.map((view) => [view.row, view]));
	const entryIds = views.flatMap((view) => (view.entryId ? [view.entryId] : []));
	const entryTypes =
		entryIds.length > 0
			? new Map(
					(
						await scope.db
							.select({ id: entries.id, postTypeId: postTypes.id, name: postTypes.name })
							.from(entries)
							.innerJoin(postTypes, eq(postTypes.id, entries.postTypeId))
							.where(scope.where(entries, inArray(entries.id, entryIds)))
					).map((row) => [row.id, { id: row.postTypeId, name: row.name }]),
				)
			: new Map<string, { id: string; name: string }>();
	const leftovers: ImportLeftover[] = leftoverRows.map((row) => {
		const params = (row.params ?? {}) as Record<string, string>;
		const view = byPosition.get(row.position);
		return {
			row: row.position,
			entryId: view?.entryId ?? null,
			title: view?.title ?? null,
			text: params.text ?? "",
			markup: params.markup ?? "",
			key: row.column,
			blockId: params.blockId || null,
			postType: view?.entryId ? (entryTypes.get(view.entryId) ?? null) : null,
		};
	});
	const notFetchedRows = await scope.select(importRunProblems, ofRun(eq(importRunProblems.rule, "notFetched")), {
		orderBy: [asc(importRunProblems.position)],
		limit: REPORT_LIST_LIMIT,
	});
	const changesOf = (kind: string) =>
		scope.select(importRunChanges, and(eq(importRunChanges.runId, run.id), eq(importRunChanges.kind, kind)), {
			orderBy: [asc(importRunChanges.position), asc(importRunChanges.id)],
			limit: REPORT_LIST_LIMIT,
		});
	const ruleRows = await changesOf("redirect");
	const typeRows = await changesOf("postType");
	const fieldRows = await changesOf("field");
	const typeNames = new Map((await scope.select(postTypes)).map((postType) => [postType.id, postType.name] as const));
	return {
		leftovers,
		leftoversTotal: json.leftovers ?? leftovers.length,
		notFetchedTotal: json.notFetched ?? notFetchedRows.length,
		notFetched: notFetchedRows.map((row) => {
			const params = (row.params ?? {}) as Record<string, string>;
			return { row: row.position, address: params.address ?? "", problem: params.problem ?? null };
		}),
		redirects: {
			on: json.redirectsOn ?? false,
			count: json.redirects ?? 0,
			rules: ruleRows.map((row) => row.details as { from: string; to: string }),
		},
		structure: {
			postTypes: typeRows
				.map((row) => ({
					id: row.postTypeId && typeNames.has(row.postTypeId) ? row.postTypeId : null,
					name: (row.postTypeId ? typeNames.get(row.postTypeId) : undefined) ?? (row.details as { name: string }).name,
				}))
				.sort((a, b) => a.name.localeCompare(b.name)),
			fields: fieldRows
				.map((row) => ({
					postType: (row.postTypeId ? typeNames.get(row.postTypeId) : undefined) ?? "",
					key: (row.details as { key: string }).key,
					label: (row.details as { label: string }).label,
				}))
				.sort((a, b) => a.postType.localeCompare(b.postType) || a.key.localeCompare(b.key)),
		},
		skippedTypes: json.skippedTypes ?? [],
		skippedKeys: json.skippedKeys ?? [],
		skippedItems: json.skippedItems ?? 0,
	};
}

/** Goes through a run's rows in the worker (see `importsRun`). */
async function runImport(context: JobContext, siteId: string, runId: string): Promise<void> {
	const { data, storage, log } = context;
	const background = await data.background(siteId);
	const run = background ? await background.first(importRuns, eq(importRuns.id, runId)) : undefined;
	if (!background || !run || (run.status !== "waiting" && run.status !== "running")) return;
	const finish = (status: "done" | "stopped" | "failed", failure?: { reason: string }) =>
		finishRun(background, storage, run, status, failure);
	if (run.stopRequestedAt) return finish("stopped");
	// The run writes as the person who started it, with their access as it is now.
	let scope: SiteScope;
	try {
		if (!run.startedBy) return finish("failed", { reason: "access" });
		const actor = await context.actors.person(run.startedBy);
		scope = await data.site({ actor, via: { kind: "admin" } }, siteId, "import.run");
	} catch (error) {
		if (error instanceof PermissionDeniedError || error instanceof SiteNotFoundError) {
			return finish("failed", { reason: "access" });
		}
		throw error;
	}
	try {
		if (run.status === "waiting") await scope.update(importRuns, { status: "running" }, eq(importRuns.id, run.id));
		const parent = await scope.first(imports, eq(imports.id, run.importId));
		if (!parent) return finish("failed", { reason: "settings" });
		if (parent.source !== "csv") {
			return await runSourceImport(context, scope, run, parent, finish, async () => {
				await context.jobs.send(importsRun, { siteId, runId });
			});
		}
		const settings = csvSettingsSchema.parse(run.settings);
		let mapping: Awaited<ReturnType<typeof csvMapping>>;
		try {
			mapping = await csvMapping(scope, settings);
		} catch (error) {
			if (error instanceof ImportInvalidError) return finish("failed", { reason: "settings" });
			throw error;
		}
		const file = run.fileId ? await scope.first(importFiles, eq(importFiles.id, run.fileId)) : undefined;
		const stream = file ? await openFile(storage, file) : null;
		if (!file || !stream) return finish("failed", { reason: "file" });
		const pipeline = await pipelineContext(scope, run.importId, mapping);
		let header: string[] | null = null;
		let index = 0;
		let gone = 0;
		const separator = (file.details as CsvDetails).separator as CsvSeparator;
		for await (const record of csvRecords(stream, { separator })) {
			if (!header) {
				header = csvColumns(record.cells);
				continue;
			}
			index++;
			const item = csvItem(record, header, mapping);
			if (index <= run.done) {
				// Gone through by an earlier job: only its matching value counts (for repeated values).
				if (item.match) pipeline.seen.set(matchKey(item.match.value), item.position);
				continue;
			}
			if (gone >= ROWS_PER_JOB) {
				await context.jobs.send(importsRun, { siteId, runId });
				await stream.cancel().catch(() => {});
				return;
			}
			const current = await scope.first(importRuns, eq(importRuns.id, run.id));
			if (!current || current.stopRequestedAt) {
				await stream.cancel().catch(() => {});
				return finish("stopped");
			}
			const decision = decide(pipeline, item);
			if (decision.kind === "create" || decision.kind === "update") {
				await resolveFinds(pipeline, item, (address) =>
					fetchFile(pipeline, context.media, run.id, item.position, address),
				);
			}
			const outcome = await writeItem(pipeline, run.id, item, decision);
			await scope.transaction(async (tx) => {
				await recordProblems(tx, run.id, item);
				await countOutcome(tx, run.id, outcome, item.problems.length > 0, index);
			});
			gone++;
		}
		return finish("done");
	} catch (error) {
		log.error("An Import run failed", { siteId, runId, error });
		return finish("failed", { reason: "error" });
	}
}

/** Ends a run: its status, when it ended and when its report is purged; its file is deleted. */
async function finishRun(
	scope: BackgroundScope,
	storage: InstallStorage,
	run: RunRow,
	status: "done" | "stopped" | "failed",
	failure?: { reason: string },
): Promise<void> {
	const now = scope.now();
	await scope.update(
		importRuns,
		{ status, finishedAt: now, expiresAt: reportExpiry(now), fileId: null, failure: failure ?? null },
		eq(importRuns.id, run.id),
	);
	if (run.fileId) await removeFile(scope, storage, run.fileId);
}

/** Deletes an uploaded file, if it is still there. */
async function removeFile(
	scope: Pick<SiteScope, "first" | "delete">,
	storage: InstallStorage,
	fileId: string,
): Promise<void> {
	const file = await scope.first(importFiles, eq(importFiles.id, fileId));
	if (file) await deleteFile(scope, storage, file);
}

function reportExpiry(finishedAt: Date): Date {
	return new Date(finishedAt.getTime() + IMPORT_REPORT_LIFETIME_MS);
}

async function findImport(scope: SiteScope, importId: string): Promise<ImportRow> {
	const row = isUuid(importId) ? await scope.first(imports, eq(imports.id, importId)) : undefined;
	if (!row) throw new ImportNotFoundError();
	return row;
}

async function findRun(scope: SiteScope, runId: string): Promise<RunRow> {
	const row = isUuid(runId) ? await scope.first(importRuns, eq(importRuns.id, runId)) : undefined;
	if (!row) throw new ImportRunNotFoundError();
	return row;
}

function problemView(row: number, problem: ItemProblem): ImportProblem {
	return { row, column: problem.column, rule: problem.rule, params: problem.params ?? null };
}

/** Imports as the API answers them, each with its newest run. */
/** How many Entries each Import keeps track of (those it brought in that still exist), by its id. */
async function trackedEntries(scope: SiteScope, importIds: readonly string[]): Promise<Map<string, number>> {
	const rows = await scope.db
		.select({ importId: importItems.importId, count: count() })
		.from(importItems)
		.where(
			scope.where(
				importItems,
				and(
					inArray(importItems.importId, [...importIds]),
					eq(importItems.kind, "entry"),
					isNotNull(importItems.entryId),
				),
			),
		)
		.groupBy(importItems.importId);
	return new Map(rows.map((row) => [row.importId, Number(row.count)]));
}

async function importViews(scope: SiteScope, rows: readonly ImportRow[]): Promise<Import[]> {
	if (rows.length === 0) return [];
	const ids = rows.map((row) => row.id);
	const tracked = await trackedEntries(scope, ids);
	const latest = await scope.db
		.selectDistinctOn([importRuns.importId])
		.from(importRuns)
		.where(scope.where(importRuns, inArray(importRuns.importId, ids)))
		.orderBy(importRuns.importId, desc(importRuns.number));
	const summaries = new Map((await runSummaries(scope, latest)).map((summary) => [summary.importId, summary]));
	const postTypeIds = rows.flatMap((row) => {
		const parsed = csvSettingsSchema.safeParse(row.settings);
		return parsed.success ? [parsed.data.postTypeId] : [];
	});
	const types = new Map(
		(postTypeIds.length > 0 ? await scope.select(postTypes, inArray(postTypes.id, postTypeIds)) : []).map((type) => [
			type.id,
			type.name,
		]),
	);
	const creators = await names(
		scope,
		rows.flatMap((row) => (row.createdBy ? [row.createdBy] : [])),
	);
	return rows.map((row) => {
		const settings = row.settings as ImportSettings;
		const postTypeId = "postTypeId" in settings ? settings.postTypeId : null;
		const typeName = postTypeId ? types.get(postTypeId) : undefined;
		const creator = row.createdBy ? creators.get(row.createdBy) : undefined;
		return {
			id: row.id,
			name: row.name,
			source: row.source as ImportSource,
			settings,
			postType: postTypeId && typeName !== undefined ? { id: postTypeId, name: typeName } : null,
			createdBy: row.createdBy && creator !== undefined ? { id: row.createdBy, name: creator } : null,
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
			runs: row.runs,
			entries: tracked.get(row.id) ?? 0,
			lastRun: summaries.get(row.id) ?? null,
		};
	});
}

async function runSummaries(scope: SiteScope, runs: readonly RunRow[]): Promise<ImportRunSummary[]> {
	const starters = await names(
		scope,
		runs.flatMap((run) => (run.startedBy ? [run.startedBy] : [])),
	);
	return runs.map((run) => {
		const summary = run.summary as RunSummaryJson;
		const starter = run.startedBy ? starters.get(run.startedBy) : undefined;
		return {
			id: run.id,
			importId: run.importId,
			number: run.number,
			status: run.status as ImportRunStatus,
			stopRequested: run.stopRequestedAt !== null,
			startedBy: run.startedBy && starter !== undefined ? { id: run.startedBy, name: starter } : null,
			startedAt: run.startedAt,
			finishedAt: run.finishedAt,
			fileName: run.fileName,
			progress: { done: run.done, total: run.total },
			counts: {
				created: summary.created ?? 0,
				updated: summary.updated ?? 0,
				unchanged: summary.unchanged ?? 0,
				skipped: summary.skipped ?? 0,
				problemRows: summary.problemRows ?? 0,
			},
		};
	});
}

/** Entries a run changed, with their titles in the Default language (null once deleted). */
async function changeViews(
	scope: SiteScope,
	language: string,
	rows: readonly (typeof importRunChanges.$inferSelect)[],
): Promise<ImportChange[]> {
	const ids = rows.flatMap((row) => (row.entryId ? [row.entryId] : []));
	const found = ids.length > 0 ? await scope.select(entries, inArray(entries.id, ids)) : [];
	const titles = new Map(
		found.map((row) => [
			row.id,
			readValue(storedVersion(row.draft), { key: "title", language, defaultLanguage: language }),
		]),
	);
	const types = new Map(found.map((row) => [row.id, row.postTypeId]));
	return rows.map((row) => ({
		row: row.position,
		entryId: row.entryId && titles.has(row.entryId) ? row.entryId : null,
		postTypeId: row.entryId ? (types.get(row.entryId) ?? null) : null,
		title: row.entryId ? (titles.get(row.entryId) ?? null) : null,
		reason: row.reason,
	}));
}

/** People's names by id. */
async function names(scope: Pick<SiteScope, "db">, ids: readonly string[]): Promise<Map<string, string>> {
	const wanted = [...new Set(ids)];
	if (wanted.length === 0) return new Map();
	const rows = await scope.db
		.select({ id: people.id, name: people.name })
		.from(people)
		.where(inArray(people.id, wanted));
	return new Map(rows.map((row) => [row.id, row.name]));
}
