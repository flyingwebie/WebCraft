// Code mode and the Builder need a window at least 1024px wide (#138, decided in #126). The rule is the
// window's width alone, checked live as the window changes: from 1280px both editors show their
// three-sided layout; from 1024px to 1279px the tree and the Inspector are drawers over the page, one
// open at a time, opened from the toolbar or with F6, with the code panels still below; below 1024px
// the Code switch says so and leaves Edit mode on, the Builder says so with a link back, and an editor
// the window shrinks under is covered, not closed: widening shows it again as it was. Taps select
// everywhere and Move up / Move down reorder by touch. Checked in light and dark, with axe and the keyboard.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Cookie, Locator, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";
const ENTRY_TEMPLATE =
	'<article data-wc-id="post"><Hero heading="{{ title }}" /><p class="intro" data-wc-id="lead">{{ subtitle }}</p>' +
	'<ul data-wc-id="list"><li data-wc-id="one">One</li><li data-wc-id="two">Two</li></ul></article>';
const NOTICE = "Code mode needs a window at least 1024px wide";
/** The Builder's canvas shows Staff's own Template, which Checks look at: axe leaves it out. */
const CANVAS = { exclude: ["iframe[title^='Canvas']"] };

const openedPages: Page[] = [];
async function testPage(theme: Theme, width: number, touch = false) {
	const page = await install.newPage(theme, { touch });
	page.setDefaultTimeout(10000);
	await page.setViewportSize({ width, height: 900 });
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
	await api.designSystem.createClass({ siteId, name: "hero", styles: "padding: var(--space-m);" });
	await api.designSystem.createClass({ siteId, name: "intro" });
	await api.designSystem.publish({ siteId });
	const { component } = await api.components.create({
		siteId,
		name: "Hero",
		props: [{ key: "heading", label: "Heading", type: "text", required: true }],
	});
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<section class="hero"><h1>{{ props.heading }}</h1></section>',
	});
	await api.components.publish({ siteId, componentId: component.id });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>Acme Bakery</p></header><main>{{@outlet}}</main><footer><p>Open daily</p></footer>",
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
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

/** The Entry template's Draft as Template markup, as the admin reads it. */
async function draftMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return (await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "";
}

/**
 * The accessible name of what has focus (followed into shadow roots), and what holds it: "Layers" or
 * "Settings" for a drawer (the tree or the Inspector), or the name of the dialog it is in.
 */
async function focused(page: Page): Promise<{ name: string; within: string }> {
	return page.evaluate(() => {
		let element = document.activeElement as HTMLElement | null;
		while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement as HTMLElement;
		const drawer = element?.closest("#builder-layers, #builder-inspector, #wc-code-layers, #wc-code-inspector");
		const dialog = element?.closest("[role=dialog]");
		const labelled = dialog?.getAttribute("aria-labelledby");
		const root = element?.getRootNode() as Document | ShadowRoot | undefined;
		const within = drawer
			? drawer.id.endsWith("layers")
				? "Layers"
				: "Settings"
			: labelled
				? (root?.getElementById?.(labelled)?.textContent ?? "")
				: "";
		return { name: (element?.getAttribute("aria-label") ?? element?.textContent ?? "").trim(), within: within.trim() };
	});
}

/** Whether a notice covers this: nothing under it can be reached (it sits in an inert part of the page). */
async function underCover(locator: Locator): Promise<boolean> {
	return locator.first().evaluate((element) => {
		for (let node: Node | null = element; node; ) {
			if (node instanceof Element && node.hasAttribute("inert")) return true;
			node = node.parentNode ?? (node instanceof ShadowRoot ? node.host : null);
		}
		return false;
	});
}

async function boxOf(locator: Locator) {
	const box = await locator.boundingBox();
	if (!box) throw new Error("Not on screen.");
	return box;
}

// -------------------------------------------------------------------------------------------------
// Code mode

