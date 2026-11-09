// Importing a CSV file into one Post Type: rows land as Drafts in the background, each value read
// through its Field's type, with an Import report of what was created, updated and skipped.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { csvSettings, startRun } from "./support.ts";

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let staff: TestBrowser;
let editor: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

/** A new Post Type for one test, with a SKU and a price. */
async function products(name = "Products") {
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name,
		urlPattern: `/${name.toLowerCase().replaceAll(" ", "-")}/{slug}`,
		fields: [
			{ key: "sku", label: "SKU", type: "text" },
			{ key: "price", label: "Price", type: "number" },
		],
	});
	return postType;
}

describe("a CSV Import run", () => {
	test("brings every row in as a Draft in the background, reporting what it created and the columns it skipped", async () => {
		const postType = await products();
		const settings = csvSettings(postType.id, [
			{ column: "name", to: "title" },
			{ column: "sku", to: "fields.sku" },
			{ column: "price", to: "fields.price" },
			{ column: "internal_note", to: null },
		]);
		const { import: created } = await editor.api.imports.create({
			siteId,
			name: "Spring products",
			source: "csv",
			settings,
		});

		const run = await startRun(
			editor.api,
			siteId,
			created.id,
			"name,sku,price,internal_note\nPumpkin loaf,PK-700,5.50,check stock\nSeeded rye,RY-650,5.20,\n",
		);
		expect(run).toMatchObject({ status: "waiting", number: 1, progress: { done: 0, total: 2 } });
		expect((await editor.api.entries.list({ siteId, postTypeId: postType.id })).entries).toEqual([]);

		expect((await install.drainJobs()).failed).toEqual([]);

		const { run: report } = await editor.api.imports.report({ siteId, runId: run.id });
		expect(report).toMatchObject({
			status: "done",
			progress: { done: 2, total: 2 },
			counts: { created: 2, updated: 0, unchanged: 0, skipped: 0, problemRows: 0 },
			skippedColumns: ["internal_note"],
			problems: [],
		});
		const { entries } = await editor.api.entries.list({ siteId, postTypeId: postType.id });
		expect(
			entries
				.map((entry) => ({ status: entry.status, title: entry.draft.title, fields: entry.draft.fields }))
				.sort((a, b) => a.title.localeCompare(b.title)),
		).toEqual([
			{ status: "draft", title: "Pumpkin loaf", fields: { sku: "PK-700", price: 5.5 } },
			{ status: "draft", title: "Seeded rye", fields: { sku: "RY-650", price: 5.2 } },
		]);
		expect(entries.map((entry) => entry.draft.slug).sort()).toEqual(["pumpkin-loaf", "seeded-rye"]);
	});
});
