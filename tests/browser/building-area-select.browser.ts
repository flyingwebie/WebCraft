// Staff selecting, Layers and the Inspector in the building area (ADR 0037 › 1.3, BA-08; SPEC 5 and 7),
// in Chromium:
// - Staff's page carries both kinds of tags: one click on a heading selects it (outline, the
//   "h1 · Heading" chip, its row in Layers, the Inspector); on text a second click places the caret and
//   typing saves to the Entry's Draft;
// - an element of a Component is outlined in the Component colour, and the Inspector says which;
// - changing the Tag or a Class in the Inspector changes the page in the frame without a reload, scroll
//   kept, and is one Undo step;
// - Layers' keys: the arrows move between rows (the canvas follows), open and close them, Alt with the
//   arrows moves an element, Delete removes it, each one Undo step;
// - two changes made quickly both land (a late answer never undoes newer work);
// - Escape clears the selection; the selection is in the address (`wc-select`): Back after a place
//   and a reload show it again;
// - an element of a Module's Component is read only, with the reason;
// - the shell with an element selected passes the accessibility checks, light and dark.
// The building area's own test of `code-selection`, `code-layers` (selection, Inspector), the tree keys
// of `editor-keyboard` and `editor-concurrency` (late answers keep newer work).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
let breadId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	await api.modules.approve({ moduleId: "extra-blocks", version: "1.0.0" });
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).account;

	for (const name of ["site-header", "page", "hero", "hero__title", "lead", "is-large"]) {
		await api.designSystem.createClass({ siteId, name, styles: name === "is-large" ? "font-size: 3rem;" : "" });
	}
	await api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	await api.globals.saveDraft({ siteId, fields: { tagline: "Open every day from seven." } });
	await api.globals.publish({ siteId });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: [
			'<header class="site-header"><p>{{ site.tagline }}</p><MapEmbed label="Find us" url="https://www.openstreetmap.org/export/embed.html?bbox=1,2,3,4" /></header>',
			'<main class="page">{{@outlet}}</main>',
			"<footer><p>Harbour Street</p></footer>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { component } = await api.components.create({
		siteId,
		name: "HeroSplit",
		props: [{ key: "headline", label: "Headline", type: "text" }],
	});
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<section class="hero"><h1 class="hero__title">{{ props.headline }}</h1></section>',
	});
	await api.components.publish({ siteId, componentId: component.id });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "subtitle", label: "Subtitle", type: "text" }],
	});
	postTypeId = postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: [
			"<article>",
			'<HeroSplit headline="Fresh from our ovens" />',
			"<h2>{{ title }}</h2>",
			'<p class="lead">{{ subtitle }}</p>',
			"<p>Baked by hand.</p>",
			"</article>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: made } = await api.entries.create({
		siteId,
		postTypeId,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven at seven" },
	});
	await api.entries.publish({ siteId, entryId: made.id });
	breadId = made.id;
});

let sharedPage: Promise<{ page: Page }> | undefined;

/** The one page in the building area the checks share (entering is rate-limited), at 1440 × 900. */
function shared() {
	sharedPage ??= (async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: `/page${path}` });
		await settled(page);
		await tree(page).getByRole("treeitem").first().waitFor();
		return { page };
	})();
	return sharedPage;
}

afterAll(async () => {
	await (await sharedPage)?.page
		.context()
		.close()
		.catch(() => {});
	await install?.close();
});

const tree = (page: Page) => page.getByRole("tree", { name: "Elements of the page" });
const inspector = (page: Page) => page.locator('[data-wc-panel-body="inspector"]');
const chip = (page: Page) => page.locator("[data-wc-chip]");

/** What `read` gives once `done` accepts it, waiting up to 8 seconds. */
async function eventually<Value>(read: () => Promise<Value>, done: (value: Value) => boolean): Promise<Value> {
	const deadline = Date.now() + 8000;
	let value = await read();
	while (!done(value) && Date.now() < deadline) {
		await Bun.sleep(100);
		value = await read();
	}
	return value;
}

