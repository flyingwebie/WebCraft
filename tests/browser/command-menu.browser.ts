// The Command menu (#131) in a real browser, on both canvases, in light and dark: its three tabs and
// their keys (winning over the code panels), what screen readers hear (the tab list, the highlighted
// result read as label, group and key, the count once typing pauses, Insert's "Inserts inside …"),
// Recent, canvas-scoped commands, the shared layer actions, Insert's toolbar rules and ⌥↵, Go to
// (layers, Templates, Pages in Code mode keeping the Draft), where focus returns, and the Keyboard
// shortcuts list built from the shortcut registry with the same keys as the tooltips. Axe checks
// every open state.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Locator, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
const SLUG = "commands";

/** The canvas shows Staff's own Template (Checks look at it) and runs no script: axe leaves it out. */
const CANVAS = { exclude: ["iframe[title^='Canvas']"] };

const ENTRY_TEMPLATE =
	'<article class="intro" data-wc-label="Post" data-wc-id="post"><h1 data-wc-id="t">{{ title }}</h1>' +
	'<p data-wc-id="lead">Fresh from the oven</p>' +
	'<ul data-wc-id="list"><li data-wc-id="one">One</li></ul>' +
	'<section data-wc-id="box"></section></article>';

const openedPages: Page[] = [];
async function testPage(theme: "light" | "dark") {
	const page = await install.newPage(theme);
	page.setDefaultTimeout(10000);
	openedPages.push(page);
	return page;
}
afterEach(async () => {
	await Promise.all(openedPages.splice(0).map((page) => page.close()));
});

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Commands Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Command Bakery", slug: SLUG })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId] })).account;
	await api.designSystem.createClass({ siteId, name: "intro", styles: "padding: var(--space-m);" });
	const pages = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	if (!pages) throw new Error("Page Post Type missing");
	const home = (await api.entries.create({ siteId, postTypeId: pages.id, title: "Welcome" })).entry;
	await api.pages.setHomePage({ siteId, pageId: home.id });
	await api.entries.create({ siteId, postTypeId: pages.id, title: "About us" });
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	postTypeId = postType.id;
	await api.entries.create({ siteId, postTypeId, title: "Fresh bread" });
	const { component } = await api.components.create({ siteId, name: "Hero" });
	await api.components.saveMarkup({ siteId, componentId: component.id, markup: '<h2 data-wc-id="hero">Hero</h2>' });
	await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header data-wc-id="top"><p data-wc-id="hello" data-wc-label="Greeting">Hello</p></header>' +
			'<main data-wc-id="main">{{@outlet}}</main>',
	});
});

beforeEach(async () => {
	const { api } = await install.install.superadmin();
	await api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: ENTRY_TEMPLATE });
});

afterAll(async () => {
	await install.close();
});

async function draftMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return (await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "";
}

async function builderPage(theme: "light" | "dark" = "light"): Promise<Page> {
	const page = await testPage(theme);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/builder/${siteId}/entry-template/${postTypeId}`));
	await page.getByRole("tree", { name: "Layers" }).waitFor();
	await page.frameLocator("iframe[title^='Canvas']").getByText("Fresh bread").waitFor();
	return page;
}

async function codeModePage(theme: "light" | "dark" = "light"): Promise<Page> {
	const page = await testPage(theme);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/sites/${siteId}`));
	await page.getByRole("button", { name: "Edit on site" }).click();
	await page.waitForURL((url) => url.hostname.startsWith(SLUG));
	await page.getByRole("button", { name: "Code", exact: true }).click();
	await page.getByRole("tree", { name: "Layers" }).getByRole("treeitem").first().waitFor();
	return page;
}

function layer(page: Page, name: string | RegExp) {
	return page.getByRole("tree", { name: "Layers" }).getByRole("treeitem", { name });
}

function menuOf(page: Page) {
	return page.getByRole("dialog", { name: "Command menu" });
}

/** Whether the browser is on an Apple device: ⌘ and "Command" there, Ctrl and "Control" elsewhere. */
async function onApple(page: Page): Promise<boolean> {
	return page.evaluate(() => /mac|iphone|ipad/i.test(navigator.platform));
}

