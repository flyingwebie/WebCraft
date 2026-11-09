// Undo of an Import run: in two steps it removes the whole run (the Drafts it created are deleted,
// the Drafts it updated go back to what they were, the files it fetched go to the Trash), and it is
// refused once anything the run brought in was published or edited since.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { photo } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { csvSettings, importCsv, runAgain, startRun } from "./support.ts";

const PUBLIC = "93.184.216.34";

let install: TestInstall;
let siteId: string;
let staff: TestBrowser;
let editor: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall({ mediaImportTimeoutMs: 1500 });
	const workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	install.dns.answer("photos.example", [PUBLIC]);
	install.http.respond("GET", /^https:\/\/photos\.example\//, { body: await photo({ width: 100, height: 100 }) });
});

afterAll(async () => {
	await install.close();
});

let count = 0;

/** A new Post Type with a SKU, a price and a photo, and settings mapping `name,sku,price,photo` by SKU. */
async function products() {
	const key = `products${++count}`;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: key,
		urlPattern: `/${key}/{slug}`,
		fields: [
			{ key: "sku", label: "SKU", type: "text" },
			{ key: "price", label: "Price", type: "number" },
			{ key: "photo", label: "Photo", type: "media" },
		],
	});
	const settings = csvSettings(
		postType.id,
		[
			{ column: "name", to: "title" },
			{ column: "sku", to: "fields.sku" },
			{ column: "price", to: "fields.price" },
			{ column: "photo", to: "fields.photo" },
		],
		{ match: "fields.sku" },
	);
	return { postType, settings };
}

/** The Drafts of a Post Type by title: their prices. */
async function prices(postTypeId: string) {
	const { entries } = await editor.api.entries.list({ siteId, postTypeId });
	return Object.fromEntries(entries.map((entry) => [entry.draft.title, entry.draft.fields.price]));
}

/** The confirmation id Undo's first step answers. */
function confirmationOf(answer: Awaited<ReturnType<typeof editor.api.imports.undo>>): string | undefined {
	return "confirmation" in answer ? answer.confirmation.id : undefined;
}

/** Undoes a run in its two steps; answers the second step's answer. */
async function undo(runId: string) {
	const first = await editor.api.imports.undo({ siteId, runId });
	return editor.api.imports.undo({ siteId, runId, confirmation: confirmationOf(first) });
}

