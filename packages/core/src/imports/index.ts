/**
 * Imports (GLOSSARY.md › Importing): one pipeline for bringing outside content into a Site as
 * Drafts. A source reads items as a stream, a mapping turns them into Entries, an Import run writes
 * them in the background as Drafts with their Source id, and its Import report records what
 * happened. CSV files are the first source; the WordPress import (#112) plugs into the same seam.
 */
import { importFiles } from "@webcraft/db/schema";
import { and, eq } from "drizzle-orm";

import { listPostTypes } from "../content/post-types.ts";
import { isUuid } from "../ids.ts";
import type { JobQueue } from "../jobs/define.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import type { ImportSourceView, ModuleHost } from "../modules/host.ts";
import { actingPerson, can } from "../permissions/can.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import type { CsvSettings } from "./csv-source.ts";
import { ImportFileNotFoundError } from "./errors.ts";
import { type ImportFile, uploadCsv } from "./files.ts";
import {
	createImport,
	getImport,
	type Import,
	type ImportPreview,
	type ImportRunReport,
	type ImportRunSummary,
	type ImportSettings,
	listImports,
	type NewImport,
	previewRun,
	runReport,
	startRun,
	stopRun,
	updateImport,
} from "./runs.ts";
import {
	type PreviewEntry,
	type PreviewMedia,
	type SourcePreview,
	sourcePreview,
	sourceSample,
	surveyOf,
} from "./source-runs.ts";
import { type SourceSettings, suggestedSettings } from "./source-settings.ts";
import { importsSurvey, type SourceFileDetails, type SurveyType } from "./survey.ts";
import { type ImportUndo, undoRun } from "./undo.ts";
import { finishUpload, sourceFor, startUpload, uploadPart } from "./uploads.ts";

export { CSV_LIMITS, CSV_SEPARATORS, type CsvRefusal, CsvRefusedError, type CsvSeparator } from "./csv.ts";
export { type CsvSettings, type CsvTarget, csvSettingsSchema } from "./csv-source.ts";
export {
	ImportFileNotFoundError,
	ImportFileNotReadyError,
	ImportInvalidError,
	ImportNotFoundError,
	ImportPostTypeFixedError,
	ImportRunNotFoundError,
	ImportRunningError,
	type ImportSettingProblem,
	ImportSourceNotFoundError,
	ImportUndoRefusedError,
	ImportUploadRefusedError,
	type UndoRefusal,
	type UploadRefusal,
} from "./errors.ts";
export { csvTooLarge, IMPORT_FILE_LIFETIME_MS, type ImportFile } from "./files.ts";
export type { EntryItem, ImportLeftover, ItemDestination, ItemFind, ItemProblem } from "./items.ts";
export { importsPurge, importsPurgeSchedule } from "./purge.ts";
export {
	IMPORT_REPORT_LIFETIME_MS,
	IMPORT_SOURCES,
	type Import,
	type ImportChange,
	type ImportCounts,
	type ImportPreview,
	type ImportProblem,
	type ImportRunReport,
	type ImportRunStatus,
	type ImportRunSummary,
	type ImportSettings,
	type ImportSource,
	importsRun,
	type NewImport,
} from "./runs.ts";
export type { PreviewEntry, PreviewMedia, SourcePreview } from "./source-runs.ts";
export { importsPreview } from "./source-runs.ts";
export {
	NEW_FIELD_TYPES,
	SOURCE_KEY_TARGETS,
	type SourceSettings,
	sourceSettingsSchema,
} from "./source-settings.ts";
export { importsSurvey, type SourceSurvey, type SurveyKey, type SurveyType } from "./survey.ts";
export type { ImportUndo, UndoPreview } from "./undo.ts";
export { IMPORT_MAX_PARTS, IMPORT_PART_BYTES, IMPORT_PART_MIN_BYTES, partsHash } from "./uploads.ts";

