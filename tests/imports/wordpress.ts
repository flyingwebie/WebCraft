// Helpers for the WordPress import's tests: the fixture export file, uploading a file in parts the
// way the admin does (each part with its SHA-256, then the SHA-256 of the parts' hashes), and an
// Install where the WordPress import and Redirects Modules run.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { ApiClient } from "@webcraft/api";

import type { TestInstall } from "../harness/index.ts";

/** The WordPress import Module's source. */
export const WORDPRESS = "wordpress-import.export";

/** The made-up bakery's export file. */
export const OLD_MILL = readFileSync(join(import.meta.dir, "fixtures/old-mill-export.xml"), "utf8");

/** A public address the fake DNS gives the made-up old site (the guarded fetcher refuses documentation ranges). */
export const OLD_SITE_ADDRESS = "93.184.216.80";

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The SHA-256 the last call of an upload sends: of the parts' hashes, each as its 32 bytes, in order. */
export function partsDigest(hashes: readonly string[]): string {
	const hash = createHash("sha256");
	for (const each of hashes) hash.update(Buffer.from(each, "hex"));
	return hash.digest("hex");
}

/** Sends a file's parts, from `from` (bytes) to the end; answers each part's hash. */
export async function sendParts(
	api: ApiClient,
	siteId: string,
	file: { id: string; partBytes: number },
	bytes: Uint8Array,
	from = 0,
): Promise<string[]> {
	const hashes: string[] = [];
	for (let offset = 0; offset < bytes.length; offset += file.partBytes) {
		const part = bytes.slice(offset, offset + file.partBytes);
		const hash = sha256(part);
		hashes.push(hash);
		if (offset < from) continue;
		await api.imports.uploadPart({ siteId, fileId: file.id, offset, sha256: hash, part: new File([part], "part") });
	}
	return hashes;
}

/** Uploads an export file in parts (4 KiB, so even a small file comes in several) and finishes it. */
export async function uploadExport(
	api: ApiClient,
	siteId: string,
	text: string | Uint8Array = OLD_MILL,
	options: { name?: string; partBytes?: number } = {},
) {
	const bytes = typeof text === "string" ? new TextEncoder().encode(text) : text;
	const { file } = await api.imports.startUpload({
		siteId,
		source: WORDPRESS,
		fileName: options.name ?? "oldmill.WordPress.2024-03-20.xml",
		size: bytes.length,
		partBytes: options.partBytes ?? 4 * 1024,
	});
	const hashes = await sendParts(api, siteId, file, bytes);
	return (await api.imports.finishUpload({ siteId, fileId: file.id, sha256: partsDigest(hashes) })).file;
}

/** Uploads an export file and lets the worker survey it; answers the surveyed file. */
export async function surveyedExport(
	install: TestInstall,
	api: ApiClient,
	siteId: string,
	text: string | Uint8Array = OLD_MILL,
) {
	const uploaded = await uploadExport(api, siteId, text);
	const drained = await install.drainJobs();
	if (drained.failed.length > 0) throw drained.failed[0]?.error;
	return (await api.imports.file({ siteId, fileId: uploaded.id })).file;
}

/** Approves the WordPress import and Redirects Modules, as the Superadmin does once. */
export async function approveModules(install: TestInstall): Promise<void> {
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "wordpress-import", version: "1.0.0" });
	await admin.api.modules.approve({ moduleId: "redirects", version: "1.1.0" });
}

/** Makes the old site's files answer: each address with its bytes, from a public address. */
export function serveOldSite(install: TestInstall, files: Record<string, Uint8Array>): void {
	install.dns.answer("oldmill.example", [OLD_SITE_ADDRESS]);
	for (const [address, body] of Object.entries(files)) {
		install.http.respond("GET", address, {
			body,
			headers: { "content-type": address.endsWith(".png") ? "image/png" : "image/jpeg" },
		});
	}
}

/** Creates a WordPress Import with its settings, runs it with a surveyed file and lets the worker run it. */
export async function runImport(
	install: TestInstall,
	api: ApiClient,
	siteId: string,
	fileId: string,
	settings: Parameters<ApiClient["imports"]["create"]>[0]["settings"],
	name = "Old bakery site",
) {
	const { import: created } = await api.imports.create({ siteId, name, source: WORDPRESS, settings });
	const { run } = await api.imports.start({ siteId, importId: created.id, fileId });
	const drained = await install.drainJobs();
	if (drained.failed.length > 0) throw drained.failed[0]?.error;
	return { importId: created.id, run: (await api.imports.report({ siteId, runId: run.id })).run };
}
