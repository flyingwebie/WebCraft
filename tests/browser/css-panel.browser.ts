// The CSS panel in a real browser (#132, decided in #120; ADR 0035: one panel on both canvases): one
// tab per Class of the selected element in the order of its `class` attribute, then the Site CSS;
// each Class tab with its width switcher, Own CSS, how widely the Class is used and a layout row of
// plain declarations; Classes added and removed through the element's HTML, never deleted; token
// utilities as removable chips; a Generated Class made normal by editing, with an optional rename;
// and no `@layer`. Checked in light and dark, from the keyboard, and on the Builder's canvas.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Cookie, Locator, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
let tablet: { id: string; name: string; width: number };
const slug = "css-bakery";
const path = "/blog/fresh-bread";
const ENTRY_TEMPLATE = [
	"<article>",
	'<h1 class="hero-title lead p-m">{{ title }}</h1>',
	'<p class="lead">{{ subtitle }}</p>',
	"<p>Plain words</p>",
	"</article>",
].join("");

const openedPages: Page[] = [];
async function testPage(theme: Theme) {
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
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId] })).account;
	const { designSystem } = await api.designSystem.get({ siteId });
	const first = [...designSystem.draft.tokens.breakpoints].sort((a, b) => a.width - b.width)[0];
	if (!first) throw new Error("The default Design system has no breakpoint.");
	tablet = { id: first.id, name: first.name, width: first.width };
	await api.designSystem.createClass({
		siteId,
		name: "hero-title",
		styles: "font-size: var(--text-xl);",
		css: "&:hover {\n  color: rgb(1, 2, 3);\n}",
	});
	await api.designSystem.createClass({ siteId, name: "lead", styles: "line-height: 1.6;" });
	await api.designSystem.createClass({ siteId, name: "hero", styles: "padding: var(--space-m);" });
	await api.designSystem.publish({ siteId });
	const layout = await api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main>{{@outlet}}</main>" });
	await api.templates.publish({ siteId, templateId: layout.template.id });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "subtitle", label: "Subtitle", type: "text" }],
	});
	postTypeId = postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: ENTRY_TEMPLATE });
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: post } = await api.entries.create({
		siteId,
		postTypeId,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven at seven" },
	});
	await api.entries.publish({ siteId, entryId: post.id });
});

beforeEach(async () => {
	await (await install.install.superadmin()).api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: ENTRY_TEMPLATE,
	});
});

afterAll(async () => {
	await install.close();
});

let cookies: Cookie[] | undefined;

/** A page in Code mode: the first time through "Edit on site" in the admin, then Code in the editing bar. */
async function codeModePage(theme: Theme): Promise<Page> {
	const page = await testPage(theme);
	if (cookies) {
		await page.context().addCookies(cookies);
		await page.goto(install.siteUrl(slug, path));
	} else {
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname === new URL(install.siteUrl(slug, "/")).hostname);
		await page.goto(install.siteUrl(slug, path));
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await page.getByRole("textbox", { name: /^HTML of / }).waitFor();
		cookies = (await page.context().cookies()).filter((cookie) => cookie.name.startsWith("webcraft."));
	}
	await page
		.getByRole("textbox", { name: "HTML of Blog posts · Entry template" })
		.and(page.locator(":not([readonly])"))
		.waitFor();
	await page.getByRole("tab", { name: "Site CSS" }).waitFor();
	return page;
}

const cssRegion = (page: Page) => page.getByRole("region", { name: "CSS", exact: true });
const tabList = (page: Page) => page.getByRole("tablist", { name: "Classes of the selected element" });
const cssText = (page: Page) => cssRegion(page).getByRole("textbox", { name: /^CSS: / });

async function tabNames(page: Page): Promise<string[]> {
	return (await tabList(page).getByRole("tab").allTextContents()).map((name) =>
		name.replace(/(classes|custom)$/, "").trim(),
	);
}

/** Waits until the panel shows these tabs: a newly selected element's arrive after its selection. */
async function waitForTabs(page: Page, expected: readonly string[]): Promise<void> {
	let shown: string[] = [];
	for (let tries = 0; tries < 40; tries++) {
		shown = await tabNames(page);
		if (shown.join(" ") === expected.join(" ")) return;
		await page.waitForTimeout(250);
	}
	expect(shown).toEqual([...expected]);
}

