/**
 * Files for a Module's import source (a WordPress export file, up to 1 GiB) come in parts, so a big
 * upload never goes through `/api/rpc` in one body and can stop and go on where it got to:
 *
 * 1. **Start** (`startUpload`): the file's name and size. WebCraft answers the file's id and the
 *    size of each part (`partBytes`, 8 MiB unless asked for smaller; the last part is what is left).
 * 2. **Parts** (`uploadPart`), in order: each at its `offset` (a multiple of `partBytes`), with the
 *    SHA-256 of its bytes. A part whose bytes don't have that hash is refused (`hash`), so a part
 *    spoiled on the way is sent again; a part at the wrong offset is refused (`offset`), and the file's
 *    `receivedBytes` says where to go on; a part sent again as it was is taken again, changing nothing.
 * 3. **Finish** (`finishUpload`): the file's whole size has come, and the SHA-256 of its parts' hashes
 *    (the 32 bytes of each, in order) is the one given (`hash`): the file is whole and in order. The
 *    worker then surveys it (see `survey.ts`).
 *
 * Each part is kept as its own object in the Site's private storage folder
 * (`<workspace id>/<site id>/imports/<id>/part-000001`), never in the Media library and never served,
 * and read back as one stream. A file nobody used for a day is deleted (`imports.purge`), and a run
 * deletes the file it took when it ends.
 */
import { createHash } from "node:crypto";

import { importFiles } from "@webcraft/db/schema";
import { and, eq } from "drizzle-orm";

import { isUuid } from "../ids.ts";
import type { JobQueue } from "../jobs/define.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import { siteFolder } from "../media/storage.ts";
import type { ModuleHost, RunningSource } from "../modules/host.ts";
import { actingPerson, can } from "../permissions/can.ts";
import type { SiteScope } from "../tenancy/data-layer.ts";
import { PermissionDeniedError } from "../tenancy/errors.ts";
import { ImportFileNotFoundError, ImportSourceNotFoundError, ImportUploadRefusedError } from "./errors.ts";
import { IMPORT_FILE_LIFETIME_MS } from "./files.ts";

/** The size of each part of an upload, unless the uploader asks for smaller ones. */
export const IMPORT_PART_BYTES = 8 * 1024 * 1024;
/** The smallest part an uploader may ask for. */
export const IMPORT_PART_MIN_BYTES = 1024;
/** The most parts one file is uploaded in. */
export const IMPORT_MAX_PARTS = 10_000;

type FileRow = typeof importFiles.$inferSelect;

/**
 * A Module's import source on the scope's Site, which the scope's person may import from: its
 * Module runs there, and they hold its Permission besides `import.run` (`structure.edit` for the
 * WordPress import, so Staff only). `ImportSourceNotFoundError` or `PermissionDeniedError` otherwise.
 */
export async function sourceFor(scope: SiteScope, modules: ModuleHost, sourceId: string): Promise<RunningSource> {
	const source = await modules.importSource(scope.site, sourceId);
	if (!source) throw new ImportSourceNotFoundError();
	const resource = { level: "site", workspaceId: scope.site.workspaceId, siteId: scope.site.id } as const;
	if (!can(scope.access.actor, source.needs, resource)) {
		throw new PermissionDeniedError(typeof source.needs === "string" ? source.needs : source.needs.key);
	}
	return source;
}

/** Starts an upload in parts for a source (see the module's comment). */
export async function startUpload(
	scope: SiteScope,
	modules: ModuleHost,
	storage: InstallStorage,
	input: { source: string; fileName: string; size: number; partBytes?: number },
): Promise<FileRow> {
	const source = await sourceFor(scope, modules, input.source);
	if (!Number.isInteger(input.size) || input.size < 1 || input.size > source.maxBytes) {
		throw new ImportUploadRefusedError("size", `This source takes files of at most ${source.maxBytes} bytes.`, {
			maxBytes: source.maxBytes,
		});
	}
	const partBytes = input.partBytes ?? IMPORT_PART_BYTES;
	if (
		!Number.isInteger(partBytes) ||
		partBytes < IMPORT_PART_MIN_BYTES ||
		partBytes > IMPORT_PART_BYTES ||
		Math.ceil(input.size / partBytes) > IMPORT_MAX_PARTS
	) {
		throw new ImportUploadRefusedError(
			"part",
			`Parts are ${IMPORT_PART_MIN_BYTES} to ${IMPORT_PART_BYTES} bytes, at most ${IMPORT_MAX_PARTS} of them.`,
			{ minBytes: IMPORT_PART_MIN_BYTES, maxBytes: IMPORT_PART_BYTES },
		);
	}
	const id = crypto.randomUUID();
	const target = await storage.current();
	const now = scope.now();
	return scope.insert(importFiles, {
		id,
		uploadedBy: actingPerson(scope.access.actor),
		fileName: cleanFileName(input.fileName, source.extensions[0] ?? ""),
		source: source.id,
		status: "uploading",
		sizeBytes: input.size,
		receivedBytes: 0,
		partBytes,
		parts: [],
		storage: target.kind,
		key: `${siteFolder(scope.site)}/imports/${id}`,
		details: {},
		createdAt: now,
		expiresAt: new Date(now.getTime() + IMPORT_FILE_LIFETIME_MS),
	});
}

