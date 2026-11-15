// Before the cutover (BA-34), Staff between 1024 and 1279 px and by touch, in Chromium:
// - selecting on the page opens the right dock's drawer (Layers and the Inspector) only when it was
//   open, and never closes it (`window-width` 289, 558);
// - narrowing the window while working in Layers or the Inspector keeps that dock open as a drawer,
//   focus where it was (`window-width` 322, 592);
// - the width presets still preview a tablet's and a phone's width in the drawer layout
//   (`window-width` 574);
// - shrinking under 1024 covers the shell, closes nothing, and widening brings it back with its
//   drawer, its selection and its Undo history (`window-width` 624);
// - by touch: a tap selects on the page and in Layers, the drawer opens and the Inspector answers
//   taps, the insert row inserts, and every control is a target of at least 44 px;
//   a drag of a finger across the page moves nothing (`window-width` 430, 676, 697), light and dark.
// The edit link may only be followed a few times a minute from one address: one page per pointer.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Locator, Page } from "playwright";

import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { enterBuildingArea, eventually, frameOf, settled } from "./building-area.ts";
import { expectKeyboardUsable, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let api: TestBrowser["api"];
let siteId: string;
let postTypeId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";
const MARKUP =
	'<article><h1>{{ title }}</h1><ul><li data-wc-id="one">One</li><li data-wc-id="two">Two</li></ul><p class="lead">Out of the oven</p></article>';

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	api = (await local.superadmin()).api;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).account;
	await api.designSystem.createClass({ siteId, name: "lead" });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>Welcome.</p></header><main>{{@outlet}}</main><footer><p>Harbour Street, Cork.</p></footer>",
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	postTypeId = (await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" })).postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: MARKUP });
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: post } = await api.entries.create({ siteId, postTypeId, title: "Fresh bread" });
	await api.entries.publish({ siteId, entryId: post.id });
});

const pages: Promise<Page>[] = [];

afterAll(async () => {
	for (const page of pages) {
		await (await page)
			.context()
			.close()
			.catch(() => {});
	}
	await install?.close();
});

/**
 * A page in the building area at `width`, with a mouse or a finger. The mouse's page enters; the
 * finger's takes its cookies (the edit link may be followed only a few times a minute).
 */
function entered(touch: boolean, width: number, from?: () => Promise<Page>): () => Promise<Page> {
	let opened: Promise<Page> | undefined;
	return () => {
		opened ??= (async () => {
			const page = await install.newPage("light", { touch });
			await page.setViewportSize({ width, height: 900 });
			if (from) {
				const entry = await from();
				await page.context().addCookies(await entry.context().cookies());
				await page.goto(entry.url());
				await frameOf(page);
			} else await enterBuildingArea(install, page, { as: staff, siteId, slug, open: `/page${path}` });
			// Between 1024 and 1279 px Layers is in a drawer, closed: the drawer's button says the shell is drawn.
			await (width < 1280 ? toggle(page) : tree(page).getByRole("treeitem").first()).waitFor();
			return page;
		})();
		pages.push(opened);
		return opened;
	};
}

const withMouse = entered(false, 1100);
const withFinger = entered(true, 1280, withMouse);

const tree = (page: Page) => page.getByRole("tree", { name: "Elements of the page", includeHidden: true });
const rightDock = (page: Page) => page.locator('[data-wc-dock="right"]');
const toggle = (page: Page) => page.locator('[data-wc-drawer-toggle="right"]');
const inspector = (page: Page) => page.locator('[data-wc-panel-body="inspector"]');

/** Closes the right drawer if it is open (each check starts from the drawers closed). */
async function closeDrawer(page: Page): Promise<void> {
	if ((await toggle(page).count()) && (await toggle(page).getAttribute("aria-expanded")) === "true") {
		await toggle(page).click();
		await rightDock(page).waitFor({ state: "detached" });
	}
}

