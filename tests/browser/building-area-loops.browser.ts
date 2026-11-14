// The Loops place in the building area (ADR 0037, BA-25; SPEC 8 and 10, `places-assets/08`), in
// Chromium at 1440 × 900:
// - it opens from the rail in three columns: the Saved Loops above the open Loop's settings (300), its
//   definition, and its result (320), with what the Draft lists, how fresh that is and the pages using it;
// - changing the Limit updates the result at once and, published, the page that shows the Loop;
// - a click on a key of the result copies its binding to the clipboard and says so (the keyboard too);
// - a rule of Match and a second order save to the Draft and change the result;
// - the definition shows as markup, the choice kept in the address;
// - "+" makes a new Loop (a refused name says why), and a Loop of its own items is a grid that saves;
// - a Member is told Loops are Staff's;
// - the place passes the accessibility checks, light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { announced, enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, forgetPageErrors, pageErrors, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let editor: TestAccount;
let admin: TestBrowser;
let siteId: string;
let latestId: string;
let hoursId: string;
const slug = "bakery";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	admin = await local.superadmin();
	const { api } = admin;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).account;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Giulia Romano" })).account;

	const { postType: blog } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		key: "blog",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "summary", label: "Summary", type: "text" }],
	});
	for (const [title, summary] of [
		["Bagels", "Boiled, then baked"],
		["Brioche", "Butter and eggs"],
		["Focaccia", "Olive oil and salt"],
		["Rye", "Dark and dense"],
		["Spelt", "An old grain"],
	] as const) {
		const { entry } = await api.entries.create({ siteId, postTypeId: blog.id, title, fields: { summary } });
		await api.entries.publish({ siteId, entryId: entry.id });
	}

	const { loop: latest } = await api.loops.create({
		siteId,
		name: "latest-posts",
		source: "query",
		query: { postTypes: ["blog"], sort: [{ by: "title", direction: "asc" }], limit: 3 },
	});
	latestId = latest.id;
	await api.loops.publish({ siteId, loopId: latestId });
	const { loop: hours } = await api.loops.create({
		siteId,
		name: "opening-hours",
		source: "items",
		fields: [
			{ key: "day", label: "Day", type: "text" },
			{ key: "hours", label: "Hours", type: "text" },
		],
	});
	hoursId = hours.id;
	await api.loops.saveItems({
		siteId,
		loopId: hoursId,
		items: [
			{ day: "Monday", hours: "8–18" },
			{ day: "Tuesday", hours: "8–18" },
		],
	});
	await api.loops.publish({ siteId, loopId: hoursId });

	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: [
			"<header><p>Acme Bakery</p></header><main>{{@outlet}}</main>",
			"<aside><h2>Latest</h2><ul>{{@loop latest-posts as item}}<li>{{ item.title }}</li>{{@empty}}<li>No posts</li>{{/loop}}</ul></aside>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const pagesType = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	for (const [title, pageSlug] of [
		["Menu", "menu"],
		["About", "about"],
	] as const) {
		const { entry } = await api.entries.create({ siteId, postTypeId: pagesType?.id ?? "", title, slug: pageSlug });
		await api.entries.publish({ siteId, entryId: entry.id });
	}
});

afterAll(async () => {
	await install?.close();
});

/** The shell's parameters in its address. */
function params(page: Page): URLSearchParams {
	return new URL(page.url()).searchParams;
}

