import { CSV_LIMITS, csvSettingsSchema, csvTooLarge } from "@webcraft/core";
import { z } from "zod";

import { signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/**
 * A Site's Imports (GLOSSARY.md › Importing): outside content brought in as Drafts, run in the
 * background, each run with its Import report. Staff, Owners and Editors (`import.run`).
 */
export const imports = {
	/**
	 * Uploads a CSV file for an Import: UTF-8 (with or without a byte order mark), separated by commas,
	 * semicolons or tabs, at most 10 MB, 10,000 rows and 200 columns, its first row naming every
	 * column once. Answers its columns with the first row's values, how many rows it has and its
	 * separator, or `IMPORT_FILE_REFUSED` with `data.reason`. The file is private (never in the Media
	 * library, never served) and is deleted once a run took it and ended, or after a day.
	 */
	uploadCsv: signedIn.input(z.object({ siteId: id, file: z.file() })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "import.run");
		if (input.file.size > CSV_LIMITS.maxBytes) throw csvTooLarge();
		const data = new Uint8Array(await input.file.arrayBuffer());
		return { file: await context.services.imports.uploadCsv(site, { fileName: input.file.name, data }) };
	}),

	/**
	 * What a run would do with an uploaded file and these settings, without writing anything: how many
	 * rows create, update or skip Drafts (rows matching an Entry an Import brought in that someone
	 * edited since are skipped), how many files it would fetch, and every problem by row and column.
	 * With `importId`, rows also match what that Import brought in before (Run again).
	 */
	preview: signedIn
		.input(z.object({ siteId: id, fileId: id, settings: csvSettingsSchema, importId: id.nullable().optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "import.run");
			const { siteId: _, ...query } = input;
			return { preview: await context.services.imports.preview(site, query) };
		}),

	/** The Site's Imports, newest first, each with its newest run. */
	list: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "import.run");
		return { imports: await context.services.imports.list(site) };
	}),

	/** One Import, with its runs, newest first. */
	get: signedIn.input(z.object({ siteId: id, importId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "import.run");
		return await context.services.imports.get(site, input.importId);
	}),

	/**
	 * Creates an Import: a name, its source (`csv`) and its settings, which must fit the Site: a Post
	 * Type and language it has, each column going to the title, the slug or a Field once (or skipped,
	 * `to: null`), and what rows match existing Entries by (the title, the slug, or a text, email or
	 * number Field a column fills). Refused with `IMPORT_INVALID`, each problem at its place.
	 */
	create: signedIn
		.input(
			z.object({
				siteId: id,
				name: z.string().trim().min(1).max(200),
				source: z.literal("csv"),
				settings: csvSettingsSchema,
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "import.run");
			const { siteId: _, ...created } = input;
			return { import: await context.services.imports.create(site, created) };
		}),

	/** Changes an Import's name or settings; its later runs use them. */
	update: signedIn
		.input(
			z.object({
				siteId: id,
				importId: id,
				name: z.string().trim().min(1).max(200).optional(),
				settings: csvSettingsSchema.optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "import.run");
			const { siteId: _, importId, ...change } = input;
			return { import: await context.services.imports.update(site, importId, change) };
		}),

	/**
	 * Starts a run of an Import with a file you uploaded: it waits for the worker, then runs in the
	 * background, bringing every row in as a Draft. Refused with `IMPORT_RUNNING` while another run of
	 * the Import hasn't ended.
	 */
	start: signedIn.input(z.object({ siteId: id, importId: id, fileId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "import.run");
		return { run: await context.services.imports.start(site, input.importId, input.fileId) };
	}),

	/**
	 * Stops a run: it finishes the row it is on and keeps what's done; its report says it was stopped.
	 * A run that ended is left as it is.
	 */
	stop: signedIn.input(z.object({ siteId: id, runId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "import.run");
		return { run: await context.services.imports.stop(site, input.runId) };
	}),

	/**
	 * A run's progress (rows done of the total) and Import report: counts, the columns it skipped, its
	 * problems by row and column, the Entries it created, updated and skipped, and whether it can be
	 * undone. Kept 90 days after the run ends.
	 */
	report: signedIn.input(z.object({ siteId: id, runId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "import.run");
		return { run: await context.services.imports.report(site, input.runId) };
	}),

	/**
	 * Undoes a whole run, in two steps. The first call changes nothing: it answers what Undo would do
	 * (`preview`: Drafts it deletes and puts back, files it puts in the Trash) and a `confirmation` id,
	 * valid for 5 minutes; calling again with it undoes the run. Refused with `IMPORT_UNDO_REFUSED`
	 * (`data.reason`: `status`, `published`, `edited` or `linked`, with the Entries in the way) once
	 * anything it brought in was published or edited.
	 */
	undo: signedIn
		.input(z.object({ siteId: id, runId: id, confirmation: z.string().max(100).optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "import.run");
			const undo = await context.services.imports.undo(site, input.runId, input.confirmation);
			return { ...undo, run: await context.services.imports.report(site, input.runId) };
		}),
};