/** Resizes the window and waits until the shell has drawn itself for the new size. */
async function resize(page: Page, width: number, height = 900): Promise<void> {
	await page.setViewportSize({ width, height });
	await page.waitForFunction(([w, h]) => window.innerWidth === w && window.innerHeight === h, [width, height]);
	await settled(page);
	await settled(page);
}

/** Clicks (or taps) an element of the page in the frame, as a person does. */
async function pointAt(page: Page, frame: Frame, selector: string, how: "click" | "tap" = "click"): Promise<void> {
	const element = frame.locator(selector).first();
	await element.scrollIntoViewIfNeeded();
	const found = await element.boundingBox();
	if (!found) throw new Error(`${selector} isn't on the page.`);
	const x = found.x + Math.min(12, found.width / 2);
	const y = found.y + found.height / 2;
	if (how === "tap") await page.touchscreen.tap(x, y);
	else await page.mouse.click(x, y);
	await settled(page);
}

/** The selection's reference, as the address keeps it. */
function selectedIn(page: Page): string | null {
	return new URL(page.url()).searchParams.get("wc-select");
}

/** The Entry template's Draft markup now. */
async function draftMarkup(): Promise<string> {
	return (await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "";
}

/** Whether focus is inside `locator`. */
async function focusedIn(locator: Locator): Promise<boolean> {
	return locator.evaluate((element) => element.contains(document.activeElement));
}

/** The visible controls of the shell smaller than 44 px either way (what a finger may miss). */
async function smallTargets(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const selector = [
			"button",
			"a[href]",
			"select",
			"textarea",
			'input:not([type="checkbox"], [type="radio"], [type="hidden"], [type="range"], [type="file"])',
			'[role="button"]',
			'[role="tab"]',
			'[role="treeitem"]',
			'[role="menuitem"]',
			'[role="menuitemradio"]',
			'[role="switch"]',
		].join(",");
		const small: string[] = [];
		for (const element of document.querySelectorAll<HTMLElement>(`[data-wc-staff] :is(${selector})`)) {
			if (element.classList.contains("sr-only") || element.closest("[inert]")) continue;
			const box = element.getBoundingClientRect();
			if (box.width === 0 || box.height === 0) continue;
			const style = getComputedStyle(element);
			if (style.visibility === "hidden" || style.display === "none") continue;
			if (box.width < 43.5 || box.height < 43.5) {
				const name = element.getAttribute("aria-label") ?? element.textContent?.trim().slice(0, 30) ?? "";
				small.push(`${element.tagName.toLowerCase()} "${name}" ${Math.round(box.width)}×${Math.round(box.height)}`);
			}
		}
		return small;
	});
}

