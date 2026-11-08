import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Where an Install keeps files (ADR 0026): local disk or an S3-compatible bucket, behind one
 * interface. Keys are paths with one folder per Workspace and Site: `<workspace id>/<site id>/media/
 * <name>` for Media that visitors get, `<workspace id>/<site id>/uploads/<media id>` for raw uploads
 * the worker hasn't cleaned yet (never served), and later `…/form-uploads/…` for Form uploads.
 */
export type StorageKind = "disk" | "s3";

/** Bytes `start` to `end` of a file, both included. */
export type ByteRange = { start: number; end: number };

export type StorageBackend = {
	readonly kind: StorageKind;
	/** Stores a file, replacing what the key held. */
	put(key: string, data: Uint8Array, contentType: string): Promise<void>;
	/** A whole file, or null when there is none. */
	read(key: string): Promise<Uint8Array | null>;
	/** A file (or the bytes in `range`) as a stream, or null when there is none. */
	stream(key: string, range?: ByteRange): Promise<ReadableStream<Uint8Array> | null>;
	/** Removes a file; a key that holds none is fine. */
	delete(key: string): Promise<void>;
};

/** Storage that couldn't be reached or refused a request. The message says what it answered. */
export class StorageError extends Error {
	override name = "StorageError";
}

/** The folder of one Site in the storage. */
export function siteFolder(site: { workspaceId: string; id: string }): string {
	return `${site.workspaceId}/${site.id}`;
}

/** A key part: letters, digits, dots, dashes and underscores, never `.` or `..`. */
const KEY_PART = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;

/** The parts of a key, refusing anything that could step outside the storage. */
export function keyParts(key: string): string[] {
	const parts = key.split("/");
	if (parts.length === 0 || !parts.every((part) => KEY_PART.test(part) && part !== "." && part !== "..")) {
		throw new StorageError(`${key} isn't a storage key.`);
	}
	return parts;
}

/** How much of a file a stream reads at a time. */
const CHUNK_BYTES = 256 * 1024;

/** Local disk: files under one folder (`WEBCRAFT_STORAGE_DIR`), which web and worker share. */
export function diskStorage(root: string): StorageBackend {
	const pathOf = (key: string) => join(root, ...keyParts(key));
	return {
		kind: "disk",
		async put(key, data) {
			const path = pathOf(key);
			await mkdir(dirname(path), { recursive: true });
			// Written beside it, then renamed: nobody ever reads half a file.
			const partial = `${path}.${crypto.randomUUID()}.partial`;
			try {
				await writeFile(partial, data);
				await rename(partial, path);
			} catch (error) {
				await rm(partial, { force: true });
				throw error;
			}
		},
		async read(key) {
			try {
				return new Uint8Array(await readFile(pathOf(key)));
			} catch (error) {
				if (isMissing(error)) return null;
				throw error;
			}
		},
		async stream(key, range) {
			const path = pathOf(key);
			let size: number;
			try {
				size = (await stat(path)).size;
			} catch (error) {
				if (isMissing(error)) return null;
				throw error;
			}
			let position = range?.start ?? 0;
			const end = range ? Math.min(range.end + 1, size) : size;
			// The file is opened for each read and closed straight after, so a stream nobody finishes
			// (a visitor who goes away) never keeps a file open.
			return new ReadableStream<Uint8Array>({
				async pull(controller) {
					const length = Math.min(CHUNK_BYTES, end - position);
					if (length <= 0) {
						controller.close();
						return;
					}
					const handle = await open(path, "r");
					try {
						const buffer = new Uint8Array(length);
						const { bytesRead } = await handle.read(buffer, 0, length, position);
						if (bytesRead === 0) {
							controller.close();
							return;
						}
						position += bytesRead;
						controller.enqueue(buffer.subarray(0, bytesRead));
					} finally {
						await handle.close();
					}
				},
			});
		},
		async delete(key) {
			await rm(pathOf(key), { force: true });
		},
	};
}

function isMissing(error: unknown): boolean {
	return (error as { code?: unknown }).code === "ENOENT";
}
