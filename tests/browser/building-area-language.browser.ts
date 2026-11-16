// The language of the page in the building area, opened and used (BA-35), in Chromium:
// - for a Member, the client bar's language menu: it names the language the page is in; it opens from a
//   click or the arrow keys, lists the Site's languages with the page's one checked, and choosing one
//   opens the page in it in the frame; Escape gives focus back; at a tablet's width the bar shows only
//   its icon and keeps its name;
// - for Staff, the bottom bar's language menu, the same way;
// - the shell passes the accessibility checks with each menu open, light and dark.
// The building area's own test of the old editing bar's language menu (`edit-mode.browser.ts`, "the
// language menu"). On a phone the languages are a list in More (`building-area-phone.browser.ts`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { enterBuildingArea, frameOf } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let editor: TestAccount;
let staff: TestAccount;
let siteId: string;
const slug = "bakery";
const bread = "/bakes/fresh-bread";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Giulia Romano" })).account;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).account;
	await api.languages.add({ siteId, code: "it" });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>Acme Bakery</p></header><main>{{@outlet}}</main><footer><p>Harbour Street, Cork.</p></footer>",
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Bakes",
		urlPattern: "/bakes/{slug}",
		fields: [{ key: "subtitle", label: "Subtitle", type: "text", translatable: true }],
	});
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1><p>{{ subtitle }}</p></article>",
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		slug: "fresh-bread",
		fields: { subtitle: "Out of the oven" },
	});
	await api.entries.publish({ siteId, entryId: entry.id });
});

afterAll(async () => {
	await install?.close();
});

/** Waits until the frame shows `pathname`. */
async function framedAt(page: Page, pathname: string): Promise<Frame> {
	for (let attempt = 0; attempt < 150; attempt++) {
		const frame = await frameOf(page);
		if (new URL(frame.url()).pathname === pathname) {
			await frame.locator("h1").waitFor();
			return frame;
		}
		await page.waitForTimeout(50);
	}
	throw new Error(`The frame never showed ${pathname}.`);
}

const button = (page: Page) => page.locator("[data-wc-language]");
const menu = (page: Page) => page.getByRole("menu", { name: "Language", exact: true });
const focusedItem = (page: Page) =>
	page.evaluate(() =>
		document.activeElement?.getAttribute("role") === "menuitemradio" ? document.activeElement.textContent : null,
	);

/** The menu's items as they read: each language's code and name, and whether it is the page's. */
async function items(page: Page): Promise<[string, string | null][]> {
	return menu(page)
		.getByRole("menuitemradio")
		.evaluateAll((all) => all.map((each) => [each.textContent ?? "", each.getAttribute("aria-checked")]));
}

