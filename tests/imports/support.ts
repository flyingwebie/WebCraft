// Helpers for Import tests: a CSV file to upload, and running an Import the way the admin does
// (upload the file, start a run, let the worker run it, read the Import report).
import type { ApiClient } from "@webcraft/api";

import { upload } from "../harness/images.ts";
import type { TestInstall } from "../harness/index.ts";

export const csv = (text: string, name = "products.csv") => upload(text, name, "text/csv");

/** A column of a CSV file and where it goes: `title`, `slug`, `fields.<key>`, or null to skip it. */
export type ColumnTarget = { column: string; to: string | null };

/** A CSV Import's settings, with what tests usually leave out filled in. */
export function csvSettings(
	postTypeId: string,
	columns: readonly ColumnTarget[],
	options: { match?: string; language?: string | null } = {},
) {
	return { postTypeId, language: options.language ?? null, match: options.match ?? "title", columns: [...columns] };
}

/** Uploads `text` as a CSV file and starts a run of the Import with it; answers the run. */
export async function startRun(api: ApiClient, siteId: string, importId: string, text: string, name?: string) {
	const { file } = await api.imports.uploadCsv({ siteId, file: csv(text, name) });
	return (await api.imports.start({ siteId, importId, fileId: file.id })).run;
}

/**
 * Creates a CSV Import into a Post Type and runs it with `text`, letting the worker run it: answers
 * the Import and the run's Import report.
 */
export async function importCsv(
	install: TestInstall,
	api: ApiClient,
	siteId: string,
	settings: ReturnType<typeof csvSettings>,
	text: string,
) {
	const { import: created } = await api.imports.create({ siteId, name: "Products", source: "csv", settings });
	const run = await startRun(api, siteId, created.id, text);
	const drained = await install.drainJobs();
	if (drained.failed.length > 0) throw drained.failed[0]?.error;
	const { run: report } = await api.imports.report({ siteId, runId: run.id });
	return { importId: created.id, run: report };
}

/** Runs an Import again with `text`; answers the new run's Import report. */
export async function runAgain(install: TestInstall, api: ApiClient, siteId: string, importId: string, text: string) {
	const run = await startRun(api, siteId, importId, text);
	const drained = await install.drainJobs();
	if (drained.failed.length > 0) throw drained.failed[0]?.error;
	return (await api.imports.report({ siteId, runId: run.id })).run;
}
