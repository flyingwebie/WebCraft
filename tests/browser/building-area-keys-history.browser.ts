// The building area's keys and history beyond BA-08 to BA-11 (BA-33), in Chromium:
// - ⌘/ opens the Keyboard shortcuts list, with only what the person may do; Escape closes it and focus
//   goes back; F6 does nothing while it is open (a modal keeps focus);
// - F6 goes back to where focus was in a region ("deep memory");
// - a selection inside a branch someone closed keeps the tree's tab stop on the row around it;
// - a change autosaved as it is made says what was done, never that it was saved;
// - CSS typed after leaving the box is a step of its own;
// - a Class made from the Inspector keeps the Classes a peer made meanwhile;
// - the shortcuts list passes the accessibility checks, light and dark.
// The building area's own test of `editor-keyboard` 176, 263 and 363, the Keyboard shortcuts list of
// `edit-command-menu` 467 and `command-menu`, `editor-history` 583 and `editor-concurrency` 325.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { announced, enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).account;
	await api.designSystem.createClass({ siteId, name: "lead", styles: "line-height: 1.5;" });
	const site = await api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main>{{@outlet}}</main>" });
	await api.templates.publish({ siteId, templateId: site.template.id });
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
		markup: '<article><h1>{{ title }}</h1><section><p class="lead">{{ subtitle }}</p></section></article>',
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: made } = await api.entries.create({
		siteId,
		postTypeId,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven" },
	});
	await api.entries.publish({ siteId, entryId: made.id });
});

let sharedPage: Promise<Page> | undefined;

function shared() {
	sharedPage ??= (async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: `/page${path}` });
		await settled(page);
		await tree(page).getByRole("treeitem").first().waitFor();
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

const tree = (page: Page) => page.getByRole("tree", { name: "Elements of the page" });

/** Opens every closed row of Layers, so each row can be found by its name. */
async function openRows(page: Page): Promise<void> {
	for (let pass = 0; pass < 40; pass++) {
		const closed = tree(page).locator('[role="treeitem"][aria-expanded="false"]').first();
		if ((await closed.count()) === 0) return;
		await closed.locator("svg").first().click();
		await settled(page);
	}
}

async function eventually<Value>(read: () => Promise<Value>, done: (value: Value) => boolean): Promise<Value> {
	const deadline = Date.now() + 15000;
	let value = await read();
	while (!done(value) && Date.now() < deadline) {
		await Bun.sleep(100);
		value = await read();
	}
	return value;
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

async function leadClass() {
	const { api } = await install.install.superadmin();
	return (await api.designSystem.get({ siteId })).designSystem.draft.classes.find((each) => each.name === "lead");
}

const focusedLabel = (page: Page) =>
	page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.textContent ?? "");

