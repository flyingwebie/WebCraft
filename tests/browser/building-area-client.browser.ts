// Client editing (ADR 0037, BA-14; SPEC 13): the building area drawn for a Member, in Chromium.
// - a Member gets the client shell (rail 76 with words, bar 56, the page as a sheet 12 from
//   everything with corners 10) and none of the Staff's parts: no docks, panels, code panes, insert
//   row, gutters, size readout, or Templates, Styles, Loops and Components places (not in the DOM, and
//   not at their addresses either); their calls that change Structure are refused anyway;
// - every area they may change is outlined at rest; under the pointer the chip names it and says
//   "Click to edit"; a locked header says why; being edited and changed (the amber dot) as SPEC 13.2;
//   Preview shows no mark at all and nothing in it is editable;
// - the keys of SPEC 13.9: Tab and Shift+Tab between marked areas, Enter edits, Escape finishes, then
//   closes the side panel;
// - the bar: the Draft's state in words, Edit / Preview, Desktop / Tablet / Phone narrowing the sheet,
//   the side panel (360, one at a time, pushing the page), Publish 132 × 40 (an Author's "Send for
//   review", 164); the page's name lists Pages and Entries, and "New Page" makes a Draft Page and opens it;
// - the first-visit card shows once per person, and again from Help with the keys and "Ask your agency";
// - the shell passes the accessibility checks, light and dark.
// The building area's own test of the old editing bar's bar, menus and language for Members
// (`edit-mode.browser.ts`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Cookie, Frame, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { announced, enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let editor: TestAccount;
let author: TestAccount;
let siteId: string;
let pagesId: string;
const slug = "bakery";
const post = "/blog/fresh-bread";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Giulia Romano" })).account;
	author = (await local.createMember({ workspaceId, role: "author", name: "Aoife Author" })).account;
	await api.install.emailBranding.update({ senderName: "Acme Studio", footer: "hello@acme.studio · 021 555 0100" });

	await api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	await api.globals.saveDraft({ siteId, fields: { tagline: "Baked by hand since 1987." } });
	await api.globals.publish({ siteId });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: [
			'<header><p class="logo">Acme Bakery</p><p>{{ site.tagline }}</p>',
			'<nav aria-label="Main"><a href="/">Home</a> <a href="/blog/fresh-bread">Fresh bread</a></nav></header>',
			"<main>{{@outlet}}</main>",
			"<footer><p>Harbour Street, Cork.</p></footer>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	pagesId = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id ?? "";
	for (const [title, pageSlug] of [
		["Home", "home"],
		["Menu", "menu"],
	] as const) {
		const { entry } = await api.entries.create({ siteId, postTypeId: pagesId, title, slug: pageSlug });
		await api.entries.publish({ siteId, entryId: entry.id });
		if (pageSlug === "home") await api.pages.setHomePage({ siteId, pageId: entry.id });
	}
	// Members may arrange Pages on this Site: the Sections button shows on a Page.
	await api.pageLayouts.configure({ siteId, enabled: true });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "subtitle", label: "Subtitle", type: "text" },
			{ key: "intro", label: "Intro", type: "richText" },
		],
	});
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1><p>{{ subtitle }}</p><div>{{ intro }}</div></article>",
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: made } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven at seven", intro: "<p>Sourdough, rye and spelt.</p>" },
	});
	await api.entries.publish({ siteId, entryId: made.id });
});

afterAll(async () => {
	await install?.close();
});

type Box = { x: number; y: number; width: number; height: number };

async function box(page: Page, selector: string): Promise<Box> {
	const found = await page.locator(selector).first().boundingBox();
	if (!found) throw new Error(`${selector} isn't shown.`);
	return found;
}

/** An element of the page in the frame, as the shell's window has it. */
async function boxIn(frame: Frame, selector: string): Promise<Box> {
	const found = await frame.locator(selector).first().boundingBox();
	if (!found) throw new Error(`${selector} isn't shown in the page.`);
	return found;
}

/** Waits until the shell has said `text`. */
async function said(page: Page, text: string): Promise<void> {
	await page.waitForFunction(
		(text) => (document.querySelector("[data-wc-messages]")?.textContent ?? "").replaceAll(" ", "").includes(text),
		text,
		{ timeout: 8000 },
	);
}

/** The text of the page's region `selector`, as a person reads it. */
async function textOf(frame: Frame, selector: string): Promise<string> {
	return ((await frame.locator(selector).textContent()) ?? "").replaceAll(" ", " ");
}