/** A file uploaded in parts for a Module's import source, as the admin shows it. */
export type SourceFileView = {
	id: string;
	fileName: string;
	source: string;
	/** `uploading`, `surveying` (the worker reads it), `ready` or `refused`. */
	status: string;
	sizeBytes: number;
	receivedBytes: number;
	partBytes: number;
	expiresAt: Date;
	/** What it holds, once surveyed: each type with its count and keys (samples are read with `sample`). */
	survey: { items: number; types: (Omit<SurveyType, "samples"> & { samples: number })[] } | null;
	refusal: { code: string; message: string } | null;
	/** The mapping the Map step starts from, once surveyed. */
	suggested: SourceSettings | null;
};

/** One of a file's first items, read with the settings as they are: the Map step's live sample Entry. */
export type SourceSample = { entry: PreviewEntry | null; media: PreviewMedia | null; of: number; count: number };

/** A Site's Imports. Open the Site with `import.run`. */
export type Imports = {
	/**
	 * Takes a CSV file for an Import: reads it whole, refusing what an Import can't take
	 * (`CsvRefusedError`), and keeps it privately until a run takes it, or for a day.
	 */
	uploadCsv(scope: SiteScope, upload: { fileName: string; data: Uint8Array }): Promise<ImportFile>;
	/**
	 * What a run would do with an uploaded file and these settings, without writing anything: how many
	 * rows create, update or skip Drafts, and the problems in it. With `importId`, rows match what that
	 * Import brought in before.
	 */
	preview(
		scope: SiteScope,
		input: { fileId: string; settings: CsvSettings; importId?: string | null },
	): Promise<ImportPreview>;
	/** The Site's Imports, newest first, each with its newest run. */
	list(scope: SiteScope): Promise<Import[]>;
	/** One Import with its runs, newest first. */
	get(scope: SiteScope, importId: string): Promise<{ import: Import; runs: ImportRunSummary[] }>;
	/** Creates an Import (logged `import.create`); its settings must fit the Site. */
	create(scope: SiteScope, input: NewImport): Promise<Import>;
	/** Changes an Import's name or settings, for its later runs. */
	update(scope: SiteScope, importId: string, change: { name?: string; settings?: ImportSettings }): Promise<Import>;
	/**
	 * The import sources the Modules running on the Site add that the scope's person may import from,
	 * and whether a run there makes Redirect rules (a Module making them runs on the Site).
	 */
	sources(scope: SiteScope, language: string): Promise<{ sources: ImportSourceView[]; redirectsOn: boolean }>;
	/** Starts uploading a source's file in parts (see `uploads.ts`). */
	startUpload(
		scope: SiteScope,
		input: { source: string; fileName: string; size: number; partBytes?: number },
	): Promise<SourceFileView>;
	/** Takes one part of a file at its offset, with its SHA-256. */
	uploadPart(
		scope: SiteScope,
		input: { fileId: string; offset: number; sha256: string; data: Uint8Array },
	): Promise<SourceFileView>;
	/** Checks the whole file came (its size, and the SHA-256 of its parts' hashes), then the worker surveys it. */
	finishUpload(scope: SiteScope, input: { fileId: string; sha256: string }): Promise<SourceFileView>;
	/** A source's file you uploaded: how far it came, and what it holds once surveyed. */
	file(scope: SiteScope, fileId: string): Promise<SourceFileView>;
	/** One of a file's first items of a type, read with these settings (the live sample Entry). */
	sample(
		scope: SiteScope,
		input: { fileId: string; settings: SourceSettings; type: string; index: number; importId?: string | null },
	): Promise<SourceSample>;
	/**
	 * What a run of a source's file would do with these settings, worked out in the worker without
	 * writing or fetching anything: `working` until it is, then the counts and the first Entries.
	 */
	previewSource(
		scope: SiteScope,
		input: { fileId: string; settings: SourceSettings; importId?: string | null },
	): Promise<SourcePreview>;
	/**
	 * Starts a run with an uploaded file (logged `import.run`): the worker runs it in the background,
	 * writing Drafts as the person who started it. One run of an Import at a time.
	 */
	start(scope: SiteScope, importId: string, fileId: string): Promise<ImportRunReport>;
	/** Stops a run (logged `import.stop`): it finishes the row it is on and keeps what's done. */
	stop(scope: SiteScope, runId: string): Promise<ImportRunReport>;
	/** A run's progress and Import report. */
	report(scope: SiteScope, runId: string): Promise<ImportRunReport>;
	/**
	 * Undoes a whole run, in two steps (logged `import.undo`): deletes the Drafts it created, puts back
	 * the Drafts it updated and puts the files it fetched in the Trash, while nothing it brought in was
	 * published or edited since.
	 */
	undo(scope: SiteScope, runId: string, confirmation?: string): Promise<ImportUndo>;
};

