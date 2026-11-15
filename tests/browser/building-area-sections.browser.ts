// Sections for a Member (ADR 0037, BA-17; SPEC 13.3 and 13.4, `client/06`, `client/07`), in Chromium:
// - the Sections side panel: the page's sections in order, with the Site template's header and footer as
//   locked rows, a section whose place the agency fixed carrying a lock, a hidden one faded; the keys
//   (arrows, Home, End, typing a name, Space to pick up and move, Escape to put back, Alt with the
//   arrows, Delete) and a drag by the handle;
// - a section chosen on the page, by its edge: its name and bar inside its top edge (move up, move
//   down, hide, settings, remove); hidden sections faded, and gone in Preview; Remove asks nothing and
//   a toast offers Undo; ⌘Z takes a move back;
// - "+ Add section" near the boundary between two sections, and the panel's "Add section": the picker
//   of the Allowed components (groups, search, cards; pointing at one shows where it lands; a click
//   adds it, chosen and in view);
// - a section's settings (its Props, typed) and its text typed in place on the page; a locked
//   section's Props still change; others' changes arrive without taking the person's typing or focus;
// - what Staff switch decides what a Member may do: no Sections where the Site doesn't let Members
//   arrange, only Allowed components to add;
// - the shell passes the accessibility checks with each of these open, light and dark.
// The building area's counterpart of `page-layouts.browser.ts` and `page-layout-props.browser.ts` (the
// Page layout drawer of the editing bar), for Members. Their phone cases are BA-19's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiClient } from "@webcraft/api";
import type { Frame, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { announced, enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let api: ApiClient;
let editor: TestAccount;
let peerAccount: TestAccount;
let siteId: string;
let pagesId: string;
const slug = "bakery";

type Component = Awaited<ReturnType<ApiClient["components"]["create"]>>["component"];
const components: Record<"hero" | "quote" | "banner" | "cards" | "unavailable", Component> = {} as never;

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	({ api } = await local.superadmin());
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Giulia Romano" })).account;
	peerAccount = (await local.createMember({ workspaceId, role: "editor", name: "Pat Peer" })).account;
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>Acme Bakery</p></header><main>{{@outlet}}</main><footer><p>Harbour Street, Cork.</p></footer>",
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	pagesId = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id ?? "";
	const made = async (
		name: string,
		props: NonNullable<Parameters<ApiClient["components"]["create"]>[0]["props"]>,
		markup: string,
	) => {
		const { component } = await api.components.create({ siteId, name, props });
		await api.components.saveMarkup({ siteId, componentId: component.id, markup });
		await api.components.publish({ siteId, componentId: component.id });
		return component;
	};
	components.hero = await made(
		"Hero",
		[
			{ key: "heading", label: "Heading", type: "text", translatable: true },
			{ key: "count", label: "Count", type: "number", default: 3 },
		],
		"<section><h1>{{ props.heading }}</h1><p>{{ props.count }}</p></section>",
	);
	components.quote = await made(
		"Quote",
		[{ key: "quote", label: "Quote", type: "text", default: "Best bread in Cork." }],
		"<section><blockquote>{{ props.quote }}</blockquote></section>",
	);
	components.banner = await made(
		"Banner",
		[{ key: "cta", label: "Button", type: "link", default: { url: "https://example.com/old", text: "Old" } }],
		'<section><a href="{{ props.cta.url }}">{{ props.cta.text }}</a></section>',
	);
	components.cards = await made(
		"Cards",
		[
			{
				key: "group",
				label: "Group",
				type: "group",
				fields: [
					{ key: "first", label: "First", type: "text", default: "First baseline" },
					{ key: "second", label: "Second", type: "text", default: "Second baseline" },
				],
			},
			{ key: "rows", label: "Rows", type: "repeater", fields: [{ key: "text", label: "Text", type: "text" }] },
		],
		"<section><h2>{{ props.group.first }}</h2></section>",
	);
	components.unavailable = await made("Unavailable", [], "<section><p>Not for Members</p></section>");
	await api.pageLayouts.configure({
		siteId,
		enabled: true,
		allowedComponents: [components.hero.id, components.quote.id, components.banner.id, components.cards.id],
	});
});

afterAll(async () => {
	await install?.close();
});

type Placement = {
	id: string;
	component: Component;
	values?: Record<string, unknown>;
	locked?: boolean;
	hidden?: boolean;
};

const hero = (id: string, heading: string, flags: { locked?: boolean; hidden?: boolean } = {}): Placement => ({
	id,
	component: components.hero,
	values: { heading: { en: heading } },
	...flags,
});

/** Makes a published Page at `/<pageSlug>` with these sections; answers its Entry's id. */
async function makePage(title: string, pageSlug: string, placements: Placement[]): Promise<string> {
	const { entry } = await api.entries.create({ siteId, postTypeId: pagesId, title, slug: pageSlug });
	const state = await api.pageLayouts.get({ siteId, entryId: entry.id });
	await api.pageLayouts.save({
		siteId,
		entryId: entry.id,
		basedOn: state.version,
		layout: {
			placements: placements.map((placement) => ({
				id: placement.id,
				component: placement.component.id,
				props: placement.component.draft.props,
				values: (placement.values ?? {}) as never,
				...(placement.locked ? { locked: true } : {}),
				...(placement.hidden ? { hidden: true } : {}),
			})),
		},
	});
	await api.entries.publish({ siteId, entryId: entry.id });
	return entry.id;
}