/** The element focus is on in the page in the frame, as `localName[data-wc-field]`. */
async function focusInPage(frame: Frame): Promise<string | null> {
	return frame.evaluate(() => {
		const element = document.activeElement;
		return element ? `${element.localName}[${element.getAttribute("data-wc-field") ?? ""}]` : null;
	});
}

/** Waits until the frame shows `path` with its regions editable. */
async function framedAt(page: Page, path: string): Promise<Frame> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const frame = await frameOf(page);
		if (new URL(frame.url()).pathname === path) {
			await frame.waitForLoadState("load");
			return frame;
		}
		await page.waitForTimeout(50);
	}
	throw new Error(`The frame never showed ${path}.`);
}

const subtitle = 'article [data-wc-field="subtitle"]';
const intro = 'article [data-wc-field="intro"]';

/** The edit and building-area cookies, to open more pages in the same session (the link works once). */
let cookies: Cookie[] = [];

describe("client editing, for an Editor", () => {
	let page: Page;
	let frame: Frame;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		frame = await enterBuildingArea(install, page, { as: editor, siteId, slug, open: `/page${post}` });
		cookies = (await page.context().cookies()).filter((cookie) => cookie.name.includes("webcraft."));
		await frame.locator("h1[contenteditable]").waitFor();
		await page.locator('[data-wc-client-mark="rest"]').first().waitFor();
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("gets the client shell at SPEC 13.1's sizes, and none of the Staff's parts", async () => {
		// Rail 76 with an icon over a word, the Site's tile at the top; the bar 56.
		const rail = await box(page, "[data-wc-client-rail]");
		expect({ width: rail.width, height: rail.height }).toEqual({ width: 76, height: 844 });
		expect(await page.locator("[data-wc-client-rail] [data-wc-place]").allTextContents()).toEqual([
			"Page",
			"Content",
			"Media",
		]);
		for (const item of ["page", "content", "media"]) {
			const each = await box(page, `[data-wc-place="${item}"]`);
			expect({ item, width: each.width, height: each.height }).toEqual({ item, width: 62, height: 54 });
		}
		expect(await page.locator('[data-wc-place="page"]').getAttribute("aria-pressed")).toBe("true");
		expect(await page.locator('[data-wc-rail="help"]').textContent()).toBe("Help");
		expect(await page.locator('[data-wc-rail="exit"]').textContent()).toBe("Exit");
		expect(await page.locator("[data-wc-logo]").textContent()).toContain("Acme Bakery: back to the dashboard");
		const bar = await box(page, "[data-wc-client-bar]");
		expect({ y: bar.y, width: bar.width, height: bar.height }).toEqual({ y: 844, width: 1440, height: 56 });
		expect((await box(page, '[data-wc-bar="page-details"]')).height).toBe(36);
		expect((await box(page, "[data-wc-page-switcher]")).height).toBe(36);
		expect(await page.locator("[data-wc-page-switcher]").textContent()).toBe("Fresh bread");
		const publish = await box(page, "[data-wc-publish]");
		expect({ width: publish.width, height: publish.height }).toEqual({ width: 132, height: 40 });
		// The page as a light sheet, 12 from the rail and the bar, corners 10, no gutters.
		const sheet = await box(page, "[data-wc-frame-box]");
		expect(sheet).toEqual({ x: 88, y: 12, width: 1340, height: 820 });
		expect(
			await page.locator("[data-wc-frame-box]").evaluate((element) => getComputedStyle(element).borderRadius),
		).toBe("10px");

		// Not hidden: absent.
		for (const absent of [
			"[data-wc-dock]",
			"[data-wc-panel]",
			"[data-wc-insert-row]",
			"[data-wc-gutter]",
			"[data-wc-readout]",
			'[data-wc-place="templates"]',
			'[data-wc-place="styles"]',
			'[data-wc-place="loops"]',
			'[data-wc-place="components"]',
			'[data-wc-place="more"]',
			'[data-wc-rail="dark-preview"]',
			'[data-wc-rail="panels"]',
			'[data-wc-rail="hide-interface"]',
			"[data-wc-outline]:not(.hidden)",
		]) {
			expect({ absent, count: await page.locator(absent).count() }).toEqual({ absent, count: 0 });
		}
		// A Post Type's Entry is no Page: no Sections.
		expect(await page.locator('[data-wc-bar="sections"]').count()).toBe(0);

		// Their addresses open the page, not the place.
		for (const place of ["styles%2Fclasses", "templates", "loops", "components"]) {
			await page.goto(install.siteUrl(slug, `/_webcraft/build/page${post}?wc-place=${place}`));
			await framedAt(page, post);
			expect({ place, frames: await page.locator("[data-wc-place-frame]").count() }).toEqual({ place, frames: 0 });
		}
		frame = await framedAt(page, post);
		await frame.locator("h1[contenteditable]").waitFor();

		// And a call that changes Structure is refused, whatever the shell draws.
		const refused = await page.evaluate(async (id) => {
			const config = JSON.parse(document.getElementById("webcraft-building-area-config")?.textContent ?? "{}") as {
				token: string;
			};
			const response = await fetch("/_webcraft/build/api/rpc/pageLayouts/configure", {
				method: "POST",
				headers: { "content-type": "application/json", "x-webcraft-edit-token": config.token },
				body: JSON.stringify({ json: { siteId: id, enabled: false } }),
			});
			const body = (await response.json()) as { json?: { code?: string } };
			return { status: response.status, code: body.json?.code ?? null };
		}, siteId);
		expect(refused).toEqual({ status: 403, code: "FORBIDDEN" });
	});

	test("marks: dashed at rest, the chip under the pointer, locked parts say why, being edited, the amber dot", async () => {
		// Every area the Member may change is outlined at rest, 6 off its content: the Tagline (a Global in
		// the header), the title, the Subtitle and the Intro.
		await page.locator('[data-wc-client-mark="rest"]').nth(3).waitFor();
		expect(await page.locator('[data-wc-client-mark="rest"]').count()).toBe(4);
		const region = await boxIn(frame, subtitle);
		await page.mouse.move(region.x + region.width / 2, region.y + region.height / 2);
		const hover = page.locator('[data-wc-client-mark="hover"]');
		await hover.waitFor();
		const drawn = await hover.boundingBox();
		if (!drawn) throw new Error("No outline.");
		for (const [edge, value] of [
			["x", drawn.x - (region.x - 6)],
			["y", drawn.y - (region.y - 6)],
			["width", drawn.width - (region.width + 12)],
			["height", drawn.height - (region.height + 12)],
		] as const) {
			expect({ edge, drift: Math.abs(value) <= 1 }).toEqual({ edge, drift: true });
		}
		expect(await page.locator('[data-wc-client-mark="hover"]').evaluate((element) => element.style.border)).toContain(
			"2px solid",
		);
		const chip = page.locator('[data-wc-client-chip="hover"]');
		expect(await chip.textContent()).toBe("SubtitleClick to edit");
		const chipBox = await chip.boundingBox();
		if (!chipBox) throw new Error("No chip.");
		// Above the outline's top left corner, never on the content.
		expect(chipBox.y + chipBox.height).toBeLessThanOrEqual(drawn.y);
		expect(chipBox.height).toBe(26);
		expect(await page.locator('[data-wc-client-mark="rest"]').count()).toBe(3);

		// Locked: nothing at rest; under the pointer, a grey outline and the reason.
		const logo = await boxIn(frame, "header .logo");
		await page.mouse.move(logo.x + 4, logo.y + logo.height / 2);
		await page.locator('[data-wc-client-chip="locked"]').waitFor();
		expect(await page.locator('[data-wc-client-chip="locked"]').textContent()).toBe("HeaderSame on every page");
		expect(await page.locator('[data-wc-client-mark="locked"]').count()).toBe(1);

		// Being edited: solid, and plain text keeps its chip, with the name only.
		await page.mouse.click(region.x + region.width - 3, region.y + region.height / 2);
		await page.keyboard.press("End");
		await page.locator('[data-wc-client-chip="editing"]').waitFor();
		expect(await page.locator('[data-wc-client-chip="editing"]').textContent()).toBe("Subtitle");
		expect(await page.locator("[data-wc-draft-state]").textContent()).toContain("No changes yet");

		// Typing: "Saving…", then "Saved", then what is left to publish, and the amber dot on the outline's corner.
		await page.keyboard.type(", every day");
		await page.locator('[data-wc-draft-state="saved"]').waitFor({ timeout: 6000 });
		await page.locator('[data-wc-draft-state="changes"]').waitFor({ timeout: 6000 });
		expect(await page.locator("[data-wc-draft-state]").textContent()).toContain("1 change not published");
		const dot = page.locator('[data-wc-client-mark="changed"]');
		await dot.waitFor({ timeout: 6000 });
		const dotBox = await dot.boundingBox();
		const now = await boxIn(frame, subtitle);
		if (!dotBox) throw new Error("No dot.");
		expect(Math.abs(dotBox.x + dotBox.width / 2 - (now.x - 6))).toBeLessThanOrEqual(1);
		expect(Math.abs(dotBox.y + dotBox.height / 2 - (now.y - 6))).toBeLessThanOrEqual(1);
		expect(await page.locator('[data-wc-bar="undo"]').getAttribute("aria-label")).toBe("Undo Edit Subtitle");
		// Publish says how many changes it would make live.
		expect(await page.locator("[data-wc-publish]").textContent()).toBe("Publish11 change to publish");
	});

	test("keys: Escape finishes, Tab and Shift+Tab move between marked areas, Enter edits, typing waits for it", async () => {
		await page.mouse.move(700, 870);
		await page.locator(subtitle).count();
		const region = await boxIn(frame, subtitle);
		await page.mouse.click(region.x + region.width - 3, region.y + region.height / 2);
		await page.locator('[data-wc-client-chip="editing"]').waitFor();

		// Escape finishes: focus stays on the area, which now waits for Enter.
		await page.keyboard.press("Escape");
		await said(page, "Finished editing Subtitle");
		await page.locator('[data-wc-client-chip="focus"]').waitFor();
		expect(await page.locator('[data-wc-client-chip="focus"]').textContent()).toBe("SubtitlePress Enter to edit");
		expect(await focusInPage(frame)).toBe("p[subtitle]");
		const before = await textOf(frame, subtitle);
		await page.keyboard.type("zz");
		expect(await textOf(frame, subtitle)).toBe(before);

		// Tab goes to the next marked area, Shift+Tab back, skipping what isn't marked.
		await page.keyboard.press("Tab");
		await said(page, "Intro. Press Enter to edit it.");
		expect(await focusInPage(frame)).toBe("div[intro]");
		await page.keyboard.press("Shift+Tab");
		expect(await focusInPage(frame)).toBe("p[subtitle]");
		await page.keyboard.press("Shift+Tab");
		expect(await focusInPage(frame)).toBe("h1[title]");
		await page.keyboard.press("Shift+Tab");
		expect(await focusInPage(frame)).toBe("p[tagline]");

		// Enter starts editing at the end of the text; Enter in plain text finishes again.
		await page.keyboard.press("Tab");
		await page.keyboard.press("Tab");
		expect(await focusInPage(frame)).toBe("p[subtitle]");
		await page.keyboard.press("Enter");
		await page.locator('[data-wc-client-chip="editing"]').waitFor();
		await page.keyboard.type("!");
		expect(await textOf(frame, subtitle)).toBe(`${before}!`);
		await page.keyboard.press("Enter");
		await page.locator('[data-wc-client-chip="focus"]').waitFor();
		expect(await textOf(frame, subtitle)).toBe(`${before}!`);

		// Rich text: Enter starts editing (no new line), and its toolbar names it.
		await page.keyboard.press("Tab");
		await page.keyboard.press("Enter");
		await page.getByRole("toolbar", { name: "Text formatting: Intro" }).waitFor();
		expect(await frame.locator(`${intro} p`).count()).toBe(1);
		await page.keyboard.press("Escape");
		await page.getByRole("toolbar", { name: /^Text formatting/ }).waitFor({ state: "detached" });
	});

	test("the side panel: 360 on the right, pushing the page; Escape closes it, from the panel and from the page", async () => {
		await page.locator('[data-wc-bar="page-details"]').click();
		const panel = page.locator('[data-wc-side-panel="pageDetails"]');
		await panel.waitFor();
		expect(await box(page, '[data-wc-side-panel="pageDetails"]')).toEqual({ x: 1080, y: 0, width: 360, height: 844 });
		expect(await page.locator('[data-wc-bar="page-details"]').getAttribute("aria-expanded")).toBe("true");
		// The page is pushed, not covered: the sheet ends 12 before the panel.
		await settled(page);
		const sheet = await box(page, "[data-wc-frame-box]");
		expect(sheet.x + sheet.width).toBe(1068);
		expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Page details");
		await page.keyboard.press("Escape");
		await panel.waitFor({ state: "detached" });
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-bar"))).toBe("page-details");

		// From the page: Escape finishes editing, then closes the panel, and focus stays in the page.
		await page.locator('[data-wc-bar="page-details"]').click();
		await panel.waitFor();
		const region = await boxIn(frame, subtitle);
		await page.mouse.click(region.x + region.width - 3, region.y + region.height / 2);
		await page.locator('[data-wc-client-chip="editing"]').waitFor();
		await page.keyboard.press("Escape");
		await page.locator('[data-wc-client-chip="focus"]').waitFor();
		await page.keyboard.press("Escape");
		await panel.waitFor({ state: "detached" });
		expect(await focusInPage(frame)).toBe("p[subtitle]");
	});

	test("Preview shows no mark at all, nothing in it is editable, and its links are followed", async () => {
		await page.locator('[data-wc-segment="preview"]').click();
		await said(page, "Preview: the page as visitors will see it");
		expect(await page.locator('[data-wc-segment="preview"]').getAttribute("aria-pressed")).toBe("true");
		await settled(page);
		expect(await page.locator("[data-wc-client-mark], [data-wc-client-chip], [data-wc-mark]").count()).toBe(0);
		expect(await frame.locator("[data-wc-item]:not([contenteditable='false'])").count()).toBe(0);
		const region = await boxIn(frame, subtitle);
		await page.mouse.move(region.x + 10, region.y + region.height / 2);
		await settled(page);
		expect(await page.locator("[data-wc-client-mark], [data-wc-client-chip]").count()).toBe(0);

		// A link goes where it goes, as for a visitor: the shell opens the page.
		await frame.locator('nav a[href="/"]').click();
		await page.waitForURL((url) => url.pathname === "/_webcraft/build/page/");
		const home = await framedAt(page, "/");
		await settled(page);
		expect(await home.locator("[data-wc-item]:not([contenteditable='false'])").count()).toBe(0);
		// The home page is a Page, and Members may arrange this Site's Pages: Sections is there.
		await page.locator('[data-wc-bar="sections"]').waitFor();

		// Edit brings the marks back.
		await page.locator('[data-wc-segment="edit"]').click();
		await page.locator('[data-wc-client-mark="rest"]').first().waitFor();
		expect(await home.locator("[data-wc-item][contenteditable='false']").count()).toBe(0);
		await page.goBack();
		frame = await framedAt(page, post);
		await frame.locator("h1[contenteditable]").waitFor();
	});

	test("Desktop, Tablet and Phone narrow the sheet, centred; the page's own media queries follow", async () => {
		await page.locator('[data-wc-segment="tablet"]').click();
		await page.waitForFunction(() => {
			const box = document.querySelector("[data-wc-frame-box]")?.getBoundingClientRect();
			return box?.width === 768;
		});
		const tablet = await box(page, "[data-wc-frame-box]");
		expect(tablet.x).toBe(88 + (1340 - 768) / 2);
		expect(await frame.evaluate(() => [innerWidth, matchMedia("(max-width: 768px)").matches])).toEqual([768, true]);
		await page.locator('[data-wc-segment="phone"]').click();
		await page.waitForFunction(
			() => document.querySelector("[data-wc-frame-box]")?.getBoundingClientRect().width === 390,
		);
		expect(await frame.evaluate(() => innerWidth)).toBe(390);
		// The marks follow the narrowed page.
		const region = await boxIn(frame, subtitle);
		await page.mouse.move(region.x + 4, region.y + region.height / 2);
		const outline = await page.locator('[data-wc-client-mark="hover"]').boundingBox();
		expect(Math.abs((outline?.x ?? 0) - (region.x - 6))).toBeLessThanOrEqual(1);
		await page.locator('[data-wc-segment="desktop"]').click();
		await page.waitForFunction(
			() => document.querySelector("[data-wc-frame-box]")?.getBoundingClientRect().width === 1340,
		);
	});

	test("the page's name lists Pages and Entries; New Page makes a Draft Page and opens it", async () => {
		await page.locator("[data-wc-page-switcher]").click();
		const list = page.getByRole("dialog", { name: "Pages and Entries" });
		await list.waitFor();
		await page.locator(`[data-wc-switch="${post}"][aria-current="page"]`).waitFor();
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-switch"))).toBe(post);
		expect(await list.locator("h3").allTextContents()).toEqual(["Pages", "Blog posts"]);
		expect(await list.locator("[data-wc-switch]").allTextContents()).toEqual([
			"Home/",
			"Menu/menu",
			`Fresh bread${post}`,
		]);
		// Escape closes the list and gives focus back to the page's name.
		await page.keyboard.press("Escape");
		await list.waitFor({ state: "detached" });
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-page-switcher"))).toBe(true);

		await page.locator("[data-wc-page-switcher]").click();
		await page.locator('[data-wc-switch-new="page"]').click();
		await page.getByLabel("Title of the new Page").fill("Order a cake");
		await page.keyboard.press("Enter");
		await page.waitForURL((url) => url.pathname === "/_webcraft/build/page/order-a-cake", { timeout: 10_000 });
		await framedAt(page, "/order-a-cake");
		const { api } = await install.install.superadmin();
		const made = (await api.entries.list({ siteId, postTypeId: pagesId })).entries.find(
			(each) => each.draft.title === "Order a cake",
		);
		expect(made?.status).toBe("draft");
		await page.locator("[data-wc-page-switcher]").filter({ hasText: "Order a cake" }).waitFor();
		expect(await announced(page)).toContain("Order a cake");

		// Back to the post, from the list.
		await page.locator("[data-wc-page-switcher]").click();
		await page.locator(`[data-wc-switch="${post}"]`).click();
		frame = await framedAt(page, post);
		await frame.locator("h1[contenteditable]").waitFor();
	});
});