async function selectedTab(page: Page): Promise<string> {
	return ((await tabList(page).getByRole("tab", { selected: true }).textContent()) ?? "")
		.replace(/(classes|custom)$/, "")
		.trim();
}

/** Selects an element on the page and waits until the panel shows its first tab. */
async function selectOnPage(page: Page, element: Locator, tab: string): Promise<void> {
	await element.click();
	await tabList(page).getByRole("tab", { name: tab, selected: true }).waitFor();
}

async function draftMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return (await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "";
}

async function draftClasses() {
	const { api } = await install.install.superadmin();
	return (await api.designSystem.get({ siteId })).designSystem.draft.classes;
}

for (const theme of THEMES) {
	describe(`the CSS panel in Code mode, ${theme}`, () => {
		test("one tab per Class in the element's order, then Site CSS, each with its cascade layer", async () => {
			const page = await codeModePage(theme);

			await selectOnPage(page, page.locator("main h1"), ".hero-title");

			expect(await tabNames(page)).toEqual([".hero-title", ".lead", "Site CSS"]);
			const region = cssRegion(page);
			await region.getByText("Cascade layer: classes").waitFor();
			await region.getByText("Used on 1 element / 1 page").waitFor();
			await region.getByRole("listitem").filter({ hasText: "p-m" }).waitFor();
			expect(await cssText(page).inputValue()).toBe("font-size: var(--text-xl);");
			await expectNoAxeViolations(page, `CSS panel › a Class tab (${theme})`);

			await tabList(page).getByRole("tab", { name: "Site CSS" }).click();
			await region.getByText("Cascade layer: custom").waitFor();
			expect(await region.getByRole("group", { name: "Layout" }).count()).toBe(0);
			await expectNoAxeViolations(page, `CSS panel › Site CSS (${theme})`);
		});
	});
}

describe("choosing what to edit", () => {
	test("the last Class edited stays open on another element that has it; an element with no Class opens on Site CSS", async () => {
		const page = await codeModePage("light");
		await selectOnPage(page, page.locator("main h1"), ".hero-title");

		await tabList(page).getByRole("tab", { name: ".lead" }).click();
		await page.locator("main p", { hasText: "Out of the oven" }).click();
		await waitForTabs(page, [".lead", "Site CSS"]);
		expect(await selectedTab(page)).toBe(".lead");

		await page.locator("main p", { hasText: "Plain words" }).click();
		await waitForTabs(page, ["Site CSS"]);
		expect(await selectedTab(page)).toBe("Site CSS");
	});

	test("the width switcher and Own CSS choose which piece of the Class is edited; the layout row hides on Own CSS", async () => {
		const page = await codeModePage("light");
		await selectOnPage(page, page.locator("main h1"), ".hero-title");
		const region = cssRegion(page);

		await region.getByRole("button", { name: `${tablet.name} (${tablet.width}px)` }).click();
		await region.getByRole("textbox", { name: `CSS: .hero-title from ${tablet.name}` }).waitFor();
		expect(await region.getByRole("group", { name: "Layout" }).count()).toBe(1);

		await region.getByRole("button", { name: "Own CSS" }).click();
		const own = region.getByRole("textbox", { name: "CSS: .hero-title, own CSS" });
		expect(await own.inputValue()).toBe("&:hover {\n  color: rgb(1, 2, 3);\n}");
		expect(await region.getByRole("group", { name: "Layout" }).count()).toBe(0);

		await region.getByRole("button", { name: "All widths" }).click();
		await region.getByRole("textbox", { name: "CSS: .hero-title" }).waitFor();
	});

	test("the tabs are reached and moved through from the keyboard", async () => {
		const page = await codeModePage("light");
		await selectOnPage(page, page.locator("main h1"), ".hero-title");

		await tabList(page).getByRole("tab", { name: ".hero-title" }).focus();
		await page.keyboard.press("ArrowRight");
		expect(await selectedTab(page)).toBe(".lead");
		await page.keyboard.press("End");
		expect(await selectedTab(page)).toBe("Site CSS");
		await page.keyboard.press("Home");
		expect(await selectedTab(page)).toBe(".hero-title");
		expect(
			await tabList(page)
				.getByRole("tab", { name: ".hero-title" })
				.evaluate((tab) => tab.matches(":focus")),
		).toBe(true);
	});
});

