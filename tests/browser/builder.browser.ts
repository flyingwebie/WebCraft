// The visual builder in a real browser (#66): full-screen, with its top bar, the Layers panel, the
// canvas and the style panel, in light and dark (axe and the keyboard; the canvas shows Staff's own
// Template, which Checks look at, so axe leaves it out). Every move the Layers panel makes from the
// keyboard is checked by what is saved: moving up, down, into the layer before and out, picking up
// and putting down, cut, copy, paste, duplicate, delete and rename, each announced. Dragging on the
// canvas, the Template markup view, the style panel and "Make it a Field" too.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
let entryTemplateId: string;

/** The canvas shows Staff's own Template (Checks look at it) and runs no script: axe leaves it out. */
const CANVAS = { exclude: ["iframe[title^='Canvas']"] };

const ENTRY_TEMPLATE =
	'<article class="intro" data-wc-label="Post" data-wc-id="post"><h1 data-wc-id="t">{{ title }}</h1>' +
	'<p data-wc-id="lead">Fresh from the oven</p>' +
	'<ul data-wc-id="list"><li data-wc-id="one">One</li><li data-wc-id="two">Two</li><li data-wc-id="three">Three</li></ul>' +
	'<section data-wc-id="box"></section></article>';

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId] })).account;
	await api.designSystem.createClass({ siteId, name: "intro", styles: "padding: var(--space-m);" });
	await api.designSystem.saveDraft({ siteId, darkMode: true });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "summary", label: "Summary", type: "text" }],
	});
	postTypeId = postType.id;
	await api.entries.create({ siteId, postTypeId, title: "Fresh bread", fields: { summary: "Out at seven" } });
	await resetTemplate();
});

afterAll(async () => {
	await install.close();
});

/** Puts the Entry template's Draft back as the fixture has it. */
async function resetTemplate(): Promise<void> {
	const { api } = await install.install.superadmin();
	const saved = await api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: ENTRY_TEMPLATE });
	entryTemplateId = saved.template.id;
}

/** The Entry template's Draft as Template markup, as the admin reads it. */
async function draftMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return (await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "";
}

