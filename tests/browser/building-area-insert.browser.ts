// Inserting and the Command menu in the building area (BA-10; SPEC 2, 6 and 13.9, `builder/04`, `06`,
// `09`, `docking/07`), for Staff, in Chromium:
// - the insert row's one rule: inside the selection when it can hold the new element (the parent stays
//   selected), else after it (the new element is selected); ⌘ forces after; Section goes after the
//   top-level element the selection is in, with its container selected; the landing line shows on the
//   canvas and in the tree; a new empty element is a 35 px dashed box; one Undo takes an insert back;
// - on a Page, Section makes "Section1", places it and edits it in place (four clicks to a Heading in
//   it); the empty Page offers Add a Component and New section; with nothing selected on a Page the
//   insert targets the Page, never the Site template (audit finding 7);
// - the Command menu's three tabs and their keys (from the shell and from the page), Tab and the arrows
//   between tabs, Recent, focus going back, and Italian;
// - the tree row's menu: Copy, Paste, Wrap in, Make Component, from a right-click and Shift+F10;
// - the shell with the menu open and with the empty Page passes the accessibility checks.
// The building area's own test of `command-menu`, `edit-command-menu` (Staff), `components-from-code`
// (Make Component, New Component) and the insert cases of `builder`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Locator, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { announced, enterBuildingArea, eventually, frameOf, settled } from "./building-area.ts";
import { expectKeyboardUsable, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let italian: TestAccount;
let member: TestAccount;
let siteId: string;
let postTypeId: string;
let heroId: string;
let homeId: string;
const slug = "bakery";
const post = "/blog/our-sourdough-starter-explained";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).account;
	italian = (await local.createStaff({ workspaces: [workspaceId], name: "Giulia Romano" })).account;
	member = (await local.createMember({ workspaceId, role: "editor", name: "Aoife Murphy" })).account;
	await (await local.signIn(italian)).api.me.updatePreferences({ adminLanguage: "it" });

	for (const name of ["site-header", "page", "hero", "card", "card__title", "more", "container"])
		await api.designSystem.createClass({ siteId, name, styles: "" });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header class="site-header"><p>Acme Bakery</p></header><main class="page">{{@outlet}}</main><footer><p>Harbour Street</p></footer>',
	});
	await api.templates.publish({ siteId, templateId: site.template.id });

	const { component: hero } = await api.components.create({
		siteId,
		name: "HeroSplit",
		props: [{ key: "headline", label: "Headline", type: "text" }] as never,
	});
	await api.components.saveMarkup({
		siteId,
		componentId: hero.id,
		markup: '<section class="hero"><h1>{{ props.headline }}</h1></section>',
	});
	await api.components.publish({ siteId, componentId: hero.id });
	heroId = hero.id;
	const heroProps = (await api.components.get({ siteId, componentId: hero.id })).component.draft.props;

	const pagesId = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id ?? "";
	for (const [title, pageSlug] of [
		["Home", "home"],
		["Spring offers", "spring-offers"],
		["Visit us", "visit-us"],
	] as const) {
		const { entry } = await api.entries.create({ siteId, postTypeId: pagesId, title, slug: pageSlug });
		if (pageSlug === "home") {
			homeId = entry.id;
			const state = await api.pageLayouts.get({ siteId, entryId: entry.id });
			await api.pageLayouts.save({
				siteId,
				entryId: entry.id,
				basedOn: state.version,
				layout: {
					placements: [
						{ id: "hero", component: hero.id, props: heroProps, values: { headline: { en: "Fresh every morning" } } },
					],
				},
			});
		}
		await api.entries.publish({ siteId, entryId: entry.id });
	}

	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		key: "post",
		urlPattern: "/blog/{slug}",
	});
	postTypeId = postType.id;
	const { entry } = await api.entries.create({ siteId, postTypeId, title: "Our sourdough starter, explained" });
	await api.entries.publish({ siteId, entryId: entry.id });
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup:
			'<section class="hero"><div class="card"><h2 class="card__title">{{ title }}</h2></div></section><section class="more"><p>Read on</p></section>',
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
});

let sharedPage: Promise<Page> | undefined;

/** The one page in the building area the checks share (entering is rate-limited), at 1440 × 900. */
function shared(): Promise<Page> {
	sharedPage ??= (async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: `/page${post}` });
		await settled(page);
		await tree(page)
			.getByRole("treeitem", { name: /section \.hero/ })
			.waitFor();
		return page;
	})();
	return sharedPage;
}

