// Import work whose worker stopped for good (killed, out of memory) is picked up again. A run goes on
// from where it got to, or ends when someone asked it to stop meanwhile, and fails when it keeps
// stopping; a source's file is surveyed again, and refused when its survey keeps stopping.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { csvSettings, startRun } from "./support.ts";
import { approveModules, uploadExport } from "./wordpress.ts";

const MINUTE = 60_000;

let install: TestInstall;
let siteId: string;
let staff: TestBrowser;
let editor: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	await approveModules(install);
	const workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let count = 0;

/** A new Post Type with a SKU, and an Import into it matching by SKU. */
async function anImport() {
	const key = `loaves${++count}`;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: key,
		urlPattern: `/${key}/{slug}`,
		fields: [{ key: "sku", label: "SKU", type: "text" }],
	});
	const settings = csvSettings(
		postType.id,
		[
			{ column: "name", to: "title" },
			{ column: "sku", to: "fields.sku" },
		],
		{ match: "fields.sku" },
	);
	const { import: created } = await editor.api.imports.create({ siteId, name: key, source: "csv", settings });
	return { postType, importId: created.id };
}

function loaves(rows: number): string {
	return `name,sku\n${Array.from({ length: rows }, (_, index) => `Loaf ${index},L-${index}`).join("\n")}\n`;
}

/** Starts a run of 501 rows and lets the worker go through the first 500, then stop for good. */
async function runThatStopped(importId: string) {
	const run = await startRun(editor.api, siteId, importId, loaves(501));
	await install.drainJobs({ only: ["imports.run"], rounds: 1 });
	expect(await install.crashJobs({ only: ["imports.run"] })).toBe(1);
	expect((await editor.api.imports.report({ siteId, runId: run.id })).run).toMatchObject({
		status: "running",
		progress: { done: 500, total: 501 },
	});
	return run;
}

describe("a run whose worker stopped", () => {
	// It goes through 500 rows: give it room on a busy machine.
	test("is picked up again from where it got to, once it has stopped moving for half an hour", async () => {
		const { postType, importId } = await anImport();
		const run = await runThatStopped(importId);

		await install.clock.advance(20 * MINUTE);
		await install.drainJobs();
		expect((await editor.api.imports.report({ siteId, runId: run.id })).run).toMatchObject({
			status: "running",
			progress: { done: 500, total: 501 },
		});

		await install.clock.advance(11 * MINUTE);
		await install.drainJobs();

		expect((await editor.api.imports.report({ siteId, runId: run.id })).run).toMatchObject({
			status: "done",
			progress: { done: 501, total: 501 },
			counts: { created: 501, updated: 0, problemRows: 0 },
		});
		expect((await editor.api.entries.list({ siteId, postTypeId: postType.id })).entries).toHaveLength(501);
		// The Import can run again.
		const again = await startRun(editor.api, siteId, importId, loaves(1));
		expect(again.status).toBe("waiting");
	}, 120_000);

	test("ends stopped, keeping what's done, when someone asked it to stop meanwhile", async () => {
		const { postType, importId } = await anImport();
		const run = await runThatStopped(importId);
		const { run: asked } = await editor.api.imports.stop({ siteId, runId: run.id });
		expect(asked).toMatchObject({ status: "running", stopRequested: true });

		await install.clock.advance(31 * MINUTE);
		await install.drainJobs();

		expect((await editor.api.imports.report({ siteId, runId: run.id })).run).toMatchObject({
			status: "stopped",
			progress: { done: 500, total: 501 },
			counts: { created: 500 },
		});
		expect((await editor.api.entries.list({ siteId, postTypeId: postType.id })).entries).toHaveLength(500);
	}, 120_000);

	test("fails once it was picked up again three times and its worker stopped each time", async () => {
		const { postType, importId } = await anImport();
		const run = await startRun(editor.api, siteId, importId, loaves(2));
		expect(await install.crashJobs({ only: ["imports.run"] })).toBe(1);
		for (let attempt = 1; attempt <= 3; attempt++) {
			await install.clock.advance(31 * MINUTE);
			await install.drainJobs({ only: ["imports.recover"] });
			expect(await install.crashJobs({ only: ["imports.run"] })).toBe(1);
		}

		await install.clock.advance(31 * MINUTE);
		await install.drainJobs();

		expect((await editor.api.imports.report({ siteId, runId: run.id })).run).toMatchObject({
			status: "failed",
			failure: { reason: "error" },
			progress: { done: 0, total: 2 },
		});
		expect((await editor.api.entries.list({ siteId, postTypeId: postType.id })).entries).toEqual([]);
		expect((await startRun(editor.api, siteId, importId, loaves(1))).status).toBe("waiting");
	});
});

describe("a source's file whose survey's worker stopped", () => {
	test("is surveyed again once its survey has gone on for longer than its job may run", async () => {
		const uploaded = await uploadExport(staff.api, siteId);
		expect(await install.crashJobs({ only: ["imports.survey"] })).toBe(1);

		await install.clock.advance(60 * MINUTE);
		await install.drainJobs();
		expect((await staff.api.imports.file({ siteId, fileId: uploaded.id })).file.status).toBe("surveying");

		await install.clock.advance(31 * MINUTE);
		expect((await install.drainJobs()).failed).toEqual([]);

		const { file } = await staff.api.imports.file({ siteId, fileId: uploaded.id });
		expect(file).toMatchObject({ status: "ready", refusal: null });
		expect(file.survey?.items).toBeGreaterThan(0);
	});

	test("is refused once it was surveyed again three times and its worker stopped each time", async () => {
		const uploaded = await uploadExport(staff.api, siteId);
		expect(await install.crashJobs({ only: ["imports.survey"] })).toBe(1);
		for (let attempt = 1; attempt <= 3; attempt++) {
			await install.clock.advance(91 * MINUTE);
			await install.drainJobs({ only: ["imports.recover"] });
			expect(await install.crashJobs({ only: ["imports.survey"] })).toBe(1);
		}

		await install.clock.advance(91 * MINUTE);
		await install.drainJobs();

		const { file } = await staff.api.imports.file({ siteId, fileId: uploaded.id });
		expect(file).toMatchObject({
			status: "refused",
			refusal: { code: "error", message: "The file couldn't be read." },
			survey: null,
		});
	});
});
