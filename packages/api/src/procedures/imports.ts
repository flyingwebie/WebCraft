import {
	CSV_LIMITS,
	csvSettingsSchema,
	csvTooLarge,
	IMPORT_PART_BYTES,
	ImportUploadRefusedError,
	sourceSettingsSchema,
} from "@webcraft/core";
import { z } from "zod";

import { onSite, sensitive, signedIn } from "../context.ts";
import { id } from "../inputs.ts";
import { languageOf } from "./modules.ts";

/** An Import's source: `csv`, or a Module's import source such as `wordpress-import.export`. */
const source = z.string().regex(/^(?:csv|[a-z][a-z0-9]*(?:-[a-z0-9]+)*\.[a-z]+(?:-[a-z]+)*)$/);

/** An Import's settings: a CSV file's, or a Module source's (which the source's Import reads). */
const settings = z.union([csvSettingsSchema, sourceSettingsSchema]);

const sha256 = z.string().regex(/^[0-9a-fA-F]{64}$/);

/**
 * A Site's Imports (GLOSSARY.md › Importing): outside content brought in as Drafts, run in the
 * background, each run with its Import report. Staff, Owners and Editors (`import.run`).
 */
export const imports = {
	connect: signedIn
		.input(
			z.strictObject({
				siteId: id,
				source,
				name: z.string().trim().min(1).max(200),
				importId: id.optional(),
				address: z.string().max(2000).optional(),
				includeHidden: z.boolean().optional(),
				username: z.string().min(1).max(200).optional(),
				applicationPassword: z.string().min(1).max(1000).optional(),
			}),
		)
		.use(onSite("structure.edit"))
		.use(sensitive("import.connect"))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "import.run");
			return context.services.imports.connect(site, input);
		}),
	refresh: signedIn.input(z.object({ siteId: id, importId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "import.run");
		const { import: saved } = await context.services.imports.get(site, input.importId);
		return context.services.imports.connect(site, { source: saved.source, name: saved.name, importId: input.importId });
	}),
	remove: signedIn
		.input(z.object({ siteId: id, importId: id, confirmation: id.optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "import.run");
			return context.services.imports.remove(site, input.importId, input.confirmation);
		}),
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

	/**
	 * The import sources Modules add on the Site that you may import from (a WordPress export file,
	 * for Staff), and whether a run makes Redirect rules here (`redirectsOn`: a Module making them,
	 * Redirects and 404 log, is on for the Site).
	 */
	sources: signedIn.input(z.object({ siteId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "import.run");
		return context.services.imports.sources(site, await languageOf(context.services, context.person));
	}),

	/**
	 * Starts uploading a file for a Module's import source, in parts: its name and size (at most what
	 * the source takes, 1 GiB for a WordPress export file). Answers the file with its id and the size
	 * of each part (`partBytes`: 8 MiB, or the smaller size asked for, at least 1 KiB). The file is
	 * private (never in the Media library, never served), and deleted after a day unused.
	 */
	startUpload: signedIn
		.input(
			z.object({
				siteId: id,
				source,
				fileName: z.string().min(1).max(1000),
				size: z.number().int().min(1),
				partBytes: z.number().int().optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "import.run");
			const { siteId: _, ...upload } = input;
			return { file: await context.services.imports.startUpload(site, upload) };
		}),

	/**
	 * Sends one part of a file, at its byte `offset` (a multiple of `partBytes`), with the SHA-256 of
	 * its bytes in hexadecimal. Refused with `IMPORT_UPLOAD_REFUSED` and `data.reason`: `hash` (the
	 * bytes don't have that hash: send it again), `offset` (go on from `data.receivedBytes`), `part`
	 * (not the size it should be), `status` (all parts came). A part sent again as it was changes nothing.
	 */
	uploadPart: signedIn
		.input(
			z.object({
				siteId: id,
				fileId: id,
				offset: z.number().int().min(0),
				sha256,
				part: z.file(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "import.run");
			if (input.part.size > IMPORT_PART_BYTES) {
				throw new ImportUploadRefusedError("part", `A part has at most ${IMPORT_PART_BYTES} bytes.`, {
					bytes: IMPORT_PART_BYTES,
				});
			}
			const data = new Uint8Array(await input.part.arrayBuffer());
			const { fileId, offset, sha256: hash } = input;
			return { file: await context.services.imports.uploadPart(site, { fileId, offset, sha256: hash, data }) };
		}),

	/**
	 * Finishes an upload: every byte came and the SHA-256 of the parts' hashes (each part's 32 bytes, in
	 * order) is `sha256`. The worker then surveys the file (`status` goes from `surveying` to `ready`,
	 * or `refused` with `refusal`: not a file the source reads, a document type declared, …).
	 */
	finishUpload: signedIn.input(z.object({ siteId: id, fileId: id, sha256 })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "import.run");
		return { file: await context.services.imports.finishUpload(site, { fileId: input.fileId, sha256: input.sha256 }) };
	}),

	/**
	 * A file you uploaded for a Module's source: how much of it came (`receivedBytes`, to go on with an
	 * upload that stopped), its status, and once surveyed what it holds (each type of item with its
	 * count and keys) and the mapping the Map step starts from (`suggested`).
	 */
	file: signedIn.input(z.object({ siteId: id, fileId: id })).handler(async ({ context, input }) => {
		const site = await context.services.data.site(context.access, input.siteId, "import.run");
		return { file: await context.services.imports.file(site, input.fileId) };
	}),

	/**
	 * One of the first items of a type in a surveyed file (`index` from 0), read with these settings
	 * as a run would write it, without writing or fetching anything: the Map step's live sample Entry.
	 */
	sample: signedIn
		.input(
			z.object({
				siteId: id,
				fileId: id,
				settings: sourceSettingsSchema,
				type: z.string().min(1).max(100),
				index: z.number().int().min(0).max(1000),
				importId: id.nullable().optional(),
			}),
		)
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "import.run");
			const { siteId: _, ...query } = input;
			return { sample: await context.services.imports.sample(site, query) };
		}),

	/**
	 * What a run of a Module source's file would do with these settings, worked out in the background
	 * without writing or fetching anything: `status` is `working` until it is `ready` (call again to
	 * see). Then the Entries each type would create, update or skip, the new Post Types, the files it
	 * would fetch, the Redirect rules it would make, its Import leftovers and problems, and the first
	 * Entries of each type with their Blocks. With `importId`, items match what that Import brought in.
	 */
	previewSource: signedIn
		.input(z.object({ siteId: id, fileId: id, settings: sourceSettingsSchema, importId: id.nullable().optional() }))
		.handler(async ({ context, input }) => {
			const site = await context.services.data.site(context.access, input.siteId, "import.run");
			const { siteId: _, ...query } = input;
			return { preview: await context.services.imports.previewSource(site, query) };
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
				source,
				settings,
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
				settings: settings.optional(),
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