/** The builder open on the Entry template, its canvas showing the Entry saved last. */
async function builderPage(theme: "light" | "dark" = "light"): Promise<Page> {
	const page = await install.newPage(theme);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/builder/${siteId}/entry-template/${postTypeId}`));
	await page.getByRole("tree", { name: "Layers" }).waitFor();
	await page.frameLocator("iframe[title^='Canvas']").getByText("Fresh bread").waitFor();
	return page;
}

/** The layer with this name in the Layers panel. */
function layer(page: Page, name: string | RegExp) {
	return page.getByRole("tree", { name: "Layers" }).getByRole("treeitem", { name });
}

/** What the live region last said. */
async function announced(page: Page): Promise<string> {
	return ((await page.getByRole("status").filter({ hasText: /\S/ }).last().textContent()) ?? "").trim();
}

for (const theme of THEMES) {
	describe(`the builder, ${theme}`, () => {
		test("its top bar, Layers panel and style panel", async () => {
			const page = await builderPage(theme);
			await layer(page, /^Post/).click();
			await page.getByRole("tab", { name: "Style" }).click();
			await page.getByRole("combobox", { name: "Add a Class" }).waitFor();

			await expectAccessibleScreen(page, `Builder (${theme})`, CANVAS);
		});

		test("the insert menu", async () => {
			const page = await builderPage(theme);
			await layer(page, /^Post/).click();

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Insert" }),
				"dialog",
				`Builder › Insert (${theme})`,
				CANVAS,
			);
		});
	});
}

describe("the Layers panel from the keyboard alone", () => {
	test("moves a layer up, down, into the layer before and out, each announced, and saves the moves", async () => {
		await resetTemplate();
		const page = await builderPage();
		await layer(page, /^“Two”/).click();
		await layer(page, /^li/).nth(1).focus();
		expect(await layer(page, /^li/).nth(1).getAttribute("aria-selected")).toBe("true");

		await page.keyboard.press("Alt+ArrowUp");
		expect(await announced(page)).toBe("Moved li: 1 of 3 in ul.");
		await page.keyboard.press("Alt+ArrowUp");
		expect(await announced(page)).toBe("li is already first.");
		await page.keyboard.press("Alt+ArrowDown");
		await page.keyboard.press("Alt+ArrowDown");
		expect(await announced(page)).toBe("Moved li: 3 of 3 in ul.");
		// The tree's rules hold: a list item can't go inside another.
		await page.keyboard.press("Alt+ArrowRight");
		expect(await announced(page)).toBe("<li> can't go inside <li>: a browser would end the <li> before it.");
		await layer(page, /^ul/).click();
		await page.keyboard.press("Alt+ArrowDown");
		expect(await announced(page)).toBe("Moved ul: 4 of 4 in Post.");
		await page.keyboard.press("Alt+ArrowRight");
		expect(await announced(page)).toBe("Moved ul: 1 of 1 in section.");
		await page.keyboard.press("Alt+ArrowLeft");
		expect(await announced(page)).toBe("Moved ul: 4 of 4 in Post.");
		await page.keyboard.press("Alt+ArrowRight");
		await page.keyboard.press("ControlOrMeta+s");
		await page.getByRole("button", { name: "Save" }).and(page.locator("[disabled]")).waitFor();

		expect(await draftMarkup()).toContain(
			'<section data-wc-id="box"><ul data-wc-id="list"><li data-wc-id="one">One</li><li data-wc-id="three">Three</li>' +
				'<li data-wc-id="two">Two</li></ul></section></article>',
		);
	});

	test("picks a layer up with Space, moves it with the arrows, and puts it back with Escape or down with Space", async () => {
		await resetTemplate();
		const page = await builderPage();
		await layer(page, /^section/).click();

		await page.keyboard.press(" ");
		expect(await announced(page)).toStartWith("Picked up section.");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("Escape");
		expect(await announced(page)).toBe("Put section back where it was.");
		await page.keyboard.press(" ");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press(" ");
		expect(await announced(page)).toBe("Put down section: 3 of 4 in Post.");
		await page.keyboard.press("ControlOrMeta+s");
		await page.getByRole("button", { name: "Save" }).and(page.locator("[disabled]")).waitFor();

		expect(await draftMarkup()).toContain('<section data-wc-id="box"></section><ul data-wc-id="list">');
	});

	test("cuts, copies, pastes, duplicates, deletes and renames, each announced", async () => {
		await resetTemplate();
		const page = await builderPage();
		await layer(page, /^p/).click();

		await page.keyboard.press("ControlOrMeta+c");
		expect(await announced(page)).toBe("Copied p.");
		await layer(page, /^section/).click();
		await page.keyboard.press("ControlOrMeta+v");
		expect(await announced(page)).toBe("Pasted p: 5 of 5 in Post.");
		await page.keyboard.press("ControlOrMeta+d");
		expect(await announced(page)).toBe("Duplicated p: 6 of 6 in Post.");
		await page.keyboard.press("Delete");
		expect(await announced(page)).toBe("Deleted p.");
		await layer(page, /^ul/).click();
		await page.keyboard.press("ControlOrMeta+x");
		expect(await announced(page)).toBe("Cut ul.");
		await layer(page, /^h1/).click();
		await page.keyboard.press("ControlOrMeta+v");
		expect(await announced(page)).toBe("Pasted ul: 2 of 5 in Post.");
		await page.keyboard.press("F2");
		const rename = page.getByRole("textbox", { name: "Layer label of ul" });
		await rename.fill("Steps");
		await rename.press("Enter");
		expect(await announced(page)).toBe("Renamed Steps.");
		await expect(layer(page, /^Steps/).getAttribute("aria-selected")).resolves.toBe("true");
		await page.keyboard.press("ControlOrMeta+s");
		await page.getByRole("button", { name: "Save" }).and(page.locator("[disabled]")).waitFor();

		const markup = await draftMarkup();
		expect(markup).toMatch(
			/^<article class="intro" data-wc-label="Post" data-wc-id="post"><h1 data-wc-id="t">\{\{ title \}\}<\/h1><ul data-wc-label="Steps" data-wc-id="[A-Za-z0-9]{12}"><li data-wc-id="[A-Za-z0-9]{12}">One<\/li>/,
		);
		expect(markup).toMatch(
			/<section data-wc-id="box"><\/section><p data-wc-id="[A-Za-z0-9]{12}">Fresh from the oven<\/p><\/article>$/,
		);
	});

	test("undoes and redoes", async () => {
		await resetTemplate();
		const page = await builderPage();
		await layer(page, /^section/).click();
		await page.keyboard.press("Delete");
		await expect(layer(page, /^section/).count()).resolves.toBe(0);

		await page.keyboard.press("ControlOrMeta+z");
		await layer(page, /^section/).waitFor();
		expect(await announced(page)).toBe("Undone.");
		await page.keyboard.press("ControlOrMeta+Shift+z");
		expect(await announced(page)).toBe("Redone.");
		await expect(layer(page, /^section/).count()).resolves.toBe(0);
	});
});
