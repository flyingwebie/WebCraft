// Site script safety in a real browser: Site › Libraries and Site › Outside scripts with their menus
// and dialogs, the "Edit on site" menu with Safe mode, and in Edit mode the notice a failing Site
// script shows, Safe mode opened from it, and outside scripts' placeholders. Light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Cookie, Page } from "playwright";

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

/** The edit cookie from the first time Edit mode opened, handed to later pages (the link works once). */
let editCookies: Cookie[] | undefined;

async function editModePage(theme: Theme): Promise<Page> {
	const page = await install.newPage(theme);
	if (editCookies) {
		await page.context().addCookies(editCookies);
	} else {
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname === new URL(install.siteUrl(slug, "/")).hostname);
		editCookies = (await page.context().cookies()).filter((cookie) => cookie.name === "webcraft.edit");
	}
	await page.goto(install.siteUrl(slug, "/"));
	await page.getByRole("button", { name: "Publish", exact: true }).waitFor();
	return page;
}

for (const theme of THEMES) {
	describe(`Site › Libraries, ${theme}`, () => {
		test("the screen, and a Library's menu from the keyboard", async () => {
			const page = await adminPage(theme, `/sites/${siteId}/libraries`);
			await page.getByText("Newer: 3.14.0").waitFor();
			await expectAccessibleScreen(page, `Libraries (${theme})`);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Actions for motion-kit" }),
				"menu",
				`Libraries › a Library's menu (${theme})`,
			);
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

	describe(`Edit mode with a failing Site script, ${theme}`, () => {
		test("the bar says which script failed; Safe mode opens from it and runs none of the Site's scripts", async () => {
			const page = await editModePage(theme);
			const notice = page.getByRole("alert").filter({ hasText: "The Site script failed." });
			await notice.waitFor();
			expect(await notice.textContent()).toContain("startSlider");
			// Outside scripts don't run: a labelled placeholder shows each.
			await page.getByText("Visitor counter").waitFor();
			expect(await page.getByText("doesn't run while editing").count()).toBe(2);
			await expectNoAxeViolations(page, `Edit mode › a failing Site script (${theme})`);

			await notice.getByRole("button", { name: "Open in Safe mode" }).click();
			await page.getByText("Safe mode", { exact: true }).waitFor();
			await page.getByRole("button", { name: "Publish", exact: true }).waitFor();
			expect(await page.getByRole("alert").filter({ hasText: "failed" }).count()).toBe(0);
			expect(await page.evaluate(() => document.documentElement.dataset.siteScript)).toBeUndefined();
			await expectNoAxeViolations(page, `Edit mode › Safe mode (${theme})`);

			// The bar's menu turns it off again.
			await page.getByRole("button", { name: "Ciara Byrne: Edit mode menu" }).click();
			await page.getByRole("menuitem", { name: "Turn off Safe mode" }).click();
			await page.getByRole("alert").filter({ hasText: "The Site script failed." }).waitFor();
		});
	});
}