describe("the first-visit card and Help, for an Author", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: author, siteId, slug, open: `/page${post}`, firstVisit: true });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("the card shows once per person; Help shows it again with the keys and Ask your agency", async () => {
		const card = page.locator('[data-wc-help-card="first"]');
		await card.waitFor();
		expect(await card.getByRole("heading", { level: 2 }).textContent()).toBe("You're editing a Draft of Fresh bread");
		expect(await card.locator("[data-wc-legend]").allTextContents()).toEqual([
			"Dashed outline: click it to change the words or the photo.",
			"Amber dot: you changed it. Visitors don't see it yet.",
			"No outline: the same on every page. Your agency looks after it.",
		]);
		// An Author sends for review: one cell, 164 wide.
		expect(await page.locator("[data-wc-publish]").textContent()).toBe("Send for review");
		expect((await box(page, "[data-wc-publish]")).width).toBe(164);
		await expectNoAxeViolations(page, "building area, the first-visit card");

		await card.getByRole("button", { name: "Got it" }).click();
		await card.waitFor({ state: "detached" });
		const admin = await install.install.signIn(author);
		for (let attempt = 0; attempt < 40; attempt++) {
			if ((await admin.api.me.editorPreferences({ siteId })).hintSeen) break;
			await Bun.sleep(100);
		}
		expect((await admin.api.me.editorPreferences({ siteId })).hintSeen).toBe(true);
		await page.reload();
		await frameOf(page);
		await page.locator("[data-wc-client-rail]").waitFor();
		await settled(page);
		expect(await page.locator("[data-wc-help-card]").count()).toBe(0);

		// Help: the same card, the keys, and who to ask; focus goes into it, Escape gives it back.
		await page.locator('[data-wc-rail="help"]').click();
		const help = page.locator('[data-wc-help-card="help"]');
		await help.waitFor();
		expect(await page.locator('[data-wc-rail="help"]').getAttribute("aria-pressed")).toBe("true");
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-help-close"))).toBe(true);
		expect(await help.locator("[data-wc-help-keys] dd").allTextContents()).toEqual([
			"move between marked areas",
			"starts editing",
			"finishes, then closes the panel",
			"undo",
			"redo",
		]);
		expect(await help.locator("[data-wc-help-agency]").textContent()).toBe(
			"Acme Studio looks after this site. Ask them about anything you can't change here.hello@acme.studio · 021 555 0100",
		);
		await expectNoAxeViolations(page, "building area, Help");
		await page.keyboard.press("Escape");
		await help.waitFor({ state: "detached" });
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-rail"))).toBe("help");
	});
});

for (const theme of THEMES) {
	test(`the client shell passes the accessibility checks, with the page in ${theme}`, async () => {
		const page = await install.newPage(theme);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.context().addCookies(cookies);
		await page.goto(install.siteUrl(slug, `/_webcraft/build/page${post}`));
		const frame = await framedAt(page, post);
		await frame.locator("h1[contenteditable]").waitFor();
		await page.locator('[data-wc-client-mark="rest"]').first().waitFor();
		await expectAccessibleScreen(page, `building area, client editing (${theme})`);
		// With the side panel and the page list open.
		await page.locator('[data-wc-bar="page-details"]').click();
		await page.locator("[data-wc-side-panel]").waitFor();
		await expectNoAxeViolations(page, `building area, client editing, side panel (${theme})`);
		await page.locator("[data-wc-page-switcher]").click();
		await page.locator("[data-wc-page-list]").waitFor();
		await expectNoAxeViolations(page, `building area, client editing, page list (${theme})`);
		await page.context().close();
	});
}
