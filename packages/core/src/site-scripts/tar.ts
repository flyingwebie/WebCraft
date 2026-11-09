/**
 * Reading one file out of a gzipped tar archive, as the npm registry serves packages. Only what that
 * needs: regular files (with POSIX and GNU long names), nothing is written to disk, and the whole
 * archive is read in memory (the guarded fetcher limits its size).
 */

/** An archive unpacks to more than may be read. */
export class ArchiveTooLargeError extends Error {
	override name = "ArchiveTooLargeError";
}

/**
 * The bytes of a gzipped archive, unpacked, at most `maxBytes` of them (`ArchiveTooLargeError`
 * beyond): a small archive can unpack to far more than it weighs.
 */
export async function gunzip(bytes: Uint8Array, maxBytes: number): Promise<Uint8Array> {
	const reader = new Blob([bytes as Uint8Array<ArrayBuffer>])
		.stream()
		.pipeThrough(new DecompressionStream("gzip"))
		.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		total += value.byteLength;
		if (total > maxBytes) {
			await reader.cancel();
			throw new ArchiveTooLargeError(`The archive unpacks to more than ${maxBytes} bytes.`);
		}
		chunks.push(value);
	}
	const unpacked = new Uint8Array(total);
	let at = 0;
	for (const chunk of chunks) {
		unpacked.set(chunk, at);
		at += chunk.byteLength;
	}
	return unpacked;
}

/** A file of an archive: its path, as stored, and its bytes. */
export type ArchiveFile = { path: string; bytes: Uint8Array };

/** Every regular file of a tar archive, in the order it holds them. Stops at the end marker or at broken data. */
export function readTar(archive: Uint8Array): ArchiveFile[] {
	const files: ArchiveFile[] = [];
	const decoder = new TextDecoder();
	const text = (from: number, length: number) => {
		const field = archive.subarray(from, from + length);
		const end = field.indexOf(0);
		return decoder.decode(end === -1 ? field : field.subarray(0, end));
	};
	let at = 0;
	let longName: string | null = null;
	while (at + 512 <= archive.length) {
		const header = archive.subarray(at, at + 512);
		if (header.every((byte) => byte === 0)) break;
		const size = Number.parseInt(text(at + 124, 12).trim() || "0", 8);
		if (!Number.isFinite(size) || size < 0) break;
		const type = String.fromCharCode(header[156] ?? 0);
		const prefix = text(at + 345, 155);
		const name = text(at, 100);
		const start = at + 512;
		const body = archive.subarray(start, start + size);
		at = start + Math.ceil(size / 512) * 512;
		if (type === "L") {
			longName = decoder.decode(body).replace(/\0+$/, "");
			continue;
		}
		const path = longName ?? (prefix ? `${prefix}/${name}` : name);
		longName = null;
		if (type === "0" || type === "\0") files.push({ path, bytes: body });
	}
	return files;
}