describe("adding and removing Classes", () => {
	test("+ adds a Class of the Site, and a new name makes an empty Class first, written into the HTML", async () => {
		const page = await codeModePage("light");
		await selectOnPage(page, page.locator("main h1"), ".hero-title");
		const region = cssRegion(page);
		const html = page.getByRole("textbox", { name: "HTML of Blog posts · Entry template" });

		await region.getByRole("button", { name: "Give this element a Class" }).click();
		await region.getByRole("combobox", { name: "Class name" }).fill("hero");
		await region.getByRole("combobox", { name: "Class name" }).press("Enter");
		await tabList(page).getByRole("tab", { name: ".hero", exact: true, selected: true }).waitFor();
		await page.waitForFunction(() => document.querySelector("main h1")?.classList.contains("hero"));
		expect(await html.inputValue()).toContain('class="hero-title lead p-m hero"');

		await region.getByRole("button", { name: "Give this element a Class" }).click();
		await region.getByRole("combobox", { name: "Class name" }).fill("brand-new");
		await region.getByRole("combobox", { name: "Class name" }).press("Enter");
		await tabList(page).getByRole("tab", { name: ".brand-new", selected: true }).waitFor();
		expect(await tabNames(page)).toEqual([".hero-title", ".lead", ".hero", ".brand-new", "Site CSS"]);
		const made = (await draftClasses()).find((each) => each.name === "brand-new");
		expect(made?.styles).toBe("");
		// The class list reaches the shared Draft as the element's HTML.
		for (let tries = 0; tries < 40 && !(await draftMarkup()).includes("hero brand-new"); tries++)
			await page.waitForTimeout(250);
		expect(await draftMarkup()).toContain('class="hero-title lead p-m hero brand-new"');
	});

	test("Delete on a tab or its × removes the Class from the element, never from the Design system", async () => {
		const page = await codeModePage("light");
		await selectOnPage(page, page.locator("main h1"), ".hero-title");

		await tabList(page).getByRole("tab", { name: ".lead" }).click();
		await page.keyboard.press("Delete");
		await page.waitForFunction(() => !document.querySelector("main h1")?.classList.contains("lead"));
		expect(await tabNames(page)).toEqual([".hero-title", "Site CSS"]);

		await tabList(page).locator('[title="Remove .hero-title from this element"]').click();
		await page.waitForFunction(() => !document.querySelector("main h1")?.classList.contains("hero-title"));
		expect(await tabNames(page)).toEqual(["Site CSS"]);
		const names = (await draftClasses()).map((each) => each.name);
		expect(names).toContain("lead");
		expect(names).toContain("hero-title");
	});

	test("a token utility shows as a chip that can be removed but not edited", async () => {
		const page = await codeModePage("light");
		await selectOnPage(page, page.locator("main h1"), ".hero-title");
		const chips = cssRegion(page).getByRole("list", { name: "Token utilities" });

		expect(await chips.getByRole("textbox").count()).toBe(0);
		await chips.getByRole("button", { name: "Remove token utility p-m" }).click();

		await page.waitForFunction(() => !document.querySelector("main h1")?.classList.contains("p-m"));
		expect(await chips.count()).toBe(0);
		expect(await tabNames(page)).toEqual([".hero-title", ".lead", "Site CSS"]);
	});
});

