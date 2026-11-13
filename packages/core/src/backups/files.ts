import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type pg from "pg";

import { keyParts, StorageError } from "../media/storage.ts";

/** A file of local storage a Backup holds: its storage key, its path on disk and its size. */
export type LocalFile = { key: string; path: string; size: number };

/** Where a file of local storage sits in a Backup archive. */
export const FILES_FOLDER = "files/";

/**
 * The storage keys of Media variants kept on local disk, which a Backup leaves out: a restore makes
 * them again from the originals. Read in the dump's snapshot, so they match its rows. An older
 * database without the Media library has none.
 */
export async function localVariantKeys(client: pg.ClientBase): Promise<Set<string>> {
	const exists = await client.query<{ found: string | null }>("SELECT to_regclass('public.media_files') AS found");
	if (!exists.rows[0]?.found) return new Set();
	const { rows } = await client.query<{ key: string }>(
		"SELECT DISTINCT key FROM public.media_files WHERE role = 'variant' AND storage = 'disk'",
	);
	return new Set(rows.map((row) => row.key));
}

/**
 * Every file in local storage a Backup holds: Media originals and uploads waiting for the worker,
 * Library files, files waiting for an Import, Form uploads, everything but Media variants and the
 * half-written files a write leaves while it runs.
 */
export async function listLocalFiles(storageDir: string, leaveOut: ReadonlySet<string>): Promise<LocalFile[]> {
	const files: LocalFile[] = [];
	const walk = async (folder: string) => {
		let entries: import("node:fs").Dirent[];
		try {
			entries = await readdir(folder, { withFileTypes: true });
		} catch (error) {
			if ((error as { code?: unknown }).code === "ENOENT") return;
			throw error;
		}
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
			const path = join(folder, entry.name);
			if (entry.isDirectory()) {
				await walk(path);
				continue;
			}
			if (!entry.isFile() || entry.name.endsWith(".partial")) continue;
			const key = relative(storageDir, path).split(sep).join("/");
			if (key.startsWith("webcraft-check/") || leaveOut.has(key) || !isKey(key)) continue;
			try {
				files.push({ key, path, size: (await stat(path)).size });
			} catch (error) {
				// Deleted since the folder was read.
				if ((error as { code?: unknown }).code !== "ENOENT") throw error;
			}
		}
	};
	await walk(storageDir);
	return files;
}

/**
 * Opens a file of local storage to copy it: its size now and its content. Null when it was deleted
 * since it was listed (a file emptied from the Trash while the Backup ran).
 */
export async function openLocalFile(
	file: LocalFile,
): Promise<{ size: number; body: AsyncIterable<Uint8Array> } | null> {
	let handle: import("node:fs/promises").FileHandle;
	try {
		handle = await open(file.path, "r");
	} catch (error) {
		if ((error as { code?: unknown }).code === "ENOENT") return null;
		throw error;
	}
	const { size } = await handle.stat();
	// The stream closes the file once it has been read.
	return { size, body: handle.createReadStream({ end: Math.max(size - 1, 0), start: 0 }) as AsyncIterable<Uint8Array> };
}

/**
 * Writes a file from a Backup into local storage, at its key, without holding it in memory: beside
 * its final name first, then renamed, as the storage itself writes.
 */
export async function restoreLocalFile(
	storageDir: string,
	key: string,
	content: AsyncIterable<Uint8Array>,
): Promise<void> {
	const path = join(storageDir, ...keyParts(key));
	await mkdir(dirname(path), { recursive: true });
	const partial = `${path}.${crypto.randomUUID()}.partial`;
	try {
		await pipeline(Readable.from(content), createWriteStream(partial));
		await rename(partial, path);
	} catch (error) {
		await rm(partial, { force: true });
		throw error;
	}
}

function isKey(key: string): boolean {
	try {
		keyParts(key);
		return true;
	} catch (error) {
		if (error instanceof StorageError) return false;
		throw error;
	}
}
