// How a CSV Import reads each cell: through its Field type's own reading of text. Numbers with a dot
// or a comma, true/false words, dates, choices by value or label, Relationships by slug or title,
// files by their https address (fetched through Import from URL), a Body as plain paragraphs, and
// Fields inside Groups. A cell a Field can't take is left out and listed at its row and column.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { photo } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { csvSettings, importCsv } from "./support.ts";

const PUBLIC = "93.184.216.34";

let install: TestInstall;
let siteId: string;
let staff: TestBrowser;
let editor: TestBrowser;
let image: Uint8Array;

beforeAll(async () => {
	install = await createTestInstall({ mediaImportTimeoutMs: 1500 });
	const workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	image = await photo({ width: 400, height: 300 });
	install.dns.answer("photos.example", [PUBLIC]);
});

afterAll(async () => {
	await install.close();
});

let postTypes = 0;

/** A new Post Type for one test, with these Fields. */
async function postTypeWith(fields: Parameters<typeof staff.api.postTypes.create>[0]["fields"]) {
	const key = `things${++postTypes}`;
	const { postType } = await staff.api.postTypes.create({ siteId, name: key, urlPattern: `/${key}/{slug}`, fields });
	return postType;
}

/** The Drafts of a Post Type by title: their Field values. */
async function draftsOf(postTypeId: string) {
	const { entries } = await editor.api.entries.list({ siteId, postTypeId });
	return Object.fromEntries(entries.map((entry) => [entry.draft.title, entry.draft.fields]));
}

