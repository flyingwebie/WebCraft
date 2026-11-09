// Helpers for Backup tests: reading an archive's manifest, and a Backup "from a newer WebCraft" made
// by rewriting a real Backup's manifest, since a test can't run a newer version. Archives are plain
// tar files with the manifest first (see docs/development.md › Backups).
import { readFileSync, writeFileSync } from "node:fs";

/** A Backup's manifest as JSON, with the parts tests read typed. */
export type ArchiveManifest = Record<string, unknown> & {
	webcraft: { version: string };
	masterKey: { fingerprint: string };
};

/** The manifest of a Backup archive, as JSON. */
export function manifestOf(archive: string): ArchiveManifest {
	const bytes = readFileSync(archive);
	const size = Number.parseInt(bytes.subarray(124, 136).toString().replace(/\0.*$/, "").trim(), 8);
	return JSON.parse(bytes.subarray(512, 512 + size).toString());
}

/** Writes a copy of a Backup whose manifest `change` rewrote, everything else as it was. */
export function withManifest(archive: string, copy: string, change: (manifest: ReturnType<typeof manifestOf>) => void) {
	const bytes = readFileSync(archive);
	const size = Number.parseInt(bytes.subarray(124, 136).toString().replace(/\0.*$/, "").trim(), 8);
	const manifest = manifestOf(archive);
	change(manifest);
	const body = Buffer.from(`${JSON.stringify(manifest, null, "\t")}\n`);
	const header = Buffer.from(bytes.subarray(0, 512));
	header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
	header.write("        ", 148, "latin1");
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
	const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
	const rest = bytes.subarray(512 + size + ((512 - (size % 512)) % 512));
	writeFileSync(copy, Buffer.concat([header, body, padding, rest]));
}