/** An option's accessible name: its text, without what is hidden from screen readers. */
function spokenText(option: Element): string {
	const copy = option.cloneNode(true) as Element;
	for (const hidden of copy.querySelectorAll("[aria-hidden=true]")) hidden.remove();
	return (copy.textContent ?? "").trim();
}

/** What a screen reader reads for the highlighted result: the option the search box points at. */
async function highlighted(search: Locator): Promise<string> {
	return search.evaluate((input) => {
		const id = input.getAttribute("aria-activedescendant");
		const option = id ? (input.getRootNode() as Document | ShadowRoot).getElementById(id) : null;
		if (!option) return "";
		const copy = option.cloneNode(true) as Element;
		for (const hidden of copy.querySelectorAll("[aria-hidden=true]")) hidden.remove();
		return (copy.textContent ?? "").trim();
	});
}

/** The search box's description, as its `aria-describedby` reads. */
async function description(search: Locator): Promise<string> {
	return search.evaluate((input) => {
		const root = input.getRootNode() as Document | ShadowRoot;
		return (input.getAttribute("aria-describedby") ?? "")
			.split(" ")
			.map((id) => root.getElementById(id)?.textContent?.trim() ?? "")
			.join(" ");
	});
}

/** The element with focus, through shadow roots: its role and accessible name as the page gives them. */
async function focused(page: Page): Promise<{ role: string | null; text: string }> {
	return page.evaluate(() => {
		let active = document.activeElement;
		while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
		return {
			role: active?.getAttribute("role") ?? active?.tagName.toLowerCase() ?? null,
			text: (active?.getAttribute("aria-label") ?? active?.textContent ?? "").trim(),
		};
	});
}

async function waitForFocus(page: Page, role: string, text: RegExp): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const now = await focused(page);
		if (now.role === role && text.test(now.text)) return;
		await page.waitForTimeout(50);
	}
	expect(await focused(page)).toEqual({ role, text: String(text) });
}

async function expectAnnounced(page: Page, text: string | RegExp): Promise<void> {
	await page.getByRole("status").filter({ hasText: text }).first().waitFor({ timeout: 10_000 });
}