/** Edit mode cookies without Code mode's, and with it, from the first time through the admin. */
let editCookies: Cookie[] | undefined;
let codeCookies: Cookie[] | undefined;

async function signInOnSite(): Promise<void> {
	if (editCookies && codeCookies) return;
	const page = await testPage("light", 1280);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/sites/${siteId}`));
	await page.getByRole("button", { name: "Edit on site" }).click();
	await page.waitForURL((url) => url.hostname === new URL(install.siteUrl(slug, "/")).hostname);
	await page.goto(install.siteUrl(slug, path));
	editCookies = (await page.context().cookies()).filter((cookie) => cookie.name.startsWith("webcraft."));
	await page.getByRole("button", { name: "Code", exact: true }).click();
	await page.getByRole("textbox", { name: /^HTML of / }).waitFor();
	codeCookies = (await page.context().cookies()).filter((cookie) => cookie.name.startsWith("webcraft."));
}

/** The page in Edit mode (Code mode off) in a window this wide. */
async function editModePage(theme: Theme, width: number, touch = false): Promise<Page> {
	await signInOnSite();
	const page = await testPage(theme, width, touch);
	await page.context().addCookies(editCookies ?? []);
	await page.goto(install.siteUrl(slug, path));
	// The bar shows Edit, Preview and Code, or (on a phone) its menu.
	await page
		.getByRole("button", { name: "Edit", exact: true })
		.or(page.getByRole("button", { name: "Edit mode menu", exact: true }))
		.first()
		.waitFor();
	return page;
}

/** The page in Code mode in a window this wide, waiting for its editor unless it opens covered. */
async function codeModePage(theme: Theme, width: number, options: { touch?: boolean; covered?: boolean } = {}) {
	await signInOnSite();
	const page = await testPage(theme, width, options.touch);
	await page.context().addCookies(codeCookies ?? []);
	await page.goto(install.siteUrl(slug, path));
	if (options.covered) {
		await page.getByText(NOTICE).waitFor();
		return page;
	}
	await page
		.getByRole("textbox", { name: "HTML of Blog posts · Entry template" })
		.and(page.locator(":not([readonly])"))
		.waitFor();
	return page;
}

function codeLayersAside(page: Page) {
	return page.getByRole("complementary", { name: "Layers" });
}
function codeInspectorAside(page: Page) {
	return page.getByRole("complementary", { name: "Settings" });
}
function codeDock(page: Page) {
	return page.getByRole("region", { name: "Code mode" });
}
function toggle(page: Page, name: "Layers" | "Settings") {
	return page.getByRole("button", { name, exact: true });
}

describe("Code mode at each width", () => {
	for (const width of [1440, 1280]) {
		test(`${width}px: the full three-sided layout, no drawer buttons`, async () => {
			const page = await codeModePage("light", width);

			await codeLayersAside(page).getByRole("tree", { name: "Layers" }).waitFor();
			expect(await codeInspectorAside(page).isVisible()).toBe(true);
			expect(await toggle(page, "Layers").count()).toBe(0);
			expect(await toggle(page, "Settings").count()).toBe(0);
			const tree = await boxOf(codeLayersAside(page));
			const inspector = await boxOf(codeInspectorAside(page));
			const dock = await boxOf(codeDock(page));
			// Tree left, Inspector right, the code panels between them below the page.
			expect(tree.x).toBe(0);
			expect(inspector.x + inspector.width).toBeCloseTo(width, 0);
			expect(dock.x).toBeGreaterThanOrEqual(tree.x + tree.width - 1);
			expect(dock.x + dock.width).toBeLessThanOrEqual(inspector.x + 1);
		});
	}

	for (const width of [1100, 1024]) {
		for (const theme of THEMES) {
			test(`${width}px, ${theme}: the tree and the Inspector are drawers over the page, one at a time`, async () => {
				const page = await codeModePage(theme, width);
				const layers = toggle(page, "Layers");
				const settings = toggle(page, "Settings");

				await layers.waitFor();
				expect(await codeLayersAside(page).isVisible()).toBe(false);
				expect(await codeInspectorAside(page).isVisible()).toBe(false);
				expect(await layers.getAttribute("aria-expanded")).toBe("false");
				// The code panels stay below, the whole width of the window.
				const dock = await boxOf(codeDock(page));
				expect(dock.x).toBe(0);
				expect(dock.width).toBeCloseTo(width, 0);
				await expectNoAxeViolations(page, `Code mode at ${width}px (${theme})`);

				await layers.click();
				await codeLayersAside(page).getByRole("tree", { name: "Layers" }).waitFor();
				expect(await layers.getAttribute("aria-expanded")).toBe("true");
				expect(await codeInspectorAside(page).isVisible()).toBe(false);
				const drawer = await boxOf(codeLayersAside(page));
				expect(drawer.y + drawer.height).toBeLessThanOrEqual((await boxOf(codeDock(page))).y + 1);
				await expectNoAxeViolations(page, `Code mode at ${width}px, Layers open (${theme})`);

				await settings.click();
				await codeInspectorAside(page).waitFor();
				expect(await codeLayersAside(page).isVisible()).toBe(false);
				expect(await layers.getAttribute("aria-expanded")).toBe("false");
				expect(await settings.getAttribute("aria-expanded")).toBe("true");
				await expectNoAxeViolations(page, `Code mode at ${width}px, Settings open (${theme})`);

				await settings.click();
				await codeInspectorAside(page).waitFor({ state: "hidden" });
				expect(await (await boxOf(codeDock(page))).width).toBeCloseTo(width, 0);
			});
		}
	}

	test("F6 opens the Layers drawer, then the Inspector, then closes them, moving focus with it", async () => {
		const page = await codeModePage("light", 1100);
		const html = page.getByRole("textbox", { name: "HTML of Blog posts · Entry template" });
		await html.focus();

		await page.keyboard.press("F6");
		await codeLayersAside(page).getByRole("tree", { name: "Layers" }).waitFor();
		expect((await focused(page)).within).toBe("Layers");

		await page.keyboard.press("F6");
		await codeInspectorAside(page).waitFor();
		expect(await codeLayersAside(page).isVisible()).toBe(false);
		expect((await focused(page)).within).toBe("Settings");

		await page.keyboard.press("F6");
		await codeInspectorAside(page).waitFor({ state: "hidden" });
		expect((await focused(page)).name).toBe("HTML of Blog posts · Entry template");

		await page.keyboard.press("Shift+F6");
		await codeInspectorAside(page).waitFor();
		expect((await focused(page)).within).toBe("Settings");
	});

	test("selecting on the page opens the Inspector drawer only when it was open", async () => {
		const page = await codeModePage("light", 1100);

		await page.locator("main h1").click();
		await page.getByRole("textbox", { name: "HTML of Hero · Component" }).waitFor();
		expect(await codeInspectorAside(page).isVisible()).toBe(false);
		expect(await codeLayersAside(page).isVisible()).toBe(false);

		await toggle(page, "Settings").click();
		await codeInspectorAside(page).waitFor();
		await page.locator("main p.intro").click();
		await page.getByRole("textbox", { name: "HTML of Blog posts · Entry template" }).waitFor();
		expect(await codeInspectorAside(page).isVisible()).toBe(true);
		expect(await toggle(page, "Settings").getAttribute("aria-expanded")).toBe("true");
	});

	test("the layout follows the window as it changes, without loading the page again", async () => {
		const page = await codeModePage("light", 1440);
		await page.evaluate(() => {
			(window as unknown as { stillHere: boolean }).stillHere = true;
		});

		await page.setViewportSize({ width: 1100, height: 900 });
		await toggle(page, "Layers").waitFor();
		expect(await codeLayersAside(page).isVisible()).toBe(false);

		await page.setViewportSize({ width: 1280, height: 900 });
		await toggle(page, "Layers").waitFor({ state: "hidden" });
		await codeLayersAside(page).getByRole("tree", { name: "Layers" }).waitFor();
		expect(await page.evaluate(() => (window as unknown as { stillHere?: boolean }).stillHere)).toBe(true);
	});
});

test("Code mode: narrowing while working in the tree keeps it open as a drawer, focus and all", async () => {
	const page = await codeModePage("light", 1280);
	const row = codeLayersAside(page).getByRole("treeitem", { name: /^li/ }).first();
	await row.click();
	await row.focus();

	await page.setViewportSize({ width: 1100, height: 900 });

	await toggle(page, "Layers").waitFor();
	expect(await toggle(page, "Layers").getAttribute("aria-expanded")).toBe("true");
	expect(await row.isVisible()).toBe(true);
	expect((await focused(page)).within).toBe("Layers");
});

describe("Code mode below 1024px", () => {
	for (const theme of THEMES) {
		test(`${theme}: the Code switch shows a notice and leaves Edit mode on`, async () => {
			const page = await editModePage(theme, 900);
			await page.evaluate(() => {
				(window as unknown as { stillHere: boolean }).stillHere = true;
			});
			const code = page.getByRole("button", { name: "Code", exact: true });

			await code.click();

			const notice = page.getByRole("dialog", { name: NOTICE });
			await notice.waitFor();
			await expectNoAxeViolations(page, `Edit mode › Code needs a wider window (${theme})`);
			expect(await page.getByRole("button", { name: "Edit", exact: true }).getAttribute("aria-pressed")).toBe("true");
			expect(await page.getByRole("region", { name: "Code mode" }).count()).toBe(0);
			expect(await page.evaluate(() => (window as unknown as { stillHere?: boolean }).stillHere)).toBe(true);
			await page.keyboard.press("Escape");
			await notice.waitFor({ state: "hidden" });
			expect((await focused(page)).name).toBe("Code");
		});
	}

	test("on a phone-width window the menu's Code row shows the same notice", async () => {
		const page = await editModePage("light", 390, true);

		await page.getByRole("button", { name: "Edit mode menu", exact: true }).click();
		await page.getByRole("button", { name: "Code", exact: true }).click();

		await page.getByText(NOTICE).waitFor();
		expect(await page.getByRole("region", { name: "Code mode" }).count()).toBe(0);
	});

	test("Code mode opened in a narrow window is covered, and shows itself once the window is wide enough", async () => {
		const page = await codeModePage("dark", 900, { covered: true });
		const notice = page.getByRole("dialog", { name: NOTICE });
		await notice.waitFor();
		expect(await notice.getAttribute("aria-modal")).toBe("true");
		await expectNoAxeViolations(page, "Code mode covered (dark)");
		await page.getByRole("textbox", { name: /^HTML of / }).waitFor({ state: "attached" });
		expect(await underCover(page.getByRole("textbox", { name: /^HTML of / }))).toBe(true);
		expect(await underCover(page.locator("main h1"))).toBe(true);

		await page.setViewportSize({ width: 1280, height: 900 });

		await notice.waitFor({ state: "hidden" });
		await page.getByRole("textbox", { name: "HTML of Blog posts · Entry template" }).waitFor();
		await codeLayersAside(page).getByRole("tree", { name: "Layers" }).waitFor();
	});

	test("shrinking covers the open editor, closes nothing, and widening brings it back as it was", async () => {
		const page = await codeModePage("light", 1100);
		await toggle(page, "Settings").click();
		await codeInspectorAside(page).waitFor();
		const html = page.getByRole("textbox", { name: "HTML of Blog posts · Entry template" });
		const typed = (await html.inputValue()).replace("</article>", "<p>Typed before shrinking</p></article>");
		await html.fill(typed);
		await page.locator("main p", { hasText: "Typed before shrinking" }).waitFor();
		// The shared Draft gives the new element its id; that is the text the editor holds from then on.
		for (let tries = 0; tries < 50 && !/<p data-wc-id="[^"]+">Typed/.test(await html.inputValue()); tries++) {
			await page.waitForTimeout(100);
		}
		const held = await html.inputValue();
		expect(held).toMatch(/<p data-wc-id="[^"]+">Typed before shrinking/);
		await html.focus();
		await html.evaluate((area: HTMLTextAreaElement) => area.setSelectionRange(10, 14));

		await page.setViewportSize({ width: 900, height: 900 });

		const notice = page.getByRole("dialog", { name: NOTICE });
		await notice.waitFor();
		expect(await notice.getAttribute("aria-modal")).toBe("true");
		expect(await underCover(page.getByRole("textbox", { name: /^HTML of / }))).toBe(true);
		expect((await focused(page)).within).toBe(NOTICE);
		// Nothing was closed: the shared Draft has what was typed.
		for (let tries = 0; tries < 50 && !(await draftMarkup()).includes("Typed before shrinking"); tries++) {
			await page.waitForTimeout(100);
		}
		expect(await draftMarkup()).toContain("Typed before shrinking");

		await page.setViewportSize({ width: 1100, height: 900 });

		await notice.waitFor({ state: "hidden" });
		expect(await html.inputValue()).toBe(held);
		expect(await html.evaluate((area: HTMLTextAreaElement) => [area.selectionStart, area.selectionEnd])).toEqual([
			10, 14,
		]);
		expect((await focused(page)).name).toBe("HTML of Blog posts · Entry template");
		expect(await codeInspectorAside(page).isVisible()).toBe(true);
		expect(await toggle(page, "Settings").getAttribute("aria-expanded")).toBe("true");
	});
});

describe("Code mode by touch", () => {
	test("a tap on the page selects, and the tree and Inspector answer taps", async () => {
		const page = await codeModePage("light", 1280, { touch: true });

		await page.locator("main h1").tap();
		await page.getByRole("textbox", { name: "HTML of Hero · Component" }).waitFor();

		const item = codeLayersAside(page).getByRole("treeitem", { name: /^li/ }).first();
		await item.tap();
		await page.getByRole("textbox", { name: "HTML of Blog posts · Entry template" }).waitFor();
		expect(await item.getAttribute("aria-selected")).toBe("true");
		await codeInspectorAside(page).getByRole("tab", { name: "Style" }).tap();
		expect(await codeInspectorAside(page).getByRole("tab", { name: "Style" }).getAttribute("aria-selected")).toBe(
			"true",
		);
	});
});

// -------------------------------------------------------------------------------------------------
// The Builder

async function builderPage(theme: Theme, width: number, touch = false): Promise<Page> {
	const page = await testPage(theme, width, touch);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/builder/${siteId}/entry-template/${postTypeId}`));
	if (width >= 1024) {
		await page.getByRole("tree", { name: "Layers", includeHidden: true }).waitFor({ state: "attached" });
		await page.frameLocator("iframe[title^='Canvas']").getByText("One", { exact: true }).waitFor();
	}
	return page;
}

