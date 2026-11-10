// Site export and Site import as Staff do them in the admin: export a Site (the worker writes it),
// download it through its signed link, upload it into a Workspace in parts, and import it (the worker
// reads it). Archives are plain tar files with the manifest first (see docs/development.md › "Site
// export and import"); `manifestIn` and `withManifest` read and rewrite one, as `backups.ts` does
// for Backups, to make exports "from another WebCraft".
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";

import type { TestBrowser } from "./browser.ts";
import type { TestInstall } from "./index.ts";

/** A passphrase long enough for an export. */
export const PASSPHRASE = "correct horse battery staple";

type ExportView = Awaited<ReturnType<TestBrowser["api"]["siteExports"]["get"]>>["export"];
type ImportView = Awaited<ReturnType<TestBrowser["api"]["siteImports"]["get"]>>["import"];

/** Exports a Site as `browser`'s person and drains the worker: answers the export, written. */
export async function exportSite(
	install: TestInstall,
	browser: TestBrowser,
	siteId: string,
	options: { passphrase?: string | null; includeSubmissions?: boolean } = {},
): Promise<ExportView> {
	const { export: started } = await browser.api.siteExports.start({
		...options,
		siteId,
		passphrase: options.passphrase ?? null,
	});
	const drained = await install.drainJobs();
	if (drained.failed.length > 0) throw new Error(`Jobs failed: ${JSON.stringify(drained.failed)}`);
	return (await browser.api.siteExports.get({ siteId, exportId: started.id })).export;
}

/** Downloads an export through its signed link, as the browser's person: the response as it came. */
export async function downloadExport(install: TestInstall, browser: TestBrowser, view: ExportView): Promise<Response> {
	if (!view.download) throw new Error(`The export has no download link: ${view.status}`);
	return browser.request(install.adminUrl(view.download.url));
}

