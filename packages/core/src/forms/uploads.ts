import { formUploads } from "@webcraft/db/schema";
import type { SubmissionFile } from "@webcraft/module-sdk";
import { FORM_UPLOAD_FORMATS, type FormUploadFormat, isUploadFormat } from "@webcraft/renderer";
import { and, eq, inArray, isNotNull, isNull, lt, type SQL } from "drizzle-orm";

import type { Clock } from "../clock.ts";
import type { EmailAttachment, EmailAttachmentRef } from "../email/mailer.ts";
import { isUuid } from "../ids.ts";
import type { Logger } from "../log.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import { sniff } from "../media/sniff.ts";
import { type ByteRange, StorageError, type StorageKind, siteFolder } from "../media/storage.ts";
import type { BackgroundScope, DataLayer, Site, SiteScope } from "../tenancy/data-layer.ts";

/**
 * Form uploads (GLOSSARY.md, ADR 0026): the files visitors send with a Form's file fields. They are
 * private: stored in the Install's storage under the Site's `form-uploads/` folder, never in the Media
 * library, never served on the Site. People download them through the admin
 * (`/api/forms/uploads/<site id>/<upload id>`) when they may read the Site's Submissions, and every
 * download is in the Audit log. They belong to their Submission, which the Module keeping Submissions
 * holds: it removes them whenever it deletes Submissions (`context.submissions.removeUploads`).
 *
 * What a file is comes from its bytes, never its name or the type the browser claims: a file is taken
 * only when its bytes are one of its field's formats and its name ends in one of their extensions.
 * SVG never is (an image that can hold scripts), whatever it is called.
 */

/** Where a Site's Form uploads are downloaded in the admin: `/api/forms/uploads/<site id>/<upload id>`. */
export const FORM_UPLOADS_PATH = "/api/forms/uploads/";

/** The kind of email attachment a Form upload is (`EmailAttachmentRef.kind`). */
export const UPLOAD_ATTACHMENT = "formUpload";

/** What a file's bytes are, as Forms take them: one of `FORM_UPLOAD_FORMATS`, or null (SVG among them). */
export function uploadFormat(bytes: Uint8Array, name: string): FormUploadFormat | null {
	const extension = extensionOf(name);
	const sniffed = sniff(bytes);
	if ("format" in sniffed) {
		const format = sniffed.format.format;
		return format !== "svg" && isUploadFormat(format) ? format : null;
	}
	if (isZip(bytes)) return officeFormat(bytes, extension);
	if (extension === "txt" || extension === "csv") return isPlainText(bytes) ? extension : null;
	return null;
}

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
}

function isZip(bytes: Uint8Array): boolean {
	return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/** An office document (a ZIP holding its parts), by what the archive says it is. */
function officeFormat(bytes: Uint8Array, extension: string): FormUploadFormat | null {
	const head = new TextDecoder("latin1").decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024)));
	if (extension === "odt" || extension === "ods") {
		const kind = extension === "odt" ? "text" : "spreadsheet";
		return head.startsWith("mimetype", 30) && head.includes(`application/vnd.oasis.opendocument.${kind}`)
			? extension
			: null;
	}
	const part = { docx: "word/", xlsx: "xl/", pptx: "ppt/" }[extension];
	return part && head.includes("[Content_Types].xml") && head.includes(part) ? (extension as FormUploadFormat) : null;
}

/**
 * Plain text: UTF-8 without control characters (tabs and line breaks aside), and nothing a browser
 * could take for markup (an SVG or a page), should anyone open it as such.
 */
function isPlainText(bytes: Uint8Array): boolean {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return false;
	}
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this refuses.
	if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) return false;
	return !/<\s*(?:[a-z][\w.-]*:)?(?:svg|html|script)\b|<\s*[!?]/i.test(text);
}