function builderLayers(page: Page) {
	return page.getByRole("region", { name: "Layers" });
}
/** The Inspector, named after what is selected. */
function builderInspector(page: Page) {
	return page.locator("#builder-inspector");
}
function builderLayer(page: Page, name: string | RegExp) {
	return page.getByRole("tree", { name: "Layers" }).getByRole("treeitem", { name });
}
function canvasRegion(page: Page) {
	return page.getByRole("region", { name: "Canvas" });
}
function dockHtml(page: Page) {
	return page.getByRole("region", { name: "HTML" });
}

describe("the Builder at each width", () => {
	for (const width of [1440, 1280]) {
		test(`${width}px: the full three-sided layout, no drawer buttons`, async () => {
			const page = await builderPage("light", width);

			await builderLayers(page).waitFor();
			expect(await builderInspector(page).isVisible()).toBe(true);
			expect(await toggle(page, "Layers").count()).toBe(0);
			const tree = await boxOf(builderLayers(page));
			const inspector = await boxOf(builderInspector(page));
			const canvas = await boxOf(canvasRegion(page));
			const html = await boxOf(dockHtml(page));
			expect(tree.x).toBe(0);
			expect(canvas.x).toBeGreaterThanOrEqual(tree.x + tree.width - 1);
			expect(inspector.x).toBeGreaterThanOrEqual(canvas.x + canvas.width - 1);
			expect(html.y).toBeGreaterThanOrEqual(canvas.y + canvas.height - 1);
		});
	}

	for (const width of [1100, 1024]) {
		for (const theme of THEMES) {
			test(`${width}px, ${theme}: the tree and the Inspector are drawers over the canvas, one at a time`, async () => {
				const page = await builderPage(theme, width);
				const layers = toggle(page, "Layers");
				const settings = toggle(page, "Settings");

				await layers.waitFor();
				expect(await builderLayers(page).isVisible()).toBe(false);
				expect(await builderInspector(page).isVisible()).toBe(false);
				const canvas = await boxOf(canvasRegion(page));
				expect(canvas.x).toBe(0);
				expect(canvas.width).toBeCloseTo(width, 0);
				// The code panels stay below the canvas.
				expect((await boxOf(dockHtml(page))).y).toBeGreaterThanOrEqual(canvas.y + canvas.height - 1);
				await expectNoAxeViolations(page, `Builder at ${width}px (${theme})`, [], CANVAS);

				await layers.click();
				await builderLayers(page).waitFor();
				expect(await layers.getAttribute("aria-expanded")).toBe("true");
				const drawer = await boxOf(builderLayers(page));
				expect(drawer.y + drawer.height).toBeLessThanOrEqual((await boxOf(dockHtml(page))).y + 1);
				await expectNoAxeViolations(page, `Builder at ${width}px, Layers open (${theme})`, [], CANVAS);

				await settings.click();
				await builderInspector(page).waitFor();
				expect(await builderLayers(page).isVisible()).toBe(false);
				expect(await layers.getAttribute("aria-expanded")).toBe("false");
				await expectNoAxeViolations(page, `Builder at ${width}px, Settings open (${theme})`, [], CANVAS);

				await settings.click();
				await builderInspector(page).waitFor({ state: "hidden" });
			});
		}
	}

	test("F6 opens the Layers drawer, then the Inspector, then closes them, moving focus with it", async () => {
		const page = await builderPage("light", 1100);
		await page.getByRole("button", { name: "Dark preview" }).focus();

		await page.keyboard.press("F6");
		await builderLayers(page).waitFor();
		expect((await focused(page)).within).toBe("Layers");

		await page.keyboard.press("F6");
		await builderInspector(page).waitFor();
		expect(await builderLayers(page).isVisible()).toBe(false);
		expect((await focused(page)).within).toBe("Settings");

		await page.keyboard.press("F6");
		await builderInspector(page).waitFor({ state: "hidden" });
		expect((await focused(page)).name).toBe("Dark preview");

		await page.keyboard.press("Shift+F6");
		await builderInspector(page).waitFor();
	});

	test("selecting on the canvas opens the Inspector drawer only when it was open", async () => {
		const page = await builderPage("light", 1100);
		const canvas = page.frameLocator("iframe[title^='Canvas']");

		await canvas.getByText("Two", { exact: true }).click();
		await page.getByText("li selected.").first().waitFor({ state: "attached" });
		expect(await builderInspector(page).isVisible()).toBe(false);
		expect(await builderLayers(page).isVisible()).toBe(false);

		await toggle(page, "Settings").click();
		await builderInspector(page).waitFor();
		await canvas.getByText("One", { exact: true }).click();
		expect(await builderInspector(page).isVisible()).toBe(true);
		expect(await toggle(page, "Settings").getAttribute("aria-expanded")).toBe("true");
	});

	test("the width switcher still previews tablet and phone widths in the drawer layout", async () => {
		const page = await builderPage("light", 1024);

		const frameWidth = async (width: number) => {
			const frame = page.locator("iframe[title^='Canvas']");
			for (let tries = 0; tries < 50 && Math.round((await boxOf(frame)).width) !== width; tries++) {
				await page.waitForTimeout(100);
			}
			return Math.round((await boxOf(frame)).width);
		};
		await page.getByRole("button", { name: "Tablet width (768 px)" }).click();
		expect(await frameWidth(768)).toBe(768);
		await page.getByRole("button", { name: "Phone width (390 px)" }).click();
		expect(await frameWidth(390)).toBe(390);
		expect(await page.getByText(NOTICE).count()).toBe(0);
	});
});

