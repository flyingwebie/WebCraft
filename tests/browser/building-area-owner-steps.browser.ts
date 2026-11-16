// Three things the owner hit in the building area (FX-01), each checked in Chromium the way they were
// met, on a Site whose Site template is the Templates place's first one (`<main>{{@outlet}}</main>`):
// - a Template or Component no page shows opens on its stand-in: Layers and the HTML pane read it
//   (they stayed on "Opening the page's elements…" and "Reading the markup…" for ever), and inserting
//   into it works: an Entry template made new from the Templates place (its Post Type has no Entry
//   yet), and a Component made new from the Components place (empty: nothing on the page names it);
// - after a Section is inserted on a Page, Layers shows it with its tree and the HTML pane reads its
//   source; each place of the rail opens every time, also while that Section is edited in place
//   (pressing Content, Templates, Media, Styles, Loops or Components did nothing then);
// - when the Section's Placement leaves the page again (its Add taken back with Undo), the shell stops
//   editing it in place, instead of keeping a Component nothing can read (CODE_SOURCE_NOT_FOUND,
//   Layers without it, every place locked).
// A Section on a Page is a Page section (FX-05, ADR 0038): every one is called "Section" in Layers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { enterBuildingArea, eventually, frameOf } from "./building-area.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let superadmin: TestBrowser;
let siteId: string;
let blogId: string;
let contactId: string;
const slug = "bakery";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	superadmin = await local.superadmin();
	const { api } = superadmin;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).account;
	const site = await api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main>{{@outlet}}</main>" });
	await api.templates.publish({ siteId, templateId: site.template.id });
	const pagesId = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id ?? "";
	for (const [title, pageSlug] of [
		["Home", "home"],
		["Contact us", "contact-us"],
	] as const) {
		const { entry } = await api.entries.create({ siteId, postTypeId: pagesId, title, slug: pageSlug });
		await api.entries.publish({ siteId, entryId: entry.id });
		if (pageSlug === "contact-us") contactId = entry.id;
	}
	// A Post Type with no Entry yet: its Entry template has no page to show it on.
	blogId = (await api.postTypes.create({ siteId, name: "Blog posts", key: "post", urlPattern: "/blog/{slug}" }))
		.postType.id;
});

afterAll(async () => {
	await install?.close();
});

const tree = (page: Page) => page.getByRole("tree", { name: "Elements of the page" });
const row = (page: Page, name: RegExp) => tree(page).getByRole("treeitem", { name }).first();
/** The Page's Sections' rows (their Placements), in order. */
const sections = (page: Page) =>
	tree(page).locator('[role="treeitem"][data-wc-ref^="content/"]:not([data-wc-ref*="#"])[aria-label^="Section"]');
/** Waits until the Page has `count` Sections in Layers. */
const sectionsShown = (page: Page, count: number) =>
	eventually(
		() => sections(page).count(),
		(shown) => shown === count,
		{ what: `${count} Sections in Layers` },
	);
const framedAddress = (page: Page) =>
	page.evaluate(
		() => document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]")?.contentWindow?.location.pathname ?? "",
	);
/** What the HTML pane shows: its state and its text. */
const htmlPane = (page: Page) =>
	page.evaluate(() => {
		const pane = document.querySelector("[data-wc-html-pane]");
		return { status: pane?.getAttribute("data-wc-html-pane") ?? null, text: pane?.textContent ?? "" };
	});
/** Any pane's "Couldn't read it", the Inspector's "Inside the … Component" and Done, as the shell shows them. */
const stale = (page: Page) =>
	page.evaluate(() => ({
		// In the panels (the shell's own config, a script, holds the words too).
		notRead: [...document.querySelectorAll("[data-wc-dock]")].some((dock) =>
			(dock.textContent ?? "").includes("Couldn't read it"),
		),
		inside: document.querySelector("[data-wc-inside]")?.textContent ?? null,
		done: document.querySelector("[data-wc-done]") !== null,
	}));

