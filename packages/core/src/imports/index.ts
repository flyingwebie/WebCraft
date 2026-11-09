/**
 * Imports (GLOSSARY.md › Importing): one pipeline for bringing outside content into a Site as
 * Drafts. A source reads items as a stream, a mapping turns them into Entries, an Import run writes
 * them in the background as Drafts with their Source id, and its Import report records what
 * happened. CSV files are the first source; the WordPress import (#112) plugs into the same seam.
 */
import type { JobQueue } from "../jobs/define.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import type { CsvSettings } from "./csv-source.ts";
import { type ImportFile, uploadCsv } from "./files.ts";
import {
	createImport,
	getImport,
	type Import,
	type ImportPreview,
	type ImportRunReport,
	type ImportRunSummary,
	listImports,
	type NewImport,
	previewRun,
	runReport,
	startRun,
	stopRun,
	updateImport,
} from "./runs.ts";
import { type ImportUndo, undoRun } from "./undo.ts";

export { CSV_LIMITS, CSV_SEPARATORS, type CsvRefusal, CsvRefusedError, type CsvSeparator } from "./csv.ts";
export { type CsvSettings, type CsvTarget, csvSettingsSchema } from "./csv-source.ts";
export {
	ImportFileNotFoundError,
	ImportInvalidError,
	ImportNotFoundError,
	ImportRunNotFoundError,
	ImportRunningError,
	type ImportSettingProblem,
	ImportUndoRefusedError,
	type UndoRefusal,
} from "./errors.ts";
export { csvTooLarge, IMPORT_FILE_LIFETIME_MS, type ImportFile } from "./files.ts";
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
	type ImportSource,
	importsRun,
	type NewImport,
} from "./runs.ts";
export type { ImportUndo, UndoPreview } from "./undo.ts";

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
	update(scope: SiteScope, importId: string, change: { name?: string; settings?: CsvSettings }): Promise<Import>;
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

export function createImports(options: { storage: InstallStorage; jobs: JobQueue }): Imports {
	const { storage, jobs } = options;
	return {
		uploadCsv: (scope, upload) => uploadCsv(scope, storage, upload),
		preview: (scope, input) => previewRun(scope, storage, input),
		list: listImports,
		get: getImport,
		create: createImport,
		update: updateImport,
		start: (scope, importId, fileId) => startRun(scope, jobs, importId, fileId),
		stop: (scope, runId) => stopRun(scope, storage, runId),
		report: runReport,
		undo: undoRun,
	};
}