test("the Builder: narrowing while working in the Inspector keeps it open as a drawer, focus and all", async () => {
	const page = await builderPage("light", 1280);
	await builderLayer(page, /^li/).first().click();
	const style = builderInspector(page).getByRole("tab", { name: "Style" });
	await style.focus();

	await page.setViewportSize({ width: 1100, height: 900 });

	await toggle(page, "Settings").waitFor();
	expect(await toggle(page, "Settings").getAttribute("aria-expanded")).toBe("true");
	expect(await style.isVisible()).toBe(true);
	expect((await focused(page)).within).toBe("Settings");
});

describe("the Builder below 1024px", () => {
	for (const theme of THEMES) {
		test(`${theme}: opening it shows the notice with a link back`, async () => {
			const page = await builderPage(theme, 900);

			const notice = page.getByRole("dialog", { name: NOTICE });
			await notice.waitFor();
			expect(await notice.getAttribute("aria-modal")).toBe("true");
			await expectNoAxeViolations(page, `Builder too narrow (${theme})`);
			expect(await underCover(page.getByRole("tree", { name: "Layers", includeHidden: true }))).toBe(true);
			await page.keyboard.press("Tab");
			expect((await focused(page)).name).toBe("Templates");

			await notice.getByRole("link", { name: "Templates" }).click();
			await page.waitForURL((url) => url.pathname === `/sites/${siteId}/templates`);
		});
	}

	test("shrinking covers it, closes nothing, and widening brings it back with its Undo history", async () => {
		const page = await builderPage("light", 1100);
		await toggle(page, "Layers").click();
		await builderLayer(page, /^li/).nth(1).click();
		await page.keyboard.press("Alt+ArrowUp");
		await page.getByText("Moved li: 1 of 2 in ul.").first().waitFor({ state: "attached" });
		const undo = page.getByRole("button", { name: "Undo" });
		expect(await undo.isDisabled()).toBe(false);

		await page.setViewportSize({ width: 900, height: 900 });

		const notice = page.getByRole("dialog", { name: NOTICE });
		await notice.waitFor();
		expect(await notice.getAttribute("aria-modal")).toBe("true");
		expect(await underCover(page.getByRole("tree", { name: "Layers", includeHidden: true }))).toBe(true);
		await expectNoAxeViolations(page, "Builder covered after shrinking");
		// The change is in the shared Draft already.
		for (
			let tries = 0;
			tries < 50 && !(await draftMarkup()).includes('<li data-wc-id="two">Two</li><li data-wc-id="one">');
			tries++
		) {
			await page.waitForTimeout(100);
		}
		expect(await draftMarkup()).toContain('<li data-wc-id="two">Two</li><li data-wc-id="one">One</li>');

		await page.setViewportSize({ width: 1100, height: 900 });

		await notice.waitFor({ state: "hidden" });
		await builderLayers(page).waitFor();
		expect(await toggle(page, "Layers").getAttribute("aria-expanded")).toBe("true");
		expect(await builderLayer(page, /^li/).first().getAttribute("aria-selected")).toBe("true");
		expect((await focused(page)).within).toBe("Layers");
		expect(await undo.isDisabled()).toBe(false);
		await undo.click();
		await page
			.getByText("Moved li: 2 of 2 in ul.")
			.first()
			.waitFor({ state: "attached" })
			.catch(() => undefined);
		for (
			let tries = 0;
			tries < 50 && !(await draftMarkup()).includes('<li data-wc-id="one">One</li><li data-wc-id="two">');
			tries++
		) {
			await page.waitForTimeout(100);
		}
		expect(await draftMarkup()).toContain('<li data-wc-id="one">One</li><li data-wc-id="two">Two</li>');
	});
});

