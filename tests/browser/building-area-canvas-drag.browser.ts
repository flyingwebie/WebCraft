// Dragging on the canvas (BA-33), in Chromium:
// - the selected element's chip is its grab handle: dragged over the page it shows where the element
//   lands (a line before or after an element, an outline inside one) and moves it there, one Undo step;
// - an element moves within its own Template or Component only: elsewhere is refused in words;
// - a button of the insert row dragged onto the page inserts its element where it is dropped: before
//   or after an element, or inside one that can hold it;
// - the shell after a drag passes the accessibility checks, light and dark.
// The building area's own test of `builder` 327 (moving the selected element where it is dragged) and
// the insert row's drag BA-10 left.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Locator, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { announced, enterBuildingArea, eventually, frameOf, settled, stays } from "./building-area.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
let noteId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).account;
	for (const name of ["lead", "box", "note"])
		await api.designSystem.createClass({ siteId, name, styles: name === "box" ? "padding: 48px;" : "" });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>Acme Bakery</p></header><main>{{@outlet}}</main>",
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { component } = await api.components.create({ siteId, name: "Note" });
	noteId = component.id;
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<aside class="note"><p>Noted</p></aside>',
	});
	await api.components.publish({ siteId, componentId: component.id });
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	postTypeId = postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: [
			"<article>",
			"<h1>{{ title }}</h1>",
			'<p class="lead">Fresh from the oven</p>',
			'<div class="box"><p>Inside the box</p></div>',
			"<p>Last words</p>",
			"<Note />",
			"</article>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: made } = await api.entries.create({ siteId, postTypeId, title: "Fresh bread" });
	await api.entries.publish({ siteId, entryId: made.id });
});

let sharedPage: Promise<Page> | undefined;

function shared() {
	sharedPage ??= (async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: `/page${path}` });
		await settled(page);
		await page.getByRole("tree", { name: "Elements of the page" }).getByRole("treeitem").first().waitFor();
		// The Templates' shared Drafts connect as the page opens: a change waits for them.
		await page.waitForTimeout(1500);
		return page;
	})();
	return sharedPage;
}

afterAll(async () => {
	await (await sharedPage)
		?.context()
		.close()
		.catch(() => {});
	await install?.close();
});

async function entryMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return ((await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "").replace(
		/ data-wc-id="[^"]*"/g,
		"",
	);
}

/** The Note Component's Draft markup, without ids. */
async function noteMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return (await api.components.getMarkup({ siteId, componentId: noteId })).markup.draft.replace(
		/ data-wc-id="[^"]*"/g,
		"",
	);
}

/** The article's markup without its tag (what the drags rearrange). */
async function article(): Promise<string> {
	return (await entryMarkup()).replace(/^<article>/, "").replace(/<\/article>$/, "");
}

async function clickIn(page: Page, selector: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			const element = (await frameOf(page)).locator(selector).first();
			await element.scrollIntoViewIfNeeded({ timeout: 5000 });
			const found = await element.boundingBox();
			if (!found) throw new Error(`${selector} isn't on the page.`);
			await page.mouse.click(found.x + Math.min(12, found.width / 2), found.y + found.height / 2);
			await settled(page);
			return;
		} catch (failure) {
			if (attempt >= 3) throw failure;
			await page.waitForTimeout(250);
		}
	}
}

/**
 * Drags from a control of the shell to a point of an element of the page (`at`: how far down its box),
 * pausing over it so the shell can draw where it lands; answers what the drop line said meanwhile.
 */
async function drag(page: Page, from: Locator, selector: string, at: number): Promise<string | null> {
	// What the last change drew settles first (the page is drawn again in place once its Draft saved).
	await page.waitForTimeout(800);
	for (let attempt = 0; ; attempt++) {
		try {
			const element = (await frameOf(page)).locator(selector).first();
			await element.scrollIntoViewIfNeeded({ timeout: 5000 });
			await settled(page);
			const start = await from.boundingBox();
			const target = await element.boundingBox();
			if (!start || !target) throw new Error("Nothing to drag from or to.");
			await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2);
			await page.mouse.down();
			await page.mouse.move(target.x + 20, target.y + target.height * at, { steps: 12 });
			await settled(page);
			const line = await page
				.locator("[data-wc-drop-line]:not(.hidden)")
				.getAttribute("data-wc-drop-line")
				.catch(() => null);
			await page.mouse.up();
			await settled(page);
			return line;
		} catch (failure) {
			await page.mouse.up().catch(() => {});
			if (attempt >= 2) throw failure;
			await page.waitForTimeout(300);
		}
	}
}

