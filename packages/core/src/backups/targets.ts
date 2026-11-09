import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type { Clock } from "../clock.ts";
import type { OutgoingHttp } from "../http.ts";
import { refused, type S3Settings, s3Client } from "../media/s3-storage.ts";
import { StorageError } from "../media/storage.ts";

/** Where Backups go: the Backups folder, a bucket, or a file a command named. */
export type BackupTargetKind = "folder" | "s3" | "file";

/** Somewhere Backup archives are written. */
export type BackupTarget = {
	readonly kind: BackupTargetKind;
	/** Where an archive with this name is written, for the Backup log and the command's output. */
	location(name: string): string;
	/** Writes an archive from its bytes as they are made, never holding it whole; answers its size. */
	write(name: string, bytes: AsyncIterable<Uint8Array>): Promise<number>;
	/** Removes an archive (the keep rules); one that is already gone is fine. */
	remove(name: string): Promise<void>;
};

/** The Backups folder (`WEBCRAFT_BACKUP_DIR`): each archive is written beside its name, then renamed. */
export function folderTarget(folder: string): BackupTarget {
	return {
		kind: "folder",
		location: (name) => join(folder, name),
		async write(name, bytes) {
			await mkdir(folder, { recursive: true });
			return writeFile(join(folder, name), bytes);
		},
		async remove(name) {
			await rm(join(folder, name), { force: true });
		},
	};
}

/**
 * A path `webcraft admin backup --to` named: an existing folder takes the archive under its own
 * name, anything else is the archive's file name.
 */
export async function fileTarget(path: string): Promise<BackupTarget> {
	const full = resolve(path);
	const isFolder = await stat(full).then(
		(found) => found.isDirectory(),
		() => false,
	);
	const pathOf = (name: string) => (isFolder ? join(full, name) : full);
	return {
		kind: "file",
		location: pathOf,
		async write(name, bytes) {
			await mkdir(dirname(pathOf(name)), { recursive: true });
			return writeFile(pathOf(name), bytes);
		},
		async remove(name) {
			await rm(pathOf(name), { force: true });
		},
	};
}

async function writeFile(path: string, bytes: AsyncIterable<Uint8Array>): Promise<number> {
	const partial = `${path}.partial`;
	let size = 0;
	const counted = async function* () {
		for await (const chunk of bytes) {
			size += chunk.length;
			yield chunk;
		}
	};
	try {
		await pipeline(Readable.from(counted()), createWriteStream(partial));
		await rename(partial, path);
	} catch (error) {
		await rm(partial, { force: true });
		throw error;
	}
	return size;
}

/** How big each part of an upload to a bucket is (the last can be smaller): up to 320 GB in 10,000 parts. */
const PART_BYTES = 32 * 1024 * 1024;

/** Backups go into a folder of the bucket, under the bucket's prefix: `<prefix>/<name>`. */
export const BUCKET_FOLDER = "backups";

/**
 * An S3-compatible bucket, written to with a multipart upload, so an archive of any size goes up a
 * part at a time. A failed upload is aborted, so the bucket keeps no half-written archive.
 */
export function s3Target(options: {
	settings: S3Settings;
	http: OutgoingHttp;
	clock: Clock;
	withSecret<Result>(use: (secretAccessKey: string) => Promise<Result>): Promise<Result>;
}): BackupTarget {
	const client = s3Client(options);
	const keyOf = (name: string) => `${BUCKET_FOLDER}/${name}`;
	const location = (name: string) => {
		const prefix = options.settings.prefix.replace(/^\/+|\/+$/g, "");
		return `s3://${options.settings.bucket}/${prefix ? `${prefix}/` : ""}${keyOf(name)}`;
	};
	return {
		kind: "s3",
		location,
		async write(name, bytes) {
			const key = keyOf(name);
			const started = await client.send("POST", key, {
				query: { uploads: "" },
				headers: { "content-type": "application/x-tar" },
			});
			if (!started.ok) throw await refused(started, "start an upload");
			const uploadId = /<UploadId>([^<]+)<\/UploadId>/.exec(await started.text())?.[1];
			if (!uploadId) throw new StorageError("The bucket started an upload without saying its id.");
			const parts: { number: number; etag: string }[] = [];
			let size = 0;
			try {
				for await (const part of inParts(bytes, PART_BYTES)) {
					const number = parts.length + 1;
					const response = await client.send("PUT", key, {
						query: { partNumber: String(number), uploadId },
						body: part,
					});
					if (!response.ok) throw await refused(response, "store part of a Backup");
					await response.body?.cancel();
					const etag = response.headers.get("etag");
					if (!etag) throw new StorageError("The bucket stored part of a Backup without saying its ETag.");
					parts.push({ number, etag });
					size += part.length;
				}
				const list = parts
					.map((part) => `<Part><PartNumber>${part.number}</PartNumber><ETag>${escapeXml(part.etag)}</ETag></Part>`)
					.join("");
				const done = await client.send("POST", key, {
					query: { uploadId },
					body: new TextEncoder().encode(`<CompleteMultipartUpload>${list}</CompleteMultipartUpload>`),
					headers: { "content-type": "application/xml" },
				});
				// A bucket can answer 200 and still say the upload failed.
				const answer = await done.text();
				if (!done.ok || answer.includes("<Error>")) {
					const code = /<Code>([^<]+)<\/Code>/.exec(answer)?.[1];
					throw new StorageError(`The bucket refused to finish the upload: ${done.status}${code ? ` ${code}` : ""}.`);
				}
			} catch (error) {
				await client
					.send("DELETE", key, { query: { uploadId } })
					.then((response) => response.body?.cancel())
					.catch(() => {});
				throw error;
			}
			return size;
		},
		async remove(name) {
			const response = await client.send("DELETE", keyOf(name));
			await response.body?.cancel();
			if (!response.ok && response.status !== 404) {
				throw new StorageError(`The bucket refused to remove a Backup: ${response.status}.`);
			}
		},
	};
}

/** Regroups chunks into parts of `size` bytes (the last one smaller); one empty part for no bytes. */
async function* inParts(bytes: AsyncIterable<Uint8Array>, size: number): AsyncGenerator<Uint8Array> {
	let part = new Uint8Array(size);
	let filled = 0;
	let sent = false;
	for await (const chunk of bytes) {
		let offset = 0;
		while (offset < chunk.length) {
			const taken = Math.min(size - filled, chunk.length - offset);
			part.set(chunk.subarray(offset, offset + taken), filled);
			filled += taken;
			offset += taken;
			if (filled === size) {
				yield part;
				sent = true;
				part = new Uint8Array(size);
				filled = 0;
			}
		}
	}
	if (filled > 0 || !sent) yield part.subarray(0, filled);
}

function escapeXml(text: string): string {
	return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}
