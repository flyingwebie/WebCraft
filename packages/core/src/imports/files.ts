import { importFiles } from "@webcraft/db/schema";
import { and, eq } from "drizzle-orm";

import { isUuid } from "../ids.ts";
import type { InstallStorage } from "../media/install-storage.ts";
import { type StorageKind, siteFolder } from "../media/storage.ts";
import { actingPerson } from "../permissions/can.ts";
import type { BackgroundScope, SiteScope } from "../tenancy/data-layer.ts";
import { CSV_LIMITS, type CsvDetails, CsvRefusedError, readCsvDetails } from "./csv.ts";
import { ImportFileNotFoundError } from "./errors.ts";
import { partKey } from "./uploads.ts";

/** How long an uploaded file waits for a run to take it before it is deleted. */
export const IMPORT_FILE_LIFETIME_MS = 24 * 60 * 60_000;

/** A file uploaded for an Import, as the admin shows it: what reading it found. */
export type ImportFile = CsvDetails & {
	id: string;
	fileName: string;
	sizeBytes: number;
	/** When it is deleted if no run takes it. */
	expiresAt: Date;
};

type FileRow = typeof importFiles.$inferSelect;

/**
 * Takes a CSV file for an Import (open the Site with `import.run`): reads it whole first, refusing a
 * file an Import can't take (`CsvRefusedError`), then keeps it in the Site's private storage folder,
 * apart from the Media library and never served, until a run takes it (or a day passes).
 */
export async function uploadCsv(
	scope: SiteScope,
	storage: InstallStorage,
	upload: { fileName: string; data: Uint8Array },
): Promise<ImportFile> {
	if (upload.data.length > CSV_LIMITS.maxBytes) throw csvTooLarge();
	const details = await readCsvDetails(new Blob([upload.data as Uint8Array<ArrayBuffer>]).stream());
	const id = crypto.randomUUID();
	const target = await storage.current();
	const key = `${siteFolder(scope.site)}/imports/${id}.csv`;
	await target.put(key, upload.data, "text/csv");
	const now = scope.now();
	try {
		const row = await scope.insert(importFiles, {
			id,
			uploadedBy: actingPerson(scope.access.actor),
			fileName: cleanFileName(upload.fileName),
			sizeBytes: upload.data.length,
			storage: target.kind,
			key,
			details,
			createdAt: now,
			expiresAt: new Date(now.getTime() + IMPORT_FILE_LIFETIME_MS),
		});
		return fileView(row);
	} catch (error) {
		await target.delete(key);
		throw error;
	}
}

/** A CSV file over `CSV_LIMITS.maxBytes`. */
export function csvTooLarge(): CsvRefusedError {
	return new CsvRefusedError("size", `An Import takes CSV files of at most ${CSV_LIMITS.maxBytes} bytes.`, {
		maxBytes: CSV_LIMITS.maxBytes,
	});
}

/** A file the scope's person uploaded and no run took yet; `ImportFileNotFoundError` otherwise. */
export async function ownFile(scope: SiteScope, fileId: string): Promise<FileRow> {
	const row = isUuid(fileId)
		? await scope.first(
				importFiles,
				and(eq(importFiles.id, fileId), eq(importFiles.uploadedBy, actingPerson(scope.access.actor))),
			)
		: undefined;
	if (!row || row.expiresAt.getTime() <= scope.now().getTime()) throw new ImportFileNotFoundError();
	return row;
}

/** A stored file as a stream; null when the storage no longer holds it. */
export async function openFile(
	storage: InstallStorage,
	row: Pick<FileRow, "storage" | "key">,
): Promise<ReadableStream<Uint8Array> | null> {
	const backend = await storage.holding(row.storage as StorageKind);
	return backend.stream(row.key);
}

/** Deletes a file: from the storage, then its row. */
export async function deleteFile(
	scope: Pick<SiteScope | BackgroundScope, "delete">,
	storage: InstallStorage,
	row: Pick<FileRow, "id" | "storage" | "key" | "parts" | "partBytes">,
): Promise<void> {
	const backend = await storage.holding(row.storage as StorageKind);
	// A file uploaded in parts is kept as one object per part.
	if (row.partBytes !== null) {
		const parts = (row.parts as string[]).length;
		for (let index = 0; index < parts; index++) await backend.delete(partKey(row, index));
	} else await backend.delete(row.key);
	await scope.delete(importFiles, eq(importFiles.id, row.id));
}

export function fileView(row: FileRow): ImportFile {
	return {
		id: row.id,
		fileName: row.fileName,
		sizeBytes: row.sizeBytes,
		expiresAt: row.expiresAt,
		...(row.details as CsvDetails),
	};
}

/** A file name as people see it: no folders before it, no control characters, at most 255 characters. */
function cleanFileName(name: string): string {
	const base = name.split(/[\\/]/).pop() ?? "";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is removed.
	const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
	return clean.slice(0, 255) || "file.csv";
}
