import { createHash } from "node:crypto";

import type { StorageBackend } from "../media/storage.ts";

/**
 * Site export archives and Site import uploads can be many gigabytes, and storage takes a file in one
 * piece. So both are kept as parts, each its own private object under one folder
 * (`<folder>/part-000001`, …), as an Import's source file is, and read back as one stream
 * (`streamParts` in `imports/uploads.ts`).
 */

/** How big each part of an export archive is (the last is smaller), unless the Install says otherwise. */
export const ARCHIVE_PART_BYTES = 32 * 1024 * 1024;

/** A part's key in storage. */
export function partKeyIn(folder: string, index: number): string {
	return `${folder}/part-${String(index + 1).padStart(6, "0")}`;
}

/**
 * Writes bytes as they come into parts of `partBytes` under `folder`, never holding more than one
 * part. Answers each part's SHA-256 (hexadecimal, in order) and the whole size.
 */
export async function writeParts(
	backend: StorageBackend,
	folder: string,
	bytes: AsyncIterable<Uint8Array>,
	partBytes: number,
	onPart?: (written: number) => Promise<void>,
): Promise<{ parts: string[]; size: number }> {
	const parts: string[] = [];
	let size = 0;
	let part = new Uint8Array(partBytes);
	let filled = 0;
	const flush = async () => {
		const data = part.subarray(0, filled);
		await backend.put(partKeyIn(folder, parts.length), data, "application/octet-stream");
		parts.push(createHash("sha256").update(data).digest("hex"));
		size += data.length;
		part = new Uint8Array(partBytes);
		filled = 0;
		await onPart?.(size);
	};
	for await (const chunk of bytes) {
		let offset = 0;
		while (offset < chunk.length) {
			const taken = Math.min(partBytes - filled, chunk.length - offset);
			part.set(chunk.subarray(offset, offset + taken), filled);
			filled += taken;
			offset += taken;
			if (filled === partBytes) await flush();
		}
	}
	if (filled > 0 || parts.length === 0) await flush();
	return { parts, size };
}

/** Removes a folder's parts; ones already gone are fine. */
export async function removeParts(backend: StorageBackend, folder: string, count: number): Promise<void> {
	for (let index = 0; index < count; index++) await backend.delete(partKeyIn(folder, index));
}