/** A file's name as kept: no folders, no control characters, at most 200 characters (keeping its extension). */
export function cleanFileName(name: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes.
	const base = (name.split(/[\\/]/).pop() ?? "").replace(/[\u0000-\u001f\u007f"]/g, "").trim();
	if (base.length <= 200) return base || "file";
	const extension = extensionOf(base);
	return `${base.slice(0, 200 - extension.length - 1)}.${extension}`;
}

/** The type a format's files are stored and sent as. */
export function uploadContentType(format: FormUploadFormat): string {
	return FORM_UPLOAD_FORMATS[format].contentType;
}

type UploadRow = typeof formUploads.$inferSelect;

/** One upload to download: its name, type and size, and its bytes as a stream. */
export type UploadDownload = {
	name: string;
	contentType: string;
	size: number;
	stream: ReadableStream<Uint8Array>;
};

export type FormUploads = {
	/**
	 * Stores the files of a Submission about to be kept, as WebCraft's own work for the Site (no person
	 * sent them), and answers each as the Submission names it. They belong to no Submission until
	 * `attach`; `discard` removes them when it isn't kept after all.
	 */
	store(
		site: Site,
		formId: string,
		files: readonly { fieldKey: string; name: string; bytes: Uint8Array; contentType: string }[],
	): Promise<SubmissionFile[]>;
	/** Makes stored files the Submission's inside the transaction keeping it, before any Notification is queued. */
	attach(scope: Pick<SiteScope, "update">, uploadIds: readonly string[], submissionId: string): Promise<void>;
	/** Removes stored files that belong to no Submission. */
	discard(site: Site, uploadIds: readonly string[]): Promise<void>;
	/**
	 * Removes the files of these Submissions: detaches their rows through `scope` (in the same
	 * transaction as the Submissions), then removes their bytes at once, or once `later` runs (after the
	 * transaction commits). Failed deletions retain detached rows for retry. Answers how many files went.
	 */
	remove(
		scope: Pick<SiteScope, "select" | "update">,
		site: Site,
		submissionIds: readonly string[],
		later?: (work: () => Promise<void>) => void,
	): Promise<number>;
	/** Removes every upload when the receiver Module's data is removed from this Site. */
	removeSite(
		scope: Pick<SiteScope, "select" | "update">,
		site: Site,
		later: (work: () => Promise<void>) => void,
	): Promise<number>;
	/**
	 * An upload of the Site to download, for a person `scope` was opened for who may read the Site's
	 * Submissions (the caller checks that): recorded in the Audit log as `formUpload.download`. Null
	 * when there is no such upload of a kept Submission, or its file is gone.
	 */
	download(scope: SiteScope, uploadId: string): Promise<UploadDownload | null>;
	/** Retry removing unclaimed uploads older than a day, including failed deletions. */
	purge(site: Site): Promise<void>;
	/** Where an upload is downloaded in the admin: a full address on the admin host. */
	url(site: Pick<Site, "id">, uploadId: string): string;
	/** Reads an upload a Notification attaches (`formUpload`), when the email is sent. */
	attachment(ref: EmailAttachmentRef): Promise<EmailAttachment | null>;
};

export type FormUploadsDeps = {
	data: DataLayer;
	storage: Pick<InstallStorage, "current" | "holding">;
	clock: Clock;
	log: Logger;
	adminOrigin: string;
};

export function createFormUploads(deps: FormUploadsDeps): FormUploads {
	const { data, storage, clock, log } = deps;

	const background = async (site: Pick<Site, "id">): Promise<BackgroundScope> => {
		const scope = await data.background(site.id);
		if (!scope) throw new Error("The Site is gone.");
		return scope;
	};

	const deleteBytes = async (scope: BackgroundScope, rows: readonly UploadRow[]) => {
		for (const row of rows) {
			try {
				await (await storage.holding(row.storage as StorageKind)).delete(row.key);
				await scope.delete(formUploads, and(eq(formUploads.id, row.id), isNull(formUploads.submissionId)));
			} catch (error) {
				log[error instanceof StorageError ? "warn" : "error"]("A Form upload's file couldn't be deleted", {
					key: row.key,
					error,
				});
			}
		}
	};

	const removeWhere = async (
		scope: Pick<SiteScope, "select" | "update">,
		site: Site,
		where: SQL | undefined,
		later?: (work: () => Promise<void>) => void,
	) => {
		const rows = await scope.select(formUploads, where);
		if (rows.length === 0) return 0;
		// Detach in the Submission transaction: never downloadable again. Keep the rows
		// until storage confirms deletion, so an outage or crash is retried by the daily purge.
		await scope.update(formUploads, { submissionId: null }, where);
		const clean = async () => deleteBytes(await background(site), rows);
		if (later) later(clean);
		else await clean();
		return rows.length;
	};

	const read = async (row: UploadRow, range?: ByteRange) =>
		(await storage.holding(row.storage as StorageKind)).stream(row.key, range);

	return {
		async store(site, formId, files) {
			if (files.length === 0) return [];
			const scope = await background(site);
			const backend = await storage.current();
			const stored: SubmissionFile[] = [];
			const written: UploadRow[] = [];
			try {
				for (const file of files) {
					const id = crypto.randomUUID();
					const key = `${siteFolder(site)}/form-uploads/${id}`;
					const row = await scope.insert(formUploads, {
						id,
						formId,
						fieldKey: file.fieldKey,
						submissionId: null,
						name: file.name,
						contentType: file.contentType,
						size: file.bytes.byteLength,
						storage: backend.kind,
						key,
						createdAt: clock.now(),
					});
					written.push(row);
					await backend.put(key, file.bytes, file.contentType);
					stored.push({ uploadId: row.id, name: row.name, size: row.size, contentType: row.contentType });
				}
			} catch (error) {
				await deleteBytes(scope, written);
				throw error;
			}
			return stored;
		},

		async attach(scope, uploadIds, submissionId) {
			if (uploadIds.length === 0) return;
			await scope.update(
				formUploads,
				{ submissionId },
				and(inArray(formUploads.id, [...uploadIds]), isNull(formUploads.submissionId)),
			);
		},

		async discard(site, uploadIds) {
			if (uploadIds.length === 0) return;
			const scope = await background(site);
			const where = and(inArray(formUploads.id, [...uploadIds]), isNull(formUploads.submissionId));
			const rows = await scope.select(formUploads, where);
			await deleteBytes(scope, rows);
		},

		async remove(scope, site, submissionIds, later) {
			const ids = submissionIds.filter(isUuid);
			if (ids.length === 0) return 0;
			return removeWhere(scope, site, inArray(formUploads.submissionId, ids), later);
		},

		removeSite: (scope, site, later) => removeWhere(scope, site, undefined, later),

		async purge(site) {
			const scope = await background(site);
			const before = new Date(clock.now().getTime() - 24 * 60 * 60 * 1000);
			const rows = await scope.select(
				formUploads,
				and(isNull(formUploads.submissionId), lt(formUploads.createdAt, before)),
			);
			await deleteBytes(scope, rows);
		},

		async download(scope, uploadId) {
			if (!isUuid(uploadId)) return null;
			const row = await scope.first(
				formUploads,
				and(eq(formUploads.id, uploadId), isNotNull(formUploads.submissionId)),
			);
			if (!row) return null;
			const stream = await read(row);
			if (!stream) return null;
			await scope.audit("formUpload.download", {
				uploadId: row.id,
				submissionId: row.submissionId,
				formId: row.formId,
				name: row.name,
			});
			return { name: row.name, contentType: row.contentType, size: row.size, stream };
		},

		url(site, uploadId) {
			return new URL(`${FORM_UPLOADS_PATH}${site.id}/${uploadId}`, deps.adminOrigin).toString();
		},

		async attachment(ref) {
			if (ref.kind !== UPLOAD_ATTACHMENT || !ref.siteId || !isUuid(ref.id)) return null;
			const scope = await data.background(ref.siteId);
			if (!scope || scope.site.workspaceId !== ref.workspaceId) return null;
			const row = await scope.first(formUploads, and(eq(formUploads.id, ref.id), isNotNull(formUploads.submissionId)));
			if (!row) return null;
			const bytes = await (await storage.holding(row.storage as StorageKind)).read(row.key);
			return bytes ? { filename: row.name, contentType: row.contentType, content: bytes } : null;
		},
	};
}