describe("keys", () => {
	test("⌘/ lists the keyboard shortcuts; Escape closes it, focus goes back; F6 stays in it", async () => {
		const page = await shared();
		await tree(page).getByRole("treeitem").first().focus();
		const before = await focusedLabel(page);
		await page.keyboard.press("ControlOrMeta+/");
		const list = page.getByRole("dialog", { name: "Keyboard shortcuts" });
		await list.waitFor();
		expect(await list.getByRole("region", { name: "In Layers" }).count()).toBe(1);
		expect(await list.getByText("Pick the layer up, put it down").count()).toBe(1);
		await page.keyboard.press("F6");
		expect(await page.evaluate(() => document.activeElement?.closest("dialog") !== null)).toBe(true);
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await page.waitForTimeout(300);
			await expectNoAxeViolations(page, `the Keyboard shortcuts list (${theme})`);
		}
		await page.emulateMedia({ colorScheme: "light" });
		await page.keyboard.press("Escape");
		await list.waitFor({ state: "detached" });
		expect(await focusedLabel(page)).toBe(before);
	});

	test("F6 goes back to where focus was in a region", async () => {
		const page = await shared();
		await openRows(page);
		const rows = tree(page).getByRole("treeitem");
		await rows.nth(2).click();
		await rows.nth(2).focus();
		const was = await focusedLabel(page);
		await page.keyboard.press("F6");
		expect(await focusedLabel(page)).not.toBe(was);
		await page.keyboard.press("Shift+F6");
		expect(await focusedLabel(page)).toBe(was);
	});

	test("a selection inside a branch someone closed keeps the tree's tab stop on the row around it", async () => {
		const page = await shared();
		await clickIn(page, "p.lead");
		await tree(page).getByRole("treeitem", { name: "p .lead", selected: true }).waitFor();
		const section = tree(page).getByRole("treeitem", { name: "section", exact: true });
		await section.locator("svg").first().click();
		await tree(page).getByRole("treeitem", { name: "p .lead" }).waitFor({ state: "detached" });
		expect(await section.getAttribute("tabindex")).toBe("0");
		expect(await tree(page).locator('[role="treeitem"][tabindex="0"]').count()).toBe(1);
	});

	test("a change saved as it is made says what was done, never that it was saved", async () => {
		const page = await shared();
		await openRows(page);
		const heading = tree(page).getByRole("treeitem", { name: "h1", exact: true });
		await heading.click();
		await heading.focus();
		await page.keyboard.press("Alt+ArrowDown");
		expect(
			await eventually(
				() => announced(page),
				(text) => text.includes("Move h1"),
			),
		).toContain("Move h1");
		const { api } = await install.install.superadmin();
		const moved = await eventually(
			async () => (await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "",
			(markup) => markup.indexOf("<section") < markup.indexOf("<h1"),
		);
		expect(moved.indexOf("<section")).toBeLessThan(moved.indexOf("<h1"));
		await page.waitForTimeout(800);
		expect(await announced(page)).not.toMatch(/sav/i);
		await tree(page).getByRole("treeitem", { name: "h1", exact: true }).focus();
		await page.keyboard.press("Alt+ArrowUp");
	});
});

describe("history and peers", () => {
	test("CSS typed after leaving the box is a step of its own", async () => {
		const page = await shared();
		await clickIn(page, "p.lead");
		const css = page.locator('textarea[data-wc-code-box="css"]');
		await css.waitFor();
		await css.fill(".lead {\n  line-height: 1.5;\n  color: rgb(1, 1, 1);\n}");
		await page.locator('[data-wc-rail="panels"]').focus();
		await eventually(
			async () => (await leadClass())?.styles ?? "",
			(styles) => styles.includes("rgb(1, 1, 1)"),
		);
		await css.fill(".lead {\n  line-height: 1.5;\n  color: rgb(2, 2, 2);\n}");
		await page.locator('[data-wc-rail="panels"]').focus();
		await eventually(
			async () => (await leadClass())?.styles ?? "",
			(styles) => styles.includes("rgb(2, 2, 2)"),
		);
		await page.locator('[data-wc-bar="undo"]').click();
		expect(
			await eventually(
				async () => (await leadClass())?.styles ?? "",
				(styles) => styles.includes("rgb(1, 1, 1)"),
			),
		).toContain("rgb(1, 1, 1)");
	});

	test("a Class made from the Inspector keeps the Classes a peer made meanwhile", async () => {
		const page = await shared();
		await clickIn(page, "h1");
		const { api } = await install.install.superadmin();
		await api.designSystem.createClass({ siteId, name: "peer-made" });
		const inspector = page.locator('[data-wc-panel-body="inspector"]');
		await inspector.getByRole("button", { name: "Add a Class" }).click();
		await inspector
			.getByRole("combobox", { name: "Add a Class" })
			.or(inspector.getByRole("textbox", { name: "Add a Class" }))
			.fill("mine-made");
		await page.keyboard.press("Enter");
		await inspector.locator('[data-wc-class="mine-made"]').waitFor();
		const names = (await api.designSystem.get({ siteId })).designSystem.draft.classes.map((each) => each.name);
		expect(names).toContain("peer-made");
		expect(names).toContain("mine-made");
	});
});
