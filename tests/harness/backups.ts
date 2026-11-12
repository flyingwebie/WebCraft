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

/** Writes a copy of a Backup cut off `bytes` before its end: a download that stopped, a disk that filled up. */
export function cutShort(archive: string, copy: string, bytes: number) {
	const whole = readFileSync(archive);
	writeFileSync(copy, whole.subarray(0, whole.length - bytes));
}

/** Writes a copy of a Backup with one more file at `path`, before the archive's end marker. */
export function withExtraFile(archive: string, copy: string, path: string, content: string) {
	const whole = readFileSync(archive);
	const body = Buffer.from(content);
	const header = Buffer.alloc(512);
	header.write(path, 0, 100, "latin1");
	header.write("0000644\0", 100, "latin1");
	header.write("0000000\0", 108, "latin1");
	header.write("0000000\0", 116, "latin1");
	header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
	header.write("00000000000\0", 136, "latin1");
	header.write("        ", 148, "latin1");
	header.write("0", 156, "latin1");
	header.write("ustar\0", 257, "latin1");
	header.write("00", 263, "latin1");
	let sum = 0;
	for (const byte of header) sum += byte;
	header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
	const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
	// The end marker is the archive's last two empty blocks.
	const end = whole.length - 1024;
	writeFileSync(copy, Buffer.concat([whole.subarray(0, end), header, body, padding, whole.subarray(end)]));
}