const layoutOf = (entryId: string) => api.pageLayouts.get({ siteId, entryId });

/** Waits until the saved layout's sections read `expected` (each section's values, or its ids). */
async function saved<T>(read: () => Promise<T>, expected: T): Promise<void> {
	const deadline = Date.now() + 8000;
	let actual: T;
	do {
		actual = await read();
		if (JSON.stringify(actual) === JSON.stringify(expected)) break;
		await new Promise((resolve) => setTimeout(resolve, 50));
	} while (Date.now() < deadline);
	expect(actual).toEqual(expected);
}

const headings = (entryId: string) => async () =>
	(await layoutOf(entryId)).placements.map((placement) => placement.values.heading);

/** Opens a page in the shell (the session's cookies are there: the link was followed once). */
async function open(page: Page, path: string): Promise<Frame> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build/page${path}`));
	for (let attempt = 0; attempt < 100; attempt++) {
		const frame = await frameOf(page);
		if (new URL(frame.url()).pathname === path) {
			await frame.locator("main [data-wc-page-placement]").first().waitFor();
			await page.locator('[data-wc-bar="sections"]').waitFor();
			// The sections are arranged once the controller has the page.
			await frame.locator("html.wc-arrange-on").waitFor({ state: "attached" });
			return frame;
		}
		await page.waitForTimeout(50);
	}
	throw new Error(`The frame never showed ${path}.`);
}

/** Opens the Sections panel and waits for its list. */
async function openSections(page: Page) {
	await page.locator('[data-wc-bar="sections"]').click();
	await page.locator("[data-wc-sections-list]").waitFor();
	return page.getByRole("tree");
}

/** Waits until the page's first section reads `text`. */
async function firstIs(frame: Frame, text: string): Promise<void> {
	await frame.waitForFunction(
		(text) => document.querySelector("main [data-wc-page-placement]")?.textContent?.includes(text),
		text,
		{ timeout: 8000 },
	);
}

/** Waits until the shell has said `text`. */
async function said(page: Page, text: string): Promise<void> {
	await page.waitForFunction(
		(text) => (document.querySelector("[data-wc-messages]")?.textContent ?? "").replaceAll(" ", "").includes(text),
		text,
		{ timeout: 8000 },
	);
}

/**
 * Chooses a section on the page by its edge: a click on its own part, away from its words (the end of
 * its first line, which its heading doesn't reach).
 */
async function chooseSection(frame: Frame, id: string): Promise<void> {
	const section = frame.locator(`[data-wc-page-placement="${id}"]`).first();
	const box = await section.boundingBox();
	if (!box) throw new Error(`No section ${id}.`);
	await section.click({ position: { x: box.width - 6, y: 6 } });
}

/** Puts the Sections panel away (Escape from its close button), whatever view it shows. */
async function closeSections(page: Page) {
	const close = page.locator("[data-wc-side-panel-close]");
	if ((await close.count()) > 0) await close.click();
	await page.locator('[data-wc-side-panel="sections"]').waitFor({ state: "detached" });
}

describe("Sections, for an Editor", () => {
	let page: Page;
	let peer: Page;

	beforeAll(async () => {
		await makePage("Start", "start", [hero("start", "Start here")]);
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: editor, siteId, slug, open: "/page/start" });
		await page.locator('[data-wc-bar="sections"]').waitFor();
		peer = await install.newPage("light");
		await peer.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, peer, { as: peerAccount, siteId, slug, open: "/page/start" });
		await peer.locator('[data-wc-bar="sections"]').waitFor();
	});

	afterAll(async () => {
		await page?.context().close();
		await peer?.context().close();
	});

	test("the list: locked header and footer, a fixed and a hidden section, the keys, typeahead and a drag", async () => {
		const entryId = await makePage("Arrange", "arrange", [
			hero("north", "North"),
			hero("south", "South"),
			hero("fixed", "Fixed", { locked: true }),
			hero("away", "Away", { hidden: true }),
		]);
		const frame = await open(page, "/arrange");
		const tree = await openSections(page);
		expect(await page.locator('[data-wc-side-panel="sections"] h2').textContent()).toBe("Sections");
		expect(await page.locator('[data-wc-side-panel="sections"] header p').textContent()).toBe("Arrange · 4 sections");
		expect(await tree.getAttribute("aria-label")).toBe("Sections of Arrange");
		const rows = tree.getByRole("treeitem");
		expect(await rows.count()).toBe(6);
		expect(await rows.first().getAttribute("aria-level")).toBe("1");
		expect(await rows.last().getAttribute("aria-setsize")).toBe("6");
		// The Site template's header and footer: locked rows, the same on every page.
		expect(await rows.first().textContent()).toBe("HeaderSame on every page");
		expect(await rows.last().textContent()).toBe("FooterSame on every page");
		// A section whose place the agency fixed, and a hidden one, say so.
		expect(await tree.getByRole("treeitem", { name: /^Hero · Fixed\s*Your agency fixed its place$/ }).count()).toBe(1);
		expect(await tree.getByRole("treeitem", { name: /^Hero · Away\s*Hidden from visitors$/ }).count()).toBe(1);
		expect(await rows.nth(4).textContent()).toContain("Hidden from visitors");
		// Hidden: faded on the page (it stays in the Draft).
		expect(
			await frame
				.locator('[data-wc-page-placement="away"]')
				.first()
				.evaluate((element) => getComputedStyle(element).opacity),
		).toBe("0.7");

		// Space picks a section up, the arrows move it, Escape puts it back.
		await rows.filter({ hasText: "Hero · South" }).click();
		await page.keyboard.press("Space");
		await tree.locator('[data-grabbed="true"]').waitFor();
		await said(page, "Hero · South picked up.");
		await page.keyboard.press("ArrowUp");
		await firstIs(frame, "South");
		await page.keyboard.press("Escape");
		await firstIs(frame, "North");
		// Escape put it back; the panel stays.
		expect(await tree.locator('[data-grabbed="true"]').count()).toBe(0);
		await page.locator("[data-wc-sections-list]").waitFor();
		// Alt with the arrows moves it at once.
		await page.keyboard.press("Alt+ArrowUp");
		await firstIs(frame, "South");
		await saved(headings(entryId), ["South", "North", "Fixed", "Away"]);
		// A drag by the handle: South goes below North.
		const grip = rows.filter({ hasText: "Hero · South" }).locator("[data-wc-section-grip]");
		const target = await rows.filter({ hasText: "Hero · North" }).boundingBox();
		const from = await grip.boundingBox();
		if (!target || !from) throw new Error("No rows to drag between.");
		await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
		await page.mouse.down();
		await page.mouse.move(from.x + from.width / 2, target.y + target.height - 4, { steps: 6 });
		await page.mouse.up();
		await firstIs(frame, "North");
		await saved(headings(entryId), ["North", "South", "Fixed", "Away"]);

		// Home goes to the first row; typing a name finds its row.
		await rows.filter({ hasText: "Hero · South" }).focus();
		await page.keyboard.press("Home");
		expect(await rows.first().getAttribute("aria-selected")).toBe("true");
		await page.keyboard.type("hero");
		expect(await rows.nth(1).getAttribute("aria-selected")).toBe("true");
		expect(await rows.nth(1).evaluate((row) => row === document.activeElement)).toBe(true);
		await page.waitForTimeout(700);
		await page.keyboard.type("foo");
		expect(await rows.last().getAttribute("aria-selected")).toBe("true");

		// A fixed section can't move, hide or go: its menu says so, and Delete is refused aloud.
		await rows.nth(3).click();
		await page.keyboard.press("Delete");
		await said(page, "Your agency fixed this section's place");
		expect(await rows.count()).toBe(6);
		await rows.nth(3).getByRole("button", { name: "More for Hero · Fixed" }).click();
		const menu = page.getByRole("menu", { name: "Hero · Fixed" });
		await menu.waitFor();
		for (const [item, disabled] of [
			["Settings", null],
			["Duplicate", null],
			["Move up", "true"],
			["Move down", "true"],
			["Hide", "true"],
			["Remove", "true"],
		] as const)
			expect({
				item,
				disabled: await menu.getByRole("menuitem", { name: item }).getAttribute("aria-disabled"),
			}).toEqual({
				item,
				disabled,
			});
		await expectNoAxeViolations(page, "Sections menu");
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "detached" });
		expect(
			await rows
				.nth(3)
				.getByRole("button", { name: "More for Hero · Fixed" })
				.evaluate((button) => button === document.activeElement),
		).toBe(true);
		// Its words still change: its settings.
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Shift+Tab");
		await page.keyboard.press("Enter");
		const heading = page.locator("[data-wc-section-settings]").getByLabel("Heading", { exact: true });
		await heading.waitFor();
		await heading.fill("Still editable");
		await heading.press("Tab");
		await saved(headings(entryId), ["North", "South", "Still editable", "Away"]);
		await frame.locator("h1").filter({ hasText: "Still editable" }).waitFor();

		await page.locator("[data-wc-side-panel-back]").click();
		await page.locator("[data-wc-sections-list]").waitFor();
		await expectAccessibleScreen(page, "Sections list, light");
		await page.emulateMedia({ colorScheme: "dark" });
		await expectAccessibleScreen(page, "Sections list, dark");
		await page.emulateMedia({ colorScheme: "light" });
		await closeSections(page);
	});

	test("a section chosen on the page: its name and bar, hide and Preview, settings, Remove with Undo, ⌘Z", async () => {
		const entryId = await makePage("Bar", "bar", [hero("north", "North"), hero("south", "South")]);
		const frame = await open(page, "/bar");
		// By its edge: a click on the section's own part (not on its words) chooses it as a whole.
		const north = frame.locator('[data-wc-page-placement="north"]').first();
		await chooseSection(frame, "north");
		const mark = page.locator('[data-wc-section-mark="selected"]');
		await mark.waitFor();
		const drawn = await mark.boundingBox();
		const section = await north.boundingBox();
		if (!drawn || !section) throw new Error("No section outline.");
		expect(Math.abs(drawn.x - section.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(drawn.y - section.y)).toBeLessThanOrEqual(1);
		expect(Math.abs(drawn.width - section.width)).toBeLessThanOrEqual(1);
		expect(await mark.locator("[data-wc-section-chip]").textContent()).toBe("Hero· section");
		const bar = page.getByRole("toolbar", { name: "Hero · North: section tools" });
		expect(
			await bar.getByRole("button").evaluateAll((buttons) => buttons.map((b) => b.getAttribute("aria-label"))),
		).toEqual(["Move up", "Move down", "Hide", "Settings", "Remove"]);
		const barBox = await bar.boundingBox();
		if (!barBox) throw new Error("No bar.");
		// Inside the section's top edge, on its right.
		expect(barBox.y).toBeGreaterThan(section.y);
		expect(barBox.x + barBox.width).toBeLessThanOrEqual(section.x + section.width);
		expect(await bar.getByRole("button", { name: "Move up" }).getAttribute("aria-disabled")).toBe("true");
		await expectNoAxeViolations(page, "a section's bar, light");

		// Move down, by the bar.
		await bar.getByRole("button", { name: "Move down" }).click();
		await firstIs(frame, "South");
		await saved(headings(entryId), ["South", "North"]);
		// ⌘Z takes it back; ⇧⌘Z does it again.
		await page.locator('[data-wc-bar="undo"]').focus();
		await page.keyboard.press("ControlOrMeta+z");
		await firstIs(frame, "North");
		await saved(headings(entryId), ["North", "South"]);
		await page.keyboard.press("ControlOrMeta+Shift+z");
		await firstIs(frame, "South");

		// Hide: faded, and gone in Preview.
		await chooseSection(frame, "north");
		await page
			.getByRole("toolbar", { name: "Hero · North: section tools" })
			.getByRole("button", { name: "Hide" })
			.click();
		await saved(async () => (await layoutOf(entryId)).layout.placements.map((p) => !!p.hidden), [false, true]);
		await frame.locator('[data-wc-page-placement="north"][data-wc-hidden-placement="true"]').first().waitFor();
		await page.locator('[data-wc-segment="preview"]').click();
		await page.waitForFunction(
			() =>
				getComputedStyle(
					(document.querySelector("iframe[data-wc-frame]") as HTMLIFrameElement).contentDocument?.querySelector(
						'[data-wc-page-placement="north"]',
					) as Element,
				).display === "none",
		);
		expect(await page.locator("[data-wc-section-mark]").count()).toBe(0);
		expect(await frame.locator('[data-wc-placement-prop][contenteditable="true"]').count()).toBe(0);
		await page.locator('[data-wc-segment="edit"]').click();
		await frame.locator('[data-wc-placement-prop][contenteditable="true"]').first().waitFor();

		// Settings, from the bar: the side panel shows its Props.
		await chooseSection(frame, "north");
		await page
			.getByRole("toolbar", { name: "Hero · North: section tools" })
			.getByRole("button", { name: "Settings" })
			.click();
		const settings = page.locator('[data-wc-side-panel="sections"]');
		await settings.locator("[data-wc-section-settings]").waitFor();
		expect(await settings.locator("h2").textContent()).toBe("Hero · settings");
		const count = settings.getByLabel("Count", { exact: true });
		await count.fill("7");
		await count.press("Tab");
		await frame.locator('[data-wc-page-placement="north"] p').filter({ hasText: "7" }).waitFor();
		await saved(async () => (await layoutOf(entryId)).placements[1]?.values.count, 7);
		await expectAccessibleScreen(page, "a section's settings, light");
		await closeSections(page);

		// Remove asks nothing: the toast offers Undo.
		await chooseSection(frame, "south");
		await page
			.getByRole("toolbar", { name: "Hero · South: section tools" })
			.getByRole("button", { name: "Remove" })
			.click();
		const toast = page.locator("[data-wc-section-toast]");
		await toast.waitFor();
		expect(await toast.textContent()).toContain("Section removed");
		await saved(headings(entryId), ["North"]);
		await expectNoAxeViolations(page, "the removed toast");
		await toast.getByRole("button", { name: "Undo" }).click();
		await saved(headings(entryId), ["South", "North"]);
		await firstIs(frame, "South");
		await toast.waitFor({ state: "detached" });

		await page.emulateMedia({ colorScheme: "dark" });
		await chooseSection(frame, "south");
		await page.locator('[data-wc-section-mark="selected"]').waitFor();
		await expectNoAxeViolations(page, "a section's bar, dark");
		await page.emulateMedia({ colorScheme: "light" });
	});

	test("+ Add section between two sections, and the picker: Allowed only, groups, search, where it lands", async () => {
		const entryId = await makePage("Add", "add", [hero("north", "North"), hero("south", "South")]);
		const frame = await open(page, "/add");
		// Near the boundary between North and South, a line offers "+ Add section".
		const south = await frame.locator('[data-wc-page-placement="south"]').first().boundingBox();
		if (!south) throw new Error("No South.");
		// Away from the middle, where the line's button comes.
		await page.mouse.move(south.x + 40, south.y + 4);
		const line = page.locator("[data-wc-add-section-line]");
		await line.waitFor();
		const add = line.getByRole("button", { name: "Add section: After Hero · North" });
		await add.click();
		const panel = page.locator('[data-wc-side-panel="sections"]');
		await panel.locator("[data-wc-section-picker]").waitFor();
		expect(await panel.locator("h2").textContent()).toBe("Add a section");
		expect(await panel.locator("header p").textContent()).toBe("After Hero · North");
		// Only what the agency allowed, in groups.
		const cards = panel.locator("[data-wc-section-card]");
		expect(await cards.allTextContents()).toEqual([
			"HeroHeading, Count",
			"QuoteQuote",
			"CardsGroup, Rows",
			"BannerButton",
		]);
		expect(await panel.locator("h3").allTextContents()).toEqual(["Words", "Lists", "Calls to action"]);
		expect(await panel.getByRole("button", { name: /^Unavailable/ }).count()).toBe(0);
		// Search.
		await panel.getByRole("searchbox", { name: "Search sections" }).fill("quo");
		expect(await cards.count()).toBe(1);
		// Pointing at a card shows where it lands: after North.
		await cards.first().hover();
		const landing = frame.locator("[data-wc-section-landing]");
		await landing.waitFor();
		expect(await landing.textContent()).toBe("Quote · will be added here");
		expect(
			await landing.evaluate(
				(element) =>
					element.previousElementSibling?.getAttribute("data-wc-page-placement") === "north" &&
					element.nextElementSibling?.getAttribute("data-wc-page-placement") === "south",
			),
		).toBe(true);
		await expectNoAxeViolations(page, "the picker, light");
		// A click adds it there with its sample words, chosen and in view.
		await cards.first().click();
		await saved(
			async () => (await layoutOf(entryId)).placements.map((p) => p.componentName),
			["Hero", "Quote", "Hero"],
		);
		await frame.locator("blockquote").filter({ hasText: "Best bread in Cork." }).waitFor();
		expect(await landing.count()).toBe(0);
		await page
			.locator('[data-wc-section-mark="selected"] [data-wc-section-chip]')
			.filter({ hasText: "Quote" })
			.waitFor();
		await page.locator("[data-wc-sections-list]").waitFor();
		expect(
			await page
				.getByRole("treeitem", { name: /^Quote/ })
				.evaluate((row) => row.getAttribute("aria-selected") === "true" && row === document.activeElement),
		).toBe(true);

		// By the keyboard: the panel's Add section adds after the chosen row.
		await page.locator("[data-wc-sections-add]").focus();
		await page.keyboard.press("Enter");
		await panel.getByRole("searchbox", { name: "Search sections" }).waitFor();
		expect(await panel.locator("header p").textContent()).toBe("After Quote · Best bread in Cork.");
		await page.emulateMedia({ colorScheme: "dark" });
		await expectAccessibleScreen(page, "the picker, dark");
		await page.emulateMedia({ colorScheme: "light" });
		await panel.getByRole("searchbox", { name: "Search sections" }).focus();
		await page.keyboard.press("Tab");
		await page.keyboard.press("Enter");
		await saved(
			async () => (await layoutOf(entryId)).placements.map((p) => p.componentName),
			["Hero", "Quote", "Hero", "Hero"],
		);
		await closeSections(page);
	});

	test("text typed in place on a section, and peers' changes keep the person's typing and focus", async () => {
		const entryId = await makePage("Peers", "peers", [hero("hero", "Welcome to Cork")]);
		const frame = await open(page, "/peers");
		const theirs = await open(peer, "/peers");
		// Typed in place: marked like any other area, named by its Prop.
		const inline = frame.locator('[data-wc-placement-prop="heading"]');
		const area = await inline.boundingBox();
		if (!area) throw new Error("No heading.");
		await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
		await page.locator('[data-wc-client-chip="hover"]').filter({ hasText: "Heading" }).waitFor();
		await inline.click();
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.type("Inline Cork");
		await page.keyboard.press("Enter");
		await saved(headings(entryId), ["Inline Cork"]);
		await theirs.locator("h1").filter({ hasText: "Inline Cork" }).waitFor();

		// Both open its settings; the peer's Count arrives while the person's Heading waits, focused.
		for (const each of [page, peer]) {
			await openSections(each);
			await each.getByRole("treeitem", { name: /^Hero/ }).click();
			await each.keyboard.press("Enter");
			await each.locator("[data-wc-section-settings]").waitFor();
		}
		const heading = page.locator("[data-wc-section-settings]").getByLabel("Heading", { exact: true });
		await heading.fill("Own pending words");
		const count = peer.locator("[data-wc-section-settings]").getByLabel("Count", { exact: true });
		await count.fill("9");
		await count.press("Tab");
		await page.waitForFunction(
			() =>
				(document.querySelector('[data-wc-section-settings] input[type="number"]') as HTMLInputElement)?.value === "9",
		);
		expect(await heading.inputValue()).toBe("Own pending words");
		expect(await heading.evaluate((input) => input === document.activeElement)).toBe(true);
		await heading.press("Tab");
		await theirs.locator("h1").filter({ hasText: "Own pending words" }).waitFor();
		await saved(async () => (await layoutOf(entryId)).placements[0]?.values, {
			heading: "Own pending words",
			count: 9,
		});
		await closeSections(page);
		await closeSections(peer);
	});

	test("Props of every kind: a Group and a Repeater keep peers' changes, a refused link shows what is saved", async () => {
		const entryId = await makePage("Kinds", "kinds", [
			{
				id: "cards",
				component: components.cards,
				values: {
					rows: {
						rows: [
							{ id: "north", values: { text: { en: "North" } } },
							{ id: "south", values: { text: { en: "South" } } },
						],
					},
				},
			},
			{ id: "banner", component: components.banner },
		]);
		await open(page, "/kinds");
		await open(peer, "/kinds");
		const settingsOf = async (each: Page, name: RegExp) => {
			if ((await each.locator("[data-wc-sections-list]").count()) === 0) await openSections(each);
			await each.getByRole("treeitem", { name }).click();
			await each.keyboard.press("Enter");
			await each.locator("[data-wc-section-settings]").waitFor();
			return each.locator("[data-wc-section-settings]");
		};
		const mine = await settingsOf(page, /^Cards/);
		const theirs = await settingsOf(peer, /^Cards/);
		// A Group: the person's First waits while the peer's Second arrives.
		await mine.getByLabel("First", { exact: true }).fill("Own first");
		await theirs.getByLabel("Second", { exact: true }).fill("Peer second");
		await theirs.getByLabel("Second", { exact: true }).press("Tab");
		await page.waitForFunction(() =>
			[...document.querySelectorAll<HTMLInputElement>("[data-wc-section-settings] input")].some(
				(input) => input.value === "Peer second",
			),
		);
		expect(await mine.getByLabel("First", { exact: true }).inputValue()).toBe("Own first");
		expect(await mine.getByLabel("First", { exact: true }).evaluate((input) => input === document.activeElement)).toBe(
			true,
		);
		await mine.getByLabel("First", { exact: true }).press("Tab");
		await saved(async () => (await layoutOf(entryId)).placements[0]?.values.group, {
			first: "Own first",
			second: "Peer second",
		});

		// A Repeater: the person types in South while the peer removes North.
		const southText = mine.getByRole("group", { name: "Row 2" }).getByLabel("Text", { exact: true });
		await southText.focus();
		await southText.press("End");
		await page.keyboard.type("a");
		await theirs.getByRole("button", { name: "Actions for row 1" }).click();
		await peer.getByRole("menuitem", { name: "Remove row" }).click();
		await page.waitForFunction(
			() => document.querySelectorAll("[data-wc-section-settings] [data-wc-section-row-of]").length === 1,
		);
		const kept = mine.getByRole("group", { name: "Row 1" }).getByLabel("Text", { exact: true });
		expect(await kept.inputValue()).toBe("Southa");
		expect(await kept.evaluate((input) => input === document.activeElement)).toBe(true);
		await page.keyboard.type("b");
		await kept.press("Tab");
		await saved(async () => (await layoutOf(entryId)).placements[0]?.values.rows, [{ id: "south", text: "Southab" }]);
		// Add to Rows.
		await mine.getByRole("button", { name: "Add to Rows" }).click();
		await saved(async () => ((await layoutOf(entryId)).placements[0]?.values.rows as unknown[] | undefined)?.length, 2);

		// A link that may not be saved: refused, said, and the saved value shows again.
		await page.locator("[data-wc-side-panel-back]").click();
		const banner = await settingsOf(page, /^Banner/);
		const address = banner.getByLabel("Address", { exact: true });
		expect(await address.inputValue()).toBe("https://example.com/old");
		await address.fill("javascript:alert(1)");
		await banner.getByLabel("Words", { exact: true }).focus();
		await said(page, "Someone changed this at the same moment, or it can't be saved as it is.");
		await page.waitForFunction(
			() =>
				(document.querySelector('[data-wc-section-link="cta"] input[inputmode="url"]') as HTMLInputElement)?.value ===
				"https://example.com/old",
		);
		await address.fill("https://example.com/new");
		await address.press("Tab");
		await saved(async () => (await layoutOf(entryId)).placements[1]?.values.cta, {
			url: "https://example.com/new",
			text: "Old",
		});
		await closeSections(page);
		await closeSections(peer);
	});

	test("a section removed by someone else while its settings are typed in isn't brought back", async () => {
		const entryId = await makePage("Gone", "gone", [hero("gone", "Gone soon"), hero("stays", "Stays")]);
		await open(page, "/gone");
		await open(peer, "/gone");
		await openSections(page);
		await page.getByRole("treeitem", { name: /Gone soon/ }).click();
		await page.keyboard.press("Enter");
		await page.locator("[data-wc-section-settings]").getByLabel("Heading", { exact: true }).fill("Orphaned input");
		await openSections(peer);
		await peer.getByRole("treeitem", { name: /Gone soon/ }).click();
		await peer.keyboard.press("Delete");
		await saved(headings(entryId), ["Stays"]);
		// The person's list shows what is there now; their input isn't saved.
		await page.locator("[data-wc-sections-list]").waitFor();
		await said(page, "Someone changed this at the same moment");
		await saved(headings(entryId), ["Stays"]);
		await closeSections(page);
		await closeSections(peer);
	});

	test("what Staff switch: no Sections where Members may not arrange, only Allowed components to add", async () => {
		await makePage("Switches", "switches", [hero("hero", "Switch me")]);
		await api.pageLayouts.configure({ siteId, enabled: false });
		try {
			const frame = await page.goto(install.siteUrl(slug, "/_webcraft/build/page/switches")).then(() => frameOf(page));
			await frame.locator('[data-wc-page-placement="hero"]').first().waitFor();
			await page.locator("[data-wc-bar=page-details]").waitFor();
			await settled(page);
			expect(await page.locator('[data-wc-bar="sections"]').count()).toBe(0);
			// Nothing of a section is drawn, and its text isn't editable.
			await chooseSection(frame, "hero");
			await settled(page);
			expect(await page.locator("[data-wc-section-mark]").count()).toBe(0);
			expect(await frame.locator('[data-wc-placement-prop][contenteditable="true"]').count()).toBe(0);
		} finally {
			await api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [components.quote.id] });
		}
		try {
			await open(page, "/switches");
			await openSections(page);
			// Hero is no longer Allowed: its section stays and changes, but no copy of it is made.
			await page.getByRole("treeitem", { name: /^Hero/ }).click();
			await page
				.getByRole("treeitem", { name: /^Hero/ })
				.getByRole("button", { name: /^More for/ })
				.click();
			expect(await page.getByRole("menuitem", { name: "Duplicate" }).getAttribute("aria-disabled")).toBe("true");
			await page.keyboard.press("Escape");
			await page.locator("[data-wc-sections-add]").click();
			expect(await page.locator("[data-wc-section-card]").allTextContents()).toEqual(["QuoteQuote"]);
			await closeSections(page);
		} finally {
			await api.pageLayouts.configure({
				siteId,
				enabled: true,
				allowedComponents: [components.hero.id, components.quote.id, components.banner.id, components.cards.id],
			});
		}
		expect(await announced(page)).not.toContain("went wrong");
	});

	// ── BA-35: the Props' remaining cases of `page-layout-props.browser.ts` and `page-layouts.browser.ts` ──

	/** Opens a section's settings in the Sections panel, from its row. */
	const settingsOf = async (each: Page, name: RegExp) => {
		if ((await each.locator("[data-wc-sections-list]").count()) === 0) {
			if ((await each.locator("[data-wc-section-settings]").count()) > 0)
				await each.locator("[data-wc-side-panel-back]").click();
			else await openSections(each);
			await each.locator("[data-wc-sections-list]").waitFor();
		}
		await each.getByRole("treeitem", { name }).click();
		await each.keyboard.press("Enter");
		await each.locator("[data-wc-section-settings]").waitFor();
		return each.locator("[data-wc-section-settings]");
	};
	const isFocused = (locator: ReturnType<Page["locator"]>) =>
		locator.evaluate((input) => input === document.activeElement);

	test("a Prop typed in while someone moves its section keeps what was typed, and focus", async () => {
		const entryId = await makePage("Moved", "moved", [hero("hero", "First words"), hero("other", "Second words")]);
		const frame = await open(page, "/moved");
		await open(peer, "/moved");
		const mine = (await settingsOf(page, /Second words/)).getByLabel("Heading", { exact: true });
		await mine.fill("Own moved input");
		expect(await isFocused(mine)).toBe(true);
		// The peer moves the first section down: the person's section is now first.
		await openSections(peer);
		await peer.getByRole("treeitem", { name: /First words/ }).click();
		await peer.keyboard.press("Alt+ArrowDown");
		await saved(async () => (await layoutOf(entryId)).placements.map((placement) => placement.id), ["other", "hero"]);
		await frame.waitForFunction(
			() => document.querySelector("main [data-wc-page-placement]")?.getAttribute("data-wc-page-placement") === "other",
			undefined,
			{ timeout: 8000 },
		);
		expect(await mine.inputValue()).toBe("Own moved input");
		expect(await isFocused(mine)).toBe(true);
		await mine.press("Tab");
		await saved(headings(entryId), ["Own moved input", "First words"]);
		await closeSections(page);
		await closeSections(peer);
	});

	test("two people typing in one Prop: what each typed at either end is kept", async () => {
		const entryId = await makePage("Merge", "merge", [hero("hero", "Middle")]);
		await open(page, "/merge");
		await open(peer, "/merge");
		const mine = (await settingsOf(page, /Middle/)).getByLabel("Heading", { exact: true });
		const theirs = (await settingsOf(peer, /Middle/)).getByLabel("Heading", { exact: true });
		await mine.fill("Start Middle");
		await theirs.fill("Middle End");
		await theirs.press("Tab");
		await page.waitForFunction(
			() =>
				[...document.querySelectorAll<HTMLInputElement>("[data-wc-section-settings] input")].some(
					(input) => input.value === "Start Middle End",
				),
			undefined,
			{ timeout: 8000 },
		);
		expect(await isFocused(mine)).toBe(true);
		await mine.press("Tab");
		await saved(headings(entryId), ["Start Middle End"]);
		await closeSections(page);
		await closeSections(peer);
	});

	test("a Prop typed in while Staff replace its declaration isn't saved into the new one, which is kept, and the person is told", async () => {
		const { component } = await api.components.create({
			siteId,
			name: "Notice",
			props: [{ key: "first", label: "First", type: "text", default: "Baseline" }],
		});
		await api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: "<section><h2>{{ props.first }}</h2></section>",
		});
		await api.components.publish({ siteId, componentId: component.id });
		const notice = (await api.components.get({ siteId, componentId: component.id })).component;
		const entryId = await makePage("Replaced", "replaced", [{ id: "notice", component: notice }]);
		const frame = await open(page, "/replaced");
		const first = (await settingsOf(page, /^Notice/)).getByLabel("First", { exact: true });
		await first.fill("Old declaration input");
		// Staff declare `first` again, as a new Prop with the same key.
		const replacement = crypto.randomUUID();
		await api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: `{{@props}}\nfirst: text id="${replacement}" default="Replacement"\n{{/props}}\n<section><h2>{{ props.first }}</h2></section>`,
		});
		await api.components.publish({ siteId, componentId: component.id });
		await frame.locator("main h2").filter({ hasText: "Replacement" }).waitFor({ timeout: 10_000 });
		await closeSections(page);
		// The person is told that what they typed wasn't kept, in words.
		await said(page, "What you typed wasn't kept: someone changed this section's settings at the same moment.");
		// What was typed for the old declaration isn't saved into the new one; the new one is kept.
		const placement = (await layoutOf(entryId)).placements[0];
		expect(placement?.props[0]?.id).toBe(replacement);
		expect(JSON.stringify(placement?.values ?? {})).not.toContain("Old declaration input");
		await frame.locator("main h2").filter({ hasText: "Replacement" }).waitFor();
	});

	test("empty Props take keystrokes one after another before they are left", async () => {
		const { component } = await api.components.create({
			siteId,
			name: "Blank",
			props: [
				{ key: "first", label: "First", type: "text" },
				{ key: "group", label: "Group", type: "group", fields: [{ key: "second", label: "Second", type: "text" }] },
			],
		});
		await api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: "<section><p>A card to fill in</p><h2>{{ props.first }}</h2></section>",
		});
		await api.components.publish({ siteId, componentId: component.id });
		const blank = (await api.components.get({ siteId, componentId: component.id })).component;
		const entryId = await makePage("Blank", "blank", [{ id: "blank", component: blank }]);
		await open(page, "/blank");
		const settings = await settingsOf(page, /^Blank/);
		await settings.getByLabel("First", { exact: true }).focus();
		await page.keyboard.type("ab");
		await settings.getByLabel("First", { exact: true }).press("Tab");
		await settings.getByLabel("Second", { exact: true }).focus();
		await page.keyboard.type("cd");
		await settings.getByLabel("Second", { exact: true }).press("Tab");
		await saved(async () => (await layoutOf(entryId)).placements[0]?.values, { first: "ab", group: { second: "cd" } });
		await closeSections(page);
	});

	for (const peerAction of ["remove", "move"] as const) {
		test(`typing on in a Repeater's row past a peer's ${peerAction} and then another removal keeps the row and its words`, async () => {
			const entryId = await makePage(`Rows ${peerAction}`, `rows-${peerAction}`, [
				{
					id: "cards",
					component: components.cards,
					values: {
						rows: {
							rows: ["North", "Middle", "South"].map((text) => ({
								id: text.toLowerCase(),
								values: { text: { en: text } },
							})),
						},
					},
				},
			]);
			await open(page, `/rows-${peerAction}`);
			await open(peer, `/rows-${peerAction}`);
			const mine = await settingsOf(page, /^Cards/);
			const theirs = await settingsOf(peer, /^Cards/);
			const rowTexts = () =>
				page.evaluate(() =>
					[
						...document.querySelectorAll<HTMLInputElement>("[data-wc-section-settings] [data-wc-section-row-of] input"),
					].map((input) => input.value),
				);
			const last = mine.locator("[data-wc-section-row-of] input").last();
			await last.focus();
			await last.press("End");
			await page.keyboard.type("a");
			await theirs.getByRole("button", { name: "Actions for row 1" }).click();
			await peer.getByRole("menuitem", { name: peerAction === "remove" ? "Remove row" : "Move down" }).click();
			const afterFirst = peerAction === "remove" ? ["Middle", "Southa"] : ["Middle", "North", "Southa"];
			for (let attempt = 0; attempt < 80 && JSON.stringify(await rowTexts()) !== JSON.stringify(afterFirst); attempt++)
				await page.waitForTimeout(100);
			expect(await rowTexts()).toEqual(afterFirst);
			expect(await isFocused(mine.locator("[data-wc-section-row-of] input").last())).toBe(true);
			await page.keyboard.type("b");
			await theirs.getByRole("button", { name: `Actions for row ${peerAction === "remove" ? 1 : 2}` }).click();
			await peer.getByRole("menuitem", { name: "Remove row" }).click();
			const afterSecond = peerAction === "remove" ? ["Southab"] : ["Middle", "Southab"];
			for (let attempt = 0; attempt < 80 && JSON.stringify(await rowTexts()) !== JSON.stringify(afterSecond); attempt++)
				await page.waitForTimeout(100);
			expect(await rowTexts()).toEqual(afterSecond);
			await mine.locator("[data-wc-section-row-of] input").last().press("Tab");
			await saved(
				async () => (await layoutOf(entryId)).placements[0]?.values.rows,
				[...(peerAction === "remove" ? [] : [{ id: "middle", text: "Middle" }]), { id: "south", text: "Southab" }],
			);
			await closeSections(page);
			await closeSections(peer);
		});
	}

	test("a Prop's save says nothing; a row's own eye hides its section and keeps the chosen one", async () => {
		const entryId = await makePage("Quiet", "quiet", [hero("north", "North"), hero("south", "South")]);
		const frame = await open(page, "/quiet");
		const heading = (await settingsOf(page, /Hero · North/)).getByLabel("Heading", { exact: true });
		await heading.focus();
		const messages = page.locator("[data-wc-messages]");
		const before = await messages.textContent();
		await heading.fill("Quietly saved");
		await heading.press("Tab");
		await frame.locator("main h1").filter({ hasText: "Quietly saved" }).waitFor();
		await saved(headings(entryId), ["Quietly saved", "South"]);
		expect(await messages.textContent()).toBe(before);

		// Back to the list, North chosen: South's own eye hides South, and North stays chosen.
		await page.locator("[data-wc-side-panel-back]").click();
		const north = page.getByRole("treeitem", { name: /Quietly saved/ });
		const south = page.getByRole("treeitem", { name: /Hero · South/ });
		await north.click();
		expect(await north.getAttribute("aria-selected")).toBe("true");
		await south.hover();
		await south.getByRole("button", { name: "Hide Hero · South", exact: true }).click();
		await saved(
			async () => (await layoutOf(entryId)).placements.map((placement) => Boolean(placement.hidden)),
			[false, true],
		);
		expect(await north.getAttribute("aria-selected")).toBe("true");
		expect(await south.getAttribute("aria-selected")).toBe("false");
		await south.getByRole("button", { name: "Show Hero · South", exact: true }).waitFor({ state: "attached" });
		// An action is said, as the drawer's were.
		await said(page, "Hide or show Hero · South");
		await closeSections(page);
	});
});