describe("each Field type reads a cell", () => {
	test("numbers with a dot or a comma, true/false words, dates, choices by value or label, email and links", async () => {
		const postType = await postTypeWith([
			{ key: "price", label: "Price", type: "number" },
			{ key: "vegan", label: "Vegan", type: "boolean" },
			{ key: "baked", label: "Baked", type: "date" },
			{ key: "at", label: "At", type: "date", mode: "dateTime" },
			{
				key: "allergens",
				label: "Allergens",
				type: "select",
				multiple: true,
				options: [
					{ value: "gluten", label: "Gluten" },
					{ value: "seeds", label: "Sesame seeds" },
				],
			},
			{ key: "contact", label: "Contact", type: "email" },
			{ key: "more", label: "More", type: "link" },
		]);
		const columns = ["title", "price", "vegan", "baked", "at", "allergens", "contact", "more"];
		const { run } = await importCsv(
			install,
			editor.api,
			siteId,
			csvSettings(
				postType.id,
				columns.map((column) => ({ column, to: column === "title" ? "title" : `fields.${column}` })),
			),
			[
				columns.join(","),
				'Rye,"5,20",yes,2026-03-02,2026-03-02 09:30,"gluten; Sesame seeds",Bakery@Example.com,https://bakery.example/rye',
				"Brioche,-3,No,2026-01-31,2026-01-31T10:00:00+01:00,,,/brioche",
			].join("\n"),
		);

		expect(run).toMatchObject({ status: "done", counts: { created: 2, problemRows: 0 } });
		expect(await draftsOf(postType.id)).toEqual({
			Rye: {
				price: 5.2,
				vegan: true,
				baked: "2026-03-02",
				at: "2026-03-02T09:30:00Z",
				allergens: ["gluten", "seeds"],
				contact: "bakery@example.com",
				more: { url: "https://bakery.example/rye", text: "" },
			},
			Brioche: {
				price: -3,
				vegan: false,
				baked: "2026-01-31",
				at: "2026-01-31T09:00:00Z",
				allergens: [],
				contact: null,
				more: { url: "/brioche", text: "" },
			},
		});
	});

	test("a Body as plain paragraphs, rich text as HTML, and Fields inside a Group", async () => {
		const postType = await postTypeWith([
			{ key: "body", label: "Body", type: "body" },
			{ key: "summary", label: "Summary", type: "richText" },
			{
				key: "origin",
				label: "Origin",
				type: "group",
				fields: [
					{ key: "city", label: "City", type: "text" },
					{ key: "country", label: "Country", type: "text" },
				],
			},
		]);
		await importCsv(
			install,
			editor.api,
			siteId,
			csvSettings(postType.id, [
				{ column: "title", to: "title" },
				{ column: "description", to: "fields.body" },
				{ column: "summary", to: "fields.summary" },
				{ column: "city", to: "fields.origin.city" },
			]),
			'title,description,summary,city\nRye,"A dense loaf.\nBaked in tins.\n\n<b>Not bold</b> here.",<p>Our <strong>best</strong> loaf</p><script>x</script>,Dublin\n',
		);

		const rye = (await draftsOf(postType.id)).Rye;
		expect(rye?.body).toEqual([
			{ id: expect.any(String), type: "paragraph", text: [{ text: "A dense loaf.\nBaked in tins." }] },
			{ id: expect.any(String), type: "paragraph", text: [{ text: "<b>Not bold</b> here." }] },
		]);
		expect(rye?.summary).toBe("<p>Our <strong>best</strong> loaf</p>");
		expect(rye?.origin).toEqual({ city: "Dublin", country: null });
	});

	test("Relationships find Entries by slug or title; several separated by semicolons", async () => {
		const categories = await postTypeWith([]);
		for (const title of ["Breads", "Cakes", "Sweet breads"]) {
			await editor.api.entries.create({ siteId, postTypeId: categories.id, title });
		}
		const postType = await postTypeWith([
			{ key: "categories", label: "Categories", type: "relationship", postTypes: [categories.key], multiple: true },
		]);
		const ids: Record<string, string> = Object.fromEntries(
			(await editor.api.entries.list({ siteId, postTypeId: categories.id })).entries.map((entry) => [
				entry.draft.title,
				entry.id,
			]),
		);

		const { run } = await importCsv(
			install,
			editor.api,
			siteId,
			csvSettings(postType.id, [
				{ column: "title", to: "title" },
				{ column: "categories", to: "fields.categories" },
			]),
			"title,categories\nRye,breads; SWEET BREADS\nTart,Cakes\nPie,Pies\n",
		);

		expect(await draftsOf(postType.id)).toEqual({
			Rye: { categories: [ids.Breads as string, ids["Sweet breads"] as string] },
			Tart: { categories: [ids.Cakes as string] },
			Pie: { categories: [] },
		});
		expect(run.problems).toEqual([{ row: 4, column: "categories", rule: "entryNotFound", params: { name: "Pies" } }]);
	});

	test("files given by their https address are fetched into the Media library once, and the same address is reused", async () => {
		install.http.respond("GET", "https://photos.example/rye.jpg", {
			body: image,
			headers: { "content-type": "image/jpeg" },
		});
		const postType = await postTypeWith([{ key: "photo", label: "Photo", type: "media" }]);
		const before = install.http.requests.length;

		const { run } = await importCsv(
			install,
			editor.api,
			siteId,
			csvSettings(postType.id, [
				{ column: "title", to: "title" },
				{ column: "photo", to: "fields.photo" },
			]),
			"title,photo\nRye,https://photos.example/rye.jpg\nRye again,https://photos.example/rye.jpg\n",
		);

		expect(install.http.requests.slice(before).map((call) => [call.url, call.address])).toEqual([
			["https://photos.example/rye.jpg", PUBLIC],
		]);
		expect(run).toMatchObject({ status: "done", files: 1, counts: { created: 2, problemRows: 0 } });
		const drafts = await draftsOf(postType.id);
		const { items } = await editor.api.media.list({ siteId });
		const fetched = items.find((item) => item.fileName === "rye.jpg");
		expect(fetched).toMatchObject({ kind: "image", status: "ready" });
		const photoId = fetched?.id ?? "";
		expect(drafts).toEqual({ Rye: { photo: photoId }, "Rye again": { photo: photoId } });
	});

	test("a file of the Media library by its id", async () => {
		const postType = await postTypeWith([{ key: "photo", label: "Photo", type: "media" }]);
		install.http.respond("GET", "https://photos.example/brioche.jpg", { body: image });
		const { media } = await editor.api.media.importUrl({ siteId, url: "https://photos.example/brioche.jpg" });

		await importCsv(
			install,
			editor.api,
			siteId,
			csvSettings(postType.id, [
				{ column: "title", to: "title" },
				{ column: "photo", to: "fields.photo" },
			]),
			`title,photo\nBrioche,${media.id}\n`,
		);

		expect(await draftsOf(postType.id)).toEqual({ Brioche: { photo: media.id } });
	});
});