/** Waits until the frame shows the stand-in of `document` (its address after `/stand-in`). */
async function onStandIn(page: Page, document: string): Promise<void> {
	await eventually(
		() => framedAddress(page),
		(path) => path === `/_webcraft/build/stand-in${document}`,
		{ what: `The stand-in of ${document}` },
	);
	await frameOf(page);
}

/** Selects the tree's row `name` with a click, and answers what the HTML pane reads for it. */
async function selectAndRead(page: Page, name: RegExp): Promise<string> {
	await row(page, name).click();
	const read = await eventually(
		() => htmlPane(page),
		(pane) => pane.status === "ready" || pane.status === "failed",
		{ what: "The HTML pane's markup" },
	);
	expect(read.status).toBe("ready");
	return read.text;
}

/** Waits until the place `key` is the one open over the canvas. */
async function placeOpen(page: Page, key: string, what: string): Promise<void> {
	await eventually(
		() =>
			page
				.locator("[data-wc-place-frame]")
				.first()
				.getAttribute("data-wc-place-frame", { timeout: 1000 })
				.catch(() => null),
		(open) => open === key || (open ?? "").startsWith(`${key}/`),
		{ what },
	);
}

describe("a Template or Component no page shows (bug 1)", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: "/page/contact-us" });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("an Entry template made new from the Templates place opens on its stand-in, and Section goes into it", async () => {
		await page.locator('[data-wc-place="templates"]').click();
		await page.locator(`[data-wc-template-column="${blogId}"] [data-wc-template-add]`).click();
		await page.locator('[data-wc-template-make="entry"]').click();
		await page.waitForURL((url) => url.pathname === `/_webcraft/build/entry-template/${blogId}`);
		await onStandIn(page, `/entry-template/${blogId}`);
		// Its elements are read (its first Draft is `<article><h1>{{ title }}</h1></article>`): Layers shows
		// its tree, not "Opening the page's elements…", and the HTML pane its markup.
		await row(page, /^article/).waitFor();
		expect(await selectAndRead(page, /^article/)).toMatch(/<h1[^>]*>\{\{ title \}\}<\/h1>/);

		await page.locator('[data-wc-insert="section"]').click();
		const markup = async () =>
			(await superadmin.api.templates.getEntryTemplateMarkup({ siteId, postTypeId: blogId })).markup?.draft ?? "";
		expect(await eventually(markup, (text) => text.includes("<section"))).toMatch(/<\/article>\s*<section/);
		await row(page, /^section/).waitFor();
		await (await frameOf(page)).locator("section").first().waitFor();
	});

	test("a Component made new from the Components place opens on its stand-in, and Section and Heading go into it", async () => {
		await page.goto(install.siteUrl(slug, "/_webcraft/build/page/contact-us?wc-place=components"));
		await page.locator("[data-wc-component-new]").click();
		await page.locator("[data-wc-component-create]").waitFor();
		await page.keyboard.type("Price card");
		await page.keyboard.press("Enter");
		await page.waitForURL((url) => /^\/_webcraft\/build\/component\/[0-9a-f-]{36}$/.test(url.pathname));
		const componentId = new URL(page.url()).pathname.split("/").at(-1) ?? "";
		await onStandIn(page, `/component/${componentId}`);
		await page.locator("[data-wc-layers]").waitFor();

		await page.locator('[data-wc-insert="section"]').click();
		await row(page, /^section/).waitFor();
		// The Section's container is selected: a Heading lands inside it.
		await page.locator('[data-wc-insert="heading"]').click();
		const markup = async () => (await superadmin.api.components.getMarkup({ siteId, componentId })).markup?.draft ?? "";
		expect(await eventually(markup, (text) => text.includes("<h2"))).toMatch(/<section[^>]*>\s*<div[^>]*>\s*<h2/);
		// Each change draws the stand-in again by loading it again: the container stays selected throughout.
		const selected = () =>
			tree(page)
				.getByRole("treeitem", { selected: true })
				.getAttribute("aria-label", { timeout: 1000 })
				.catch(() => null);
		expect(await eventually(selected, (label) => /Container/.test(label ?? ""))).toMatch(/Container/);
		expect(await selectAndRead(page, /^section/)).toContain("<section");
	});
});

