// What Imports keep, and for how long: an Import report is kept 90 days after its run ends, then
// purged; an uploaded file no run took is deleted after a day. The Import itself, and the Source ids
// of what it brought in, stay: a later run still updates what it brought in.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { csv, csvSettings, importCsv, runAgain } from "./support.ts";

const DAY = 24 * 60 * 60_000;

let install: TestInstall;
let siteId: string;
let editor: TestBrowser;
let account: TestAccount;
let postTypeId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace()).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	const staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	({ browser: editor, account } = await install.createMember({ workspaceId, role: "editor" }));
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Products",
		urlPattern: "/products/{slug}",
		fields: [{ key: "sku", label: "SKU", type: "text" }],
	});
	postTypeId = postType.id;
});

afterAll(async () => {
	await install.close();
});

const settings = () =>
	csvSettings(
		postTypeId,
		[
			{ column: "name", to: "title" },
			{ column: "sku", to: "fields.sku" },
		],
		{ match: "fields.sku" },
	);

/** Files kept in the Site's private storage folder for Imports. */
async function importFiles() {
	const stored = await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: install.storageDir }));
	return stored.filter((path) => path.includes(`${siteId}/imports/`));
}

describe("what Imports keep", () => {
	test("an Import report is purged 90 days after its run ended; the Import and its Source ids stay", async () => {
		const { importId, run } = await importCsv(install, editor.api, siteId, settings(), "name,sku\nRye,RY-1\n");
		expect(run.expiresAt).toEqual(new Date(install.clock.now().getTime() + 90 * DAY));

		await install.clock.advance(89 * DAY);
		await install.drainJobs();
		// Sessions end after a week unused.
		editor = await install.signIn(account);
		expect((await editor.api.imports.report({ siteId, runId: run.id })).run.status).toBe("done");

		await install.clock.advance(2 * DAY);
		await install.drainJobs();
		await expect(editor.api.imports.report({ siteId, runId: run.id })).rejects.toMatchObject({
			code: "IMPORT_RUN_NOT_FOUND",
		});
		const { import: kept, runs } = await editor.api.imports.get({ siteId, importId });
		expect(kept.lastRun).toBeNull();
		expect(runs).toEqual([]);

		const again = await runAgain(install, editor.api, siteId, importId, "name,sku\nRye renamed,RY-1\n");
		expect(again).toMatchObject({ number: 2, counts: { created: 0, updated: 1 } });
	});

	test("an uploaded file no run took is deleted after a day", async () => {
		const before = await importFiles();
		const { file } = await editor.api.imports.uploadCsv({ siteId, file: csv("name,sku\nRye,RY-1\n") });
		expect(file.expiresAt).toEqual(new Date(install.clock.now().getTime() + DAY));
		expect((await importFiles()).length).toBe(before.length + 1);

		await install.clock.advance(DAY + 60_000);
		await install.drainJobs();

		expect(await importFiles()).toEqual([]);
		await expect(editor.api.imports.preview({ siteId, fileId: file.id, settings: settings() })).rejects.toMatchObject({
			code: "IMPORT_FILE_NOT_FOUND",
		});
	});
});