/** Opens a shell address in the page (as a bookmark or a typed address does). */
async function go(page: Page, address: string): Promise<void> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build${address}`));
}

const placeFrame = (page: Page) => page.locator('[data-wc-place-frame^="loops"]');
const count = (page: Page) => page.locator("[data-wc-loop-count]");
/** The value a key of the result shows, in each open item. */
const shownValue = (page: Page, key: string) => page.locator(`[data-wc-loop-key="${key}"] [data-wc-loop-value]`);

/** A Loop as the admin reads it. */
async function loopOf(id: string) {
	return (await admin.api.loops.get({ siteId, loopId: id })).loop;
}

/** Waits until the admin reads what the place saved (a change saves as it is made). */
async function until(page: Page, read: () => Promise<unknown>, expected: unknown): Promise<void> {
	for (let tries = 0; tries < 100 && !Bun.deepEquals(await read(), expected); tries++) await page.waitForTimeout(100);
	expect(await read()).toEqual(expected);
}

/** The posts the framed page shows through the Loop. */
async function postsOnPage(page: Page): Promise<string[]> {
	const frame = await frameOf(page);
	return frame.locator("aside li").allTextContents();
}

describe("the Loops place, for Staff", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: "/page/menu" });
		const origin = new URL(install.siteUrl(slug, "/")).origin;
		await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("opens from the rail in three columns: the Saved Loops and the settings, the definition, the result", async () => {
		expect(await postsOnPage(page)).toEqual(["Bagels", "Brioche", "Focaccia"]);
		// The page is announced once Edit mode has described it: the place's own announcement comes after.
		await page.waitForFunction(() =>
			document.querySelector("[data-wc-messages]")?.textContent?.includes("Opened Menu"),
		);
		await page.locator('[data-wc-place="loops"]').click();
		await placeFrame(page).waitFor();
		await page.locator("[data-wc-loop-form]").waitFor();
		expect(params(page).get("wc-place")).toBe("loops");
		await page.waitForFunction(() =>
			document.querySelector("[data-wc-messages]")?.textContent?.includes("Loops opened"),
		);

		expect((await page.locator("[data-wc-place-sidebar]").boundingBox())?.width).toBe(300);
		expect((await page.locator("[data-wc-place-header]").boundingBox())?.height).toBe(40);
		expect((await page.locator("[data-wc-loop-result]").boundingBox())?.width).toBe(320);
		// The rail and the bottom bar stay; the place covers the canvas.
		expect(await page.locator("[data-wc-insert-row]").count()).toBe(0);

		// The place alone shows the first Loop, raised and current.
		expect(await page.locator("[data-wc-loop-row]").allTextContents()).toEqual([
			"latest-posts · Published",
			"opening-hours · Published",
		]);
		expect(await page.locator('[data-wc-loop-row="latest-posts"]').getAttribute("aria-current")).toBe("page");
		expect(await page.locator('[data-wc-loop-built-in="search"]').textContent()).toContain("Site search");

		const settings = page.locator("[data-wc-loop-settings]");
		expect(await settings.textContent()).toContain("latest-posts");
		expect(await page.locator("[data-wc-loop-source]").inputValue()).toBe("query");
		expect(await page.locator("[data-wc-loop-post-types]").textContent()).toBe("Blog posts");
		expect(await page.locator("[data-wc-loop-status]").getAttribute("data-wc-loop-status")).toBe("published");

		expect(await page.locator('[data-wc-mode="form"]').getAttribute("aria-pressed")).toBe("true");
		expect(await page.locator("[data-wc-loop-sort='0']").inputValue()).toBe("title:asc");
		expect(await page.locator("[data-wc-loop-limit]").inputValue()).toBe("3");
		expect(await page.locator("[data-wc-loop-offset]").inputValue()).toBe("0");

		await expect(count(page).textContent()).resolves.toBe("3 of 5 items · just now");
		expect(await page.locator("[data-wc-loop-used-on]").textContent()).toBe("Used on 2 pages");
		// The first item starts open, its values by key.
		expect(await page.locator('[data-wc-loop-item-toggle="0"]').getAttribute("aria-expanded")).toBe("true");
		expect(await page.locator('[data-wc-loop-item-toggle="1"]').getAttribute("aria-expanded")).toBe("false");
		expect(await shownValue(page, "title").textContent()).toBe('"Bagels"');
		expect(await shownValue(page, "summary").textContent()).toBe('"Boiled, then baked"');
		await page.locator('[data-wc-loop-item-toggle="1"]').click();
		expect(await shownValue(page, "title").allTextContents()).toEqual(['"Bagels"', '"Brioche"']);

		// A Loop of its own opens by its row, as an address of its own.
		await page.locator('[data-wc-loop-row="latest-posts"]').click();
		expect(params(page).get("wc-place")).toBe(`loops/${latestId}`);
	});

	test("changing the Limit updates the result, and, published, the page using the Loop", async () => {
		const limit = page.locator("[data-wc-loop-limit]");
		await limit.fill("2");
		await page.waitForFunction(
			() => document.querySelector("[data-wc-loop-count]")?.textContent === "2 of 5 items · just now",
		);
		expect(await page.locator('[data-wc-loop-item-toggle="2"]').count()).toBe(0);
		await until(page, async () => (await loopOf(latestId)).draft.query.limit, 2);
		expect(await page.locator("[data-wc-loop-status]").getAttribute("data-wc-loop-status")).toBe("changed");
		// Pages show the Loop as published: still three.
		expect(await postsOnPage(page)).toEqual(["Bagels", "Brioche", "Focaccia"]);

		await page.locator("[data-wc-loop-publish]").click();
		await page.waitForFunction(
			() => document.querySelector("[data-wc-loop-status]")?.getAttribute("data-wc-loop-status") === "published",
		);
		expect(await announced(page)).toBe("The Loop is published: pages show it now");
		expect((await loopOf(latestId)).published?.query.limit).toBe(2);
		await page.waitForFunction(() => {
			const frame = document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]");
			return frame?.contentDocument?.querySelectorAll("aside li").length === 2;
		});

		// Back on the canvas, the page shows two.
		await page.locator("[data-wc-place-back]").click();
		await placeFrame(page).waitFor({ state: "detached" });
		expect(await postsOnPage(page)).toEqual(["Bagels", "Brioche"]);
		await page.locator('[data-wc-place="loops"]').click();
		await page.locator("[data-wc-loop-form]").waitFor();
	});

	test("a click on a key copies its binding and says so; the keyboard too", async () => {
		await page.locator('[data-wc-loop-key="title"]').first().click();
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("{{ item.title }}");
		expect(await announced(page)).toBe("Copied {{ item.title }}");

		await page.locator('[data-wc-loop-key="summary"]').first().focus();
		await page.keyboard.press("Enter");
		expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("{{ item.summary }}");
		expect(await announced(page)).toBe("Copied {{ item.summary }}");
	});

	test("a rule of Match and a second order save to the Draft and change the result", async () => {
		await page.locator("[data-wc-loop-add-rule]").click();
		const rule = page.locator('[data-wc-loop-rule="1"]');
		await rule.waitFor();
		expect(await rule.locator("[data-wc-rule-subject]").inputValue()).toBe("field:summary");
		// A rule waiting for its value isn't saved yet: the Draft keeps what it had.
		expect((await loopOf(latestId)).draft.query.filters).toEqual([]);
		await rule.locator("[data-wc-rule-compare]").selectOption("contains");
		await rule.locator("[data-wc-rule-value]").fill("and");
		await until(page, async () => (await loopOf(latestId)).draft.query.filters, [
			{ type: "field", field: "summary", operator: "contains", value: "and" },
		]);
		// "Butter and eggs", "Olive oil and salt", "Dark and dense".
		await page.waitForFunction(
			() => document.querySelector("[data-wc-loop-count]")?.textContent === "2 of 3 items · just now",
		);

		// The status rule: chosen in a menu of switches.
		await rule.locator("[data-wc-rule-subject]").selectOption("status");
		await until(page, async () => (await loopOf(latestId)).draft.query.filters, [
			{ type: "status", statuses: ["published"] },
		]);

		await page.locator("[data-wc-loop-sort='0']").selectOption("title:desc");
		await until(page, async () => (await loopOf(latestId)).draft.query.sort, [{ by: "title", direction: "desc" }]);
		await page.waitForFunction(
			() => document.querySelector('[data-wc-loop-key="title"] [data-wc-loop-value]')?.textContent === '"Spelt"',
		);

		await page.getByRole("button", { name: "Remove rule 1" }).click();
		await until(page, async () => (await loopOf(latestId)).draft.query.filters, []);
	});

	test("the definition as markup, kept in the address; Back returns to the form", async () => {
		await page.locator('[data-wc-mode="markup"]').click();
		await page.locator("[data-wc-loop-markup]").waitFor();
		expect(params(page).get("wc-view")).toBe("mode=markup");
		const markup = (await page.locator("[data-wc-loop-markup] pre").textContent()) ?? "";
		expect(markup.startsWith("{{@loop latest-posts as item}}")).toBe(true);
		expect(markup).toContain("{{ item.title }}");
		expect(markup).toContain("{{@empty}}");

		await page.goBack();
		await page.locator("[data-wc-loop-form]").waitFor();
		expect(params(page).get("wc-view")).toBeNull();
	});

	test('"+" makes a new Loop and opens it; a refused name says why', async () => {
		await page.locator("[data-wc-loop-new]").click();
		const name = page.getByRole("textbox", { name: "Name of the new Loop" });
		expect(await name.evaluate((element) => element === document.activeElement)).toBe(true);
		const before = pageErrors(page).length;
		await name.fill("Team Members");
		await name.press("Enter");
		await page.locator("[data-wc-loop-create] [role='alert']").waitFor();
		// The refusal the name was meant to get.
		forgetPageErrors(page, before, (error) => /status of 400/.test(error));
		expect(await page.locator("[data-wc-loop-create] [role='alert']").textContent()).toBe(
			"Use lower-case words joined by dashes, such as latest-posts.",
		);

		await name.fill("team-members");
		await name.press("Enter");
		await page.locator('[data-wc-loop-row="team-members"][aria-current="page"]').waitFor();
		const made = (await admin.api.loops.list({ siteId })).loops.find((loop) => loop.name === "team-members");
		expect(params(page).get("wc-place")).toBe(`loops/${made?.id}`);
		expect(await page.locator("[data-wc-loop-status]").getAttribute("data-wc-loop-status")).toBe("draft");
		expect(await page.locator("[data-wc-loop-post-types]").textContent()).toBe("None chosen yet");

		// Its Post Types, from the menu of switches.
		await page.locator("[data-wc-loop-post-types]").click();
		await page.getByRole("menuitemcheckbox", { name: "Blog posts" }).click();
		await page.keyboard.press("Escape");
		await until(page, async () => (await loopOf(made?.id ?? "")).draft.query.postTypes, ["blog"]);
		await page.waitForFunction(
			() => document.querySelector("[data-wc-loop-count]")?.textContent?.startsWith("5 items") === true,
		);
	});

	test("a Loop of its own items is a grid: a value changed in its cell saves, an item is added", async () => {
		await page.locator('[data-wc-loop-row="opening-hours"]').click();
		await page.locator("[data-wc-loop-items]").waitFor();
		expect(await page.locator("[data-wc-loop-source]").inputValue()).toBe("items");
		expect(await page.locator("[data-wc-loop-item]").count()).toBe(2);
		await count(page).filter({ hasText: "2 items" }).waitFor();
		await page.getByRole("textbox", { name: "Hours of item 2" }).fill("9–17");
		await until(page, async () => (await loopOf(hoursId)).draft.items.map((item) => item.hours), ["8–18", "9–17"]);

		await page.locator("[data-wc-loop-add-item]").click();
		await page.getByRole("textbox", { name: "Day of item 3" }).fill("Wednesday");
		await until(page, async () => (await loopOf(hoursId)).draft.items.map((item) => item.day), [
			"Monday",
			"Tuesday",
			"Wednesday",
		]);
		await page.waitForFunction(
			() => document.querySelector("[data-wc-loop-count]")?.textContent === "3 items · just now",
		);

		// Moved up from the keyboard, then removed with a second press.
		await page.getByRole("button", { name: "Move item 3 up" }).click();
		await until(page, async () => (await loopOf(hoursId)).draft.items.map((item) => item.day), [
			"Monday",
			"Wednesday",
			"Tuesday",
		]);
		await page.getByRole("button", { name: "Remove item 2" }).click();
		await page.getByRole("button", { name: "Press again to remove item 2" }).click();
		await until(page, async () => (await loopOf(hoursId)).draft.items.map((item) => item.day), ["Monday", "Tuesday"]);
	});

	for (const theme of THEMES) {
		test(`the place passes the accessibility checks, with the page in ${theme}`, async () => {
			await page.emulateMedia({ colorScheme: theme });
			await go(page, `/page/menu?wc-place=loops/${latestId}`);
			await page.locator("[data-wc-loop-form]").waitFor();
			await count(page).filter({ hasText: "items" }).waitFor();
			await settled(page);
			await expectAccessibleScreen(page, `building area, Loops place (${theme})`);

			await go(page, `/page/menu?wc-place=loops/${latestId}&wc-view=mode%3Dmarkup`);
			await page.locator("[data-wc-loop-markup]").waitFor();
			await expectNoAxeViolations(page, `building area, Loops place, markup (${theme})`);

			await go(page, `/page/menu?wc-place=loops/${hoursId}`);
			await page.locator("[data-wc-loop-items]").waitFor();
			await expectNoAxeViolations(page, `building area, Loops place, Loop items (${theme})`);
		});
	}
});

describe("the Loops place, for a Member", () => {
	test("says Loops are Staff's", async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: editor, siteId, slug, open: "/page/menu" });
		await page.locator('[data-wc-place="loops"]').click();
		await page.locator("[data-wc-loops-staff-only]").waitFor();
		expect(await page.locator("[data-wc-loops-staff-only]").textContent()).toBe(
			"Loops are Structure: only Staff change them.",
		);
		await page.context().close();
	});
});