/** Takes one part of an upload (see the module's comment). */
export async function uploadPart(
	scope: SiteScope,
	storage: InstallStorage,
	input: { fileId: string; offset: number; sha256: string; data: Uint8Array },
): Promise<FileRow> {
	return scope.transaction(async (tx) => {
		const row = await lockedOwnFile(tx, input.fileId);
		if (row.status !== "uploading") {
			throw new ImportUploadRefusedError("status", "This file has all its parts already.", { status: row.status });
		}
		const partBytes = row.partBytes ?? IMPORT_PART_BYTES;
		const parts = row.parts as string[];
		const index = input.offset / partBytes;
		const expected = Math.min(partBytes, row.sizeBytes - input.offset);
		if (!Number.isInteger(index) || index < 0 || index > parts.length || expected <= 0) {
			throw new ImportUploadRefusedError("offset", "Send the part that starts where the file got to.", {
				receivedBytes: row.receivedBytes,
			});
		}
		if (input.data.length !== expected) {
			throw new ImportUploadRefusedError("part", `This part should be ${expected} bytes.`, { bytes: expected });
		}
		const hash = createHash("sha256").update(input.data).digest("hex");
		if (hash !== input.sha256.toLowerCase()) {
			throw new ImportUploadRefusedError(
				"hash",
				"The part's bytes don't have the SHA-256 sent with it: send it again.",
				{
					offset: input.offset,
				},
			);
		}
		const now = tx.now();
		const expiresAt = new Date(now.getTime() + IMPORT_FILE_LIFETIME_MS);
		if (index < parts.length) {
			// A part sent again: the same bytes change nothing; others would replace what came.
			if (parts[index] !== hash) {
				throw new ImportUploadRefusedError("offset", "Send the part that starts where the file got to.", {
					receivedBytes: row.receivedBytes,
				});
			}
			return row;
		}
		const backend = await storage.holding(row.storage as "disk" | "s3");
		await backend.put(partKey(row, index), input.data, "application/octet-stream");
		const [saved] = await tx.update(
			importFiles,
			{ parts: [...parts, hash], receivedBytes: row.receivedBytes + input.data.length, expiresAt },
			eq(importFiles.id, row.id),
		);
		return saved as FileRow;
	});
}

/**
 * Finishes an upload: every byte came, and the SHA-256 of the parts' hashes is the one given. The
 * file then waits for the worker to survey it (`imports.survey`).
 */
export async function finishUpload(
	scope: SiteScope,
	jobs: JobQueue,
	surveyJob: Parameters<JobQueue["send"]>[0],
	input: { fileId: string; sha256: string },
): Promise<FileRow> {
	const row = await scope.transaction(async (tx) => {
		const file = await lockedOwnFile(tx, input.fileId);
		if (file.status !== "uploading") {
			throw new ImportUploadRefusedError("status", "This file has all its parts already.", { status: file.status });
		}
		if (file.receivedBytes !== file.sizeBytes) {
			throw new ImportUploadRefusedError("size", "Parts of the file are still to come.", {
				receivedBytes: file.receivedBytes,
				size: file.sizeBytes,
			});
		}
		if (partsHash(file.parts as string[]) !== input.sha256.toLowerCase()) {
			throw new ImportUploadRefusedError(
				"hash",
				"The file's parts don't add up to the SHA-256 sent: upload it again.",
				{},
			);
		}
		const now = tx.now();
		const [saved] = await tx.update(
			importFiles,
			{ status: "surveying", expiresAt: new Date(now.getTime() + IMPORT_FILE_LIFETIME_MS) },
			eq(importFiles.id, file.id),
		);
		return saved as FileRow;
	});
	await jobs.send(surveyJob, { siteId: scope.site.id, fileId: row.id });
	return row;
}

/** The SHA-256 of a file's parts' hashes, each as its 32 bytes, in order: what `finishUpload` checks. */
export function partsHash(parts: readonly string[]): string {
	const hash = createHash("sha256");
	for (const part of parts) hash.update(Buffer.from(part, "hex"));
	return hash.digest("hex");
}

/** A part's key in storage. */
export function partKey(row: Pick<FileRow, "key">, index: number): string {
	return `${row.key}/part-${String(index + 1).padStart(6, "0")}`;
}

/** A file the scope's person uploaded and no run took yet, locked for the change; `ImportFileNotFoundError` otherwise. */
async function lockedOwnFile(scope: SiteScope, fileId: string): Promise<FileRow> {
	const [row] = isUuid(fileId)
		? await scope.db
				.select()
				.from(importFiles)
				.where(
					scope.where(
						importFiles,
						and(eq(importFiles.id, fileId), eq(importFiles.uploadedBy, actingPerson(scope.access.actor))),
					),
				)
				.for("update")
		: [];
	if (!row || row.expiresAt.getTime() <= scope.now().getTime()) throw new ImportFileNotFoundError();
	return row;
}

/** A file uploaded in parts as one stream, part after part; null when storage lost a part. */
export async function streamParts(
	storage: InstallStorage,
	row: Pick<FileRow, "storage" | "key" | "parts">,
): Promise<ReadableStream<Uint8Array> | null> {
	const backend = await storage.holding(row.storage as "disk" | "s3");
	const count = (row.parts as string[]).length;
	let index = 0;
	/** Whatever reader a runtime's stream gives (Bun's and Node's differ in their types, not their use). */
	let current: { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(): Promise<void> } | null = null;
	const first = await backend.stream(partKey(row, 0));
	if (!first && count > 0) return null;
	current = first?.getReader() ?? null;
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			while (current) {
				const { done, value } = await current.read();
				if (!done && value) {
					controller.enqueue(value);
					return;
				}
				index++;
				if (index >= count) break;
				const next = await backend.stream(partKey(row, index));
				if (!next) {
					controller.error(new Error("A part of the file is missing from storage."));
					return;
				}
				current = next.getReader();
			}
			controller.close();
		},
		async cancel() {
			await current?.cancel().catch(() => {});
		},
	});
}

/** A file name as people see it: no folders before it, no control characters, at most 255 characters. */
function cleanFileName(name: string, extension: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed.
	const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return clean.slice(0, 255) || `file${extension}`;
}