describe("a cell a Field can't take", () => {
	test("is left out and listed at its row and column with its rule; the rest of the row comes in", async () => {
		const postType = await postTypeWith([
			{ key: "price", label: "Price", type: "number" },
			{ key: "vegan", label: "Vegan", type: "boolean" },
			{ key: "baked", label: "Baked", type: "date" },
			{ key: "size", label: "Size", type: "select", options: [{ value: "small", label: "Small" }] },
			{ key: "photo", label: "Photo", type: "media" },
		]);
		install.http.respond("GET", "https://photos.example/missing.jpg", { status: 404 });

		const { run } = await importCsv(
			install,
			editor.api,
			siteId,
			csvSettings(postType.id, [
				{ column: "name", to: "title" },
				{ column: "price", to: "fields.price" },
				{ column: "vegan", to: "fields.vegan" },
				{ column: "baked", to: "fields.baked" },
				{ column: "size", to: "fields.size" },
				{ column: "photo", to: "fields.photo" },
			]),
			[
				"name,price,vegan,baked,size,photo",
				"Rye,5.50 €,maybe,02/03/2026,Huge,http://photos.example/rye.jpg",
				"Tart,4,yes,2026-03-02,small,https://photos.example/missing.jpg",
				"Pie,3,,,,ftp://photos.example/pie.jpg",
			].join("\n"),
		);

		expect(run).toMatchObject({ status: "done", counts: { created: 3, problemRows: 3 }, problemsTotal: 7 });
		expect(run.problems).toEqual([
			{ row: 2, column: "price", rule: "number", params: null },
			{ row: 2, column: "vegan", rule: "boolean", params: null },
			{ row: 2, column: "baked", rule: "date", params: null },
			{ row: 2, column: "size", rule: "choice", params: { value: "Huge" } },
			{ row: 2, column: "photo", rule: "mediaAddress", params: null },
			{ row: 3, column: "photo", rule: "notFetched", params: { problem: "status", status: 404 } },
			{ row: 4, column: "photo", rule: "mediaAddress", params: null },
		]);
		expect(await draftsOf(postType.id)).toEqual({
			Rye: { price: null, vegan: false, baked: null, size: null, photo: null },
			Tart: { price: 4, vegan: true, baked: "2026-03-02", size: "small", photo: null },
			Pie: { price: 3, vegan: false, baked: null, size: null, photo: null },
		});
	});

	test("a file from an address inside a network is refused by the guarded fetcher", async () => {
		install.dns.answer("intranet.example", ["10.0.0.5"]);
		const postType = await postTypeWith([{ key: "photo", label: "Photo", type: "media" }]);
		const before = install.http.requests.length;

		const { run } = await importCsv(
			install,
			editor.api,
			siteId,
			csvSettings(postType.id, [
				{ column: "title", to: "title" },
				{ column: "photo", to: "fields.photo" },
			]),
			"title,photo\nLogo,https://intranet.example/logo.png\n",
		);

		expect(install.http.requests.slice(before)).toEqual([]);
		expect(run.problems).toEqual([{ row: 2, column: "photo", rule: "notFetched", params: { problem: "address" } }]);
	});
});