/** The Entry template's Draft markup now, as the admin reads it. */
async function entryTemplateMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return (await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "";
}

/** Clicks an element of the page in the frame, at its middle, as a person does. */
async function clickIn(page: Page, frame: Frame, selector: string): Promise<void> {
	// The page may be drawn again in place just now (a change saved): the element is then a new one.
	for (let attempt = 0; ; attempt++) {
		try {
			const element = frame.locator(selector).first();
			await element.scrollIntoViewIfNeeded({ timeout: 5000 });
			const box = await element.boundingBox();
			if (!box) throw new Error(`${selector} isn't on the page.`);
			await page.mouse.click(box.x + Math.min(12, box.width / 2), box.y + box.height / 2);
			await settled(page);
			return;
		} catch (failure) {
			if (attempt >= 3) throw failure;
			await page.waitForTimeout(250);
		}
	}
}

/** Marks the frame's window, so a reload (a new window) shows as the mark gone. */
async function markWindow(frame: Frame): Promise<void> {
	await frame.evaluate(() => {
		(window as unknown as { kept?: boolean }).kept = true;
	});
}

async function stillTheSameWindow(page: Page): Promise<boolean> {
	return (await frameOf(page)).evaluate(() => (window as unknown as { kept?: boolean }).kept === true);
}

/** The shell's address's selection (`wc-select`). */
function selectedIn(page: Page): string | null {
	return new URL(page.url()).searchParams.get("wc-select");
}