for (const theme of THEMES) {
	describe(`the Command menu in the Builder, ${theme}`, () => {
		test("three tabs and their keys, read by screen readers, Recent and focus returning", async () => {
			const page = await builderPage(theme);
			const command = (await onApple(page)) ? "Command" : "Control";
			await layer(page, /^section/).click();
			await page.keyboard.press("ControlOrMeta+k");
			const menu = menuOf(page);
			await menu.waitFor();
			expect(await menu.getByRole("tab", { name: /^Actions/, selected: true }).count()).toBe(1);
			await page.waitForTimeout(250);
			await expectNoAxeViolations(page, `Command menu, Actions (${theme})`, ["region"], CANVAS);

			const search = menu.getByRole("combobox");
			expect(await search.getAttribute("aria-label")).toBe("Search actions");
			await page.keyboard.press("Tab");
			await menu.getByRole("tab", { name: /^Go to/, selected: true }).waitFor();
			expect(await search.getAttribute("aria-label")).toBe("Go to a page, Template, Component or layer");
			await page.keyboard.press("Shift+Tab");
			await menu.getByRole("tab", { name: /^Actions/, selected: true }).waitFor();

			// Edit mode's own actions are Code mode's: the Builder hides them.
			await search.fill("Safe mode");
			await menu.getByText("Nothing matches.").waitFor();
			await search.fill("dupl");
			expect(await highlighted(search)).toBe(`Duplicate, Element, ${command} D`);
			await menu.getByRole("status").filter({ hasText: "1 result" }).waitFor();
			await page.keyboard.press("Enter");
			await menu.waitFor({ state: "hidden" });
			await expectAnnounced(page, /^Duplicated section: /);
			await waitForFocus(page, "treeitem", /^section/);

			await page.keyboard.press("ControlOrMeta+k");
			await menu.waitFor();
			const recent = menu.getByRole("group", { name: "Recent" });
			expect(await recent.getByRole("option").first().evaluate(spokenText)).toBe(`Duplicate, Element, ${command} D`);
			// A tab's own key closes the menu when that tab is open; another key switches to its tab.
			await page.keyboard.press("ControlOrMeta+p");
			await menu.getByRole("tab", { name: /^Go to/, selected: true }).waitFor();
			await page.keyboard.press("ControlOrMeta+p");
			await menu.waitFor({ state: "hidden" });
			await waitForFocus(page, "treeitem", /^section/);

			// The keys win over the code panels, and the toolbar button opens it too.
			await page.locator("[data-code-panel] textarea").first().focus();
			await page.keyboard.press("ControlOrMeta+i");
			await menu.getByRole("tab", { name: /^Insert/, selected: true }).waitFor();
			await page.keyboard.press("Escape");
			await menu.waitFor({ state: "hidden" });
			await waitForFocus(page, "textarea", /./);
			await page.getByRole("button", { name: "Command menu" }).click();
			await menu.getByRole("tab", { name: /^Actions/, selected: true }).waitFor();
		});

		test("Insert follows the toolbar's switch, says where, and ⌥↵ inserts the other way", async () => {
			const page = await builderPage(theme);
			await layer(page, /^section/).click();
			await page.keyboard.press("ControlOrMeta+i");
			const menu = menuOf(page);
			const search = menu.getByRole("combobox", { name: "Find an element" });
			await search.waitFor();
			await page.waitForTimeout(250);
			await expectNoAxeViolations(page, `Command menu, Insert (${theme})`, ["region"], CANVAS);
			expect(await description(search)).toBe("Inserts inside section Insert after instead");
			const options = await menu.getByRole("option").evaluateAll((all) =>
				all.map((option) => {
					const copy = option.cloneNode(true) as Element;
					for (const hidden of copy.querySelectorAll("[aria-hidden=true]")) hidden.remove();
					return (copy.textContent ?? "").trim();
				}),
			);
			expect(options.slice(0, 6)).toEqual([
				"Heading 2, Text",
				"Paragraph, Text",
				"Image, Media and more",
				"Loop, Template commands",
				"Hero, Components",
				"<section>, Sections",
			]);
			await menu.getByRole("button", { name: "After", exact: true }).click();
			expect(await description(search)).toBe("Inserts after section Insert inside instead");
			await menu.getByRole("button", { name: "Inside", exact: true }).click();
			expect(await description(search)).toBe("Inserts inside section Insert after instead");

			// Search reaches every allowed HTML element.
			await search.fill("<dl>");
			expect(await highlighted(search)).toBe("<dl>, HTML elements");
			await search.fill("Paragraph");
			await search.press("Alt+Enter");
			await menu.waitFor({ state: "hidden" });
			await expectAnnounced(page, "Inserted p: 5 of 5 in Post.");
			await waitForFocus(page, "treeitem", /^p/);
			await page.keyboard.press("ControlOrMeta+s");
			await page
				.locator("header")
				.getByRole("button", { name: "Save", exact: true })
				.and(page.locator("[disabled]"))
				.waitFor();
			expect(await draftMarkup()).toMatch(/<section data-wc-id="box"><\/section><p data-wc-id="[A-Za-z0-9]{12}">/);
		});
	});

	test(`the Command menu in Code mode: the same menu, its own actions and Insert's marker line (${theme})`, async () => {
		const page = await codeModePage(theme);
		const html = page.getByRole("textbox", { name: /^HTML of / });
		await html.focus();
		await page.keyboard.press("ControlOrMeta+k");
		const menu = menuOf(page);
		await menu.waitFor();
		await page.waitForTimeout(250);
		await expectNoAxeViolations(page, `Code mode Command menu (${theme})`, ["region"]);
		const search = menu.getByRole("combobox", { name: "Search actions" });
		for (const name of ["Open in builder", "Open the page script", "Turn Safe mode on", "Preview", "Leave Edit mode"]) {
			await search.fill(name);
			expect(await highlighted(search)).toStartWith(`${name}, Editor`);
		}
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "hidden" });
		await waitForFocus(page, "textarea", /./);

		await layer(page, /^header/).click();
		await page.keyboard.press("ControlOrMeta+i");
		const where = menu.getByRole("combobox", { name: "Find an element" });
		await where.waitFor();
		expect(await description(where)).toBe("Inserts inside header Insert after instead");
		await page.locator('[data-insert-preview="inside"]').waitFor();
		await where.fill("Heading 3");
		await where.press("Enter");
		await menu.waitFor({ state: "hidden" });
		await waitForFocus(page, "treeitem", /^h3/);

		// Publish asks first: Code mode's Publish opens the editing bar's own confirmation.
		await page.keyboard.press("ControlOrMeta+k");
		await menu.getByRole("combobox", { name: "Search actions" }).fill("Publish");
		await page.keyboard.press("Enter");
		const publish = page.getByRole("dialog", { name: /^Publish/ });
		await publish.waitFor();
		await page.keyboard.press("Escape");
		await publish.waitFor({ state: "hidden" });

		// Templates and Components open in the Builder.
		await page.keyboard.press("ControlOrMeta+p");
		const goTo = menu.getByRole("combobox");
		await menu.getByRole("group", { name: "Components" }).waitFor();
		await goTo.fill("Hero");
		expect(await highlighted(goTo)).toBe("Hero, Components");
		await page.keyboard.press("Enter");
		await page.waitForURL((url) => url.pathname.startsWith(`/builder/${siteId}/component/`));
	});
}

