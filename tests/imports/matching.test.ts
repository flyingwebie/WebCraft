// Matching rows to existing Entries: by a chosen Field, the title or the slug. A row matching one
// Entry updates its Draft; a row matching several, or repeating another row's value, is a problem
// row. Run again matches what the Import brought in by its Source id: it updates what nobody touched
// since, skips (and reports) what someone edited, and adds new rows.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { csvSettings, importCsv, runAgain, startRun } from "./support.ts";

let install: TestInstall;
let siteId: string;
let staff: TestBrowser;
let editor: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let count = 0;

/** A new Post Type with a SKU and a price, and the settings mapping `name,sku,price` onto it by SKU. */
async function products() {
	const key = `products${++count}`;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: key,
		urlPattern: `/${key}/{slug}`,
		fields: [
			{ key: "sku", label: "SKU", type: "text" },
			{ key: "price", label: "Price", type: "number" },
		],
	});
	const settings = csvSettings(
		postType.id,
		[
			{ column: "name", to: "title" },
			{ column: "sku", to: "fields.sku" },
			{ column: "price", to: "fields.price" },
		],
		{ match: "fields.sku" },
	);
	return { postType, settings };
}

/** The Drafts of a Post Type by SKU: title, price and status. */
async function bySku(postTypeId: string) {
	const { entries } = await editor.api.entries.list({ siteId, postTypeId });
	return Object.fromEntries(
		entries.map((entry) => [
			entry.draft.fields.sku,
			{ title: entry.draft.title, price: entry.draft.fields.price, status: entry.status },
		]),
	);
}

describe("matching existing Entries", () => {
	test("a row matching one Entry by the chosen Field updates its Draft; published Entries keep what visitors see", async () => {
		const { postType, settings } = await products();
		const { entry: rye } = await editor.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Seeded rye",
			fields: { sku: "RY-650", price: 4.9 },
		});
		await editor.api.entries.publish({ siteId, entryId: rye.id });

		const { run } = await importCsv(
			install,
			editor.api,
			siteId,
			settings,
			"name,sku,price\nSeeded rye,ry-650,5.20\nPumpkin loaf,PK-700,5.50\n",
		);

		expect(run.counts).toMatchObject({ created: 1, updated: 1, problemRows: 0 });
		expect(run.updated).toEqual([{ row: 2, entryId: rye.id, title: "Seeded rye", reason: null }]);
		// Matching ignores case; the row's own values are written, its SKU included.
		expect(await bySku(postType.id)).toEqual({
			"ry-650": { title: "Seeded rye", price: 5.2, status: "changed" },
			"PK-700": { title: "Pumpkin loaf", price: 5.5, status: "draft" },
		});
		const { entry } = await editor.api.entries.get({ siteId, entryId: rye.id });
		expect(entry.published?.fields).toMatchObject({ price: 4.9 });
	});

	test("by the slug, or the title in any case", async () => {
		const { postType, settings } = await products();
		await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Brioche", slug: "brioche-bun" });

		const bySlug = await importCsv(
			install,
			editor.api,
			siteId,
			{ ...settings, match: "slug", columns: [...settings.columns, { column: "slug", to: "slug" }] },
			"name,sku,price,slug\nBrioche buns,BR-1,2,brioche-bun\n",
		);
		expect(bySlug.run.counts).toMatchObject({ created: 0, updated: 1 });

		const byTitle = await importCsv(
			install,
			editor.api,
			siteId,
			{ ...settings, match: "title" },
			"name,sku,price\nBRIOCHE BUNS,BR-1,2.5\n",
		);
		expect(byTitle.run.counts).toMatchObject({ created: 0, updated: 1 });
		expect(await bySku(postType.id)).toEqual({ "BR-1": { title: "BRIOCHE BUNS", price: 2.5, status: "draft" } });
	});

	test("a row matching several Entries, repeating another row's value or without a value is a problem row, never imported", async () => {
		const { postType, settings } = await products();
		for (const title of ["Twin one", "Twin two"]) {
			await editor.api.entries.create({ siteId, postTypeId: postType.id, title, fields: { sku: "TW-1" } });
		}

		const { run } = await importCsv(
			install,
			editor.api,
			siteId,
			settings,
			"name,sku,price\nTwins,TW-1,3\nRye,RY-1,4\nRye again,ry-1,5\nNo SKU,,6\nExtra,EX-1,7,surprise\n",
		);

		expect(run.counts).toMatchObject({ created: 1, updated: 0, problemRows: 4 });
		expect(run.problems).toEqual([
			{ row: 2, column: null, rule: "matchesSeveral", params: { count: 2 } },
			{ row: 4, column: null, rule: "matchedTwice", params: { row: 3 } },
			{ row: 5, column: "sku", rule: "matchMissing", params: null },
			{ row: 6, column: null, rule: "columnCount", params: { columns: 3 } },
		]);
		expect(Object.keys(await bySku(postType.id)).sort()).toEqual(["RY-1", "TW-1"]);
	});
});