describe("dragging on the canvas", () => {
	test("the selected element's chip drags it where it is dropped, shown as it goes; one Undo step", async () => {
		const page = await shared();
		await clickIn(page, "p.lead");
		const chip = page.locator("[data-wc-chip]");
		await chip.waitFor();
		const line = await drag(page, chip, "h1", 0.15);
		expect(line).toBe("before");
		expect(await eventually(article, (text) => text.startsWith('<p class="lead">'))).toMatch(
			/^<p class="lead">Fresh from the oven<\/p><h1>\{\{ title \}\}<\/h1>/,
		);
		expect(
			await eventually(
				() => announced(page),
				(text) => text.includes("Move p.lead"),
			),
		).toContain("Move p.lead");
		await page.locator('[data-wc-bar="undo"]').click();
		expect(await eventually(article, (text) => text.startsWith("<h1>"))).toMatch(
			/^<h1>\{\{ title \}\}<\/h1><p class="lead">Fresh from the oven<\/p>/,
		);
	});

	test("dropped in the middle of an element that holds others, it goes inside", async () => {
		const page = await shared();
		await clickIn(page, "article > p:not(.lead)");
		const line = await drag(page, page.locator("[data-wc-chip]"), "div.box", 0.5);
		expect(line).toBe("inside");
		expect(await eventually(article, (text) => text.includes("<p>Last words</p></div>"))).toContain(
			'<div class="box"><p>Inside the box</p><p>Last words</p></div>',
		);
	});

	test("an element moves within its own Template or Component only: elsewhere is refused in words", async () => {
		const page = await shared();
		const before = await article();
		const noteBefore = await noteMarkup();
		expect(noteBefore).toBe('<aside class="note"><p>Noted</p></aside>');
		await clickIn(page, "aside.note p");
		await drag(page, page.locator("[data-wc-chip]"), "h1", 0.2);
		expect(
			await eventually(
				() => announced(page),
				(text) => text.includes("can't go there"),
			),
		).toContain("an element moves within its own Template or Component");
		// Nothing moved: neither the Entry template nor the Component the paragraph is in, given time to save.
		await stays(
			async () => ({ article: await article(), note: await noteMarkup() }),
			(now) => now.article === before && now.note === noteBefore,
			{ during: 2000, what: "The Entry template and the Note Component" },
		);
	});

	test("a button of the insert row dragged onto the page inserts its element where it is dropped", async () => {
		const page = await shared();
		const heading = page.locator('[data-wc-insert="heading"]');
		const line = await drag(page, heading, "p.lead", 0.85);
		expect(line).toBe("after");
		expect(await eventually(article, (text) => /<p class="lead">[^<]*<\/p><h2>/.test(text))).toMatch(
			/<p class="lead">Fresh from the oven<\/p><h2>Heading<\/h2>/,
		);
		await page.waitForTimeout(500);
		const textLine = await drag(page, page.locator('[data-wc-insert="text"]'), "div.box p:last-of-type", 0.85);
		expect(textLine).toBe("after");
		expect(await eventually(article, (text) => /<p>Last words<\/p><p>[^<]+<\/p><\/div>/.test(text))).toMatch(
			/<div class="box"><p>Inside the box<\/p><p>Last words<\/p><p>[^<]+<\/p><\/div>/,
		);
		// The drag leaves no catcher behind.
		expect(await page.locator("[data-wc-catcher]").count()).toBe(0);
	});

	test("a button of the insert row dropped in the middle of an element that holds others puts it inside", async () => {
		const page = await shared();
		const before = await article();
		const inBox = (text: string) => text.match(/<div class="box">([\s\S]*?)<\/div>/)?.[1] ?? "";
		const line = await drag(page, page.locator('[data-wc-insert="heading"]'), "div.box", 0.5);
		expect(line).toBe("inside");
		const after = await eventually(article, (text) => (inBox(text).match(/<h2>/g) ?? []).length === 1);
		expect(inBox(after)).toContain("<h2>Heading</h2>");
		expect((before.match(/<h2>/g) ?? []).length + 1).toBe((after.match(/<h2>/g) ?? []).length);
	});

	test("a click on a button of the insert row still inserts its element, with no drag", async () => {
		const page = await shared();
		await clickIn(page, "p.lead");
		const before = await article();
		const count = (text: string) => (text.match(/<p\b/g) ?? []).length;
		await page.locator('[data-wc-insert="text"]').click();
		const after = await eventually(article, (text) => count(text) === count(before) + 1);
		expect(count(after)).toBe(count(before) + 1);
		expect(await page.locator("[data-wc-catcher]").count()).toBe(0);
	});

	test("after a drag, the shell passes the accessibility checks, light and dark", async () => {
		const page = await shared();
		await clickIn(page, "h1");
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await page.mouse.move(24, 460);
			await page.waitForTimeout(1800);
			await settled(page);
			await expectAccessibleScreen(page, `canvas after a drag (${theme})`);
		}
	});
});
