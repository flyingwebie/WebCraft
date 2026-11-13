import {
	IMPORT_PART_BYTES,
	PASSPHRASE_MAX_LENGTH,
	PASSPHRASE_MIN_LENGTH,
	SiteImportUploadRefusedError,
} from "@webcraft/core";
import { z } from "zod";

import { onSite, onWorkspace, sensitive, signedIn } from "../context.ts";
import { id } from "../inputs.ts";

const sha256 = z.string().regex(/^[0-9a-fA-F]{64}$/);

/** An export passphrase: long enough to guard every secret of a Site wherever the file goes. */
const passphrase = z.string().min(PASSPHRASE_MIN_LENGTH).max(PASSPHRASE_MAX_LENGTH).nullable();

/**
 * Site exports (ADR 0033, GLOSSARY.md › Site export): one Site as one archive, for Staff (and the
 * Superadmin), `site.export`. Internal: the admin's own, never API tokens or AI clients (exporting is a
 * Sensitive action, and the download is a signed link for the signed-in person).
 */
export const siteExports = {
	/**
	 * Starts exporting the Site: the worker writes the archive (its Structure, Content in every
	 * language, Media, history, Reviews, Submissions, analytics, logs, Module data and Members by
	 * email). With a `passphrase` (12 characters at least, never stored) its secrets go in encrypted
	 * under it; without one they are dropped and listed. A Sensitive action, recorded as `site.export`.
	 * `SITE_EXPORT_RUNNING` (409) while another export of the Site is under way.
	 */
	start: signedIn
		.input(z.object({ siteId: id, passphrase, includeSubmissions: z.boolean().default(true) }))
		.use(onSite("site.export"))
		.use(sensitive("site.export"))
		.handler(async ({ context, input }) => ({
			export: await context.services.siteTransfer.startExport(context.site, {
				passphrase: input.passphrase,
				includeSubmissions: input.includeSubmissions,
			}),
		})),

	/** The Site's exports, newest first, with how far each got and, once written, its download link (24 hours). */
	list: signedIn
		.input(z.object({ siteId: id }))
		.use(onSite("site.export"))
		.handler(async ({ context }) => ({ exports: await context.services.siteTransfer.exports(context.site) })),

	/** One export: its progress, what it holds and what it left out, and its download link while it works. */
	get: signedIn
		.input(z.object({ siteId: id, exportId: id }))
		.use(onSite("site.export"))
		.handler(async ({ context, input }) => ({
			export: await context.services.siteTransfer.export(context.site, input.exportId),
		})),
};

/**
 * Site imports (GLOSSARY.md › Site import): a Site export uploaded into a Workspace in parts, then read
 * by the worker into a new Site, with its Site import report. Staff (and the Superadmin), `site.import`.
 */
export const siteImports = {
	/**
	 * Starts uploading a Site export, in parts: its name and size. Answers the import with its id and
	 * the size of each part (`partBytes`: 8 MiB, or the smaller size asked for). Kept privately, and
	 * deleted after a day unused, or once the import ran.
	 */
	startUpload: signedIn
		.input(
			z.object({
				workspaceId: id,
				fileName: z.string().min(1).max(1000),
				size: z.number().int().min(1),
				partBytes: z.number().int().optional(),
			}),
		)
		.use(onWorkspace("site.import"))
		.handler(async ({ context, input }) => {
			const { workspaceId: _, ...upload } = input;
			return { import: await context.services.siteTransfer.startUpload(context.workspace, upload) };
		}),

	/**
	 * Sends one part at its byte `offset` (a multiple of `partBytes`), with the SHA-256 of its bytes.
	 * Refused with `SITE_IMPORT_UPLOAD_REFUSED` and `data.reason` (`hash`, `offset` with
	 * `data.receivedBytes`, `part`, `status`); a part sent again as it was changes nothing.
	 */
	uploadPart: signedIn
		.input(z.object({ workspaceId: id, importId: id, offset: z.number().int().min(0), sha256, part: z.file() }))
		.use(onWorkspace("site.import"))
		.handler(async ({ context, input }) => {
			if (input.part.size > IMPORT_PART_BYTES) {
				throw new SiteImportUploadRefusedError("part", `A part has at most ${IMPORT_PART_BYTES} bytes.`, {
					bytes: IMPORT_PART_BYTES,
				});
			}
			const data = new Uint8Array(await input.part.arrayBuffer());
			const { importId, offset, sha256: hash } = input;
			return {
				import: await context.services.siteTransfer.uploadPart(context.workspace, {
					importId,
					offset,
					sha256: hash,
					data,
				}),
			};
		}),

	/**
	 * Finishes an upload (every byte came, and the SHA-256 of the parts' hashes is `sha256`) and reads
	 * the archive's manifest: the import then waits to be started, showing what it holds and the Modules
	 * it needs. `SITE_IMPORT_REFUSED` with `data.reason`: `not-an-export`, `newer-format` or
	 * `newer-version` (written by a newer WebCraft: update this Install first), `damaged`.
	 */
	finishUpload: signedIn
		.input(z.object({ workspaceId: id, importId: id, sha256 }))
		.use(onWorkspace("site.import"))
		.handler(async ({ context, input }) => ({
			import: await context.services.siteTransfer.finishUpload(context.workspace, {
				importId: input.importId,
				sha256: input.sha256,
			}),
		})),

	/**
	 * Imports the uploaded Site export as a new Site of the Workspace, with this name and slug (never
	 * over another Site): its Content arrives as Drafts, its domains paused, its Members matched by
	 * email or invited (no email sent until `sendInvitations`). With the export's `passphrase` its
	 * secrets come too (`SITE_IMPORT_PASSPHRASE_WRONG` for another one); without it they are dropped
	 * and listed. A Sensitive action, recorded as `site.import` once the Site exists.
	 */
	start: signedIn
		.input(
			z.object({
				workspaceId: id,
				importId: id,
				name: z.string().trim().min(1).max(100),
				slug: z.string().max(100),
				passphrase,
			}),
		)
		.use(onWorkspace("site.import"))
		.use(sensitive("site.import"))
		.handler(async ({ context, input }) => ({
			import: await context.services.siteTransfer.start(context.workspace, {
				importId: input.importId,
				name: input.name,
				slug: input.slug,
				passphrase: input.passphrase,
			}),
		})),

	/** The Workspace's Site imports, newest first. */
	list: signedIn
		.input(z.object({ workspaceId: id }))
		.use(onWorkspace("site.import"))
		.handler(async ({ context }) => ({ imports: await context.services.siteTransfer.imports(context.workspace) })),

	/** One Site import: its upload, what the archive holds, its progress, and its Site import report. */
	get: signedIn
		.input(z.object({ workspaceId: id, importId: id }))
		.use(onWorkspace("site.import"))
		.handler(async ({ context, input }) => ({
			import: await context.services.siteTransfer.import(context.workspace, input.importId),
		})),

	/**
	 * Emails the pending invitations the import made (a new link valid for 7 days each), which it left
	 * unsent. A Sensitive action (`member.invite`), recorded as `member.resendInvite` for each.
	 */
	sendInvitations: signedIn
		.input(z.object({ workspaceId: id, importId: id }))
		.use(onWorkspace("member.invite"))
		.use(sensitive("member.invite"))
		.handler(async ({ context, input }) => {
			await context.services.data.workspace(context.access, input.workspaceId, "site.import");
			return { import: await context.services.siteTransfer.sendInvitations(context.workspace, input.importId) };
		}),
};
