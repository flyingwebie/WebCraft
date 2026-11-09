// CSV files for an Import: what reading one finds (its columns, its first row, how many rows, its
// separator), the encodings and shapes it takes (UTF-8 with or without a byte order mark, commas,
// semicolons or tabs, quoted fields holding separators, quotes and line breaks), what it refuses with
// a clear reason, and that the file stays private: never in the Media library, never served.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let editor: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

const csv = (text: string, name = "products.csv") => upload(text, name, "text/csv");

describe("reading a CSV file", () => {
	test("finds its columns with the first row's values, how many rows it has and its separator", async () => {
		const { file } = await editor.api.imports.uploadCsv({
			siteId,
			file: csv("name,sku,price\nPumpkin loaf,PK-700,5.50\nSeeded rye,RY-650,5.20\n"),
		});

		expect(file).toMatchObject({
			fileName: "products.csv",
			rows: 2,
			separator: "comma",
			byteOrderMark: false,
			columns: [
				{ name: "name", first: "Pumpkin loaf" },
				{ name: "sku", first: "PK-700" },
				{ name: "price", first: "5.50" },
			],
		});
		expect(file.sizeBytes).toBe(63);
	});

	test("takes UTF-8 with a byte order mark, semicolons and Windows line ends", async () => {
		const { file } = await editor.api.imports.uploadCsv({
			siteId,
			file: csv("﻿nome;prezzo\r\nCrème brûlée;3,20\r\nFocaccia;6,00\r\n"),
		});

		expect(file).toMatchObject({
			rows: 2,
			separator: "semicolon",
			byteOrderMark: true,
			columns: [
				{ name: "nome", first: "Crème brûlée" },
				{ name: "prezzo", first: "3,20" },
			],
		});
	});

	test("takes tabs, and quoted fields holding separators, quotes and line breaks", async () => {
		const { file } = await editor.api.imports.uploadCsv({
			siteId,
			file: csv('title\tdescription\n"Rye, seeded"\t"A ""dense"" loaf.\nBaked in tins."\nBrioche\tSoft\n', "x.tsv"),
		});

		expect(file).toMatchObject({
			rows: 2,
			separator: "tab",
			columns: [
				{ name: "title", first: "Rye, seeded" },
				{ name: "description", first: 'A "dense" loaf.\nBaked in tins.' },
			],
		});
	});

	test("skips empty lines, and reads a file without a final line break", async () => {
		const { file } = await editor.api.imports.uploadCsv({
			siteId,
			file: csv("name\n\nPumpkin loaf\n\nSeeded rye"),
		});

		expect(file).toMatchObject({ rows: 2, columns: [{ name: "name", first: "Pumpkin loaf" }] });
	});
});

describe("refusing a CSV file", () => {
	const refused = (file: File, reason: string, data: Record<string, unknown> = {}) =>
		expect(editor.api.imports.uploadCsv({ siteId, file })).rejects.toMatchObject({
			code: "IMPORT_FILE_REFUSED",
			data: { reason, ...data },
		});

	test("in another encoding than UTF-8: UTF-16, or bytes that aren't UTF-8", async () => {
		const utf16 = new Uint8Array([0xff, 0xfe, ...new TextEncoder().encode("n\0a\0m\0e\0")]);
		await refused(upload(utf16, "utf16.csv"), "encoding");
		// "Crème" in Latin-1.
		const latin1 = new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x43, 0x72, 0xe8, 0x6d, 0x65, 0x0a]);
		await refused(upload(latin1, "latin1.csv"), "encoding");
	});

	test("without rows, or without a header naming every column once", async () => {
		await refused(csv(""), "empty");
		await refused(csv("name,price\n"), "empty");
		await refused(csv("name,,price\nA,B,C\n"), "header", { column: 2 });
		await refused(csv("name,price,Name\nA,1,B\n"), "header", { column: 3 });
	});

	test("with a quote that never closes", async () => {
		await refused(csv('name,description\nRye,"A dense loaf\nBrioche,Soft\n'), "quote", { row: 2 });
	});

	test("with more rows or columns than an Import takes", async () => {
		const rows = Array.from({ length: 10_001 }, (_, index) => `Loaf ${index}`).join("\n");
		await refused(csv(`name\n${rows}\n`), "rows", { max: 10_000 });
		const header = Array.from({ length: 201 }, (_, index) => `c${index}`).join(",");
		await refused(csv(`${header}\n${"x,".repeat(200)}x\n`), "columns", { max: 200 });
	});

	test("larger than 10 MB, before reading it", async () => {
		const big = csv(`name\n${"x".repeat(10 * 1024 * 1024)}\n`);
		await expect(editor.api.imports.uploadCsv({ siteId, file: big })).rejects.toMatchObject({
			code: "IMPORT_FILE_REFUSED",
			status: 413,
			data: { reason: "size", maxBytes: 10 * 1024 * 1024 },
		});
	});
});

describe("who uploads, and where the file goes", () => {
	test("an Author can't: importing is for Staff, Owners and Editors", async () => {
		const author = (await install.createMember({ workspaceId, role: "author" })).browser;
		await expect(author.api.imports.uploadCsv({ siteId, file: csv("name\nRye\n") })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("the file is private: it never joins the Media library and the Site never serves it", async () => {
		await editor.api.imports.uploadCsv({ siteId, file: csv("name\nSecret recipe\n", "secret-recipes.csv") });

		expect((await editor.api.media.list({ siteId })).items).toEqual([]);
		const stored = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: install.storageDir }));
		const kept = stored.filter((path) => path.includes("/imports/"));
		expect(kept.length).toBeGreaterThan(0);
		for (const path of kept) {
			const name = path.split("/").at(-1);
			const response = await install.request(`https://bakery.sites.test/_media/${name}`);
			expect(response.status).toBe(404);
			expect(path).not.toContain("/media/");
		}
	});
});