/** Exports a Site and downloads it: the archive's bytes. */
export async function exportedArchive(
	install: TestInstall,
	browser: TestBrowser,
	siteId: string,
	options: { passphrase?: string | null; includeSubmissions?: boolean } = {},
): Promise<Uint8Array> {
	const view = await exportSite(install, browser, siteId, options);
	const response = await downloadExport(install, browser, view);
	if (response.status !== 200) throw new Error(`The download answered ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

/** Uploads an archive into a Workspace in parts and finishes it: the import, ready (or the refusal thrown). */
export async function uploadArchive(
	browser: Pick<TestBrowser, "api">,
	workspaceId: string,
	bytes: Uint8Array,
	options: { partBytes?: number; fileName?: string } = {},
): Promise<ImportView> {
	const { import: started } = await browser.api.siteImports.startUpload({
		workspaceId,
		fileName: options.fileName ?? "site.tar",
		size: bytes.length,
		...(options.partBytes ? { partBytes: options.partBytes } : {}),
	});
	const hashes: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += started.partBytes) {
		const part = bytes.slice(offset, offset + started.partBytes);
		const sha256 = createHash("sha256").update(part).digest("hex");
		hashes.push(sha256);
		await browser.api.siteImports.uploadPart({
			workspaceId,
			importId: started.id,
			offset,
			sha256,
			part: new File([part], "part"),
		});
	}
	const digest = createHash("sha256");
	for (const hash of hashes) digest.update(Buffer.from(hash, "hex"));
	return (
		await browser.api.siteImports.finishUpload({ workspaceId, importId: started.id, sha256: digest.digest("hex") })
	).import;
}

/** Uploads and imports an archive as a new Site, then drains the worker: answers the import, done or failed. */
export async function importArchive(
	install: TestInstall,
	browser: TestBrowser,
	workspaceId: string,
	bytes: Uint8Array,
	site: { name: string; slug: string; passphrase?: string | null; partBytes?: number },
): Promise<ImportView> {
	const uploaded = await uploadArchive(browser, workspaceId, bytes, { partBytes: site.partBytes });
	await browser.api.siteImports.start({
		workspaceId,
		importId: uploaded.id,
		name: site.name,
		slug: site.slug,
		passphrase: site.passphrase ?? null,
	});
	const drained = await install.drainJobs();
	if (drained.failed.length > 0) throw new Error(`Jobs failed: ${JSON.stringify(drained.failed)}`);
	return (await browser.api.siteImports.get({ workspaceId, importId: uploaded.id })).import;
}

type TarFile = { path: string; data: Uint8Array };

/** Every file of a tar archive, in order (small archives, in tests). */
export function tarFiles(bytes: Uint8Array): TarFile[] {
	const files: TarFile[] = [];
	let offset = 0;
	let longPath: string | null = null;
	while (offset + 512 <= bytes.length) {
		const header = bytes.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) break;
		const text = (from: number, length: number) =>
			Buffer.from(header.subarray(from, from + length))
				.toString("latin1")
				.replace(/\0.*$/s, "");
		const size = Number.parseInt(text(124, 12).trim(), 8);
		const type = text(156, 1);
		const data = bytes.slice(offset + 512, offset + 512 + size);
		offset += 512 + Math.ceil(size / 512) * 512;
		if (type === "x") {
			const record = Buffer.from(data).toString("utf8");
			longPath = /\d+ path=(.*)\n/.exec(record)?.[1] ?? null;
			continue;
		}
		files.push({ path: longPath ?? text(0, 100), data });
		longPath = null;
	}
	return files;
}

/** Writes files as a tar archive again (after a test changed some). */
export function tarOf(files: readonly TarFile[]): Uint8Array {
	const chunks: Buffer[] = [];
	const header = (path: string, size: number, type: string) => {
		const block = Buffer.alloc(512);
		block.write(path.slice(0, 100), 0, "utf8");
		block.write("0000644\0", 100, "latin1");
		block.write("0000000\0", 108, "latin1");
		block.write("0000000\0", 116, "latin1");
		block.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "latin1");
		block.write("00000000000\0", 136, "latin1");
		block.write("        ", 148, "latin1");
		block.write(type, 156, "latin1");
		block.write("ustar\0", 257, "latin1");
		block.write("00", 263, "latin1");
		let sum = 0;
		for (const byte of block) sum += byte;
		block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
		return block;
	};
	const pad = (size: number) => Buffer.alloc((512 - (size % 512)) % 512);
	for (const file of files) {
		if (Buffer.byteLength(file.path) > 100) {
			const rest = ` path=${file.path}\n`;
			let length = Buffer.byteLength(rest) + 1;
			while (String(length).length + Buffer.byteLength(rest) !== length)
				length = String(length).length + Buffer.byteLength(rest);
			const record = Buffer.from(`${length}${rest}`);
			chunks.push(header("PaxHeader", record.length, "x"), record, pad(record.length));
		}
		chunks.push(header(file.path, file.data.length, "0"), Buffer.from(file.data), pad(file.data.length));
	}
	chunks.push(Buffer.alloc(1024));
	return new Uint8Array(Buffer.concat(chunks));
}

/** An archive's manifest, as JSON. */
// biome-ignore lint/suspicious/noExplicitAny: a manifest is read as plain JSON in tests.
export function manifestIn(bytes: Uint8Array): any {
	const [first] = tarFiles(bytes);
	if (first?.path !== "manifest.json") throw new Error("The archive doesn't start with its manifest.");
	return JSON.parse(Buffer.from(first.data).toString("utf8"));
}

/** A table's rows in an archive, as JSON (from its gzip-compressed JSON Lines file). */
export function rowsIn(bytes: Uint8Array, table: string): Record<string, unknown>[] {
	const manifest = manifestIn(bytes);
	const entry = manifest.tables.find((each: { name: string }) => each.name === table);
	if (!entry) return [];
	const file = tarFiles(bytes).find((each) => each.path === entry.file);
	if (!file) return [];
	return Buffer.from(gunzipSync(file.data))
		.toString("utf8")
		.split("\n")
		.filter((line) => line !== "")
		.map((line) => JSON.parse(line));
}

/**
 * A copy of an archive with its manifest and some of its tables rewritten, the checksums made to fit,
 * as an export another WebCraft wrote would be (a test can't run another version).
 */
export function rewritten(
	bytes: Uint8Array,
	change: {
		// biome-ignore lint/suspicious/noExplicitAny: a manifest is plain JSON in tests.
		manifest?: (manifest: any) => void;
		rows?: (table: string, rows: Record<string, unknown>[]) => Record<string, unknown>[] | null;
		/** Tables to add after the archive's own, such as a Module's this Install doesn't have. */
		extraTables?: { name: string; module: string | null; rows: Record<string, unknown>[] }[];
	},
): Uint8Array {
	const files = tarFiles(bytes);
	const manifest = manifestIn(bytes);
	const kept: TarFile[] = [];
	for (const file of files.slice(1)) {
		if (file.path === "files.jsonl.gz") {
			for (const [index, extra] of (change.extraTables ?? []).entries()) {
				const data = new Uint8Array(
					gzipSync(Buffer.from(extra.rows.map((row) => `${JSON.stringify(row)}\n`).join(""))),
				);
				const path = `data/${String(9000 + index)}-${extra.name}.jsonl.gz`;
				manifest.tables.push({
					name: extra.name,
					module: extra.module,
					columns: Object.keys(extra.rows[0] ?? {}),
					rows: extra.rows.length,
					file: path,
					sha256: createHash("sha256").update(data).digest("hex"),
				});
				kept.push({ path, data });
			}
		}
		const entry = manifest.tables.find((each: { file: string }) => each.file === file.path);
		if (entry && change.rows) {
			const rows = Buffer.from(gunzipSync(file.data))
				.toString("utf8")
				.split("\n")
				.filter((line) => line !== "")
				.map((line) => JSON.parse(line));
			const changed = change.rows(entry.name, rows);
			if (changed === null) {
				manifest.tables = manifest.tables.filter((each: { file: string }) => each.file !== file.path);
				continue;
			}
			const data = new Uint8Array(gzipSync(Buffer.from(changed.map((row) => `${JSON.stringify(row)}\n`).join(""))));
			entry.rows = changed.length;
			entry.sha256 = createHash("sha256").update(data).digest("hex");
			kept.push({ path: file.path, data });
			continue;
		}
		kept.push(file);
	}
	change.manifest?.(manifest);
	const manifestData = new Uint8Array(Buffer.from(`${JSON.stringify(manifest, null, "\t")}\n`));
	return tarOf([{ path: "manifest.json", data: manifestData }, ...kept]);
}