export function createImports(options: { storage: InstallStorage; jobs: JobQueue; modules: ModuleHost }): Imports {
	const { storage, jobs, modules } = options;
	/** A source's file the scope's person uploaded, unused for less than a day. */
	const ownSourceFile = async (scope: SiteScope, fileId: string) => {
		const row = isUuid(fileId)
			? await scope.first(
					importFiles,
					and(eq(importFiles.id, fileId), eq(importFiles.uploadedBy, actingPerson(scope.access.actor))),
				)
			: undefined;
		if (!row || row.source === "csv" || row.expiresAt.getTime() <= scope.now().getTime()) {
			throw new ImportFileNotFoundError();
		}
		await sourceFor(scope, modules, row.source);
		return row;
	};
	const view = async (scope: SiteScope, row: typeof importFiles.$inferSelect): Promise<SourceFileView> => {
		const details = row.details as SourceFileDetails;
		const survey = details.survey ?? null;
		return {
			id: row.id,
			fileName: row.fileName,
			source: row.source,
			status: row.status,
			sizeBytes: row.sizeBytes,
			receivedBytes: row.receivedBytes,
			partBytes: row.partBytes ?? 0,
			expiresAt: row.expiresAt,
			survey: survey && {
				items: survey.items,
				types: survey.types.map((type) => ({ ...type, samples: type.samples.length })),
			},
			refusal: details.refusal ?? null,
			suggested: survey ? suggestedSettings(survey, await listPostTypes(scope)) : null,
		};
	};
	return {
		uploadCsv: (scope, upload) => uploadCsv(scope, storage, upload),
		preview: (scope, input) => previewRun(scope, storage, input),
		list: listImports,
		get: getImport,
		create: (scope, input) => createImport(scope, modules, input),
		update: (scope, importId, change) => updateImport(scope, modules, importId, change),
		async sources(scope, language) {
			const resource = { level: "site", workspaceId: scope.site.workspaceId, siteId: scope.site.id } as const;
			const found = await modules.importSourcesAt(scope.site, language);
			const sources: ImportSourceView[] = [];
			for (const source of found) {
				const running = await modules.importSource(scope.site, source.id);
				if (running && can(scope.access.actor, running.needs, resource)) sources.push(source);
			}
			return { sources, redirectsOn: await modules.importRedirectsOn(scope.site) };
		},
		startUpload: async (scope, input) => view(scope, await startUpload(scope, modules, storage, input)),
		async uploadPart(scope, input) {
			await ownSourceFile(scope, input.fileId);
			return view(scope, await uploadPart(scope, storage, input));
		},
		async finishUpload(scope, input) {
			await ownSourceFile(scope, input.fileId);
			return view(scope, await finishUpload(scope, jobs, importsSurvey, input));
		},
		file: async (scope, fileId) => view(scope, await ownSourceFile(scope, fileId)),
		async sample(scope, input) {
			const row = await ownSourceFile(scope, input.fileId);
			surveyOf(row, row.source);
			return sourceSample(scope, row, { ...input, importId: input.importId ?? null });
		},
		async previewSource(scope, input) {
			const row = await ownSourceFile(scope, input.fileId);
			return sourcePreview(scope, { jobs, modules }, row, input.settings, input.importId ?? null);
		},
		start: (scope, importId, fileId) => startRun(scope, jobs, modules, importId, fileId),
		stop: (scope, runId) => stopRun(scope, storage, runId),
		report: runReport,
		undo: (scope, runId, confirmation) => undoRun(scope, modules, runId, confirmation),
	};
}