/** Opens a page of the Site in the shell (as the address does), and waits for its tree to show `row`. */
async function openPage(page: Page, path: string, row: RegExp): Promise<void> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build/page${path}`));
	await frameOf(page);
	await settled(page);
	await tree(page).getByRole("treeitem", { name: row }).first().waitFor();
}

afterAll(async () => {
	await (await sharedPage)
		?.context()
		.close()
		.catch(() => {});
	await install?.close();
});

const tree = (page: Page) => page.getByRole("tree", { name: "Elements of the page" });
const insertButton = (page: Page, kind: string) => page.locator(`[data-wc-insert="${kind}"]`);
const selectedIn = (page: Page) => new URL(page.url()).searchParams.get("wc-select");
const menu = (page: Page) => page.locator("dialog[data-wc-command-menu]");
/** Markup without its whitespace between tags and its element ids. */
const flat = (markup: string) =>
	markup
		.replace(/ data-wc-id="[^"]*"/g, "")
		.replace(/>\s+</g, "><")
		.replace(/\s+/g, " ");

/** Waits until a locator's attribute is `value` (or matches it), then expects it. */
async function holds(locator: Locator, name: string, value: string | RegExp): Promise<void> {
	const fits = (got: string | null) => got !== null && (typeof value === "string" ? got === value : value.test(got));
	const read = () => locator.getAttribute(name, { timeout: 10_000 }).catch(() => null);
	// Never there: what it reads now, with a screenshot, says more than the wait's own failure.
	const got = await eventually(read, fits).catch(read);
	if (!fits(got))
		await locator
			.page()
			.screenshot({ path: `${process.env.BA10_SHOTS ?? "/tmp"}/holds-${name}.png` })
			.catch(() => {});
	expect(fits(got) ? "fits" : `${name}=${got}`).toBe("fits");
}

/** Waits until a locator's text holds `text` (or matches it), then expects it. */
async function says(locator: Locator, text: string | RegExp): Promise<void> {
	const fits = (got: string) => (typeof text === "string" ? got.includes(text) : text.test(got));
	const got = await eventually(async () => (await locator.textContent()) ?? "", fits);
	expect(fits(got) ? "fits" : got).toBe("fits");
}

/** Waits until focus is on a locator's element, then expects it. */
async function focused(locator: Locator): Promise<void> {
	const got = await eventually(
		() => locator.evaluate((element) => element === document.activeElement).catch(() => false),
		(value) => value,
	).catch(() => false);
	const active = got ? "" : await locator.page().evaluate(() => document.activeElement?.outerHTML.slice(0, 200) ?? "");
	expect({ focused: got, active }).toEqual({ focused: true, active: "" });
}

/** The Entry template's Draft markup, its whitespace between tags left out. */
async function entryMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return flat((await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "");
}

/** Selects the card's title: the card's row, opened with the arrow key, then the title's row. */
async function selectTitle(page: Page): Promise<string> {
	await selectRow(page, /^div \.card/);
	await tree(page).getByRole("treeitem", { selected: true }).press("ArrowRight");
	return selectRow(page, /card__title/);
}

/** Selects a row of the tree by its name, as a click does, and waits for the address to say so. */
async function selectRow(page: Page, name: RegExp): Promise<string> {
	const row = tree(page).getByRole("treeitem", { name }).first();
	await row.click();
	await eventually(
		async () => row.getAttribute("aria-selected"),
		(value) => value === "true",
	);
	return (await row.getAttribute("data-wc-ref")) ?? "";
}

describe("the insert row on a Template's elements", () => {
	test("inside when the selection can hold it, after when it can't, ⌘ forces after, Section at the top level", async () => {
		const page = await shared();
		await openPage(page, post, /section \.hero/);
		// A click on the title in the page selects it, and the tree opens towards it.
		await (await frameOf(page)).locator("h2.card__title").click();
		await tree(page)
			.getByRole("treeitem", { name: /card__title/ })
			.waitFor();

		// The row: 28 × 28 buttons, 8 apart, in the bar's middle; the tinted kinds after the elements.
		const section = await insertButton(page, "section").boundingBox();
		const container = await insertButton(page, "container").boundingBox();
		expect(section?.width).toBe(28);
		expect(section?.height).toBe(28);
		expect(Math.round((container?.x ?? 0) - (section?.x ?? 0) - 28)).toBe(8);
		expect(
			await page
				.locator("[data-wc-insert]")
				.evaluateAll((all) => all.map((each) => each.getAttribute("data-wc-insert"))),
		).toEqual([
			"section",
			"container",
			"div",
			"heading",
			"text",
			"link",
			"image",
			"video",
			"icon",
			"list",
			"loop",
			"condition",
			"component",
			"more",
		]);

		// A div.card can hold a heading: it lands inside, and the div stays selected.
		const card = await selectRow(page, /^div \.card/);
		await insertButton(page, "heading").hover();
		await page.locator('[data-wc-insert-line="canvas"]').waitFor();
		await page.locator('[data-wc-insert-line="tree"]').waitFor();
		await insertButton(page, "heading").click();
		const inside = await eventually(entryMarkup, (text) => text.includes("<h2>Heading</h2>"));
		expect(inside).toContain('<div class="card"><h2 class="card__title">{{ title }}</h2><h2>Heading</h2></div>');
		expect(selectedIn(page)).toBe(card);

		// An h2 can't hold a paragraph: Text lands after it and is selected.
		const title = await selectTitle(page);
		await insertButton(page, "text").click();
		const after = await eventually(entryMarkup, (text) => text.includes("<p>Write something here.</p>"));
		expect(after).toContain('<h2 class="card__title">{{ title }}</h2><p>Write something here.</p>');
		await eventually(
			async () => selectedIn(page),
			(ref) => ref !== title,
		);
		expect(selectedIn(page)).not.toBe(title);
		await holds(tree(page).getByRole("treeitem", { selected: true }), "aria-label", /^p\b/);

		// ⌘ (Ctrl) held: a Div goes after the card, though the card could hold it. Empty, it is a 35 px dashed box.
		await selectTitle(page);
		await selectRow(page, /^div \.card/);
		await insertButton(page, "div").click({ modifiers: ["ControlOrMeta"] });
		const forced = await eventually(entryMarkup, (text) => text.includes("</div><div></div></section>"));
		expect(forced).toContain("</div><div></div></section>");
		const frame = await frameOf(page);
		const empty = await eventually(
			() =>
				frame.evaluate(() => {
					const element = document.querySelector<HTMLElement>("section.hero > div:empty");
					if (!element) return null;
					// The rules that set its outline or height (said if the check fails).
					const rules = [...document.styleSheets].flatMap((sheet) => {
						try {
							return [...sheet.cssRules]
								.filter(
									(rule) =>
										rule instanceof CSSStyleRule &&
										element.matches(rule.selectorText) &&
										/outline|block-size/.test(rule.cssText),
								)
								.map((rule) => rule.cssText.slice(0, 160));
						} catch {
							return [];
						}
					});
					return {
						height: element.getBoundingClientRect().height,
						outline: getComputedStyle(element).outlineStyle,
						rules,
					};
				}),
			(box) => (box?.height ?? 0) >= 35,
		);
		expect(empty?.height).toBeGreaterThanOrEqual(35);
		expect({ outline: empty?.outline, rules: empty?.rules }).toMatchObject({ outline: "dashed" });
		await page.locator("[data-wc-layers-slot]").first().waitFor();

		// Section: after the top-level section the selection is in, with its container selected.
		await selectTitle(page);
		await insertButton(page, "section").click();
		const sectioned = await eventually(entryMarkup, (text) =>
			text.includes('<section><div class="container"></div></section>'),
		);
		expect(sectioned).toMatch(/<\/section><section><div class="container"><\/div><\/section><section class="more">/);
		await holds(tree(page).getByRole("treeitem", { selected: true }), "aria-label", /^div \.container/);

		// One Undo takes the Section back.
		await page.locator('[data-wc-bar="undo"]').click();
		expect(await eventually(entryMarkup, (text) => !text.includes('class="container"'))).not.toContain(
			'class="container"',
		);
	});
});

describe("Section on a Page (D2) and the empty Page", () => {
	test("an empty Page offers both ways; New section makes Section1, places it and edits it in place", async () => {
		const page = await shared();
		await openPage(page, "/spring-offers", /footer/);
		const empty = page.locator("[data-wc-empty-page]");
		await empty.getByRole("heading", { name: "This Page is empty" }).waitFor();
		await empty.getByRole("button", { name: "Add a Component" }).waitFor();
		await says(page.locator("[data-wc-layers-slot]").first(), "Drop a Component here");
		// The Site's empty Page has no h1 of its own: nothing on it yet is the point of the state checked.
		await expectNoAxeViolations(page, "the empty Page", ["page-has-heading-one"]);
		await expectKeyboardUsable(page, "the empty Page");

		// Click one: New section. The Component is made, placed and edited in place, its container selected.
		await empty.getByRole("button", { name: "New section" }).click();
		await page.locator("[data-wc-done]").waitFor();
		await says(page.locator("[data-wc-in-place-title]"), "Section1");
		await eventually(
			async () => selectedIn(page) ?? "",
			(ref) => /^content\/[^#]+#/.test(ref),
		);
		await holds(tree(page).getByRole("treeitem", { selected: true }), "aria-label", /^div \.container/);
		// Click two: Heading lands inside the container.
		await insertButton(page, "heading").click();
		const { api } = await install.install.superadmin();
		const made = (await api.components.list({ siteId })).components.find((each) => each.name === "Section1");
		expect(made).toBeDefined();
		const markup = async () =>
			flat((await api.components.getMarkup({ siteId, componentId: made?.id ?? "" })).markup?.draft ?? "");
		expect(await eventually(markup, (text) => text.includes("<h2>Heading</h2>"))).toContain(
			'<section><div class="container"><h2>Heading</h2></div></section>',
		);
		await page.locator("[data-wc-done]").click();
		await page.locator("[data-wc-empty-page]").first().waitFor({ state: "detached" });
	});

	test("Section after a selected Placement, Add a Component from the empty Page, and nothing into the Site template", async () => {
		const page = await shared();
		const { api } = await install.install.superadmin();
		const siteMarkup = async () => (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "";
		const before = await siteMarkup();

		await openPage(page, "/home", /HeroSplit/);
		// Nothing selected on a Page: the insert targets the Page, which holds Components only.
		await page.keyboard.press("Escape");
		await insertButton(page, "heading").click();
		await eventually(
			() => announced(page),
			(text) => text.includes("A Page holds Components"),
		);
		expect(await announced(page)).toContain("A Page holds Components: add a Section or a Component first.");
		await Bun.sleep(500);
		expect(await siteMarkup()).toBe(before);
		expect(await siteMarkup()).not.toContain("Heading");

		// With HeroSplit selected, Section goes after it in the Page layout.
		await selectRow(page, /HeroSplit/);
		await insertButton(page, "section").click();
		await page.locator("[data-wc-done]").waitFor();
		const order = async () =>
			(await api.pageLayouts.get({ siteId, entryId: homeId })).placements.map((each) => each.componentName);
		const placed = await eventually(order, (names) => names.length === 2);
		expect(placed[0]).toBe("HeroSplit");
		expect(placed[1]).toMatch(/^Section\d+$/);
		await page.locator("[data-wc-done]").click();

		// The empty Page's Add a Component: Insert lists the Components only; one is placed.
		await openPage(page, "/visit-us", /footer/);
		await page.locator("[data-wc-empty-page]").getByRole("button", { name: "Add a Component" }).click();
		await menu(page).waitFor();
		const rows = menu(page).getByRole("option");
		await rows.first().waitFor();
		const names = await rows.evaluateAll((all) =>
			all.map((each) => each.querySelector("span + span")?.textContent ?? ""),
		);
		expect(names.join(" ")).toContain("HeroSplit");
		expect(names.join(" ")).not.toContain("Heading");
		await menu(page)
			.getByRole("option", { name: /^HeroSplit/ })
			.click();
		await tree(page)
			.getByRole("treeitem", { name: /HeroSplit/ })
			.waitFor();
		expect(heroId).toBeTruthy();
	});
});

describe("the Command menu", () => {
	test("three tabs and their keys, from the shell and from the page; Tab and the arrows; Recent; focus back", async () => {
		const page = await shared();
		await openPage(page, "/home", /HeroSplit/);
		const opener = page.locator('[data-wc-bar="undo"]');
		await page.locator('[data-wc-insert="section"]').focus();

		await page.keyboard.press("ControlOrMeta+k");
		await menu(page).waitFor();
		const tab = (name: string) => menu(page).getByRole("tab", { name: new RegExp(`^${name}`) });
		await holds(tab("Actions"), "aria-selected", "true");
		await focused(menu(page).getByRole("combobox"));
		// The menu's box, as `builder/09` draws it: 864 wide, 16 from the top, its tabs' row 48 high.
		const box = await menu(page).boundingBox();
		expect(Math.round(box?.width ?? 0)).toBe(864);
		expect(Math.round(box?.y ?? 0)).toBe(16);

		await page.keyboard.press("ControlOrMeta+p");
		await holds(tab("Go to"), "aria-selected", "true");
		await menu(page).getByRole("option", { name: /^Home/ }).waitFor();
		await page.keyboard.press("ControlOrMeta+i");
		await holds(tab("Insert"), "aria-selected", "true");
		await menu(page).getByRole("group", { name: "Sections" }).waitFor();
		expect(((await menu(page).locator("[data-wc-menu-where-text]").textContent()) ?? "").length).toBeGreaterThan(0);
		// Tab in the search box goes to the next tab (round to the first); a tab's own key closes the menu.
		await page.keyboard.press("Tab");
		await holds(tab("Actions"), "aria-selected", "true");
		await page.keyboard.press("Shift+Tab");
		await holds(tab("Insert"), "aria-selected", "true");
		// A modal dialog keeps Tab inside itself: the skip link is the page's, under it (axe only here).
		await expectNoAxeViolations(page, "the Command menu on Insert");
		await page.keyboard.press("ControlOrMeta+i");
		await menu(page).waitFor({ state: "hidden" });
		await focused(page.locator('[data-wc-insert="section"]'));

		// The arrows move along the tab list. Opening puts focus in the search box a frame later: wait for
		// it, so it can't take focus back from the tab list in the middle of the arrows.
		await page.keyboard.press("ControlOrMeta+k");
		await focused(menu(page).getByRole("combobox"));
		await tab("Actions").focus();
		await page.keyboard.press("ArrowRight");
		await holds(tab("Go to"), "aria-selected", "true");
		await focused(tab("Go to"));

		// An Action runs once the menu has closed, and shows under Recent the next time.
		await page.keyboard.press("ArrowLeft");
		await holds(tab("Actions"), "aria-selected", "true");
		await focused(tab("Actions"));
		await menu(page).getByRole("combobox").fill("hide the interface");
		const hide = menu(page).getByRole("option", { name: /^Hide the interface/ });
		await holds(hide, "aria-selected", "true");
		await says(hide, "Hide the interface, Editor");
		await page.keyboard.press("Enter");
		await holds(page.locator("[data-interface]"), "data-interface", "hidden");
		await page.keyboard.press("ControlOrMeta+k");
		await says(menu(page).getByRole("group", { name: "Recent" }), "Show the interface");
		await menu(page).getByRole("group", { name: "Recent" }).getByRole("option").first().click();
		await holds(page.locator("[data-interface]"), "data-interface", "shown");
		expect(await opener.count()).toBe(1);

		// ⌘K with focus in the page opens it too: the page's agent hands the key to the shell.
		const frame = await frameOf(page);
		await frame.locator("header p").click();
		await page.keyboard.press("ControlOrMeta+k");
		await menu(page).waitFor();
		await page.keyboard.press("Escape");
		await menu(page).waitFor({ state: "hidden" });
	});

	test("in Italian: the tabs, the rows and their keys in the person's Admin language", async () => {
		const page = await install.newPage("dark");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: italian, siteId, slug, open: "/page/home" });
		await page.getByRole("tree").getByRole("treeitem").first().waitFor();
		await page.keyboard.press("ControlOrMeta+k");
		await menu(page).waitFor();
		for (const name of ["Azioni", "Vai a", "Inserisci"])
			await menu(page)
				.getByRole("tab", { name: new RegExp(`^${name}`) })
				.waitFor();
		await says(menu(page).getByRole("option", { name: /^Annulla/ }), /Comando Z|Controllo Z/);
		await holds(menu(page).getByRole("combobox"), "placeholder", "Cerca un'azione…");
		await page.keyboard.press("ControlOrMeta+i");
		await menu(page).getByRole("group", { name: "Sezioni" }).waitFor();
		await expectNoAxeViolations(page, "the Command menu in Italian, dark");
		await page.context().close();
	});

	test("a Member gets the shorter menu: their Actions and Go to, no Insert", async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: member, siteId, slug, open: `/page${post}` });
		await page.locator("[data-wc-client]").waitFor();
		await page.keyboard.press("ControlOrMeta+k");
		await menu(page).waitFor();
		const tabs = await menu(page).getByRole("tab").allTextContents();
		expect(tabs.map((text) => text.replace(/[⌘⌃].*$|Ctrl.*$/, "").trim())).toEqual(["Actions", "Go to"]);
		await menu(page)
			.getByRole("option", { name: /^Preview/ })
			.waitFor();
		await menu(page)
			.getByRole("option", { name: /^Page details/ })
			.waitFor();
		expect(
			await menu(page)
				.getByRole("option", { name: /^New Component/ })
				.count(),
		).toBe(0);
		// The modal menu makes the shell and the page under it inert, out of the accessibility tree: their
		// main landmark and the page's h1 aren't counted while it is open.
		await expectNoAxeViolations(page, "a Member's Command menu", ["landmark-one-main", "page-has-heading-one"]);
		await page.keyboard.press("ControlOrMeta+p");
		await menu(page).getByRole("option", { name: /^Home/ }).waitFor();
		await page.keyboard.press("ControlOrMeta+k");
		await holds(menu(page).getByRole("tab", { name: /^Actions/ }), "aria-selected", "true");
		await menu(page).getByRole("combobox").fill("open media");
		await page.keyboard.press("Enter");
		await page.locator('[data-place="media"]').waitFor();
		await page.context().close();
	});
});

describe("the tree row's menu", () => {
	test("Copy and Paste, Wrap in, Make Component; from a right-click and Shift+F10", async () => {
		const page = await shared();
		await openPage(page, post, /section \.hero/);
		await (await frameOf(page)).locator("h2.card__title").first().click();
		const row = tree(page)
			.getByRole("treeitem", { name: /card__title/ })
			.first();
		await row.click({ button: "right" });
		const rowMenu = page.locator("[data-wc-row-menu]");
		await rowMenu.waitFor();
		// The items as a screen reader names them: the keys beside each are hidden from it, and differ by
		// platform (⌘C on a Mac, Ctrl+C elsewhere).
		const items = [...(await rowMenu.ariaSnapshot()).matchAll(/- menuitem "([^"]+)"/g)].map((match) => match[1]);
		expect(items).toEqual(["Copy", "Duplicate", "Wrap in", "Make Component", "Delete"]);
		await focused(rowMenu.getByRole("menuitem").first());
		await page.keyboard.press("Enter");
		await rowMenu.first().waitFor({ state: "detached" });
		await focused(row);

		// Shift+F10 opens it under the row; Paste is there now.
		await page.keyboard.press("Shift+F10");
		await rowMenu.waitFor();
		await rowMenu.getByRole("menuitem", { name: /Paste/ }).click();
		const titles = (text: string) => (text.match(/class="card__title"/g) ?? []).length;
		expect(titles(await eventually(entryMarkup, (text) => titles(text) === 2))).toBe(2);

		// Wrap in › a Div.
		await row.click({ button: "right" });
		await rowMenu.getByRole("menuitem", { name: /Wrap in/ }).press("ArrowRight");
		await rowMenu.getByRole("menuitem", { name: "a Div" }).click();
		expect(await eventually(entryMarkup, (text) => /<div><h2 class="card__title">/.test(text))).toMatch(
			/<div><h2 class="card__title">/,
		);

		// Make Component asks a name and places the new Component where the element was.
		await selectTitle(page);
		await tree(page).getByRole("treeitem", { selected: true }).click({ button: "right" });
		await rowMenu.getByRole("menuitem", { name: /Make Component/ }).click();
		const dialog = page.locator("dialog[data-wc-component-dialog]");
		await dialog.waitFor();
		await dialog.getByLabel("Name").fill("card title");
		await dialog.getByRole("button", { name: "Make" }).click();
		await says(dialog.getByRole("alert"), "capital first");
		await dialog.getByLabel("Name").fill("CardTitle");
		await dialog.getByRole("button", { name: "Make" }).click();
		await dialog.first().waitFor({ state: "detached" });
		expect(await eventually(entryMarkup, (text) => text.includes("<CardTitle"))).toContain("<CardTitle");
	});
});