describe("the Command menu's actions on a selection", () => {
	test("Select parent, Duplicate and Delete outside the code panels; Wrap in and Unwrap", async () => {
		const page = await builderPage();
		await layer(page, /^p/).click();
		await page.getByRole("button", { name: "Desktop width" }).focus();
		await page.keyboard.press("Escape");
		await expectAnnounced(page, "Post selected.");
		await page.locator("[data-code-panel] textarea").first().focus();
		await page.keyboard.press("ControlOrMeta+d");
		await page.keyboard.press("Backspace");
		expect(await layer(page, /^Post/).count()).toBe(1);
		await page.getByRole("button", { name: "Desktop width" }).focus();
		await page.keyboard.press("ControlOrMeta+d");
		await expectAnnounced(page, /^Duplicated Post: /);
		expect(await layer(page, /^Post/).count()).toBe(2);
		await page.keyboard.press("Backspace");
		await expectAnnounced(page, "Deleted Post.");
		expect(await layer(page, /^Post/).count()).toBe(1);

		await layer(page, /^p/).click();
		await page.keyboard.press("ControlOrMeta+k");
		const menu = menuOf(page);
		await menu.getByRole("combobox").fill("Wrap in section");
		await page.keyboard.press("Enter");
		await expectAnnounced(page, "Wrapped p in section.");
		await page.keyboard.press("ControlOrMeta+k");
		await menu.getByRole("combobox").fill("Unwrap");
		await page.keyboard.press("Enter");
		await expectAnnounced(page, "Unwrapped section.");

		await page.keyboard.press("ControlOrMeta+k");
		await menu.getByRole("combobox").fill("Rename");
		await page.keyboard.press("Enter");
		const label = page.getByRole("textbox", { name: "Layer label of p" });
		await label.waitFor();
		await waitForFocus(page, "input", /./);
		await label.fill("Lead");
		await label.press("Enter");
		await layer(page, /^Lead/).waitFor();

		await page.keyboard.press("ControlOrMeta+k");
		await menu.getByRole("combobox").fill("Publish");
		await page.keyboard.press("Enter");
		const confirm = page.getByRole("dialog", { name: /^Publish .*\?$/ });
		await confirm.waitFor();
		await confirm.getByRole("button", { name: "Cancel" }).click();
		await confirm.waitFor({ state: "hidden" });
	});

	test("a Placement gets Edit the Component and Hide or show the Placement", async () => {
		const { api } = await install.install.superadmin();
		await api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup: `${ENTRY_TEMPLATE}<Hero data-wc-id="banner" />`,
		});
		const page = await builderPage();
		await layer(page, /^Hero/).click();
		await page.keyboard.press("ControlOrMeta+k");
		const menu = menuOf(page);
		const search = menu.getByRole("combobox");
		await search.fill("Placement");
		expect(await highlighted(search)).toBe("Edit the Component, Placement");
		await search.fill("hide");
		expect(await highlighted(search)).toBe("Hide the Placement, Placement");
		await page.keyboard.press("Enter");
		await page.keyboard.press("ControlOrMeta+k");
		await search.fill("show");
		expect(await highlighted(search)).toBe("Show the Placement, Placement");
		await page.keyboard.press("Escape");
		await page.keyboard.press("ControlOrMeta+s");
		await page
			.locator("header")
			.getByRole("button", { name: "Save", exact: true })
			.and(page.locator("[disabled]"))
			.waitFor();
		expect(await draftMarkup()).toContain('<Hero data-wc-hidden="true" data-wc-id="banner" />');
		await page.keyboard.press("ControlOrMeta+k");
		await search.fill("Edit the Component");
		await page.keyboard.press("Enter");
		await page.waitForURL((url) => url.pathname.startsWith(`/builder/${siteId}/component/`));
		await page.getByRole("tree", { name: "Layers" }).getByRole("treeitem", { name: /^h2/ }).waitFor();
	});

	test("Go to selects a layer by its label, and opens a Page in Code mode keeping the Draft", async () => {
		const page = await builderPage();
		await page.keyboard.press("ControlOrMeta+p");
		const menu = menuOf(page);
		const search = menu.getByRole("combobox");
		await menu.getByRole("group", { name: "Templates" }).waitFor();
		await expectNoAxeViolations(page, "Command menu, Go to", ["region"], CANVAS);
		await search.fill("Post article");
		expect(await highlighted(search)).toBe("Post, Layers on this page");
		await page.keyboard.press("Enter");
		await waitForFocus(page, "treeitem", /^Post/);

		await page.getByRole("button", { name: "Heading", exact: true }).click();
		await expectAnnounced(page, /^Inserted h2/);
		await page.keyboard.press("ControlOrMeta+p");
		await search.fill("About us");
		expect(await highlighted(search)).toBe("About us, Pages");
		await page.keyboard.press("Enter");
		await page.waitForURL((url) => url.hostname.startsWith(SLUG) && url.pathname === "/about-us");
		await page.getByRole("tree", { name: "Layers" }).waitFor();
		expect(await draftMarkup()).toContain("<h2");
	});

	test("Keyboard shortcuts lists the shortcut registry by area, with the tooltips' keys", async () => {
		const page = await builderPage();
		const apple = await onApple(page);
		const undo = page.getByRole("button", { name: "Undo" });
		expect(await undo.getAttribute("title")).toBe(apple ? "Undo (⌘Z)" : "Undo (Ctrl+Z)");
		const opener = page.getByRole("button", { name: "Command menu" });
		expect(await opener.getAttribute("title")).toBe(apple ? "Command menu (⌘K)" : "Command menu (Ctrl+K)");
		await opener.focus();
		await page.keyboard.press("ControlOrMeta+/");
		const list = page.getByRole("dialog", { name: "Keyboard shortcuts" });
		await list.waitFor();
		await page.waitForTimeout(250);
		await expectNoAxeViolations(page, "Keyboard shortcuts", ["region"], CANVAS);
		for (const area of ["Command menu", "Editor", "Selected element, outside the code panels", "Layers panel"])
			await list.getByRole("table", { name: area }).waitFor();
		const editor = list.getByRole("table", { name: "Editor" });
		expect(await editor.getByRole("row", { name: /Undo/ }).textContent()).toContain(apple ? "⌘Z" : "Ctrl+Z");
		await page.keyboard.press("Escape");
		await list.waitFor({ state: "hidden" });
		await waitForFocus(page, "button", /Command menu/);
	});
});