describe("Undo of an Import run", () => {
	test("in two steps: deletes the Drafts it created, puts back the ones it updated, trashes the files it fetched", async () => {
		const { postType, settings } = await products();
		await editor.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Rye",
			fields: { sku: "RY-1", price: 4 },
		});
		const { run } = await importCsv(
			install,
			editor.api,
			siteId,
			settings,
			"name,sku,price,photo\nRye,RY-1,4.5,\nTart,TA-1,3,https://photos.example/tart.jpg\nPie,PI-1,6,\n",
		);
		expect(run.undo).toEqual({ available: true, reason: null });

		const asked = await editor.api.imports.undo({ siteId, runId: run.id });
		const confirmation = confirmationOf(asked);
		expect(asked).toMatchObject({ undone: false, preview: { removes: 2, restores: 1, files: 1 } });
		expect(confirmation).toEqual(expect.any(String));
		expect(await prices(postType.id)).toEqual({ Rye: 4.5, Tart: 3, Pie: 6 });

		const done = await editor.api.imports.undo({ siteId, runId: run.id, confirmation });

		expect(done).toMatchObject({
			undone: true,
			run: { status: "undone", undoneBy: { name: expect.any(String) }, undo: { available: false, reason: "status" } },
		});
		expect(await prices(postType.id)).toEqual({ Rye: 4 });
		const { items } = await editor.api.media.list({ siteId, trash: true });
		expect(items.map((item) => item.fileName)).toEqual(["tart.jpg"]);
		const { entries } = await (await install.superadmin()).api.audit.list({});
		expect(entries.find((entry) => entry.action === "import.undo")?.details).toEqual({
			importId: expect.any(String),
			runId: run.id,
			number: 1,
			removed: 2,
			restored: 1,
			trashed: 1,
		});
	});

	test("is refused once anything the run brought in was published", async () => {
		const { settings } = await products();
		const { run } = await importCsv(install, editor.api, siteId, settings, "name,sku,price,photo\nRye,RY-1,4,\n");
		const rye = run.created[0]?.entryId as string;
		await editor.api.entries.publish({ siteId, entryId: rye });

		expect((await editor.api.imports.report({ siteId, runId: run.id })).run.undo).toEqual({
			available: false,
			reason: "published",
		});
		await expect(editor.api.imports.undo({ siteId, runId: run.id })).rejects.toMatchObject({
			code: "IMPORT_UNDO_REFUSED",
			data: { reason: "published", entries: [{ id: rye, title: "Rye" }] },
		});
	});

	test("is refused once anything the run brought in was edited, even by a save that changed nothing", async () => {
		const { settings } = await products();
		const { run } = await importCsv(install, editor.api, siteId, settings, "name,sku,price,photo\nRye,RY-1,4,\n");
		const rye = run.created[0]?.entryId as string;
		await install.clock.advance(1000);
		await editor.api.entries.saveDraft({ siteId, entryId: rye, fields: { price: 4 } });

		await expect(editor.api.imports.undo({ siteId, runId: run.id })).rejects.toMatchObject({
			code: "IMPORT_UNDO_REFUSED",
			data: { reason: "edited", entries: [{ id: rye, title: "Rye" }] },
		});
	});

	test("is refused for an earlier run once a later run changed what it brought in", async () => {
		const { postType, settings } = await products();
		const first = await importCsv(install, editor.api, siteId, settings, "name,sku,price,photo\nRye,RY-1,4,\n");
		const second = await runAgain(install, editor.api, siteId, first.importId, "name,sku,price,photo\nRye,RY-1,5,\n");

		await expect(editor.api.imports.undo({ siteId, runId: first.run.id })).rejects.toMatchObject({
			code: "IMPORT_UNDO_REFUSED",
			data: { reason: "edited" },
		});
		// The later run can be undone, then the earlier one.
		await undo(second.id);
		expect(await prices(postType.id)).toEqual({ Rye: 4 });
		await undo(first.run.id);
		expect(await prices(postType.id)).toEqual({});
	});

	test("is refused while the run hasn't ended, or once it was undone", async () => {
		const { settings } = await products();
		const { import: created } = await editor.api.imports.create({ siteId, name: "Waiting", source: "csv", settings });
		const waiting = await startRun(editor.api, siteId, created.id, "name,sku,price,photo\nRye,RY-1,4,\n");

		await expect(editor.api.imports.undo({ siteId, runId: waiting.id })).rejects.toMatchObject({
			code: "IMPORT_UNDO_REFUSED",
			data: { reason: "status" },
		});
		await install.drainJobs();
		await undo(waiting.id);
		await expect(editor.api.imports.undo({ siteId, runId: waiting.id })).rejects.toMatchObject({
			data: { reason: "status" },
		});
	});

	test("asks again when something changed between the two steps", async () => {
		const { settings } = await products();
		const { run } = await importCsv(
			install,
			editor.api,
			siteId,
			settings,
			"name,sku,price,photo\nRye,RY-1,4,\nPie,PI-1,6,\n",
		);
		const asked = await editor.api.imports.undo({ siteId, runId: run.id });
		const pie = run.created.find((change) => change.title === "Pie")?.entryId as string;
		const { confirmation } = await editor.api.entries.delete({ siteId, entryId: pie });
		await editor.api.entries.delete({ siteId, entryId: pie, confirmation: confirmation?.id });

		await expect(
			editor.api.imports.undo({ siteId, runId: run.id, confirmation: confirmationOf(asked) }),
		).rejects.toMatchObject({ code: "CONFIRMATION_INVALID", data: { problem: "changed" } });
	});

	test("after Undo, the Import runs again as if the run had never been", async () => {
		const { postType, settings } = await products();
		const first = await importCsv(install, editor.api, siteId, settings, "name,sku,price,photo\nRye,RY-1,4,\n");
		await undo(first.run.id);

		const again = await runAgain(install, editor.api, siteId, first.importId, "name,sku,price,photo\nRye,RY-1,4,\n");

		expect(again.counts).toMatchObject({ created: 1, updated: 0 });
		expect(await prices(postType.id)).toEqual({ Rye: 4 });
	});

	test("removes the links other Entries make to the Drafts it deletes", async () => {
		const { postType, settings } = await products();
		const { postType: shelves } = await staff.api.postTypes.create({
			siteId,
			name: "Shelves",
			urlPattern: "/shelves/{slug}",
			fields: [{ key: "holds", label: "Holds", type: "relationship", postTypes: [postType.key], multiple: true }],
		});
		const { run } = await importCsv(install, editor.api, siteId, settings, "name,sku,price,photo\nRye,RY-1,4,\n");
		const rye = run.created[0]?.entryId as string;
		const { entry: shelf } = await editor.api.entries.create({
			siteId,
			postTypeId: shelves.id,
			title: "Top shelf",
			fields: { holds: [rye] },
		});

		await undo(run.id);

		const { entry } = await editor.api.entries.get({ siteId, entryId: shelf.id });
		expect(entry.draft.fields.holds).toEqual([]);
	});
});
