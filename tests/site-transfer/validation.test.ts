// Untrusted Site exports are validated through the HTTP upload and worker, never by calling the reader.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { pdf, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import {
	exportedArchive,
	importArchive,
	manifestIn,
	rewritten,
	tarFiles,
	tarOf,
	uploadArchive,
} from "../harness/site-transfer.ts";

let install: TestInstall;
let admin: TestBrowser;
let archive: Uint8Array;
let serial = 0;
beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace("Source")).id;
	const siteId = (await install.createSite(workspaceId, { name: "Files", slug: "files" })).id;
	for (const name of ["one.pdf", "two.pdf"]) {
		await admin.api.media.upload({ siteId, file: upload(pdf(), name, "application/pdf") });
	}
	archive = await exportedArchive(install, admin, siteId);
});
afterAll(async () => {
	await install?.close();
});

async function refused(bytes: Uint8Array) {
	const workspaceId = (await install.createWorkspace(`Target ${++serial}`)).id;
	const imported = await importArchive(install, admin, workspaceId, bytes, { name: "Copy", slug: `copy-${serial}` });
	expect(imported).toMatchObject({ status: "failed", site: null, failure: { reason: "damaged" } });
	expect((await admin.api.sites.list({ workspaceId })).sites).toEqual([]);
}

test("every listed file must occur exactly once; a duplicate cannot replace a missing file", async () => {
	const files = tarFiles(archive);
	const stored = files.filter((file) => file.path.startsWith("files/"));
	expect(stored).toHaveLength(2);
	await refused(tarOf(files.map((file) => (file === stored[1] ? required(stored[0]) : file))));
});

/** Change a metadata file and its checksum, as a hostile archive author can. */
function changeIndex(change: (files: { key: string; size: number; sha256: string }[]) => void) {
	const files = tarFiles(archive);
	const manifest = manifestIn(archive);
	const index = required(files.find((file) => file.path === "files.jsonl.gz"));
	const rows = gunzipSync(index.data)
		.toString()
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	change(rows);
	index.data = gzipSync(`${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
	manifest.files.sha256 = createHash("sha256").update(index.data).digest("hex");
	required(files[0]).data = Buffer.from(JSON.stringify(manifest));
	return tarOf(files);
}

test("file sizes and totals are checked against the bytes, not trusted from the manifest", async () => {
	await refused(
		changeIndex((files) => {
			required(files[0]).size += 1;
		}),
	);
	await refused(
		rewritten(archive, {
			manifest: (m) => {
				m.files.bytes += 1;
			},
		}),
	);
});

test("a compressed row over 16 MiB is refused without keeping a Site", async () => {
	const large = rewritten(archive, {
		rows: (table, rows) =>
			table === "public.media" ? rows.map((row) => ({ ...row, padding: "x".repeat(16 * 1024 * 1024) })) : rows,
	});
	await refused(large);
});

test("ambiguous manifests and invalid WebCraft versions are refused before import", async () => {
	const workspaceId = (await install.createWorkspace("Manifest checks")).id;
	for (const manifest of [
		(m: ReturnType<typeof manifestIn>) => {
			m.webcraft.version = "not-a-version";
		},
		(m: ReturnType<typeof manifestIn>) => {
			m.tables.push(m.tables[0]);
		},
		(m: ReturnType<typeof manifestIn>) => {
			m.tables[0].module = "unrelated";
		},
	]) {
		await expect(uploadArchive(admin, workspaceId, rewritten(archive, { manifest }))).rejects.toMatchObject({
			code: "SITE_IMPORT_REFUSED",
		});
	}
});

test("stored-file references cannot point outside the Site or at files the archive does not carry", async () => {
	await refused(
		rewritten(archive, {
			rows: (table, rows) =>
				table === "public.media_files" ? rows.map((row) => ({ ...row, key: "outside/private-file.pdf" })) : rows,
		}),
	);
});

test("the people file cannot introduce an Install role as a Member invitation", async () => {
	const files = tarFiles(archive);
	const manifest = manifestIn(archive);
	const people = required(files.find((file) => file.path === "people.jsonl.gz"));
	people.data = gzipSync(
		`${JSON.stringify({
			id: null,
			email: "new@example.com",
			name: "New",
			installRole: null,
			member: null,
			invite: { role: "superadmin" },
			referenced: false,
		})}\n`,
	);
	manifest.people.rows = 1;
	manifest.people.sha256 = createHash("sha256").update(people.data).digest("hex");
	required(files[0]).data = Buffer.from(JSON.stringify(manifest));
	await refused(tarOf(files));
});

test("missing Module data is checked before it is kept aside", async () => {
	const bytes = rewritten(archive, {
		extraTables: [{ name: "m_missing.notes", module: "missing", rows: [{ id: crypto.randomUUID(), value: "kept" }] }],
		manifest: (m) => {
			m.modules.push({ id: "missing", version: "1.0.0", tables: ["notes"] });
			m.tables.find((table: { name: string }) => table.name === "m_missing.notes").rows = 0;
		},
	});
	await refused(bytes);
});

test("tar extension headers are bounded before the manifest is read", async () => {
	const extended = Buffer.from(tarOf([{ path: "PaxHeader", data: Buffer.alloc(64 * 1024 + 1, 32) }]));
	extended[156] = 120; // pax extended header
	extended.fill(32, 148, 156);
	const sum = extended.subarray(0, 512).reduce((total, byte) => total + byte, 0);
	extended.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "latin1");
	const bytes = Buffer.concat([extended.subarray(0, -1024), archive]);
	const workspaceId = (await install.createWorkspace("Header limit")).id;
	await expect(uploadArchive(admin, workspaceId, bytes)).rejects.toMatchObject({ code: "SITE_IMPORT_REFUSED" });
});

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error("The fixture is missing an expected file.");
	return value;
}
