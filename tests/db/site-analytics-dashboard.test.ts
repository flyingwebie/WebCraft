// Sites made before the built-in "Site analytics" Dashboard (UI overhaul, SPEC 14.1, D10) get it from
// the migrate step: the same Widgets in the same places a new Site gets, listed before the Dashboards
// Staff built, which stay as they were.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { applyMigrationLevel, migrationsFolder } from "@webcraft/db";
import pg from "pg";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

/** The migrations under test: the column that marks the built-in Dashboard, and the one giving it to every Site. */
const BUILT_IN_MIGRATIONS = [
	"20261113230633_site-analytics-dashboard",
	"20261113230639_site-analytics-dashboard-for-every-site",
];

/** Every migration this build has except those under test. */
function migrationsBefore(names: readonly string[]): string[] {
	const all = readdirSync(migrationsFolder, { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);
	for (const name of names) expect(all).toContain(name);
	return all.filter((candidate) => !names.includes(candidate));
}

describe("an Install whose Sites were made before the built-in Dashboard", () => {
	let install: TestInstall;
	let workspaceId: string;
	const sites: string[] = [];
	let builtBefore: string;

	beforeAll(async () => {
		install = await createTestInstall({ database: "empty" });
		await applyMigrationLevel(install.databaseUrl, { core: migrationsBefore(BUILT_IN_MIGRATIONS), modules: {} });

		const client = new pg.Client({ connectionString: install.databaseUrl });
		await client.connect();
		try {
			const workspace = await client.query<{ id: string }>(
				"INSERT INTO workspaces (name, created_at) VALUES ('Acme Ltd', now()) RETURNING id",
			);
			workspaceId = workspace.rows[0]?.id ?? "";
			for (const slug of ["bakery", "florist"]) {
				const site = await client.query<{ id: string }>(
					"INSERT INTO sites (workspace_id, name, slug, created_at) VALUES ($1, $2, $2, now()) RETURNING id",
					[workspaceId, slug],
				);
				const siteId = site.rows[0]?.id ?? "";
				sites.push(siteId);
				await client.query(
					"INSERT INTO site_languages (workspace_id, site_id, code, name, direction, position, created_at) VALUES ($1, $2, 'en', 'English', 'ltr', 0, now())",
					[workspaceId, siteId],
				);
			}
			// A Dashboard Staff built on the first Site, before the upgrade.
			const built = await client.query<{ id: string }>(
				`INSERT INTO dashboards (workspace_id, site_id, name, range, shared_with_everyone, widgets, created_at, updated_at)
				 VALUES ($1, $2, 'Alpha board', '{"preset":"last7Days"}', true, '[]', now(), now()) RETURNING id`,
				[workspaceId, sites[0]],
			);
			builtBefore = built.rows[0]?.id ?? "";
		} finally {
			await client.end();
		}
	});

	afterAll(async () => {
		await install.close();
	});

	test("each Site gets one, laid out as a new Site's, listed first; Dashboards built before stay", async () => {
		await install.migrate({ backup: false });
		const { api } = await install.superadmin();

		const [bakery, florist] = sites as [string, string];
		const first = (await api.dashboards.list({ siteId: bakery })).dashboards;
		expect(
			first.map(({ id, name, builtIn, sharedWithEveryone }) => [id === builtBefore, name, builtIn, sharedWithEveryone]),
		).toEqual([
			[false, "Site analytics", true, false],
			[true, "Alpha board", false, true],
		]);
		const second = (await api.dashboards.list({ siteId: florist })).dashboards;
		expect(second.map(({ name, builtIn, widgets }) => [name, builtIn, widgets])).toEqual([["Site analytics", true, 6]]);

		// The same Widgets a Site made today gets (`tests/dashboards/site-analytics-dashboard.test.ts`).
		const { site: made } = await api.sites.create({ workspaceId, name: "Grocer", slug: "grocer" });
		const layout = async (siteId: string) => {
			const [board] = (await api.dashboards.list({ siteId })).dashboards;
			const { dashboard } = await api.dashboards.get({ siteId, dashboardId: board?.id ?? "" });
			return {
				name: dashboard.name,
				range: dashboard.range,
				widgets: dashboard.widgets.map(({ id: _id, ...widget }) => widget),
			};
		};
		const upgraded = await layout(florist);
		expect(upgraded.widgets.map(({ kind, x, y, w, h }) => [kind, x, y, w, h])).toEqual([
			["site-analytics:totals", 0, 0, 12, 2],
			["site-analytics:trend", 0, 2, 8, 4],
			["site-analytics:sources", 8, 2, 4, 4],
			["site-analytics:top-pages", 0, 6, 6, 4],
			["site-analytics:goals", 6, 6, 6, 2],
			["site-analytics:devices", 6, 8, 6, 2],
		]);
		expect(upgraded).toEqual(await layout(made.id));

		// It can't be deleted either.
		await expect(api.dashboards.delete({ siteId: florist, dashboardId: second[0]?.id ?? "" })).rejects.toMatchObject({
			code: "DASHBOARD_INVALID",
			data: { problem: "builtIn" },
		});
	});
});