describe("the language of the page, for a Member", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: editor, siteId, slug, open: `/page${bread}` });
		await framedAt(page, bread);
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("the client bar's menu lists the languages and opens the page in the one chosen", async () => {
		// It names the language the page is in, in the words it shows.
		await page.getByRole("button", { name: "Language: English", exact: true }).waitFor();
		expect(await button(page).textContent()).toBe("English");
		expect(await button(page).getAttribute("aria-haspopup")).toBe("menu");

		await button(page).click();
		await menu(page).waitFor();
		expect(await button(page).getAttribute("aria-expanded")).toBe("true");
		expect(await items(page)).toEqual([
			["ENEnglish", "true"],
			["ITItaliano", "false"],
		]);
		// Focus on the page's language, as a select does; the arrows move.
		expect(await focusedItem(page)).toBe("ENEnglish");
		await page.keyboard.press("ArrowDown");
		expect(await focusedItem(page)).toBe("ITItaliano");
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await expectNoAxeViolations(page, `Client editing › the language menu (${theme})`);
		}
		await page.emulateMedia({ colorScheme: "light" });

		// Escape puts it away, focus back on the button.
		await page.keyboard.press("Escape");
		await menu(page).waitFor({ state: "detached" });
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-language"))).toBe(true);

		// From the keyboard: an arrow opens it; Enter on Italiano opens the page in Italian.
		await page.keyboard.press("ArrowUp");
		await menu(page).waitFor();
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await menu(page).waitFor({ state: "detached" });
		await framedAt(page, `/it${bread}`);
		await page.getByRole("button", { name: "Language: Italiano", exact: true }).waitFor();
		expect(await button(page).textContent()).toBe("Italiano");
		// The shell's address follows the page.
		await page.waitForURL((url) => url.pathname === `/_webcraft/build/page/it${bread}`);

		// And back, by a click.
		await button(page).click();
		expect(await items(page)).toEqual([
			["ENEnglish", "false"],
			["ITItaliano", "true"],
		]);
		await menu(page)
			.getByRole("menuitemradio", { name: /English/ })
			.click();
		await framedAt(page, bread);
		await page.getByRole("button", { name: "Language: English", exact: true }).waitFor();
	});

	test("at a tablet's width the bar shows the menu's icon only, keeps its name, and it works the same", async () => {
		await page.setViewportSize({ width: 768, height: 1024 });
		try {
			await page.locator('[data-wc-client][data-wc-layout="tablet"]').waitFor();
			await page.getByRole("button", { name: "Language: English", exact: true }).waitFor();
			// Its words are hidden (only its icon shows); its name keeps them.
			expect(
				await button(page).evaluate(
					(shown) => [...shown.children].filter((child) => getComputedStyle(child).display !== "none").length,
				),
			).toBe(1);
			await button(page).click();
			await menu(page).waitFor();
			expect(await items(page)).toEqual([
				["ENEnglish", "true"],
				["ITItaliano", "false"],
			]);
			// The menu stays inside the window.
			const shown = await menu(page).boundingBox();
			expect(shown && shown.x >= 0 && shown.x + shown.width <= 768).toBe(true);
			for (const theme of ["light", "dark"] as const) {
				await page.emulateMedia({ colorScheme: theme });
				await expectNoAxeViolations(page, `Client editing on a tablet › the language menu (${theme})`);
			}
			await page.emulateMedia({ colorScheme: "light" });
			await menu(page)
				.getByRole("menuitemradio", { name: /Italiano/ })
				.click();
			await framedAt(page, `/it${bread}`);
			await page.getByRole("button", { name: "Language: Italiano", exact: true }).waitFor();
			await button(page).click();
			await menu(page)
				.getByRole("menuitemradio", { name: /English/ })
				.click();
			await framedAt(page, bread);
		} finally {
			await page.setViewportSize({ width: 1440, height: 900 });
		}
		await expectAccessibleScreen(page, "Client editing › after choosing a language");
	});
});

describe("the language of the page, for Staff", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: `/page${bread}` });
		await framedAt(page, bread);
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("the bottom bar's menu lists the languages and opens the page in the one chosen", async () => {
		await page.getByRole("button", { name: "EN, Language: English", exact: true }).waitFor();
		expect(await button(page).textContent()).toBe("EN");
		await button(page).click();
		await menu(page).waitFor();
		expect(await items(page)).toEqual([
			["ENEnglish", "true"],
			["ITItaliano", "false"],
		]);
		expect(await focusedItem(page)).toBe("ENEnglish");
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await expectNoAxeViolations(page, `Building area › the language menu (${theme})`);
		}
		await page.emulateMedia({ colorScheme: "light" });
		await page.keyboard.press("End");
		expect(await focusedItem(page)).toBe("ITItaliano");
		await page.keyboard.press("Enter");
		await framedAt(page, `/it${bread}`);
		await page.getByRole("button", { name: "IT, Language: Italiano", exact: true }).waitFor();
		// The button stays while the page in the other language loads, and focus is back on it.
		const onButton = () => page.evaluate(() => document.activeElement?.hasAttribute("data-wc-language") ?? false);
		expect(await onButton()).toBe(true);

		await button(page).click();
		await menu(page)
			.getByRole("menuitemradio", { name: /English/ })
			.click();
		await framedAt(page, bread);
		await page.getByRole("button", { name: "EN, Language: English", exact: true }).waitFor();
		expect(await onButton()).toBe(true);
		await expectAccessibleScreen(page, "Building area › after choosing a language");
	});
});
