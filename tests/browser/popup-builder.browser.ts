import { afterAll, beforeAll, expect, test } from "bun:test";
import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let siteId: string;
let staff: TestAccount;
let firstId: string;
let secondId: string;
// The builder canvas shows Staff's Template and runs no script; Site Checks inspect its content.
const CANVAS = { exclude: ["iframe[title^='Canvas']"] };
beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspace = await local.createWorkspace();
	siteId = (await local.createSite(workspace.id)).id;
	staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
	firstId = (await api.popups.create({ siteId, name: "First offer", key: "first" })).popup.id;
	secondId = (await api.popups.create({ siteId, name: "Second offer", key: "second" })).popup.id;
});
afterAll(async () => {
	await install.close();
});
for (const theme of THEMES)
	test(`the builder inserts and edits a Popup command (${theme})`, async () => {
		const { api } = await install.install.superadmin();
		const { postType } = await api.postTypes.create({
			siteId,
			name: `Builder ${theme}`,
			urlPattern: `/${theme}/{slug}`,
		});
		await api.entries.create({ siteId, postTypeId: postType.id, title: "Popup preview" });
		await api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: '<section data-wc-label="Popup layout"><h1>{{ title }}</h1></section>',
		});
		const page = await install.newPage(theme);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/builder/${siteId}/entry-template/${postType.id}`));
		await page.frameLocator("iframe[title^='Canvas']").getByText("Popup preview").waitFor();
		await page
			.getByRole("tree", { name: "Layers" })
			.getByRole("treeitem", { name: /^Popup layout/ })
			.click();
		await page.getByRole("button", { name: "Insert", exact: true }).focus();
		await page.keyboard.press("Enter");
		const dialog = page.getByRole("dialog");
		await dialog.getByRole("combobox", { name: "Find an element" }).fill("@popup");
		await page.keyboard.press("Enter");
		const choice = dialog.getByRole("combobox", { name: "Popup", exact: true });
		await expectNoAxeViolations(page, `Insert Popup ${theme}`, ["region"], CANVAS);
		await choice.press("f");
		expect(await choice.inputValue()).toBe(firstId);
		await dialog.getByRole("button", { name: "Insert", exact: true }).focus();
		await page.keyboard.press("Enter");
		await dialog.waitFor({ state: "hidden" });
		const selected = page.getByRole("combobox", { name: "Popup", exact: true });
		expect(await selected.inputValue()).toBe(firstId);
		expect(await page.getByRole("treeitem", { name: /^Popup first/ }).isVisible()).toBe(true);
		await selected.press("s");
		expect(await selected.inputValue()).toBe(secondId);
		await page.keyboard.press("ControlOrMeta+s");
		await page.getByRole("button", { name: "Save", exact: true }).and(page.locator("[disabled]")).waitFor();
		expect((await api.templates.getEntryTemplateMarkup({ siteId, postTypeId: postType.id })).markup?.draft).toContain(
			"{{@popup second",
		);
		await expectAccessibleScreen(page, `Popup inspector ${theme}`, CANVAS);
		expect(await page.getByRole("treeitem", { name: /^Popup second/ }).isVisible()).toBe(true);
		expect(await page.frameLocator("iframe[title^='Canvas']").locator("template[data-wc-popup],dialog").count()).toBe(
			0,
		);
		await page.close();
	});

for (const theme of THEMES)
	test(`the Popup's builder saves its tree and opens the Popup review before publishing (${theme})`, async () => {
		const { api } = await install.install.superadmin();
		const workspace = await install.install.createWorkspace();
		const siteId = (await install.install.createSite(workspace.id)).id;
		const staff = (await install.install.createStaff({ workspaces: [workspace.id] })).account;
		const { popup } = await api.popups.create({ siteId, name: "Offer", key: "offer" });
		await api.components.saveMarkup({ siteId, componentId: popup.componentId, markup: "<p>Original Popup tree</p>" });
		await api.popups.publish({ siteId, popupId: popup.id });
		await api.popups.saveDraft({
			siteId,
			popupId: popup.id,
			popup: { layout: "bar", barPosition: "top", barBehavior: "push" },
		});
		const page = await install.newPage(theme);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}/popups?popup=${popup.id}`));
		await page.getByRole("link", { name: "Build layout", exact: true }).click();
		await page.frameLocator("iframe[title^='Canvas']").getByText("Original Popup tree", { exact: true }).waitFor();
		expect(await page.getByRole("button", { name: "Publish", exact: true }).count()).toBe(0);
		const review = page.getByRole("button", { name: "Review and publish Popup", exact: true });
		await review.waitFor({ timeout: 5000 });
		await expectNoAxeViolations(page, `Popup publication from the builder ${theme}`, ["region"], CANVAS);
		await page.getByRole("textbox", { name: "Template markup", exact: true }).fill("<p>Revised Popup tree</p>");
		await review.focus();
		await page.keyboard.press("Enter");
		await page.waitForURL(
			(url) => url.pathname === `/sites/${siteId}/popups` && url.searchParams.get("popup") === popup.id,
		);
		expect(await page.getByRole("combobox", { name: "Layout", exact: true }).inputValue()).toBe("bar");
		const saved = await api.components.getMarkup({ siteId, componentId: popup.componentId });
		expect(saved.markup.draft).toContain("Revised Popup tree");
		expect(saved.markup.published).toContain("Original Popup tree");
		expect((await api.popups.get({ siteId, popupId: popup.id })).popup.published?.layout).toBe("modal");
		await page.getByRole("button", { name: "Publish", exact: true }).last().click();
		await page.getByRole("status").filter({ hasText: "Published" }).waitFor();
		expect((await api.components.getMarkup({ siteId, componentId: popup.componentId })).markup.published).toContain(
			"Revised Popup tree",
		);
		expect((await api.popups.get({ siteId, popupId: popup.id })).popup.published).toMatchObject({
			layout: "bar",
			barPosition: "top",
			barBehavior: "push",
		});
		const history = await api.history.list({ siteId, item: { kind: "popup", id: popup.id } });
		expect(history.copies.filter((copy) => copy.type === "revision")).toHaveLength(2);
		await page.close();
	});
