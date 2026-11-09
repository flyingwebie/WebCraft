// Approving Modules (story 148): the Superadmin sees what each Module asks for and approves it on
// the consent screen; an update that asks for more waits for approval, off everywhere until then.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ModuleDefinition } from "@webcraft/module-sdk";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { sampleBoard } from "./sample/board.ts";
import { sample } from "./sample/index.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall({ modules: [sample, sampleBoard] });
});

afterAll(async () => {
	await install.close();
});

/** The sample Module at another version, with changes to its manifest. */
function sampleAt(version: string, change: Partial<ModuleDefinition["manifest"]> = {}): ModuleDefinition {
	return { ...sample, manifest: { ...sample.manifest, version, ...change } };
}

async function listed(id: string) {
	const admin = await install.superadmin();
	const { modules } = await admin.api.modules.list();
	const found = modules.find((module) => module.id === id);
	if (!found) throw new Error(`The Modules screen doesn't list ${id}.`);
	return found;
}

describe("the Modules screen", () => {
	test("lists a Module nobody approved yet as waiting, with everything it asks for", async () => {
		expect(await listed("sample")).toEqual({
			id: "sample",
			name: "Sample notes",
			description: "Keeps notes on each Site: the Module SDK's working example.",
			version: "1.0.0",
			level: "site",
			onByDefault: true,
			status: "waiting",
			problem: null,
			approval: null,
			asks: {
				permissions: [
					{
						key: "sample.notes.view",
						label: "See the notes",
						roles: ["staff", "owner", "editor", "author"],
						isNew: true,
					},
					{
						key: "sample.notes.edit",
						label: "Write notes and send them by email",
						roles: ["staff", "owner", "editor"],
						isNew: true,
					},
				],
				uses: [{ use: "email", isNew: true }],
				outsideHosts: [{ host: "hooks.sample.example", isNew: true }],
				siteScript: { category: "analytics", beforeConsent: false, isNew: true },
			},
			adds: {
				siteRoutes: "/_wc/m/sample/",
				adminPages: ["Notes"],
				tables: 1,
				events: ["entry.published"],
				components: ["NoteCard"],
				submissions: false,
				redirectRules: false,
				notFoundLog: false,
				schedules: [],
			},
			partitions: [],
		});
	});

	test("shows a Module's words in the person's Admin language, or in the Module's first language", async () => {
		const admin = await install.superadmin();
		await admin.api.me.updatePreferences({ adminLanguage: "it" });
		try {
			const { modules } = await admin.api.modules.list();
			const byId = new Map(modules.map((module) => [module.id, module]));
			expect(byId.get("sample")?.name).toBe("Note di esempio");
			expect(byId.get("sample")?.asks.permissions[0]?.label).toBe("Vedere le note");
			expect(byId.get("sample-board")?.name).toBe("Sample board");
		} finally {
			await admin.api.me.updatePreferences({ adminLanguage: "en" });
		}
	});

	test("is only for the Superadmin", async () => {
		const workspace = await install.createWorkspace();
		const staff = await install.createStaff({ workspaces: "all" });
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });

		for (const browser of [staff.browser, owner.browser]) {
			await expect(browser.api.modules.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
			await expect(browser.api.modules.approve({ moduleId: "sample", version: "1.0.0" })).rejects.toMatchObject({
				code: "FORBIDDEN",
			});
			await expect(browser.api.modules.log({ moduleId: "sample" })).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
	});
});

describe("approving a Module", () => {
	test("approves what the consent screen showed, and records it in the Audit log", async () => {
		const admin = await install.superadmin();

		await admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });

		const module = await listed("sample");
		expect(module.status).toBe("approved");
		expect(module.approval).toEqual({
			version: "1.0.0",
			approvedAt: install.clock.now(),
			approvedBy: "Sam Superadmin",
		});
		expect(module.asks.outsideHosts).toEqual([{ host: "hooks.sample.example", isNew: false }]);
		const { entries } = await admin.api.audit.list();
		expect(entries[0]).toMatchObject({
			action: "module.approve",
			via: { kind: "admin" },
			details: {
				moduleId: "sample",
				version: "1.0.0",
				granted: [
					"permission:sample.notes.view:staff",
					"permission:sample.notes.view:owner",
					"permission:sample.notes.view:editor",
					"permission:sample.notes.view:author",
					"permission:sample.notes.edit:staff",
					"permission:sample.notes.edit:owner",
					"permission:sample.notes.edit:editor",
					"use:email",
					"host:hooks.sample.example",
					"script:analytics",
				],
			},
		});
	});

	test("refuses a version other than the one this Install runs, which the screen would have shown", async () => {
		const admin = await install.superadmin();

		await expect(admin.api.modules.approve({ moduleId: "sample-board", version: "0.9.0" })).rejects.toMatchObject({
			code: "MODULE_CHANGED",
			status: 409,
		});
		await expect(admin.api.modules.approve({ moduleId: "no-such-module", version: "1.0.0" })).rejects.toMatchObject({
			code: "MODULE_NOT_FOUND",
			status: 404,
		});
	});
});

