// The Module SDK's Redirect rules and 404 log (SDK 1.4): one Module of a build keeps each, only at
// the Site level, and the Site pipeline never fails, nor waits long, because of one: a `find` that
// throws, hangs or answers a target that isn't allowed is "no rule", said in the Module log.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import redirects from "@webcraft/module-redirects";
import {
	defineModule,
	type ModuleManifestInput,
	moduleSchema,
	notFoundLog,
	redirectRules,
	siteColumns,
	text,
	uuid,
} from "@webcraft/module-sdk";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

const manifest: Omit<ModuleManifestInput, "id"> = {
	name: { en: "Test" },
	description: { en: "Test" },
	version: "1.0.0",
	sdk: "^1.4.0",
	level: "site",
	onByDefault: true,
	adminLanguages: ["en"],
};

/** A Module whose Redirect rules answer a fixed target, or fail, for some paths. */
const answering = defineModule({
	manifest: { ...manifest, id: "answering-rules" },
	redirectRules: redirectRules({
		tables: [],
		async find(request) {
			if (request.path === "/throws") throw new Error("The rules are broken.");
			if (request.path === "/hangs") return new Promise(() => {});
			if (request.path === "/scripted") return { to: "javascript:alert(1)", status: 301 };
			if (request.path === "/elsewhere") return { to: "//evil.example/x", status: 301 };
			if (request.path === "/fine") return { to: "/landed", status: 302 };
			if (request.path === "/self") return { to: "/self?again=1", status: 301 };
			return null;
		},
	}),
});

const other = moduleSchema("other-rules").table("rules", {
	...siteColumns(),
	id: uuid("id").primaryKey(),
	path: text("path"),
});

const refused = [
	defineModule({
		manifest: { ...manifest, id: "second-rules" },
		redirectRules: redirectRules({ tables: [], find: async () => null }),
	}),
	defineModule({
		manifest: { ...manifest, id: "second-log" },
		notFoundLog: notFoundLog({ record: async () => {} }),
	}),
	defineModule({
		manifest: { ...manifest, id: "workspace-rules", level: "workspace" as const },
		redirectRules: redirectRules({ tables: [], find: async () => null }),
	}),
	defineModule({
		manifest: { ...manifest, id: "other-table-rules" },
		redirectRules: redirectRules({ tables: [other], find: async () => null }),
	}),
];

describe("which Modules may keep them", () => {
	let install: TestInstall;
	beforeAll(async () => {
		install = await createTestInstall({ modules: [redirects, ...refused] });
	});
	afterAll(async () => {
		await install.close();
	});

	test("one Module of a build keeps Redirect rules, one the 404 log; only at the Site level, reading its own tables", async () => {
		const { modules } = await (await install.superadmin()).api.modules.list();

		expect(modules.map((module) => [module.id, module.status, module.problem])).toEqual([
			["redirects", "waiting", null],
			["second-rules", "cannot-run", "The Module redirects already keeps Redirect rules."],
			["second-log", "cannot-run", "The Module redirects already keeps the 404 log."],
			["workspace-rules", "cannot-run", "Only Site-level Modules keep Redirect rules: they are a Site's."],
			["other-table-rules", "cannot-run", "Its redirectRules lists a table that isn't one of the Module's."],
		]);
	});

	test("the consent screen says what the Redirects Module keeps and what it acts after", async () => {
		const { modules } = await (await install.superadmin()).api.modules.list();
		const module = modules.find((each) => each.id === "redirects");

		expect(module?.asks.permissions).toEqual([
			{
				key: "redirects.manage",
				label: "Manage Redirect rules and the 404 log",
				roles: ["staff", "owner", "editor"],
				isNew: true,
			},
		]);
		expect(module?.adds).toMatchObject({
			adminPages: ["Redirects"],
			tables: 2,
			events: ["entry.published", "paths.changed"],
			redirectRules: true,
			notFoundLog: true,
			schedules: ["day"],
		});
	});
});

describe("a Module's rules that fail", () => {
	let install: TestInstall;
	const SITE = "https://failing.sites.test";
	beforeAll(async () => {
		install = await createTestInstall({ modules: [answering] });
		const admin = await install.superadmin();
		await admin.api.modules.approve({ moduleId: "answering-rules", version: "1.0.0" });
		const workspaceId = (await install.createWorkspace()).id;
		await install.createSite(workspaceId, { slug: "failing" });
	});
	afterAll(async () => {
		await install.close();
	});

	test("never fail the page, nor hold it up: the Site answers as if there were no rule", async () => {
		expect((await install.request(`${SITE}/fine`)).headers.get("location")).toBe("/landed");

		expect((await install.request(`${SITE}/throws`)).status).toBe(404);
		const started = performance.now();
		expect((await install.request(`${SITE}/hangs`)).status).toBe(404);
		expect(performance.now() - started).toBeLessThan(3000);
		expect((await install.request(`${SITE}/scripted`)).status).toBe(404);
		expect((await install.request(`${SITE}/elsewhere`)).status).toBe(404);
		// A target that is the request's own path, whatever query it adds, would loop in the browser.
		expect((await install.request(`${SITE}/self`)).status).toBe(404);

		const { lines } = await (await install.superadmin()).api.modules.log({ moduleId: "answering-rules", limit: 10 });
		expect(lines.map((line) => line.message)).toEqual(
			expect.arrayContaining([
				"Its Redirect rules failed; the request went on without them.",
				"Its Redirect rules took too long to answer; the request went on without them.",
				"A Redirect rule's target isn't a path on the Site or an https:// address; it was left out.",
			]),
		);
	});
});