describe("editing", () => {
	test("the layout row writes plain declarations into the open Class at the open width", async () => {
		const page = await codeModePage("light");
		await selectOnPage(page, page.locator("main h1"), ".hero-title");
		const region = cssRegion(page);

		await region.getByRole("button", { name: "Direction: column" }).click();
		expect(await cssText(page).inputValue()).toBe("font-size: var(--text-xl);\nflex-direction: column;");

		await region.getByRole("button", { name: `${tablet.name} (${tablet.width}px)` }).click();
		const columns = region.getByRole("textbox", { name: "Columns" });
		await columns.fill("3");
		await columns.press("Enter");
		const atTablet = region.getByRole("textbox", { name: `CSS: .hero-title from ${tablet.name}` });
		expect(await atTablet.inputValue()).toBe("display: grid;\ngrid-template-columns: repeat(3, minmax(0, 1fr));");
		expect(await region.getByRole("button", { name: "Display: grid" }).getAttribute("aria-pressed")).toBe("true");

		await region.getByRole("button", { name: "Save", exact: true }).click();
		await region.getByText("Unsaved changes").waitFor({ state: "hidden" });
		const saved = (await draftClasses()).find((each) => each.name === "hero-title");
		expect(saved?.breakpoints[tablet.id]).toBe("display: grid;\ngrid-template-columns: repeat(3, minmax(0, 1fr));");
		// The width that wasn't saved keeps what was typed.
		await region.getByRole("button", { name: "All widths" }).click();
		expect(await cssText(page).inputValue()).toBe("font-size: var(--text-xl);\nflex-direction: column;");
	});

	test("the panel never accepts @layer", async () => {
		const page = await codeModePage("light");
		await tabList(page).getByRole("tab", { name: "Site CSS" }).click();
		const region = cssRegion(page);

		await cssText(page).fill("@layer custom {\n  p { color: red; }\n}");

		await region.getByText("The panel places its CSS in the right cascade layer: remove @layer.").waitFor();
		await region.getByRole("button", { name: "Save", exact: true }).click();
		const { api } = await install.install.superadmin();
		expect((await api.designSystem.get({ siteId })).designSystem.draft.customCss).toBe("");
	});

	test("a Generated Class's tab says so; editing it makes it normal, with an optional rename", async () => {
		const { api } = await install.install.superadmin();
		await api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup: ENTRY_TEMPLATE.replace("<p>Plain words</p>", '<p style="color: darkgreen">Plain words</p>'),
		});
		const page = await codeModePage("light");
		const region = cssRegion(page);
		await page.locator("main p", { hasText: "Plain words" }).click();
		const generated = tabList(page).getByRole("tab", { name: /Generated/, selected: true });
		await generated.waitFor();

		await cssText(page).fill("color: darkgreen;\nfont-style: italic;");
		await region.getByRole("button", { name: "Save", exact: true }).click();
		const name = region.getByRole("textbox", { name: "Name" });
		await name.waitFor();
		expect(await name.evaluate((input) => input.matches(":focus"))).toBe(true);
		await name.fill("green-note");
		await region.getByRole("button", { name: "Rename", exact: true }).click();

		await tabList(page).getByRole("tab", { name: ".green-note", exact: true, selected: true }).waitFor();
		const made = (await draftClasses()).find((each) => each.name === "green-note");
		expect(made).toMatchObject({ generated: false, styles: "color: darkgreen;\nfont-style: italic;" });
		await expectNoAxeViolations(page, "CSS panel › after a rename");
	});
});

for (const theme of THEMES) {
	test(`the same panel on the Builder's canvas, ${theme}`, async () => {
		const page = await testPage(theme);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/builder/${siteId}/entry-template/${postTypeId}`));
		const tree = page.getByRole("tree", { name: "Layers" });
		await tree.waitFor();
		await page.frameLocator("iframe[title^='Canvas']").getByText("Fresh bread").waitFor();
		await tree.getByRole("treeitem", { name: /^h1/ }).click();

		const region = page.getByRole("region", { name: "CSS", exact: true });
		await region.getByRole("tab", { name: ".hero-title", selected: true }).waitFor();
		expect(await tabNames(page)).toEqual([".hero-title", ".lead", "Site CSS"]);
		await region.getByText("Used on 1 element / 1 page").waitFor();
		// The canvas is a sandboxed frame axe can't enter; the Builder's own checks leave it out too.
		await expectNoAxeViolations(page, `Builder › CSS panel (${theme})`, [], { exclude: ["iframe[title^='Canvas']"] });

		await region.getByRole("tab", { name: ".hero-title" }).press("ArrowRight");
		expect(await selectedTab(page)).toBe(".lead");
	});
}