describe("Staff between 1024 and 1279 px", () => {
	test("selecting on the page opens the right drawer only when it was open, and never closes it", async () => {
		const page = await withMouse();
		const frame = await frameOf(page);
		expect(await toggle(page).getAttribute("aria-expanded")).toBe("false");
		await pointAt(page, frame, "h1");
		await eventually(
			async () => selectedIn(page),
			(selected) => selected !== null,
		);
		expect(await rightDock(page).count()).toBe(0);
		expect(await toggle(page).getAttribute("aria-expanded")).toBe("false");

		await toggle(page).click();
		await rightDock(page).waitFor();
		await inspector(page).waitFor();
		const before = selectedIn(page);
		await pointAt(page, frame, "p.lead");
		await eventually(
			async () => selectedIn(page),
			(selected) => selected !== before,
		);
		expect(await rightDock(page).isVisible()).toBe(true);
		expect(await toggle(page).getAttribute("aria-expanded")).toBe("true");
		await inspector(page).waitFor();
		expect(await tree(page).getByRole("treeitem", { name: "p .lead" }).getAttribute("aria-selected")).toBe("true");
		await page.keyboard.press("Escape");
		await toggle(page).click();
		await rightDock(page).waitFor({ state: "detached" });
	});

	test("narrowing while working in Layers or the Inspector keeps it open as a drawer, focus and all", async () => {
		const page = await withMouse();
		await resize(page, 1100);
		await closeDrawer(page);
		await resize(page, 1440);
		await rightDock(page).waitFor();
		// Selected on the page, its row shows in Layers (its branches open to it).
		await pointAt(page, await frameOf(page), 'li[data-wc-code$="#one"]');
		const row = tree(page).getByRole("treeitem", { name: "li", selected: true });
		await row.waitFor();
		await inspector(page).waitFor();
		await row.focus();

		await resize(page, 1100);
		expect(await toggle(page).getAttribute("aria-expanded")).toBe("true");
		expect(await rightDock(page).isVisible()).toBe(true);
		expect(await row.isVisible()).toBe(true);
		expect(await row.evaluate((element) => element === document.activeElement)).toBe(true);
		await toggle(page).click();
		await rightDock(page).waitFor({ state: "detached" });

		// The Inspector: a field of it keeps focus as the window narrows.
		await resize(page, 1440);
		const tag = inspector(page).getByLabel("Tag");
		await tag.focus();
		await resize(page, 1100);
		expect(await toggle(page).getAttribute("aria-expanded")).toBe("true");
		expect(await tag.isVisible()).toBe(true);
		expect(await focusedIn(inspector(page))).toBe(true);
		// The drawer lies over the canvas and the bottom dock by design: what it covers is no target meanwhile.
		await expectNoAxeViolations(page, "narrowed with the Inspector in a drawer", ["target-size"]);
		await expectKeyboardUsable(page, "narrowed with the Inspector in a drawer");
		await toggle(page).click();
		await rightDock(page).waitFor({ state: "detached" });
	});

	test("the width presets still preview a tablet's and a phone's width in the drawer layout", async () => {
		const page = await withMouse();
		await resize(page, 1100);
		await closeDrawer(page);
		await resize(page, 1024);
		const frame = await frameOf(page);
		const width = () => frame.evaluate(() => document.documentElement.clientWidth);
		await page.locator('[data-wc-gutter="end"]').focus();
		await page.locator('[data-wc-preset="tablet"]').click();
		expect(await eventually(width, (now) => now === 768)).toBe(768);
		await page.locator('[data-wc-preset="phone"]').click();
		expect(await eventually(width, (now) => now === 390)).toBe(390);
		expect(await page.locator("[data-wc-narrow]").count()).toBe(0);
		await page.locator('[data-wc-gutter="end"]').dblclick();
		await resize(page, 1100);
	});

	test("under 1024 the shell is covered, closes nothing, and comes back with its drawer, selection and Undo", async () => {
		const page = await withMouse();
		await resize(page, 1100);
		await closeDrawer(page);
		await toggle(page).click();
		await rightDock(page).waitFor();
		await pointAt(page, await frameOf(page), 'li[data-wc-code$="#two"]');
		const two = tree(page).getByRole("treeitem", { name: "li", selected: true });
		await two.waitFor();
		await two.focus();
		await page.keyboard.press("Alt+ArrowUp");
		expect(await eventually(draftMarkup, (markup) => /"two"[\s\S]*"one"/.test(markup))).toMatch(/"two"[\s\S]*"one"/);
		const undo = page.locator('[data-wc-bar="undo"]');
		await eventually(
			() => undo.isDisabled(),
			(disabled) => !disabled,
		);
		const selected = selectedIn(page);

		await resize(page, 900);
		const notice = page.getByRole("dialog", { name: "The building area needs a window at least 1024 px wide" });
		await notice.waitFor();
		expect(await notice.getAttribute("aria-modal")).toBe("true");
		await expectNoAxeViolations(page, "the shell covered under 1024");

		await resize(page, 1100);
		await notice.waitFor({ state: "detached" });
		expect(await toggle(page).getAttribute("aria-expanded")).toBe("true");
		expect(await rightDock(page).isVisible()).toBe(true);
		expect(selectedIn(page)).toBe(selected);
		expect(await focusedIn(rightDock(page))).toBe(true);
		expect(await undo.isDisabled()).toBe(false);
		await undo.click();
		expect(await eventually(draftMarkup, (markup) => /"one"[\s\S]*"two"/.test(markup))).toMatch(/"one"[\s\S]*"two"/);
		await toggle(page).click();
	});
});

