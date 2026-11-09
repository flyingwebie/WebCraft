// A Module's Site script (SDK 1.3): its code, which the Site serves as a file from its own domain and
// pages load where the Module runs, never inline (ADR 0023). The manifest declares its Consent
// category, which the Superadmin approves, and the Consent banner holds the script back until
// visitors accept that category (ADR 0020). Like an outside script, it never runs in Edit mode.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ModuleDefinition } from "@webcraft/module-sdk";

import { headOf } from "../harness/code-mode.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage, expectSiteHeaders } from "../harness/site-safety.ts";
import { sample } from "./sample/index.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall({ modules: [sample] });
	await (await install.superadmin()).api.modules.approve({ moduleId: "sample", version: "1.0.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

/** A Site with a published home page. */
async function newSite() {
	const slug = `module-script-${++sites}`;
	const { id: siteId } = await install.createSite(workspaceId, { name: "Bakery", slug });
	const pages = (await staff.api.postTypes.list({ siteId })).postTypes.find((postType) => postType.builtIn === "page");
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: pages?.id as string, title: "Home" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.pages.setHomePage({ siteId, pageId: entry.id });
	return { siteId, url: (path: string) => `https://${slug}.sites.test${path}` };
}

/** The Module's script on a page: where it is (held back in its category's <template>, or loaded), and its address. */
function moduleScriptIn(html: string): { held: string | null; src: string } | undefined {
	const tag = /<script src="(\/_wc\/js\/[0-9a-f]{16}\.js)" defer data-wc-module="sample"><\/script>/.exec(html);
	if (!tag) return undefined;
	const template = /<template data-wc-consent="([a-z]+)">([\s\S]*?)<\/template>/g;
	for (const [, category = "", content = ""] of html.matchAll(template)) {
		if (content.includes(tag[0])) return { held: category, src: tag[1] ?? "" };
	}
	return { held: null, src: tag[1] ?? "" };
}

describe("a Module's Site script", () => {
	test("is held back in the category its manifest declares, on Sites where the Module runs; the Site serves its code", async () => {
		const site = await newSite();

		const html = await expectSafePage(await install.request(site.url("/")));

		const script = moduleScriptIn(headOf(html));
		expect(script?.held).toBe("analytics");
		expect(html).toContain('<meta name="webcraft-consent-mode" content="optIn">');
		const file = await install.request(site.url(script?.src ?? ""));
		expect(file.status).toBe(200);
		expectSiteHeaders(file);
		expect(file.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(await file.text()).toBe(sample.siteScript?.code);
	});

	test("with None, it loads as it is", async () => {
		const site = await newSite();
		await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });

		const html = await expectSafePage(await install.request(site.url("/")));

		expect(moduleScriptIn(headOf(html))?.held).toBeNull();
		expect(html).not.toContain("wc-consent");
	});

	test("where the Module is off, pages don't load it and the Site doesn't serve it", async () => {
		const site = await newSite();
		const { src } = moduleScriptIn(await (await install.request(site.url("/"))).text()) ?? { src: "" };

		await staff.api.modules.setOnSite({ siteId: site.siteId, moduleId: "sample", on: false });
		const html = await expectSafePage(await install.request(site.url("/")));

		expect(moduleScriptIn(html)).toBeUndefined();
		expect(html).not.toContain("wc-consent");
		expect((await install.request(site.url(src))).status).toBe(404);
	});

	test("never runs in Edit mode", async () => {
		const site = await newSite();
		const editing = await openEditMode(install, staff, site.siteId, "/");

		const html = await expectSafePage(await editing.page("/"), "editMode");

		expect(moduleScriptIn(html)).toBeUndefined();
	});
});

describe("declaring one", () => {
	test("a Module adding a Site script must declare its Consent category, or it can't run", async () => {
		const undeclared: ModuleDefinition = { ...sample, manifest: { ...sample.manifest, siteScript: null } };
		const other = await createTestInstall({ modules: [undeclared] });
		try {
			const { modules } = await (await other.superadmin()).api.modules.list();
			expect(modules[0]).toMatchObject({ id: "sample", status: "cannot-run" });
			expect(modules[0]?.problem).toContain("Consent category");
		} finally {
			await other.close();
		}
	});

	test("its category is something the Superadmin approves", async () => {
		const { modules } = await (await install.superadmin()).api.modules.list();

		expect(modules.find((module) => module.id === "sample")?.asks.siteScript).toEqual({
			category: "analytics",
			isNew: false,
		});
	});
});
