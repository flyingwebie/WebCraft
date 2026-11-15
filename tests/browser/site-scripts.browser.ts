// Site script safety in a real browser: Site › Libraries and Site › Outside scripts with their menus
// and dialogs, and the "Edit on site" menu with Safe mode. Light and dark. In the building area, the
// notice a failing Site script shows and Safe mode opened from it are `building-area-scripts`' checks,
// and outside scripts' placeholders `building-area-frame`'s.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import { fakeNpmPackage } from "../harness/fake-npm.ts";
import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
const slug = "bakery";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Ciara Byrne" })).account;

	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header><h1><a href="/">Acme Bakery</a></h1></header><main>{{@outlet}}</main><footer><p>Open daily.</p></footer>',
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const pages = (await api.postTypes.list({ siteId })).postTypes.find((postType) => postType.builtIn === "page");
	const { entry } = await api.entries.create({ siteId, postTypeId: pages?.id ?? "", title: "Home", slug: "home" });
	await api.entries.publish({ siteId, entryId: entry.id });
	await api.pages.setHomePage({ siteId, pageId: entry.id });

	// A Library with a newer version, and a Site script that fails as it runs.
	const kit = fakeNpmPackage(local, "motion-kit", {
		"3.13.0": {
			files: { "dist/motion-kit.min.js": "window.motionKit = {};" },
			license: "MIT",
			jsdelivr: "dist/motion-kit.min.js",
		},
	});
	await api.libraries.add({ siteId, library: { source: "npm", packageName: "motion-kit", version: "3.13.0" } });
	kit.publish("3.14.0", {
		files: { "dist/motion-kit.min.js": "window.motionKit = { v: 2 };" },
		jsdelivr: "dist/motion-kit.min.js",
	});
	await api.libraries.checkUpdates({ siteId });
	const { script } = await api.scripts.saveDraft({
		siteId,
		entryId: null,
		code: 'document.documentElement.dataset.siteScript = "ran";\nstartSlider();',
	});
	await api.scripts.publish({ siteId, scriptId: script.id });

	// Outside scripts, one of them blocked: Staff removed a host it needs.
	await api.outsideScripts.add({
		siteId,
		name: "Chat widget",
		placement: "bodyEnd",
		consentCategory: "marketing",
		source: { kind: "url", url: "https://widgets.example.com/chat.js" },
	});
	await api.outsideScripts.add({
		siteId,
		name: "Visitor counter",
		placement: "head",
		consentCategory: "analytics",
		source: {
			kind: "snippet",
			snippet: '<script async src="https://tags.example.com/tag.js"></script>\n<script>window.queue = [];</script>',
		},
	});
	await api.csp.removeHost({ siteId, host: "widgets.example.com" });
	await api.csp.addHost({ siteId, host: "*.cdn.example.net" });
});

afterAll(async () => {
	await install.close();
});

async function adminPage(theme: Theme, path: string): Promise<Page> {
	const page = await install.newPage(theme);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(path));
	await page.waitForLoadState("networkidle");
	return page;
}

for (const theme of THEMES) {
	describe(`Site › Libraries, ${theme}`, () => {
		test("the screen, the add sheet, and a Library's menu from the keyboard", async () => {
			const page = await adminPage(theme, `/sites/${siteId}/libraries`);
			await page.getByText("Newer: 3.14.0").waitFor();
			await expectAccessibleScreen(page, `Libraries (${theme})`);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Add Library" }),
				"dialog",
				`Libraries › add (${theme})`,
			);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Actions for motion-kit" }),
				"menu",
				`Libraries › a Library's menu (${theme})`,
			);
		});

		test("removing a Library asks first, naming it, with focus on Cancel", async () => {
			const page = await adminPage(theme, `/sites/${siteId}/libraries`);
			await page.getByRole("button", { name: "Actions for motion-kit" }).click();
			await page.getByRole("menuitem", { name: "Remove" }).click();
			const dialog = page.getByRole("dialog", { name: "Remove motion-kit?" });
			await dialog.waitFor();
			expect(
				await dialog.getByRole("button", { name: "Cancel" }).evaluate((button) => button === document.activeElement),
			).toBe(true);
			await expectNoAxeViolations(page, `Libraries › remove (${theme})`, ["region"]);
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "hidden" });
			await page.getByRole("button", { name: "Actions for motion-kit" }).waitFor();
		});
	});

	describe(`Site › Outside scripts, ${theme}`, () => {
		test("the screen, the add dialog and an outside script's menu from the keyboard", async () => {
			const page = await adminPage(theme, `/sites/${siteId}/outside-scripts`);
			await page.getByText("Blocked").waitFor();
			await expectAccessibleScreen(page, `Outside scripts (${theme})`);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Add outside script" }),
				"dialog",
				`Outside scripts › add (${theme})`,
			);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Actions for Visitor counter" }),
				"menu",
				`Outside scripts › a script's menu (${theme})`,
			);
		});

		test("a snippet that can't be used shows its problems in the dialog", async () => {
			const page = await adminPage(theme, `/sites/${siteId}/outside-scripts`);
			await page.getByRole("button", { name: "Add outside script" }).click();
			const dialog = page.getByRole("dialog");
			await dialog.getByLabel("Name", { exact: true }).fill("Broken widget");
			await dialog.getByRole("radio", { name: "A pasted snippet" }).click();
			await dialog.getByLabel("Snippet", { exact: true }).fill('<div id="widget"></div>');
			await dialog.getByRole("button", { name: "Save" }).click();
			await dialog.getByText("Line 1:").waitFor();
			await expectNoAxeViolations(page, `Outside scripts › problems (${theme})`, ["region"]);
			await page.keyboard.press("Escape");
		});
	});

	describe(`"Edit on site", ${theme}`, () => {
		test("its menu offers Safe mode, from the keyboard", async () => {
			const page = await adminPage(theme, `/sites/${siteId}`);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "More ways to open Edit mode" }),
				"menu",
				`Edit on site menu (${theme})`,
			);
		});
	});
}