describe("Staff select, arrange and change elements of Templates and Components", () => {
	test("Staff's page carries where each element comes from and the editable regions, in one tag", async () => {
		const { page } = await shared();
		const frame = await frameOf(page);
		const title = frame.locator("h2");
		expect(await title.getAttribute("data-wc-code")).toBe(`content#${await idOf(frame, "h2")}`);
		expect(await title.getAttribute("data-wc-item")).toBe(`entry:${breadId}`);
		expect(await frame.locator("h1.hero__title").getAttribute("data-wc-code")).toMatch(/^content\/[\w-]+#[\w-]+$/);
	});

	test("one click on a heading selects it: outline, chip, its row in Layers and the Inspector", async () => {
		const { page } = await shared();
		const frame = await frameOf(page);
		await clickIn(page, frame, "h1.hero__title");
		await page.locator('[data-wc-outline="selected"]').waitFor();
		expect(await chip(page).textContent()).toMatch(/^h1 · Heading · \d+ × \d+$/);
		// An element of a Component is drawn in the Component colour.
		expect(await page.locator('[data-wc-outline="selected"]').getAttribute("class")).toContain("border-[#a78bfa]");
		const row = tree(page).getByRole("treeitem", { name: "h1 .hero__title" });
		expect(await row.getAttribute("aria-selected")).toBe("true");
		expect(await page.locator('[data-wc-panel="inspector"] h2').textContent()).toBe("Element");
		expect(await inspector(page).getByLabel("Tag").inputValue()).toBe("h1");
		expect(await inspector(page).locator("[data-wc-class]").allTextContents()).toEqual([".hero__title"]);
		expect(await inspector(page).locator("[data-wc-content]").textContent()).toBe("{{ props.headline }}");
		expect(await inspector(page).locator("[data-wc-inside]").textContent()).toBe("Inside the HeroSplit Component");
		expect(selectedIn(page)).toMatch(/^content\/[\w-]+#[\w-]+$/);
	});

	test("on text, the click selects and the caret is there: typing saves to the Entry's Draft", async () => {
		const { page } = await shared();
		const frame = await frameOf(page);
		await clickIn(page, frame, "h2");
		expect(await chip(page).textContent()).toMatch(/^h2 · Title · \d+ × \d+$/);
		expect(await tree(page).getByRole("treeitem", { name: "h2" }).getAttribute("aria-selected")).toBe("true");
		await clickIn(page, frame, "h2");
		await page.keyboard.press("End");
		await page.keyboard.type(" today");
		await frame.locator("article").click({ position: { x: 2, y: 2 } });
		const { api } = await install.install.superadmin();
		const title = await eventually(
			async () => (await api.entries.get({ siteId, entryId: breadId })).entry.draft.title,
			(value) => value.replaceAll(" ", " ") === "Fresh bread today",
		);
		expect(title.replaceAll(" ", " ")).toBe("Fresh bread today");
	});

	test("changing the Tag in the Inspector changes the page in place, scroll kept, and is one Undo step", async () => {
		const { page } = await shared();
		const frame = await frameOf(page);
		await markWindow(frame);
		await clickIn(page, frame, "p.lead");
		const scrolled = await frame.evaluate(() => {
			window.scrollTo(0, 40);
			return window.scrollY;
		});
		await inspector(page).getByLabel("Tag").selectOption("h3");
		await (await frameOf(page)).locator("h3.lead").waitFor();
		expect(await stillTheSameWindow(page)).toBe(true);
		expect(await (await frameOf(page)).evaluate(() => window.scrollY)).toBe(scrolled);
		// Still selected, as the page now draws it, and the Draft has it.
		expect(await chip(page).textContent()).toMatch(/^h3 · /);
		expect(await entryTemplateMarkup()).toMatch(/<h3[^>]* class="lead"/);

		await page.getByRole("button", { name: "Undo" }).first().click();
		await (await frameOf(page)).locator("p.lead").waitFor();
		expect(await stillTheSameWindow(page)).toBe(true);
		expect(await eventually(entryTemplateMarkup, (markup) => /<p[^>]* class="lead"/.test(markup))).toMatch(
			/<p[^>]* class="lead"/,
		);
	});

	test("adding and removing a Class in the Inspector changes the page in place; each is one Undo step", async () => {
		const { page } = await shared();
		const frame = await frameOf(page);
		await markWindow(frame);
		await clickIn(page, frame, "p.lead");
		await inspector(page).getByRole("button", { name: "Add a Class" }).click();
		await inspector(page).getByRole("combobox", { name: "Add a Class" }).fill("is-large");
		await page.keyboard.press("Enter");
		await (await frameOf(page)).locator("p.lead.is-large").waitFor();
		// The new Class's styles came with the page's stylesheet.
		expect(
			await (await frameOf(page)).locator("p.lead").evaluate((element) => getComputedStyle(element).fontSize),
		).toBe("48px");
		expect(await inspector(page).locator("[data-wc-class]").allTextContents()).toEqual([".lead", ".is-large"]);

		await inspector(page).getByRole("button", { name: "Remove .is-large" }).click();
		await (await frameOf(page)).locator("p.lead:not(.is-large)").waitFor();
		await page.getByRole("button", { name: "Undo" }).first().click();
		await (await frameOf(page)).locator("p.lead.is-large").waitFor();
		await page.getByRole("button", { name: "Undo" }).first().click();
		await (await frameOf(page)).locator("p.lead:not(.is-large)").waitFor();
		expect(await stillTheSameWindow(page)).toBe(true);
	});

	test("the id and other attributes change in the Inspector, values written as {{ path }}", async () => {
		const { page } = await shared();
		const frame = await frameOf(page);
		await clickIn(page, frame, "p.lead");
		await inspector(page).getByLabel("id").fill("lead-text");
		await page.keyboard.press("Enter");
		await (await frameOf(page)).locator("p#lead-text").waitFor();
		await inspector(page).getByRole("button", { name: "Add attribute" }).click();
		await inspector(page).getByLabel("Attribute name").fill("title");
		await inspector(page).getByLabel("Value", { exact: true }).fill("Fresh: {{ title }}");
		await page.keyboard.press("Enter");
		await (await frameOf(page)).locator('p.lead[title="Fresh: Fresh bread today"]').waitFor();
		expect(await inspector(page).getByLabel("Value of title").inputValue()).toBe("Fresh: {{ title }}");
		expect(await eventually(entryTemplateMarkup, (markup) => markup.includes("{{ title }}"))).toMatch(
			/<p[^>]* id="lead-text"[^>]* title="Fresh: \{\{ title \}\}"/,
		);
		// A value that isn't one is refused in words, and nothing changes.
		await inspector(page).getByLabel("Value of title").fill("{{ not a path }}");
		await page.keyboard.press("Enter");
		expect(await inspector(page).getByRole("alert").textContent()).toContain("This isn't a value: {{ not a path }}");
		// Each was one step.
		await page.getByRole("button", { name: "Undo" }).first().click();
		await (await frameOf(page)).locator("p.lead:not([title])").waitFor();
		await page.getByRole("button", { name: "Undo" }).first().click();
		await (await frameOf(page)).locator("p.lead:not([id])").waitFor();
	});

	test("two changes made one after the other both land: a late answer keeps the newer work", async () => {
		const { page } = await shared();
		const frame = await frameOf(page);
		await clickIn(page, frame, "article > p:not(.lead)");
		await inspector(page).getByLabel("Layer label").fill("Note");
		await page.keyboard.press("Enter");
		await inspector(page).getByLabel("Tag").selectOption("small");
		await (await frameOf(page)).locator("article > small").waitFor();
		const markup = await eventually(entryTemplateMarkup, (text) => text.includes("<small"));
		expect(markup).toMatch(/<small[^>]*>Baked by hand\.<\/small>/);
		expect(await tree(page).getByRole("treeitem", { name: "Note small" }).getAttribute("aria-selected")).toBe("true");
		// Both are steps: Undo twice takes both back.
		await page.getByRole("button", { name: "Undo" }).first().click();
		await (await frameOf(page)).locator("article > p:not(.lead)").waitFor();
		await page.getByRole("button", { name: "Undo" }).first().click();
		await tree(page).getByRole("treeitem", { name: "p" }).first().waitFor();
	});

	test("Layers' keys move between rows, open and close them, and move and remove elements, each one Undo step", async () => {
		const { page } = await shared();
		const frame = await frameOf(page);
		await clickIn(page, frame, "h2");
		const rows = tree(page);
		await rows.getByRole("treeitem", { name: "h2" }).focus();
		await page.keyboard.press("ArrowDown");
		expect(await rows.getByRole("treeitem", { name: "p .lead" }).getAttribute("aria-selected")).toBe("true");
		// The canvas follows the tree.
		await settled(page);
		expect(await chip(page).textContent()).toMatch(/^p · Subtitle · /);
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("ArrowUp");
		expect(await rows.getByRole("treeitem", { name: "HeroSplit" }).getAttribute("aria-selected")).toBe("true");
		// Open and close: the Placement's Component's elements nest under it.
		const hero = rows.getByRole("treeitem", { name: "HeroSplit" });
		expect(await hero.getAttribute("aria-expanded")).toBe("false");
		await page.keyboard.press("ArrowRight");
		expect(await hero.getAttribute("aria-expanded")).toBe("true");
		await page.keyboard.press("ArrowLeft");
		expect(await hero.getAttribute("aria-expanded")).toBe("false");
		await page.keyboard.press("ArrowRight");
		expect(await hero.getAttribute("aria-expanded")).toBe("true");
		await rows.getByRole("treeitem", { name: "section .hero" }).waitFor();

		// Alt+ArrowUp moves the subtitle above the title, in the Draft and on the page.
		await rows.getByRole("treeitem", { name: "p .lead" }).click();
		await rows.getByRole("treeitem", { name: "p .lead" }).focus();
		await page.keyboard.press("Alt+ArrowUp");
		await (await frameOf(page)).locator("p.lead + h2").waitFor();
		expect(await eventually(entryTemplateMarkup, (markup) => /lead[\s\S]*<h2/.test(markup))).toMatch(/lead[\s\S]*<h2/);
		expect(
			await rows.getByRole("treeitem", { name: "p .lead" }).evaluate((row) => row === document.activeElement),
		).toBe(true);
		await page.getByRole("button", { name: "Undo" }).first().click();
		await (await frameOf(page)).locator("h2 + p.lead").waitFor();

		// Delete removes it; Undo brings it back.
		await rows.getByRole("treeitem", { name: "p .lead" }).focus();
		await page.keyboard.press("Delete");
		await (await frameOf(page)).locator("p.lead").waitFor({ state: "detached" });
		await page.getByRole("button", { name: "Undo" }).first().click();
		await (await frameOf(page)).locator("p.lead").waitFor();
	});

	test("Escape clears the selection; Back after a place and a reload show it again", async () => {
		const { page } = await shared();
		const frame = await frameOf(page);
		await clickIn(page, frame, "p.lead");
		const ref = selectedIn(page);
		expect(ref).toMatch(/^content#/);
		await page.keyboard.press("Escape");
		await page.locator('[data-wc-outline="selected"]').waitFor({ state: "hidden" });
		await inspector(page).waitFor({ state: "detached" });
		expect(selectedIn(page)).toBeNull();
		expect(await tree(page).locator('[aria-selected="true"]').count()).toBe(0);

		await clickIn(page, frame, "p.lead");
		await page.locator('[data-wc-place="templates"]').click();
		await page.locator("[data-wc-place-frame]").waitFor();
		await page.goBack();
		await page.locator("[data-wc-place-frame]").waitFor({ state: "detached" });
		expect(selectedIn(page)).toBe(ref);
		expect(await tree(page).getByRole("treeitem", { name: "p .lead" }).getAttribute("aria-selected")).toBe("true");
		await inspector(page).getByLabel("Tag").waitFor();

		await page.reload();
		await frameOf(page);
		await tree(page).getByRole("treeitem", { name: "p .lead" }).waitFor();
		expect(
			await eventually(
				() => tree(page).getByRole("treeitem", { name: "p .lead" }).getAttribute("aria-selected"),
				(selected) => selected === "true",
			),
		).toBe("true");
		await page.locator('[data-wc-outline="selected"]').waitFor();
		expect(await chip(page).textContent()).toMatch(/^p · Subtitle · /);
	});

	test("an element of a Module's Component is read only, with the reason", async () => {
		const { page } = await shared();
		const frame = await frameOf(page);
		await clickIn(page, frame, 'header [data-extra-block="map"] a');
		await inspector(page).locator("[data-wc-read-only]").waitFor();
		expect(await inspector(page).locator("[data-wc-read-only]").textContent()).toMatch(
			/comes from a Module: it can't be changed here\.$/,
		);
		expect(await inspector(page).getByLabel("Tag").isDisabled()).toBe(true);
		expect(await inspector(page).getByLabel("Layer label").isDisabled()).toBe(true);
		expect(await inspector(page).locator("[data-wc-add-attribute]").isDisabled()).toBe(true);
	});

	test("with an element selected, the shell passes the accessibility checks in light and dark", async () => {
		const { page } = await shared();
		const frame = await frameOf(page);
		await clickIn(page, frame, "h1.hero__title");
		await inspector(page).getByLabel("Tag").waitFor();
		// The pointer rests on the rail: the size readout (shown near the canvas's gutters) leaves after 1.5 s.
		await page.mouse.move(24, 460);
		await page.waitForTimeout(1800);
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			// The size readout the last keyboard walk showed (focus on a gutter) leaves 1.5 s later.
			await page.waitForTimeout(1800);
			await settled(page);
			await expectAccessibleScreen(page, `building area selection (${theme})`);
		}
	});
});

/** The id the page's element carries in its reference (`<source>#<id>`). */
async function idOf(frame: Frame, selector: string): Promise<string> {
	const ref = (await frame.locator(selector).first().getAttribute("data-wc-code")) ?? "";
	return ref.slice(ref.indexOf("#") + 1);
}
