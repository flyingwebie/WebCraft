// What an import takes: a Site export of this layout or an older one (brought up as it is read), written
// by this WebCraft or an older one. It refuses anything else before reading it in (a file that isn't
// one, a newer layout or WebCraft) and gives up, leaving nothing behind, on a file that is damaged.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

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
let siteId: string;
let archive: Uint8Array;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await admin.api.postTypes.create({ siteId, name: "Blog posts", key: "posts", urlPattern: "/blog/{slug}" });
	archive = await exportedArchive(install, admin, siteId);
});

afterAll(async () => {
	await install?.close();
});

/** A Workspace of its own for each import. */
async function workspace(name: string): Promise<string> {
	return (await install.createWorkspace(name)).id;
}

describe("refused before anything is read in", () => {
	test("a file that isn't a Site export", async () => {
		const workspaceId = await workspace("Refusals 1");
		const notTar = new TextEncoder().encode("<html>not an export</html>".repeat(40));
		await expect(uploadArchive(admin, workspaceId, notTar)).rejects.toMatchObject({
			code: "SITE_IMPORT_REFUSED",
			data: { reason: "not-an-export" },
		});
		const otherTar = tarOf([{ path: "manifest.json", data: new TextEncoder().encode('{"format":"webcraft-backup"}') }]);
		await expect(uploadArchive(admin, workspaceId, otherTar)).rejects.toMatchObject({
			code: "SITE_IMPORT_REFUSED",
			data: { reason: "not-an-export" },
		});
		const { imports } = await admin.api.siteImports.list({ workspaceId });
		expect(imports.map((each) => [each.status, each.refusal?.reason])).toEqual([
			["refused", "not-an-export"],
			["refused", "not-an-export"],
		]);
	});

	test("an export in a newer layout than this WebCraft reads", async () => {
		const newer = rewritten(archive, {
			manifest: (manifest) => {
				manifest.formatVersion = 2;
			},
		});
		await expect(uploadArchive(admin, await workspace("Refusals 2"), newer)).rejects.toMatchObject({
			code: "SITE_IMPORT_REFUSED",
			data: { reason: "newer-format", formatVersion: 2, readable: 1 },
		});
	});

	test("an export written by a newer WebCraft: update this Install first", async () => {
		const newer = rewritten(archive, {
			manifest: (manifest) => {
				manifest.webcraft.version = "99.0.0";
			},
		});
		await expect(uploadArchive(admin, await workspace("Refusals 3"), newer)).rejects.toMatchObject({
			code: "SITE_IMPORT_REFUSED",
			data: { reason: "newer-version", version: "99.0.0" },
		});
	});
});

describe("a damaged export", () => {
	test("fails as it is read in, leaving no Site behind", async () => {
		const workspaceId = await workspace("Damaged");
		const files = tarFiles(archive);
		const postTypes = files.find((file) => file.path.endsWith("-public.post_types.jsonl.gz"));
		const flipped = (data: Uint8Array) => {
			const copy = new Uint8Array(data);
			const middle = Math.floor(copy.length / 2);
			copy[middle] = (copy[middle] ?? 0) ^ 0xff;
			return copy;
		};
		const damaged = tarOf(
			files.map((file) => (file === postTypes ? { path: file.path, data: flipped(file.data) } : file)),
		);
		const imported = await importArchive(install, admin, workspaceId, damaged, { name: "Damaged", slug: "damaged" });
		expect(imported.status).toBe("failed");
		expect(imported.failure?.reason).toBe("damaged");
		expect(imported.site).toBeNull();
		expect((await admin.api.sites.list({ workspaceId })).sites).toEqual([]);
	});
});

describe("an export an older WebCraft wrote", () => {
	test("is brought up as it is read: what didn't exist yet takes its default", async () => {
		const older = rewritten(archive, {
			manifest: (manifest) => {
				manifest.webcraft.version = "0.0.9";
				manifest.migrations = manifest.migrations.filter(
					(name: string) => !/discovery-settings|content-api|site-export/.test(name),
				);
				const postTypes = manifest.tables.find((table: { name: string }) => table.name === "public.post_types");
				postTypes.columns = postTypes.columns.filter((column: string) => column !== "sitemap");
			},
			rows: (table, rows) => {
				// Before discovery settings, Post Types had no sitemap switch; before the Content API, no settings for it.
				if (table === "public.content_api_settings") return null;
				if (table === "public.post_types") return rows.map(({ sitemap: _, ...row }) => row);
				return rows;
			},
		});
		expect(manifestIn(older).tables.map((table: { name: string }) => table.name)).not.toContain(
			"public.content_api_settings",
		);
		const workspaceId = await workspace("Older");
		const imported = await importArchive(install, admin, workspaceId, older, { name: "Older", slug: "older" });

		expect(imported.status).toBe("done");
		expect(imported.report?.from).toMatchObject({ webcraft: "0.0.9", upgraded: true });
		const { postTypes } = await admin.api.postTypes.list({ siteId: imported.site?.id ?? "" });
		expect(postTypes.find((type) => type.key === "posts")?.sitemap).toBe(true);
	});
});

test("exporting an imported Site leaves its Install's transfer jobs and reports behind", async () => {
	const workspaceId = await workspace("Second export");
	const imported = await importArchive(install, admin, workspaceId, archive, { name: "Again", slug: "again" });
	expect(imported.status).toBe("done");
	const copy = await exportedArchive(install, admin, imported.site?.id ?? "");
	const manifest = manifestIn(copy);
	expect(manifest.tables.map((table: { name: string }) => table.name)).not.toContain("public.site_imports");
	expect(manifest.leftOut.tables).toContainEqual({ name: "public.site_imports", reason: "working" });
});
