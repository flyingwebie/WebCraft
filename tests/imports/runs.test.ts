// An Import run in the background: the preview before it, its progress while it runs, Stop, what it
// records in the Audit log, the uploaded file deleted once it ends, big files gone through by several
// jobs, and a run whose starter lost access.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { photo } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { csv, csvSettings, importCsv, startRun } from "./support.ts";

const PUBLIC = "93.184.216.34";

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let staff: TestBrowser;
let editor: TestBrowser;
let image: Uint8Array;

beforeAll(async () => {
	install = await createTestInstall({ mediaImportTimeoutMs: 1500 });
	workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	image = await photo({ width: 200, height: 100 });
	install.dns.answer("photos.example", [PUBLIC]);
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

describe("the preview before a run", () => {
	test("says how many rows create and update Drafts, the files to fetch and every problem, writing nothing", async () => {
		const { postType, settings } = await products();
		await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Rye", fields: { sku: "RY-1" } });
		const { file } = await editor.api.imports.uploadCsv({
			siteId,
			file: csv(
				"name,sku,price,photo,internal_note\nRye,RY-1,4,,x\nTart,TA-1,4 euro,https://photos.example/tart.jpg,\nPie,PI-1,3,,\nPie again,pi-1,3,,\n",
			),
		});
		const before = install.http.requests.length;

		const { preview } = await editor.api.imports.preview({ siteId, fileId: file.id, settings });

		expect(preview).toEqual({
			rows: 4,
			counts: { create: 2, update: 1, skip: 0, problemRows: 2 },
			files: 1,
			skippedColumns: ["internal_note"],
			problems: [
				{ row: 3, column: "price", rule: "number", params: null },
				{ row: 5, column: null, rule: "matchedTwice", params: { row: 4 } },
			],
			problemsTotal: 2,
		});
		expect(install.http.requests.slice(before)).toEqual([]);
		expect((await editor.api.entries.list({ siteId, postTypeId: postType.id })).entries).toHaveLength(1);
	});

	test("refuses a file someone else uploaded", async () => {
		const { settings } = await products();
		const other = (await install.createMember({ workspaceId, role: "editor" })).browser;
		const { file } = await other.api.imports.uploadCsv({ siteId, file: csv("name,sku,price,photo\nRye,RY-1,4,\n") });

		await expect(editor.api.imports.preview({ siteId, fileId: file.id, settings })).rejects.toMatchObject({
			code: "IMPORT_FILE_NOT_FOUND",
		});
	});
});

describe("a run in the background", () => {
	test("shows its progress, rows done of the total, while it runs", async () => {
		const { settings } = await products();
		const { import: created } = await editor.api.imports.create({ siteId, name: "Progress", source: "csv", settings });
		let seen: unknown;
		let runId = "";
		install.http.respond("GET", "https://photos.example/progress.jpg", async () => {
			seen = (await editor.api.imports.report({ siteId, runId })).run;
			return { body: image };
		});
		runId = (
			await startRun(
				editor.api,
				siteId,
				created.id,
				"name,sku,price,photo\nRye,RY-1,4,\nTart,TA-1,4,https://photos.example/progress.jpg\nPie,PI-1,3,\n",
			)
		).id;

		await install.drainJobs();

		expect(seen).toMatchObject({ status: "running", progress: { done: 1, total: 3 }, counts: { created: 1 } });
		expect((await editor.api.imports.report({ siteId, runId })).run).toMatchObject({
			status: "done",
			progress: { done: 3, total: 3 },
		});
	});

	test("Stop finishes the row it is on, keeps what's done, and the report says it stopped", async () => {
		const { postType, settings } = await products();
		const { import: created } = await editor.api.imports.create({ siteId, name: "Stopped", source: "csv", settings });
		let runId = "";
		install.http.respond("GET", "https://photos.example/stop.jpg", async () => {
			const { run } = await editor.api.imports.stop({ siteId, runId });
			expect(run).toMatchObject({ status: "running", stopRequested: true });
			return { body: image };
		});
		runId = (
			await startRun(
				editor.api,
				siteId,
				created.id,
				"name,sku,price,photo\nRye,RY-1,4,\nTart,TA-1,4,https://photos.example/stop.jpg\nPie,PI-1,3,\nCake,CA-1,3,\n",
			)
		).id;

		await install.drainJobs();

		const { run } = await editor.api.imports.report({ siteId, runId });
		expect(run).toMatchObject({ status: "stopped", progress: { done: 2, total: 4 }, counts: { created: 2 } });
		const { entries } = await editor.api.entries.list({ siteId, postTypeId: postType.id });
		expect(entries.map((entry) => entry.draft.title).sort()).toEqual(["Rye", "Tart"]);
	});

	test("a run stopped before the worker took it writes nothing", async () => {
		const { postType, settings } = await products();
		const { import: created } = await editor.api.imports.create({ siteId, name: "Early", source: "csv", settings });
		const waiting = await startRun(editor.api, siteId, created.id, "name,sku,price,photo\nRye,RY-1,4,\n");

		const { run } = await editor.api.imports.stop({ siteId, runId: waiting.id });
		await install.drainJobs();

		expect(run).toMatchObject({ status: "stopped", progress: { done: 0, total: 1 } });
		expect((await editor.api.entries.list({ siteId, postTypeId: postType.id })).entries).toEqual([]);
	});

	test("records creating, running and stopping in the Audit log", async () => {
		const { settings } = await products();
		const { import: created } = await editor.api.imports.create({ siteId, name: "Audited", source: "csv", settings });
		const run = await startRun(editor.api, siteId, created.id, "name,sku,price,photo\nRye,RY-1,4,\n", "audited.csv");
		await editor.api.imports.stop({ siteId, runId: run.id });

		const { entries } = await (await install.superadmin()).api.audit.list({});
		const ours = entries.filter((entry) => (entry.details as { importId?: string }).importId === created.id);
		expect(ours.map((entry) => [entry.action, entry.details])).toEqual([
			["import.stop", { importId: created.id, runId: run.id, number: 1 }],
			["import.run", { importId: created.id, runId: run.id, number: 1, fileName: "audited.csv" }],
			["import.create", { importId: created.id, name: "Audited", source: "csv" }],
		]);
	});

	test("deletes the uploaded file once the run ends", async () => {
		const { settings } = await products();
		const imports = async () => {
			const stored = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: install.storageDir }));
			return stored.filter((path) => path.includes(`${siteId}/imports/`));
		};
		const before = await imports();

		const { run } = await importCsv(install, editor.api, siteId, settings, "name,sku,price,photo\nRye,RY-1,4,\n");

		expect(run.status).toBe("done");
		expect(await imports()).toEqual(before);
	});

	test("goes through a big file in several jobs, each taking up where the last stopped", async () => {
		const { postType, settings } = await products();
		const rows = Array.from({ length: 601 }, (_, index) => `Loaf ${index},L-${index},${index % 7},`);

		const { run } = await importCsv(
			install,
			editor.api,
			siteId,
			settings,
			`name,sku,price,photo\n${rows.join("\n")}\nDup,L-3,1,\n`,
		);

		expect(run).toMatchObject({
			status: "done",
			progress: { done: 602, total: 602 },
			counts: { created: 601, problemRows: 1 },
			problems: [{ row: 603, column: null, rule: "matchedTwice", params: { row: 5 } }],
		});
		expect((await editor.api.entries.list({ siteId, postTypeId: postType.id })).entries).toHaveLength(601);
	});

	test("fails when the person who started it lost access to the Site meanwhile", async () => {
		const { postType, settings } = await products();
		const member = await install.createMember({ workspaceId, role: "editor" });
		const { import: created } = await member.browser.api.imports.create({
			siteId,
			name: "Gone",
			source: "csv",
			settings,
		});
		const run = await startRun(member.browser.api, siteId, created.id, "name,sku,price,photo\nRye,RY-1,4,\n");
		await (await install.superadmin()).api.members.remove({ workspaceId, personId: member.personId });

		await install.drainJobs();

		const { run: report } = await staff.api.imports.report({ siteId, runId: run.id });
		expect(report).toMatchObject({ status: "failed", failure: { reason: "access" }, counts: { created: 0 } });
		expect((await staff.api.entries.list({ siteId, postTypeId: postType.id })).entries).toEqual([]);
	});
});