describe("Staff by touch", () => {
	test("a tap selects on the page and in Layers; the drawer, the Inspector and the insert row answer taps", async () => {
		const page = await withFinger();
		await resize(page, 1100);
		const frame = await frameOf(page);
		await pointAt(page, frame, "h1", "tap");
		await eventually(
			async () => selectedIn(page),
			(selected) => selected !== null,
		);

		await toggle(page).tap();
		await rightDock(page).waitFor();
		await tree(page).getByRole("treeitem", { name: "p .lead" }).tap();
		await eventually(
			() => tree(page).getByRole("treeitem", { name: "p .lead" }).getAttribute("aria-selected"),
			(selected) => selected === "true",
		);
		await inspector(page).getByLabel("Tag").tap();
		expect(await focusedIn(inspector(page))).toBe(true);

		// The insert row: Text after the paragraph, one step, in the Draft.
		await page.locator('[data-wc-insert="text"]').tap();
		const paragraphs = (markup: string) => (markup.match(/<p\b/g) ?? []).length;
		const added = await eventually(draftMarkup, (markup) => paragraphs(markup) === 2);
		expect(paragraphs(added)).toBe(2);
		expect(added).toMatch(/lead[\s\S]*<p\b/);
		await page.locator('[data-wc-bar="undo"]').tap();
		// One step: the new paragraph goes, the lead stays.
		const undone = await eventually(draftMarkup, (markup) => paragraphs(markup) === 1);
		expect(paragraphs(undone)).toBe(1);
		expect(undone).toMatch(/<p class="lead"/);
		expect(undone).not.toMatch(/lead[\s\S]*<p\b/);
	});

	test("every control a finger can reach is at least 44 px, light and dark", async () => {
		const page = await withFinger();
		for (const width of [1280, 1100]) {
			await resize(page, width);
			if (width === 1100 && (await toggle(page).getAttribute("aria-expanded")) !== "true") await toggle(page).tap();
			await settled(page);
			expect({ width, small: await smallTargets(page) }).toEqual({ width, small: [] });
		}
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await expectNoAxeViolations(page, `Staff by touch (${theme})`);
		}
		await page.emulateMedia({ colorScheme: "light" });
	});

	test("a finger dragged across the page moves nothing", async () => {
		const page = await withFinger();
		const frame = await frameOf(page);
		await pointAt(page, frame, 'li[data-wc-code$="#one"]', "tap");
		const before = await draftMarkup();
		await frame.evaluate(() => {
			const items = [...document.querySelectorAll("li")];
			const one = items.find((item) => item.textContent === "One")?.getBoundingClientRect();
			const two = items.find((item) => item.textContent === "Two")?.getBoundingClientRect();
			if (!one || !two) throw new Error("The page shows no list.");
			const send = (type: string, x: number, y: number) =>
				document
					.elementFromPoint(x, y)
					?.dispatchEvent(
						new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true, pointerType: "touch" }),
					);
			send("pointerdown", one.x + 10, one.y + one.height / 2);
			for (let step = 1; step <= 8; step++) send("pointermove", one.x + 10, one.y + (two.bottom - one.y) * (step / 8));
			send("pointerup", two.x + 10, two.bottom - 2);
		});
		for (let tries = 0; tries < 10; tries++) {
			expect(await draftMarkup()).toBe(before);
			await page.waitForTimeout(100);
		}
		expect(await frame.locator("li").allTextContents()).toEqual(["One", "Two"]);
	});
});