describe("the Builder by touch", () => {
	test("taps select on the canvas, the tree, the Inspector and the insert toolbar; Move up reorders", async () => {
		const page = await builderPage("light", 1280, true);
		const canvas = page.frameLocator("iframe[title^='Canvas']");

		await canvas.getByText("Two", { exact: true }).tap();
		await expect(builderLayer(page, /^li/).nth(1).getAttribute("aria-selected")).resolves.toBe("true");

		await builderLayer(page, /^p/).tap();
		expect(await builderLayer(page, /^p/).getAttribute("aria-selected")).toBe("true");

		await builderInspector(page).getByRole("tab", { name: "Style" }).tap();
		expect(await builderInspector(page).getByRole("tab", { name: "Style" }).getAttribute("aria-selected")).toBe("true");

		await builderLayer(page, /^li/).nth(1).tap();
		await builderLayers(page).getByRole("button", { name: "Move up" }).tap();
		await page.getByText("Moved li: 1 of 2 in ul.").first().waitFor({ state: "attached" });

		await builderLayers(page).getByRole("button", { name: "More", exact: true }).tap();
		await page.getByRole("dialog").waitFor();
	});

	test("a touch drag on the canvas moves nothing: reordering by touch is Move up and Move down", async () => {
		const page = await builderPage("light", 1280, true);
		const canvas = page.frameLocator("iframe[title^='Canvas']");
		await canvas.getByText("One", { exact: true }).tap();
		await expect(builderLayer(page, /^li/).first().getAttribute("aria-selected")).resolves.toBe("true");

		await page.evaluate(() => {
			const frame = document.querySelector<HTMLIFrameElement>("iframe[title^='Canvas']");
			const canvasDocument = frame?.contentDocument;
			const items = [...(canvasDocument?.querySelectorAll("li") ?? [])];
			const one = items.find((item) => item.textContent === "One")?.getBoundingClientRect();
			const two = items.find((item) => item.textContent === "Two")?.getBoundingClientRect();
			if (!canvasDocument || !one || !two) throw new Error("The canvas shows no list.");
			const send = (type: string, x: number, y: number) =>
				canvasDocument
					.elementFromPoint(x, y)
					?.dispatchEvent(
						new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, pointerType: "touch" }),
					);
			send("pointerdown", one.x + 10, one.y + one.height / 2);
			for (let step = 1; step <= 8; step++) send("pointermove", one.x + 10, one.y + (two.bottom - one.y) * (step / 8));
			send("pointerup", two.x + 10, two.bottom - 2);
		});
		// Nothing is meant to happen, so watch (bounded) that no move is announced meanwhile.
		for (let tries = 0; tries < 10; tries++) {
			expect(await page.getByText(/^Moved li/).count()).toBe(0);
			await page.waitForTimeout(100);
		}
		expect(await page.getByText(/^Moved li/).count()).toBe(0);
		expect(await draftMarkup()).toContain('<li data-wc-id="one">One</li><li data-wc-id="two">Two</li>');
	});
});
