// An imported Site has the built-in "Site analytics" Dashboard like every Site (SPEC 14.1, D10): the
// one its archive carries, as it was arranged, or, from an archive written before it existed, a new one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { exportedArchive, importArchive, rewritten } from "../harness/site-transfer.ts";

let install: TestInstall;
let admin: TestBrowser;
let archive: Uint8Array;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const [builtIn] = (await admin.api.dashboards.list({ siteId })).dashboards;
	await admin.api.dashboards.update({ siteId, dashboardId: builtIn?.id ?? "", name: "Bakery numbers" });
	await admin.api.dashboards.create({ siteId, name: "Alpha board" });
	archive = await exportedArchive(install, admin, siteId);
});

afterAll(async () => {
	await install?.close();
});

const listed = async (siteId: string) =>
	(await admin.api.dashboards.list({ siteId })).dashboards.map(({ name, builtIn, widgets }) => [
		name,
		builtIn,
		widgets,
	]);

describe("an imported Site's built-in Dashboard", () => {
	test("is the one the archive carries, as it was", async () => {
		const workspaceId = (await install.createWorkspace("Imports")).id;
		const imported = await importArchive(install, admin, workspaceId, archive, { name: "Copy", slug: "copy" });
		expect(imported.status).toBe("done");

		expect(await listed(imported.site?.id ?? "")).toEqual([
			["Bakery numbers", true, 6],
			["Alpha board", false, 0],
		]);
	});

	test("is a new one when the archive comes from before it existed", async () => {
		const older = rewritten(archive, {
			manifest: (manifest) => {
				manifest.webcraft.version = "0.0.9";
				manifest.migrations = manifest.migrations.filter((name: string) => !/site-analytics-dashboard/.test(name));
				const table = manifest.tables.find((each: { name: string }) => each.name === "public.dashboards");
				table.columns = table.columns.filter((column: string) => column !== "built_in");
				table.rows = 1;
			},
			rows: (table, rows) =>
				table === "public.dashboards"
					? rows.filter((row) => row.built_in !== true).map(({ built_in: _, ...row }) => row)
					: rows,
		});
		const workspaceId = (await install.createWorkspace("Older imports")).id;
		const imported = await importArchive(install, admin, workspaceId, older, { name: "Older", slug: "older" });
		expect(imported.status).toBe("done");

		expect(await listed(imported.site?.id ?? "")).toEqual([
			["Site analytics", true, 6],
			["Alpha board", false, 0],
		]);
	});
});