describe("updates", () => {
	test("an update that asks for nothing more runs on the earlier approval", async () => {
		const updates = await createTestInstall({ modules: [sample] });
		try {
			const admin = await updates.superadmin();
			await admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });

			await updates.restart({ modules: [sampleAt("1.1.0", { outsideHosts: [] })] });

			const { modules } = await (await updates.superadmin()).api.modules.list();
			expect(modules[0]).toMatchObject({
				version: "1.1.0",
				status: "approved",
				approval: { version: "1.0.0" },
				asks: { outsideHosts: [] },
			});
		} finally {
			await updates.close();
		}
	});

	test("an update that asks for more waits for approval, showing what is new", async () => {
		const updates = await createTestInstall({ modules: [sample] });
		try {
			const admin = await updates.superadmin();
			await admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });

			await updates.restart({
				modules: [sampleAt("2.0.0", { outsideHosts: ["hooks.sample.example", "api.sample.example"] })],
			});

			const { modules } = await (await updates.superadmin()).api.modules.list();
			expect(modules[0]).toMatchObject({
				version: "2.0.0",
				status: "update-waiting",
				approval: { version: "1.0.0" },
				asks: {
					outsideHosts: [
						{ host: "hooks.sample.example", isNew: false },
						{ host: "api.sample.example", isNew: true },
					],
				},
			});
			expect(modules[0]?.asks.permissions.every((permission) => !permission.isNew)).toBe(true);

			await (await updates.superadmin()).api.modules.approve({ moduleId: "sample", version: "2.0.0" });
			const after = await (await updates.superadmin()).api.modules.list();
			expect(after.modules[0]).toMatchObject({ status: "approved", approval: { version: "2.0.0" } });
		} finally {
			await updates.close();
		}
	});

	test("giving one of its Permissions to another role is asking for more", async () => {
		const updates = await createTestInstall({ modules: [sample] });
		try {
			await (await updates.superadmin()).api.modules.approve({ moduleId: "sample", version: "1.0.0" });
			const [view, edit] = sample.manifest.permissions;
			if (!view || !edit) throw new Error("The sample has two Permissions.");

			await updates.restart({
				modules: [sampleAt("1.2.0", { permissions: [view, { ...edit, roles: [...edit.roles, "author"] }] })],
			});

			const { modules } = await (await updates.superadmin()).api.modules.list();
			expect(modules[0]?.status).toBe("update-waiting");
			expect(modules[0]?.asks.permissions.map((permission) => permission.isNew)).toEqual([false, true]);
		} finally {
			await updates.close();
		}
	});
});

describe("withdrawing an approval", () => {
	test("takes the Module back to waiting, recorded in the Audit log", async () => {
		const admin = await install.superadmin();
		await admin.api.modules.approve({ moduleId: "sample-board", version: "1.0.0" });

		await admin.api.modules.withdraw({ moduleId: "sample-board" });

		expect((await listed("sample-board")).status).toBe("waiting");
		const { entries } = await admin.api.audit.list();
		expect(entries[0]).toMatchObject({ action: "module.withdraw", details: { moduleId: "sample-board" } });
	});
});

describe("Modules WebCraft can't run", () => {
	const routes = sample.siteRoutes ?? [];
	const broken: [string, ModuleDefinition, string][] = [
		[
			"a procedure needing a Permission the manifest doesn't declare",
			{ ...sample, procedures: { notes: { delete: { ...sample.procedures.notes.add, permission: "notes.delete" } } } },
			"needs the Permission notes.delete, which the manifest doesn't declare",
		],
		[
			"Site routes without a route prefix",
			{ ...sample, manifest: { ...sample.manifest, routePrefix: undefined } },
			"no routePrefix",
		],
		[
			"Site routes on a Workspace-level Module",
			{ ...sampleBoard, siteRoutes: routes },
			"Only Site-level Modules answer on Sites",
		],
		[
			"a table outside its own schema",
			{ ...sampleBoard, tables: sample.tables },
			"isn't in the Module's own schema, m_sample_board",
		],
		[
			"an extension point that comes later",
			{ ...sampleBoard, blockTypes: [{} as never] },
			"Block types come in a later version",
		],
		[
			"an event WebCraft doesn't have",
			{ ...sampleBoard, events: { "entry.saved": async () => {} } as never },
			"no event",
		],
		[
			"migrations that don't sort oldest first",
			{
				...sampleBoard,
				migrations: [
					{ name: "0002-later", sql: "SELECT 1;" },
					{ name: "0001-earlier", sql: "SELECT 1;" },
				],
			},
			"doesn't sort after 0002-later",
		],
		[
			"words missing in a language it declares",
			{ ...sample, manifest: { ...sample.manifest, name: { en: "Sample notes" } } },
			"Words are missing in it",
		],
	];

	for (const [what, definition, reason] of broken) {
		test(`lists ${what} with the reason`, async () => {
			const refused = await createTestInstall({ modules: [definition] });
			try {
				const { modules } = await (await refused.superadmin()).api.modules.list();
				expect(modules[0]?.status).toBe("cannot-run");
				expect(modules[0]?.problem).toContain(reason);
			} finally {
				await refused.close();
			}
		});
	}

	test("a second Module with the same id can't run", async () => {
		const twice = await createTestInstall({
			modules: [sample, { ...sample, manifest: { ...sample.manifest, routePrefix: "other" } }],
		});
		try {
			const { modules } = await (await twice.superadmin()).api.modules.list();
			expect(modules.map((module) => module.status)).toEqual(["waiting", "cannot-run"]);
		} finally {
			await twice.close();
		}
	});

	test("a definition that breaks a rule is listed with the reason, and can't be approved", async () => {
		const broken: ModuleDefinition = {
			...sample,
			manifest: { ...sample.manifest, sdk: "^2.0.0" },
		};
		const refused = await createTestInstall({ modules: [broken] });
		try {
			const admin = await refused.superadmin();
			const { modules } = await admin.api.modules.list();

			expect(modules[0]).toMatchObject({ id: "sample", status: "cannot-run" });
			expect(modules[0]?.problem).toContain("SDK");
			await expect(admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" })).rejects.toMatchObject({
				code: "MODULE_CANNOT_RUN",
			});
		} finally {
			await refused.close();
		}
	});
});