describe("Run again", () => {
	test("updates the Entries nobody touched since, skips the ones someone edited, and adds new rows", async () => {
		const { postType, settings } = await products();
		const first = await importCsv(
			install,
			editor.api,
			siteId,
			settings,
			"name,sku,price\nRye,RY-1,4\nBrioche,BR-1,2\nTart,TA-1,3\n",
		);
		const ids = Object.fromEntries(first.run.created.map((change) => [change.title, change.entryId as string]));
		// Someone edits the Brioche by hand; the Tart is published, untouched since.
		await editor.api.entries.saveDraft({ siteId, entryId: ids.Brioche as string, fields: { price: 2.2 } });
		await editor.api.entries.publish({ siteId, entryId: ids.Tart as string });

		const again = await runAgain(
			install,
			editor.api,
			siteId,
			first.importId,
			"name,sku,price\nRye,RY-1,4.5\nBrioche,BR-1,9\nTart,TA-1,3.5\nPie,PI-1,6\n",
		);

		expect(again).toMatchObject({
			number: 2,
			counts: { created: 1, updated: 2, unchanged: 0, skipped: 1, problemRows: 0 },
			skipped: [{ row: 3, entryId: ids.Brioche, title: "Brioche", reason: "edited" }],
		});
		expect(await bySku(postType.id)).toEqual({
			"RY-1": { title: "Rye", price: 4.5, status: "draft" },
			"BR-1": { title: "Brioche", price: 2.2, status: "draft" },
			"TA-1": { title: "Tart", price: 3.5, status: "changed" },
			"PI-1": { title: "Pie", price: 6, status: "draft" },
		});
	});

	test("rows that change nothing are reported unchanged, and stay untouched for the next run", async () => {
		const { postType, settings } = await products();
		const first = await importCsv(install, editor.api, siteId, settings, "name,sku,price\nRye,RY-1,4\n");

		const same = await runAgain(install, editor.api, siteId, first.importId, "name,sku,price\nRye,RY-1,4\n");
		expect(same.counts).toMatchObject({ created: 0, updated: 0, unchanged: 1, skipped: 0 });

		const changed = await runAgain(install, editor.api, siteId, first.importId, "name,sku,price\nRye,RY-1,4.1\n");
		expect(changed.counts).toMatchObject({ updated: 1, skipped: 0 });
		expect(await bySku(postType.id)).toEqual({ "RY-1": { title: "Rye", price: 4.1, status: "draft" } });
	});

	test("one run of an Import at a time", async () => {
		const { settings } = await products();
		const { import: created } = await editor.api.imports.create({ siteId, name: "Once", source: "csv", settings });
		const waiting = await startRun(editor.api, siteId, created.id, "name,sku,price\nRye,RY-1,4\n");

		const { file } = await editor.api.imports.uploadCsv({
			siteId,
			file: new File(["name,sku,price\nRye,RY-1,4\n"], "again.csv"),
		});
		await expect(editor.api.imports.start({ siteId, importId: created.id, fileId: file.id })).rejects.toMatchObject({
			code: "IMPORT_RUNNING",
			data: { runId: waiting.id },
		});
		await install.drainJobs();
		expect((await editor.api.imports.start({ siteId, importId: created.id, fileId: file.id })).run.number).toBe(2);
		await install.drainJobs();
	});
});

describe("settings that don't fit the Site", () => {
	test("are refused, each problem at its place", async () => {
		const { postType } = await products();
		await expect(
			editor.api.imports.create({
				siteId,
				name: "Wrong",
				source: "csv",
				settings: csvSettings(
					postType.id,
					[
						{ column: "name", to: "title" },
						{ column: "colour", to: "fields.colour" },
						{ column: "cost", to: "fields.price" },
						{ column: "price", to: "fields.price" },
					],
					{ match: "fields.sku", language: "fr" },
				),
			}),
		).rejects.toMatchObject({
			code: "IMPORT_INVALID",
			data: {
				problems: [
					{ at: "settings.language", rule: "languageUnknown" },
					{ at: "settings.columns[1].to", rule: "targetUnknown" },
					{ at: "settings.columns[3].to", rule: "targetTwice" },
					{ at: "settings.match", rule: "matchNotMapped" },
				],
			},
		});
	});
});