describe("a Section on a Page, and the places (bugs 2 and 3)", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: "/page/contact-us" });
		await row(page, /^main/).waitFor();
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("the Section inserted shows in Layers with its tree, and the HTML pane reads its source", async () => {
		// A Section made before with a Heading, done; then, with it selected, a second Section.
		await page.locator('[data-wc-insert="section"]').click();
		await page.locator("[data-wc-done]").waitFor();
		await page.locator('[data-wc-insert="heading"]').click();
		await (await frameOf(page)).locator("h2").first().waitFor();
		await page.locator("[data-wc-done]").click();
		await page.locator("[data-wc-done]").waitFor({ state: "detached" });
		await sections(page).first().click();
		await page.locator('[data-wc-insert="section"]').click();
		await page.locator("[data-wc-done]").waitFor();

		await sectionsShown(page, 2);
		await row(page, /Container/).waitFor();
		// The HTML pane reads the Section's source: the container selected in it, under its breadcrumb.
		const read = await eventually(
			() => htmlPane(page),
			(pane) => pane.status === "ready" && pane.text.includes('data-wc-label="Container"'),
			{ what: "The second Section's markup in the HTML pane" },
		);
		expect(read.text).toContain("section");
		// A Page's Section is the Page's own: no "Inside the … Component" over it.
		expect(await stale(page)).toEqual({ notRead: false, inside: null, done: true });
		const placed = async () =>
			(await superadmin.api.pageLayouts.get({ siteId, entryId: contactId })).placements.map(
				(each) => each.componentName,
			);
		expect(await eventually(placed, (names) => names.length === 2)).toEqual(["Section", "Section"]);
	});

	test("every place of the rail opens, also while the Section is edited in place, and again after", async () => {
		expect((await stale(page)).done).toBe(true);
		for (const round of [1, 2]) {
			for (const key of ["content", "templates", "media", "styles", "loops", "components"]) {
				await page.locator(`[data-wc-place="${key}"]`).click();
				await placeOpen(page, key, `The ${key} place (round ${round})`);
				await page.locator("[data-wc-place-back]").click();
				await page.locator("[data-wc-place-frame]").waitFor({ state: "detached" });
			}
		}
		// Opening a place finished editing in place, as Done does: the Section stays on the page.
		expect((await stale(page)).done).toBe(false);
		await sectionsShown(page, 2);
	});

	test("when the Section's Placement leaves the page (Undo), editing it in place ends; Redo brings it back", async () => {
		// A third Section, edited in place, as the owner had it.
		await sections(page).nth(1).click();
		await page.locator('[data-wc-insert="section"]').click();
		await page.locator("[data-wc-done]").waitFor();
		await sectionsShown(page, 3);

		// Its Add taken back: nothing is left to edit in place, nothing points at a source the page lacks.
		await page.locator('[data-wc-bar="undo"]').click();
		await sectionsShown(page, 2);
		const after = await eventually(
			() => stale(page),
			(now) => !now.done,
			{ what: "Editing the third Section in place ending once it left the page" },
		);
		expect(after).toEqual({ notRead: false, inside: null, done: false });
		// The places open again.
		await page.locator('[data-wc-place="components"]').click();
		await placeOpen(page, "components", "The Components place after Undo");
		await page.locator("[data-wc-place-back]").click();
		await page.locator("[data-wc-place-frame]").waitFor({ state: "detached" });

		// Redo puts the Placement back, in Layers too.
		await page.locator('[data-wc-bar="redo"]').click();
		await sectionsShown(page, 3);
		expect((await stale(page)).notRead).toBe(false);
	});
});
