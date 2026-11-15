// A Popup command in a Template, in the building area (ADR 0037): Insert's Template commands place one
// (`{{@popup <key>}}`), and the HTML pane changes which Popup it shows; nothing of the Popup runs or
// shows in the frame while editing. Light and dark, with axe. The Popup's own layout and its review
// before publishing are `building-area-switching`'s "a Popup's Component goes to its review" check.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let siteId: string;
let staff: TestAccount;
const slug = "popups";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspace = await local.createWorkspace();
	siteId = (await local.createSite(workspace.id, { slug })).id;
	staff = (await local.createStaff({ workspaces: [workspace.id] })).account;
	await api.popups.create({ siteId, name: "First offer", key: "first" });
	await api.popups.create({ siteId, name: "Second offer", key: "second" });
	const site = await api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main>{{@outlet}}</main>" });
	await api.templates.publish({ siteId, templateId: site.template.id });
});

afterAll(async () => {
	await install.close();
});

const menu = (page: Page) => page.locator("dialog[data-wc-command-menu]");
const htmlBox = (page: Page) => page.locator('textarea[data-wc-code-box="html"]');

for (const theme of THEMES)
	test(`Insert places a Popup command, and the HTML pane changes which Popup it shows (${theme})`, async () => {
		const { api } = await install.install.superadmin();
		const { postType } = await api.postTypes.create({
			siteId,
			name: `Offers ${theme}`,
			urlPattern: `/${theme}/{slug}`,
		});
		await api.entries.create({ siteId, postTypeId: postType.id, title: "Popup preview" });
		await api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: '<section data-wc-label="Popup layout"><h1>{{ title }}</h1></section>',
		});
		const draft = async () =>
			(await api.templates.getEntryTemplateMarkup({ siteId, postTypeId: postType.id })).markup?.draft ?? "";
		const page = await install.newPage(theme);
		await page.setViewportSize({ width: 1440, height: 900 });
		const frame = await enterBuildingArea(install, page, {
			as: staff,
			siteId,
			slug,
			open: `/entry-template/${postType.id}`,
		});
		await frame.getByText("Popup preview").waitFor();
		const tree = page.getByRole("tree", { name: "Elements of the page" });
		await tree.getByRole("treeitem", { name: /^Popup layout/ }).click();
		await settled(page);

		await page.keyboard.press("ControlOrMeta+i");
		const search = menu(page).getByRole("combobox");
		await search.waitFor();
		await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "combobox");
		await search.fill("first offer");
		const first = menu(page).getByRole("option", { name: /^Popup: First offer/ });
		await first.waitFor();
		await expectNoAxeViolations(page, `Insert's Template commands, a Popup (${theme})`);
		await page.keyboard.press("Enter");
		await menu(page).waitFor({ state: "hidden" });
		for (let attempt = 0; attempt < 50 && !(await draft()).includes("{{@popup first"); attempt++)
			await page.waitForTimeout(100);
		expect(await draft()).toContain("{{@popup first");

		// The HTML pane shows the Template's markup: the Popup it shows is changed there.
		await tree.getByRole("treeitem", { name: /^Popup layout/ }).click();
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="html"]')?.value.includes("@popup") ===
				true,
		);
		const markup = (await htmlBox(page).inputValue()).replace("{{@popup first", "{{@popup second");
		await htmlBox(page).click();
		await page.keyboard.press("ControlOrMeta+A");
		await page.keyboard.insertText(markup);
		await page.locator('[data-wc-rail="panels"]').focus();
		for (let attempt = 0; attempt < 50 && !(await draft()).includes("{{@popup second"); attempt++)
			await page.waitForTimeout(100);
		expect(await draft()).toContain("{{@popup second");
		await expectAccessibleScreen(page, `the building area with a Popup command (${theme})`);
		// Nothing of a Popup shows or runs in the frame while editing.
		expect(await (await frameOf(page)).locator("template[data-wc-popup],dialog").count()).toBe(0);
		await page.close();
	});
