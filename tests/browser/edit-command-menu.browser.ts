// The Command menu in Edit mode (#139) in a real browser, in light and dark: one menu for everyone,
// with each command shown by Permission. A Member's Actions (Save Draft, Publish, Undo and Redo,
// Preview, leaving), the selected Placement's actions through the Page layout's own controller, Go to
// (Pages, Entries, Placements by their drawer label; never Templates or Components), Insert (Allowed
// components, only where arranging is allowed), the Edit bar's search button with its key, the
// Keyboard shortcuts list (only what the person may do) and no menu under 768px. An Author sends to
// Review instead of publishing; Staff see Templates and Components too. Undo and Redo are Edit mode's
// own Undo history (#140): its steps by name, taken along by Go to. Axe checks every open state.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Locator, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
// Each case signs different people into its own Site: Edit mode's entry links and sign-ins share one
// per-address rate limit, so each case gets its own Install.
beforeEach(async () => {
	install = await startBrowserInstall();
});
afterEach(async () => {
	await install.close();
});

type Fixture = Awaited<ReturnType<typeof fixture>>;

/**
 * A Site whose home Page places "Hero" once per heading (the last one locked when asked), with a
 * second Page, a Post Type with one Entry, and a Component that isn't Allowed.
 */
async function fixture(slug: string, options: { headings?: string[]; locked?: boolean; arranging?: boolean } = {}) {
	const { headings = ["Welcome to Cork", "Fresh bread"], locked = false, arranging = true } = options;
	const local = install.install;
	const superadmin = await local.superadmin();
	const workspaceId = (await local.createWorkspace()).id;
	const siteId = (await local.createSite(workspaceId, { slug })).id;
	const api = superadmin.api;
	const pageType = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	if (!pageType) throw new Error("Missing Page Post Type");
	const { entry } = await api.entries.create({ siteId, postTypeId: pageType.id, title: "Home" });
	await api.pages.setHomePage({ siteId, pageId: entry.id });
	// Edit mode shows Content's Drafts: the second Page and the Entry need no publishing to be gone to.
	await api.entries.create({ siteId, postTypeId: pageType.id, title: "About us" });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Stories",
		urlPattern: "/stories/{slug}",
		fields: [{ key: "intro", label: "Intro", type: "richText" }],
	});
	const { template } = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1><div>{{ intro }}</div></article>",
	});
	await api.templates.publish({ siteId, templateId: template.id });
	const { entry: story } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "First tale",
		fields: { intro: "<p>Once upon a time.</p>" },
	});
	const { component } = await api.components.create({
		siteId,
		name: "Hero",
		props: [{ key: "heading", label: "Heading", type: "text", translatable: true }],
	});
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<section><h1>{{ props.heading }}</h1></section>",
	});
	await api.components.publish({ siteId, componentId: component.id });
	const { component: banner } = await api.components.create({ siteId, name: "Banner" });
	await api.components.publish({ siteId, componentId: banner.id });
	await api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [component.id] });
	const state = await api.pageLayouts.get({ siteId, entryId: entry.id });
	await api.pageLayouts.save({
		siteId,
		entryId: entry.id,
		basedOn: state.version,
		layout: {
			placements: headings.map((heading, index) => ({
				id: `hero-${index}`,
				component: component.id,
				props: component.draft.props,
				values: { heading: { en: heading } },
				...(locked && index === headings.length - 1 ? { locked: true } : {}),
			})),
		},
	});
	await api.entries.publish({ siteId, entryId: entry.id });
	if (!arranging) await api.pageLayouts.configure({ siteId, enabled: false });
	const layout = () => api.pageLayouts.get({ siteId, entryId: entry.id });
	return { local, api, workspaceId, siteId, slug, entryId: entry.id, storyId: story.id, layout };
}

/** Opens the Site's home page in Edit mode as someone, from the admin, as they would. */
async function enter(theme: Theme, site: Fixture, account: TestAccount, width = 1280): Promise<Page> {
	const page = await install.newPage(theme);
	page.setDefaultTimeout(10_000);
	await page.setViewportSize({ width, height: 800 });
	await install.signIn(page, account);
	await page.goto(install.adminUrl(`/sites/${site.siteId}`));
	await page.getByRole("button", { name: "Edit on site" }).click();
	await page.waitForURL((url) => url.hostname.startsWith(site.slug));
	await page.getByRole("button", { name: /^Publish|^Changes/ }).waitFor();
	return page;
}

function menuOf(page: Page) {
	return page.getByRole("dialog", { name: "Command menu" });
}

/** The Edit bar's search button, once the menu behind it has loaded. */
function searchButton(page: Page) {
	return page.getByRole("button", { name: "Command menu", exact: true });
}

/** Whether the browser is on an Apple device: ⌘ and "Command" there, Ctrl and "Control" elsewhere. */
async function onApple(page: Page): Promise<boolean> {
	return page.evaluate(() => /mac|iphone|ipad/i.test(navigator.platform));
}

/** An option's accessible name: its text, without what is hidden from screen readers. */
function spokenText(option: Element): string {
	const copy = option.cloneNode(true) as Element;
	for (const hidden of copy.querySelectorAll("[aria-hidden=true]")) hidden.remove();
	return (copy.textContent ?? "").trim().replace(/\s+/g, " ");
}

/** What the open tab lists, as screen readers hear each option. */
async function options(menu: Locator): Promise<string[]> {
	return menu.getByRole("option").evaluateAll((all, read) => {
		const spoken = new Function(`return ${read}`)() as (option: Element) => string;
		return all.map(spoken);
	}, spokenText.toString());
}

/** The names of the groups the open tab lists its options under. */
async function groups(menu: Locator): Promise<string[]> {
	return menu
		.getByRole("listbox")
		.getByRole("group")
		.evaluateAll((all) => all.map((group) => group.getAttribute("aria-label") ?? ""));
}

/** The element with focus, through shadow roots: its accessible name as the page gives it. */
async function focusedName(page: Page): Promise<string> {
	return page.evaluate(() => {
		let active = document.activeElement;
		while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
		return (active?.getAttribute("aria-label") ?? active?.textContent ?? "").trim();
	});
}

async function expectAnnounced(page: Page, text: string | RegExp): Promise<void> {
	await page.locator("[data-editor-messages]").filter({ hasText: text }).first().waitFor();
}

/** Waits until the page shows its Placements' headings in this order. */
async function untilHeadings(page: Page, expected: string[]): Promise<void> {
	await page.waitForFunction(
		(wanted) =>
			JSON.stringify([...document.querySelectorAll("main [data-wc-page-placement] h1")].map((h) => h.textContent)) ===
			JSON.stringify(wanted),
		expected,
	);
}

/** The message the bar shows under itself, for everyone to see, until it is dismissed. */
function shownMessage(page: Page) {
	return page.locator("webcraft-edit-bar .message");
}

/** Waits until the Undo history is there: the Edit bar's Undo then has its keys. */
async function historyReady(page: Page): Promise<void> {
	await page.waitForFunction(() =>
		document
			.querySelector("webcraft-edit-bar")
			?.shadowRoot?.querySelector('.history button[aria-label="Undo"]')
			?.hasAttribute("aria-keyshortcuts"),
	);
}

/** Waits until the Edit bar's Undo offers `label` (its tooltip starts with it), or nothing for null. */
async function barUndo(page: Page, label: string | null): Promise<void> {
	await page.waitForFunction((label) => {
		const bar = document.querySelector("webcraft-edit-bar")?.shadowRoot;
		const button = bar?.querySelector<HTMLButtonElement>('.history button[aria-label="Undo"]');
		if (!button?.hasAttribute("aria-keyshortcuts")) return false;
		return label === null ? button.disabled : !button.disabled && button.title.startsWith(`Undo ${label} (`);
	}, label);
}

/** Types at the end of a Placement's heading on the page and leaves it: one finished action. */
async function typeHeading(page: Page, placement: string, text: string): Promise<void> {
	// The Page layout's tools make it editable once they are there.
	await page
		.locator(`main [data-wc-placement="${placement}"][data-wc-placement-prop="heading"][contenteditable="true"]`)
		.click();
	await page.keyboard.press("End");
	await page.keyboard.type(text);
	await page.keyboard.press("Enter");
}

/** Undo and Redo as the open menu lists them, Undo first, wherever "Recent" puts the one used last. */
async function steps(menu: Locator): Promise<string[]> {
	return (await options(menu))
		.filter((option) => /^(Undo|Redo)/.test(option))
		.sort()
		.reverse();
}

/** The rows of the open Keyboard shortcuts list, by group. */
async function listedShortcuts(list: Locator): Promise<[string, string[]][]> {
	return list
		.locator("table")
		.evaluateAll((tables) =>
			tables.map((table): [string, string[]] => [
				table.querySelector("caption")?.textContent ?? "",
				[...table.querySelectorAll("tbody tr td:last-child")].map((cell) => cell.textContent ?? ""),
			]),
		);
}

/**
 * The Edit bar's controls that lie over one another or outside the window, as "<one> over <next>":
 * none when the bar's groups keep clear of each other.
 */
async function barClashes(page: Page): Promise<string[]> {
	return page.evaluate(() => {
		const bar = document.querySelector("webcraft-edit-bar")?.shadowRoot?.querySelector(".bar");
		if (!bar) return ["no bar"];
		const parts = [...bar.querySelectorAll<HTMLElement>(".start > *, .middle > *, .end > *, :scope > button")]
			.map((part) => ({
				name: part.getAttribute("aria-label") || part.textContent?.trim() || part.className,
				box: part.getBoundingClientRect(),
			}))
			.filter((part) => part.box.width > 0 && part.box.height > 0)
			.sort((a, b) => a.box.left - b.box.left);
		const clashes: string[] = [];
		parts.forEach((part, index) => {
			const next = parts[index + 1];
			if (next && part.box.right > next.box.left + 0.5) clashes.push(`${part.name} over ${next.name}`);
		});
		const last = parts.at(-1);
		if ((parts[0]?.box.left ?? 0) < 0 || (last?.box.right ?? 0) > window.innerWidth + 0.5)
			clashes.push("outside the window");
		return clashes;
	});
}

/** Opens a tab with its key, types into its search box and runs the result with Enter. */
async function run(page: Page, key: "k" | "p" | "i", query: string): Promise<void> {
	const menu = menuOf(page);
	await page.keyboard.press(`ControlOrMeta+${key}`);
	const search = menu.getByRole("combobox");
	await search.fill(query);
	await menu.getByRole("option").first().waitFor();
	await page.keyboard.press("Enter");
	await menu.waitFor({ state: "hidden" });
}

for (const theme of THEMES) {
	describe(`the Command menu in Edit mode, ${theme}`, () => {
		test("a Member's Actions, the search button and its key, and focus going back", async () => {
			const site = await fixture(`menu-actions-${theme}`);
			const member = await site.local.createMember({ workspaceId: site.workspaceId, role: "editor" });
			const page = await enter(theme, site, member.account);
			const mod = (await onApple(page)) ? "⌘" : "Ctrl+";
			const command = (await onApple(page)) ? "Command" : "Control";

			// The Edit bar's search button, shown to everyone, with the shortcut in its tooltip. What the
			// menu lists is read only once it is asked for: a page costs nothing until then.
			const reads: string[] = [];
			page.on("request", (request) => {
				if (request.url().endsWith("/_webcraft/edit/api/commandMenu")) reads.push(request.url());
			});
			const button = searchButton(page);
			await button.waitFor();
			await page.waitForTimeout(300);
			expect(reads).toHaveLength(0);
			expect(await button.getAttribute("title")).toBe(`Command menu (${mod}K)`);
			expect(await button.getAttribute("aria-keyshortcuts")).toBe(`${(await onApple(page)) ? "Meta" : "Control"}+K`);
			await button.click();
			const menu = menuOf(page);
			await menu.waitFor();
			expect(reads).toHaveLength(1);
			expect(await menu.getByRole("tab").allTextContents()).toEqual([
				`Actions${mod}K`,
				`Go to${mod}P`,
				`Insert${mod}I`,
			]);
			// Nothing is selected: the page's own Actions, by Permission (an Editor publishes).
			expect(await options(menu)).toEqual([
				`Save Draft, Page, ${command} S`,
				"Publish, Page",
				`Undo, Page, ${command} Z, Nothing to undo.`,
				`Redo, Page, ${command} Shift Z, Nothing to redo.`,
				"Preview, Page",
				"Leave Edit mode, Page",
			]);
			expect(await menu.getByRole("option", { name: /^Undo/ }).getAttribute("aria-disabled")).toBe("true");
			await page.waitForTimeout(250);
			await expectNoAxeViolations(page, `Edit mode Command menu, Actions (${theme})`);
			// Escape closes it; focus goes back to the button that opened it.
			await page.keyboard.press("Escape");
			await menu.waitFor({ state: "hidden" });
			expect(await focusedName(page)).toBe("Command menu");

			// Save Draft saves what is typed at once and says so.
			const title = page.locator('main [data-wc-field="title"], [data-wc-placement-prop]').first();
			await title.click();
			await page.keyboard.press("End");
			await page.keyboard.type("!");
			await run(page, "k", "save");
			await expectAnnounced(page, "Saved to Draft");
			expect((await site.layout()).placements[0]?.values).toEqual({ heading: "Welcome to Cork!" });

			// Publish opens the Edit bar's own Publish menu; nothing is published at once.
			await run(page, "k", "publish");
			const publish = page.getByRole("dialog", { name: /^Publish/ });
			await publish.waitFor();
			await publish.getByRole("button", { name: "Publish page" }).waitFor();
			await page.keyboard.press("Escape");

			// Preview turns editing off (the menu then offers Edit), and Edit turns it on again.
			await run(page, "k", "preview");
			await page.getByRole("button", { name: "Preview", exact: true, pressed: true }).waitFor();
			await page.keyboard.press("ControlOrMeta+k");
			expect(await options(menu)).toEqual(["Publish, Page", "Edit, Page", "Leave Edit mode, Page"]);
			await menu.getByRole("combobox").fill("edit");
			expect((await options(menu))[0]).toBe("Edit, Page");
			await page.keyboard.press("Enter");
			await page.getByRole("button", { name: "Edit", exact: true, pressed: true }).waitFor();
			await expectAccessibleScreen(page, `Edit mode with the Command menu's button (${theme})`);

			// Leaving ends Edit mode: the page comes back without the Edit bar.
			await run(page, "k", "leave");
			await page.waitForFunction(() => !document.querySelector("webcraft-edit-bar"));
		});

		test("a selected Placement's Actions, Go to and Insert go through the Page layout", async () => {
			const site = await fixture(`menu-layout-${theme}`, {
				headings: ["Welcome to Cork", "Fresh bread", "Opening hours"],
			});
			const member = await site.local.createMember({ workspaceId: site.workspaceId, role: "editor" });
			const page = await enter(theme, site, member.account);
			const menu = menuOf(page);
			const search = menu.getByRole("combobox");
			await searchButton(page).waitFor();

			// Go to: Pages and Entries, and the page's Placements by their drawer label. No Templates,
			// no Components.
			await page.keyboard.press("ControlOrMeta+p");
			await menu.getByRole("option").first().waitFor();
			expect(await search.getAttribute("aria-label")).toBe("Go to a page or a Placement");
			expect(await groups(menu)).toEqual(["Pages", "Stories", "Placements on this page"]);
			expect(await options(menu)).toEqual([
				"Home, Pages",
				"About us, Pages",
				"First tale, Stories",
				"Hero · Welcome to Cork, Placements on this page",
				"Hero · Fresh bread, Placements on this page",
				"Hero · Opening hours, Placements on this page",
			]);
			await page.waitForTimeout(250);
			await expectNoAxeViolations(page, `Edit mode Command menu, Go to (${theme})`);
			// Picking a Placement selects it and scrolls to it.
			await search.fill("fresh");
			expect(await options(menu)).toEqual(["Hero · Fresh bread, Placements on this page"]);
			await page.keyboard.press("Enter");
			await menu.waitFor({ state: "hidden" });
			const selected = page.locator("main [data-wc-placement-selected]");
			await selected.waitFor();
			expect(await selected.locator("h1").textContent()).toBe("Fresh bread");
			expect(await selected.evaluate((el) => el.getBoundingClientRect().top < window.innerHeight)).toBe(true);
			await expectAnnounced(page, "Selected Hero · Fresh bread");

			// Actions now holds the Placement's: Props, Move up and down, Duplicate, Hide and Remove.
			await page.keyboard.press("ControlOrMeta+k");
			await menu.waitFor();
			expect(await groups(menu)).toEqual(["Page", "Placement"]);
			expect((await options(menu)).filter((option) => option.includes(", Placement"))).toEqual([
				"Props, Placement",
				`Move up, Placement, ${(await onApple(page)) ? "Option" : "Alt"} Up Arrow`,
				`Move down, Placement, ${(await onApple(page)) ? "Option" : "Alt"} Down Arrow`,
				"Duplicate, Placement",
				"Hide the Placement, Placement",
				"Remove, Placement",
			]);
			await search.fill("move up");
			await page.keyboard.press("Enter");
			await untilHeadings(page, ["Fresh bread", "Welcome to Cork", "Opening hours"]);
			await run(page, "k", "move down");
			await untilHeadings(page, ["Welcome to Cork", "Fresh bread", "Opening hours"]);

			await run(page, "k", "hide");
			await page.locator('main [data-wc-page-placement][data-wc-hidden-placement="true"]').waitFor();
			await page.keyboard.press("ControlOrMeta+k");
			// "show" alone finds the step just made as well ("Undo Hide or show…"): the history is the page's own.
			await search.fill("show the");
			expect(await options(menu)).toEqual(["Show the Placement, Placement"]);
			await page.keyboard.press("Enter");
			await page.waitForFunction(() => !document.querySelector("main [data-wc-hidden-placement]"));

			await run(page, "k", "duplicate");
			await untilHeadings(page, ["Welcome to Cork", "Fresh bread", "Fresh bread", "Opening hours"]);
			await run(page, "k", "remove");
			await untilHeadings(page, ["Welcome to Cork", "Fresh bread", "Opening hours"]);

			// Insert: Allowed components only, placed after the selected Placement.
			await run(page, "p", "welcome");
			await page.keyboard.press("ControlOrMeta+i");
			await menu.getByRole("option").first().waitFor();
			expect(await search.getAttribute("aria-label")).toBe("Find a component");
			expect(await options(menu)).toEqual(["Hero, Components"]);
			expect(
				await search.evaluate((input) =>
					(input.getRootNode() as ShadowRoot)
						.getElementById(input.getAttribute("aria-describedby") ?? "")
						?.textContent?.trim(),
				),
			).toBe("Inserts after Hero · Welcome to Cork");
			await page.waitForTimeout(250);
			await expectNoAxeViolations(page, `Edit mode Command menu, Insert (${theme})`);
			await page.keyboard.press("Enter");
			await menu.waitFor({ state: "hidden" });
			await page.waitForFunction(() => document.querySelectorAll("main [data-wc-page-placement]").length === 4);
			expect((await site.layout()).placements.map((placement) => placement.label)).toEqual([
				"Hero · Welcome to Cork",
				"Hero",
				"Hero · Fresh bread",
				"Hero · Opening hours",
			]);

			// The new Placement is the selected one, with focus on its row in the Page layout drawer.
			const row = page.getByRole("tree").getByRole("treeitem", { name: /^Hero\b(?! ·)/ });
			await row.and(page.locator('[aria-selected="true"]')).waitFor();
			await page.waitForFunction(() => {
				let active = document.activeElement;
				while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
				return active?.getAttribute("role") === "treeitem" && active.getAttribute("aria-selected") === "true";
			});
			// The menu's keys work from the drawer's tree too. Props opens the Placement's Props, with focus in them.
			await run(page, "k", "props");
			const inspector = page.locator('[data-editor-region="inspector"]');
			await inspector.getByLabel("Heading", { exact: true }).waitFor();
			await page.waitForFunction(() => {
				let active = document.activeElement;
				while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
				return !!active?.closest('[data-editor-region="inspector"]');
			});

			// Go to a Page leaves for it, still in Edit mode.
			await run(page, "p", "about");
			await page.waitForURL((url) => url.pathname === "/about-us");
			await page.locator("webcraft-edit-bar").waitFor({ state: "attached" });
		});

		test("the Keyboard shortcuts list shows only what the person may do", async () => {
			const site = await fixture(`menu-keys-${theme}`);
			const member = await site.local.createMember({ workspaceId: site.workspaceId, role: "editor" });
			const page = await enter(theme, site, member.account);
			await searchButton(page).waitFor();
			await historyReady(page);
			await page.keyboard.press("ControlOrMeta+/");
			const list = page.getByRole("dialog", { name: "Keyboard shortcuts" });
			await list.waitFor();
			// Undo and Redo are everyone's who may edit: Edit mode keeps their history.
			expect(await listedShortcuts(list)).toEqual([
				["Command menu", ["Actions", "Go to", "Insert", "Keyboard shortcuts"]],
				["Editor", ["Save Draft", "Undo", "Redo", "Move between editor regions"]],
				[
					"Page layout",
					[
						"Move between Placements",
						"Go to the first or last Placement",
						"Find a Placement by typing its name",
						"Move up",
						"Move down",
						"Pick a Placement up, or put it down",
						"Put a picked-up Placement back",
					],
				],
			]);
			await expectNoAxeViolations(page, `Edit mode Keyboard shortcuts (${theme})`);
			await page.keyboard.press("Escape");
			await list.waitFor({ state: "hidden" });

			// In Preview nothing is edited: the keys that save, undo, redo and arrange aren't bound, nor listed.
			await page.getByRole("button", { name: "Preview", exact: true }).click();
			await page.getByRole("button", { name: "Preview", exact: true, pressed: true }).waitFor();
			await page.keyboard.press("ControlOrMeta+/");
			await list.waitFor();
			expect(await listedShortcuts(list)).toEqual([["Command menu", ["Actions", "Go to", "Keyboard shortcuts"]]]);
		});
	});
}

for (const theme of THEMES) {
	for (const who of ["a Member", "Staff"] as const) {
		test(`the menu's Undo and Redo are Edit mode's own Undo history, for ${who} (${theme})`, async () => {
			const site = await fixture(`menu-history-${who === "Staff" ? "staff" : "member"}-${theme}`);
			const account =
				who === "Staff"
					? (await site.local.createStaff({ workspaces: [site.workspaceId] })).account
					: (await site.local.createMember({ workspaceId: site.workspaceId, role: "editor" })).account;
			const page = await enter(theme, site, account);
			await searchButton(page).waitFor();
			const command = (await onApple(page)) ? "Command" : "Control";
			const menu = menuOf(page);
			const heading = async () => (await site.layout()).placements[0]?.values.heading;

			// Nothing done yet: both are listed, off, and say why.
			await barUndo(page, null);
			await page.keyboard.press("ControlOrMeta+k");
			await menu.waitFor();
			expect(await steps(menu)).toEqual([
				`Undo, Page, ${command} Z, Nothing to undo.`,
				`Redo, Page, ${command} Shift Z, Nothing to redo.`,
			]);
			await page.keyboard.press("Escape");
			await menu.waitFor({ state: "hidden" });

			// One finished action on the page is one step: the menu names it, as the Edit bar does.
			await typeHeading(page, "hero-0", "!");
			await barUndo(page, "Props Hero · Welcome to Cork");
			expect(await heading()).toBe("Welcome to Cork!");
			await page.keyboard.press("ControlOrMeta+k");
			await menu.waitFor();
			expect(await steps(menu)).toEqual([
				`Undo Props Hero · Welcome to Cork, Page, ${command} Z`,
				`Redo, Page, ${command} Shift Z, Nothing to redo.`,
			]);
			expect(await menu.getByRole("option", { name: /^Undo/ }).getAttribute("aria-disabled")).not.toBe("true");
			await page.waitForTimeout(250);
			await expectNoAxeViolations(page, `Edit mode Command menu with a step to undo, ${who} (${theme})`);

			// The menu's Undo is the history's: the Draft goes back, it is said once in the shared message
			// area, and the Edit bar's own buttons follow.
			await menu.getByRole("combobox").fill("undo");
			await page.keyboard.press("Enter");
			await menu.waitFor({ state: "hidden" });
			await expectAnnounced(page, "Undid Props Hero · Welcome to Cork");
			expect(await page.locator("[data-editor-messages]").count()).toBe(1);
			await barUndo(page, null);
			expect(await heading()).toBe("Welcome to Cork");
			expect(
				await page
					.getByRole("group", { name: "Undo history" })
					.getByRole("button", { name: "Redo" })
					.getAttribute("title"),
			).toStartWith("Redo Props Hero · Welcome to Cork (");

			// The menu follows the history as it changes, and makes the step again.
			await page.keyboard.press("ControlOrMeta+k");
			await menu.waitFor();
			expect(await steps(menu)).toEqual([
				`Undo, Page, ${command} Z, Nothing to undo.`,
				`Redo Props Hero · Welcome to Cork, Page, ${command} Shift Z`,
			]);
			await menu.getByRole("combobox").fill("redo");
			await page.keyboard.press("Enter");
			await menu.waitFor({ state: "hidden" });
			await expectAnnounced(page, "Redid Props Hero · Welcome to Cork");
			await barUndo(page, "Props Hero · Welcome to Cork");
			expect(await heading()).toBe("Welcome to Cork!");

			// The Keyboard shortcuts list shows Undo and Redo to everyone who may edit.
			await page.keyboard.press("ControlOrMeta+/");
			const list = page.getByRole("dialog", { name: "Keyboard shortcuts" });
			await list.waitFor();
			expect((await listedShortcuts(list)).find(([group]) => group === "Editor")?.[1]).toEqual([
				"Save Draft",
				"Undo",
				"Redo",
				"Move between editor regions",
			]);
			await page.keyboard.press("Escape");
			await list.waitFor({ state: "hidden" });

			// In Preview nothing is edited: the menu offers neither.
			await page.getByRole("button", { name: "Preview", exact: true }).click();
			await page.getByRole("button", { name: "Preview", exact: true, pressed: true }).waitFor();
			await page.keyboard.press("ControlOrMeta+k");
			await menu.waitFor();
			expect(await steps(menu)).toEqual([]);
		});

		test(`Go to takes the Undo history along to the page it opens, for ${who} (${theme})`, async () => {
			const site = await fixture(`menu-go-history-${who === "Staff" ? "staff" : "member"}-${theme}`);
			const account =
				who === "Staff"
					? (await site.local.createStaff({ workspaces: [site.workspaceId] })).account
					: (await site.local.createMember({ workspaceId: site.workspaceId, role: "editor" })).account;
			const page = await enter(theme, site, account);
			await searchButton(page).waitFor();
			const command = (await onApple(page)) ? "Command" : "Control";
			const menu = menuOf(page);
			await typeHeading(page, "hero-0", "!");
			await barUndo(page, "Props Hero · Welcome to Cork");

			// Go to a Page: the history is handed over, and its token doesn't stay in the address.
			await run(page, "p", "about");
			await page.waitForURL((url) => url.pathname === "/about-us");
			await searchButton(page).waitFor();
			await barUndo(page, "Props Hero · Welcome to Cork");
			expect(new URL(page.url()).hash).toBe("");
			expect(await shownMessage(page).isVisible()).toBe(false);

			// The step made on the other page is the menu's Undo here, and is taken back there.
			await page.keyboard.press("ControlOrMeta+k");
			await menu.waitFor();
			expect((await steps(menu))[0]).toBe(`Undo Props Hero · Welcome to Cork, Page, ${command} Z`);
			await menu.getByRole("combobox").fill("undo");
			await page.keyboard.press("Enter");
			await menu.waitFor({ state: "hidden" });
			await expectAnnounced(page, "Undid Props Hero · Welcome to Cork on Home");
			await barUndo(page, null);
			expect((await site.layout()).placements[0]?.values.heading).toBe("Welcome to Cork");
		});
	}

	test(`the Edit bar's controls keep clear of one another at 1280px with a peer, the search button and Undo and Redo (${theme})`, async () => {
		const site = await fixture(`menu-bar-${theme}`);
		const member = await site.local.createMember({
			workspaceId: site.workspaceId,
			role: "editor",
			name: "Mia Member",
		});
		const staff = await site.local.createStaff({ workspaces: [site.workspaceId], name: "Sam Staff" });
		// A Member's bar and Staff's (the fullest: it has the Code switch too), each with the other's avatar.
		const memberPage = await enter(theme, site, member.account);
		const staffPage = await enter(theme, site, staff.account);
		for (const page of [memberPage, staffPage]) {
			await searchButton(page).waitFor();
			await page.locator("webcraft-edit-bar .others .other").first().waitFor();
		}
		// Each has made a step: Undo is on, and the bar says the Draft is saved.
		await typeHeading(memberPage, "hero-0", "!");
		await barUndo(memberPage, "Props Hero · Welcome to Cork");
		await typeHeading(staffPage, "hero-1", "?");
		await barUndo(staffPage, "Props Hero · Fresh bread");
		for (const [who, page] of [
			["a Member", memberPage],
			["Staff", staffPage],
		] as const) {
			expect(page.viewportSize()?.width).toBe(1280);
			for (const name of ["Command menu", "Undo", "Redo", "Page layout"])
				expect(
					await page.getByRole("region", { name: "Edit mode" }).getByRole("button", { name, exact: true }).isVisible(),
				).toBe(true);
			expect({ who, clashes: await barClashes(page) }).toEqual({ who, clashes: [] });
			await expectNoAxeViolations(page, `Edit bar with a peer, the search button and Undo and Redo, ${who} (${theme})`);
		}
	});
}

test("an Author sends to Review instead of publishing, and gets no Insert where arranging is off", async () => {
	const site = await fixture("menu-author", { arranging: false });
	const author = await site.local.createMember({ workspaceId: site.workspaceId, role: "author" });
	const page = await enter("light", site, author.account);
	await searchButton(page).click();
	const menu = menuOf(page);
	await menu.waitFor();
	const command = (await onApple(page)) ? "Command" : "Control";
	// No Insert tab, and no Placement to act on: arranging is off.
	expect(await menu.getByRole("tab").count()).toBe(2);
	expect(await options(menu)).toEqual([
		`Save Draft, Page, ${command} S`,
		"Send to Review, Page",
		`Undo, Page, ${command} Z, Nothing to undo.`,
		`Redo, Page, ${command} Shift Z, Nothing to redo.`,
		"Preview, Page",
		"Leave Edit mode, Page",
	]);
	await page.keyboard.press("Tab");
	await menu.getByRole("tab", { name: /^Go to/, selected: true }).waitFor();
	await menu.getByRole("option").first().waitFor();
	// Go to lists the page's Placements for everyone who may edit the page, arranging or not.
	expect(await groups(menu)).toEqual(["Pages", "Stories", "Placements on this page"]);
	// Tab goes round the two tabs there are.
	await page.keyboard.press("Tab");
	await menu.getByRole("tab", { name: /^Actions/, selected: true }).waitFor();
	await page.keyboard.press("Escape");
	// Picking a Placement selects it and scrolls to it; there is still nothing to arrange it with.
	await run(page, "p", "fresh");
	const selected = page.locator("main [data-wc-placement-selected]");
	await selected.waitFor();
	expect(await selected.locator("h1").textContent()).toBe("Fresh bread");
	expect(await selected.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
	await expectAnnounced(page, "Selected Hero · Fresh bread");
	await page.keyboard.press("ControlOrMeta+k");
	await menu.waitFor();
	expect(await groups(menu)).toEqual(["Page"]);
	expect(
		await page.getByRole("region", { name: "Edit mode" }).getByRole("button", { name: "Page layout" }).count(),
	).toBe(0);
	await page.keyboard.press("Escape");
	// Insert's key opens nothing.
	await page.keyboard.press("ControlOrMeta+i");
	await page.waitForTimeout(300);
	expect(await menu.count()).toBe(0);

	// The shortcuts list leaves out Insert and the Page layout's keys.
	await historyReady(page);
	await page.keyboard.press("ControlOrMeta+/");
	const list = page.getByRole("dialog", { name: "Keyboard shortcuts" });
	await list.waitFor();
	expect(await list.locator("caption").allTextContents()).toEqual(["Command menu", "Editor"]);
	expect(await list.locator("tbody tr td:last-child").allTextContents()).toEqual([
		"Actions",
		"Go to",
		"Keyboard shortcuts",
		"Save Draft",
		"Undo",
		"Redo",
	]);
	await page.keyboard.press("Escape");
	await list.waitFor({ state: "hidden" });

	// Send to Review opens the Edit bar's Changes, where the page is submitted for review.
	await page.keyboard.press("ControlOrMeta+k");
	await menu.getByRole("combobox").fill("send");
	expect(await options(menu)).toEqual(["Send to Review, Page"]);
	await page.keyboard.press("Enter");
	const changes = page.getByRole("dialog", { name: /^Changes/ });
	await changes.waitFor();
	expect(await changes.getByRole("button", { name: "Publish page" }).count()).toBe(0);
});

test("a Member can't move, hide or remove a locked Placement from the menu, but edits its Props", async () => {
	const site = await fixture("menu-locked", { locked: true });
	const member = await site.local.createMember({ workspaceId: site.workspaceId, role: "editor" });
	const page = await enter("light", site, member.account);
	await searchButton(page).waitFor();
	await run(page, "p", "fresh");
	await page.keyboard.press("ControlOrMeta+k");
	const menu = menuOf(page);
	await menu.waitFor();
	const placement = (await options(menu)).filter((option) => option.includes(", Placement"));
	expect(placement.map((option) => option.replace(/, (Option|Alt) (Up|Down) Arrow/, ""))).toEqual([
		"Props, Placement",
		"Move up, Placement, Locked",
		"Move down, Placement, Locked",
		"Duplicate, Placement",
		"Hide the Placement, Placement, Locked",
		"Remove, Placement, Locked",
	]);
	// Choosing a disabled command does nothing.
	await menu.getByRole("combobox").fill("remove");
	await page.keyboard.press("Enter");
	await page.waitForTimeout(300);
	expect(await menu.count()).toBe(1);
	expect((await site.layout()).placements.map((each) => each.label)).toEqual([
		"Hero · Welcome to Cork",
		"Hero · Fresh bread",
	]);
	await page.keyboard.press("Escape");
	await menu.waitFor({ state: "hidden" });

	// The Placement above it isn't locked: it can't move down past the locked one, and the menu says that,
	// not "Locked". It is the first, so there is nowhere up to move it either, which needs no saying.
	await run(page, "p", "welcome");
	await page.keyboard.press("ControlOrMeta+k");
	await menu.waitFor();
	const above = (await options(menu)).filter((option) => option.includes(", Placement"));
	expect(above.map((option) => option.replace(/, (Option|Alt) (Up|Down) Arrow/, ""))).toEqual([
		"Props, Placement",
		"Move up, Placement",
		"Move down, Placement, Next to a locked Placement",
		"Duplicate, Placement",
		"Hide the Placement, Placement",
		"Remove, Placement",
	]);
	expect(await menu.getByRole("option", { name: /^Move up/ }).getAttribute("aria-disabled")).toBe("true");
	await page.keyboard.press("Escape");
	await menu.waitFor({ state: "hidden" });

	// Staff stop allowing its Component: the locked Placement can't be duplicated, and the reason given
	// is the Component, not the lock.
	await site.api.pageLayouts.configure({ siteId: site.siteId, allowedComponents: [] });
	await page.reload();
	await searchButton(page).waitFor();
	await run(page, "p", "fresh");
	await page.keyboard.press("ControlOrMeta+k");
	await menu.waitFor();
	expect((await options(menu)).filter((option) => option.startsWith("Duplicate"))).toEqual([
		"Duplicate, Placement, Its Component can't be added here",
	]);
});

test("a refused Insert leaves focus in the Page layout drawer, and Go to still leaves: nothing is left unsaved", async () => {
	const site = await fixture("menu-refused");
	const member = await site.local.createMember({ workspaceId: site.workspaceId, role: "editor" });
	const page = await enter("light", site, member.account);
	await searchButton(page).waitFor();
	// Staff stop allowing Hero while the Member has the page open: the Member's Insert is refused.
	await site.api.pageLayouts.configure({ siteId: site.siteId, allowedComponents: [] });
	await page
		.getByRole("region", { name: "Edit mode" })
		.getByRole("button", { name: "Page layout", exact: true })
		.click();
	await page.getByRole("button", { name: "Insert", exact: true }).click();
	await page.locator("[data-picker]").getByRole("button", { name: "Hero", exact: true }).click();
	await page.locator('[data-editor-messages] [role="alert"]').filter({ hasText: /\S/ }).waitFor();
	// The list it was chosen from is gone; focus is on a row of the tree, not lost on the page.
	await page.waitForFunction(() => {
		let active = document.activeElement;
		while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
		return active?.getAttribute("role") === "treeitem";
	});
	expect((await site.layout()).placements).toHaveLength(2);

	// The refusal was said, and left nothing unsaved behind: Go to a Page leaves for it.
	await run(page, "p", "about");
	await page.waitForURL((url) => url.pathname === "/about-us");
	await page.locator("webcraft-edit-bar").waitFor({ state: "attached" });
});

test("while something isn't saved, Save Draft and Go to say so and the person stays; saved, Go to leaves", async () => {
	const site = await fixture("menu-unsaved");
	const member = await site.local.createMember({ workspaceId: site.workspaceId, role: "editor" });
	const page = await enter("light", site, member.account);
	await searchButton(page).waitFor();
	await page.goto(install.siteUrl(site.slug, "/stories/first-tale"));
	await searchButton(page).waitFor();
	const title = async () =>
		(await site.api.entries.get({ siteId: site.siteId, entryId: site.storyId })).entry.draft.title;

	// The server can't be reached for saves: what is typed stays unsaved.
	await page.route("**/_webcraft/edit/api/save", (route) => route.abort());
	await page.locator('h1[data-wc-field="title"]').click();
	await page.keyboard.press("End");
	await page.keyboard.type(" again");

	// Save Draft doesn't say "Saved": it says what isn't, where everyone sees it.
	await run(page, "k", "save");
	const unsaved = "Not everything is saved to the Draft. Check what you changed last, then save again.";
	await shownMessage(page).filter({ hasText: unsaved }).waitFor();
	await expectAnnounced(page, unsaved);
	expect(await page.locator("[data-editor-messages]").textContent()).not.toContain("Saved to Draft");

	// Go to stays on the page, and says why.
	await run(page, "p", "about");
	const stayed =
		"You are still on this page: not everything is saved to the Draft. Check what you changed last, then try again.";
	await shownMessage(page).filter({ hasText: stayed }).waitFor();
	await expectAnnounced(page, stayed);
	expect(new URL(page.url()).pathname).toBe("/stories/first-tale");
	expect(await title()).toBe("First tale");
	await page.waitForTimeout(250);
	await expectNoAxeViolations(page, "Edit mode saying why the person stays");

	// The server is back: the same Go to saves what was typed, then leaves.
	await page.unroute("**/_webcraft/edit/api/save");
	await run(page, "p", "about");
	await page.waitForURL((url) => url.pathname === "/about-us");
	expect(await title()).toBe("First tale again");
});

test("Staff see Templates and Components in Go to, and every Component in Insert", async () => {
	const site = await fixture("menu-staff");
	const staff = await site.local.createStaff({ workspaces: [site.workspaceId] });
	const page = await enter("dark", site, staff.account);
	await searchButton(page).waitFor();
	// Staff's bar is the fullest (it has the Code switch too): nothing in it lies over anything else.
	await expectNoAxeViolations(page, "Edit bar with the search button, Staff");
	await page.keyboard.press("ControlOrMeta+p");
	const menu = menuOf(page);
	await menu.getByRole("option").first().waitFor();
	expect(await groups(menu)).toEqual(["Pages", "Stories", "Templates", "Components", "Placements on this page"]);
	await page.keyboard.press("ControlOrMeta+i");
	await menu.getByRole("tab", { name: /^Insert/, selected: true }).waitFor();
	expect(await options(menu)).toEqual(["Banner, Components", "Hero, Components"]);
	// A Template opens in the Builder, on the admin.
	await page.keyboard.press("ControlOrMeta+p");
	await menu.getByRole("combobox").fill("site template");
	await page.keyboard.press("Enter");
	await page.waitForURL((url) => url.pathname === `/builder/${site.siteId}/site-template`);
});

test("a key the text itself uses stays the text's: italic in rich text, a link in the Body; everywhere else it opens the menu", async () => {
	const site = await fixture("menu-text");
	// A Post Type whose Entries have a Body: the block editor makes links with the Actions tab's key.
	const { postType } = await site.api.postTypes.create({
		siteId: site.siteId,
		name: "Articles",
		urlPattern: "/articles/{slug}",
		fields: [{ key: "body", label: "Story", type: "body" }],
	});
	const { template } = await site.api.templates.saveEntryTemplateMarkup({
		siteId: site.siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1><div>{{ body }}</div></article>",
	});
	await site.api.templates.publish({ siteId: site.siteId, templateId: template.id });
	await site.api.entries.create({
		siteId: site.siteId,
		postTypeId: postType.id,
		title: "Long read",
		fields: { body: [{ type: "paragraph", text: [{ text: "Baked at seven." }] }] },
	});
	const member = await site.local.createMember({ workspaceId: site.workspaceId, role: "editor" });
	const page = await enter("light", site, member.account);
	await searchButton(page).waitFor();
	await page.goto(install.siteUrl(site.slug, "/stories/first-tale"));
	await searchButton(page).waitFor();
	const menu = menuOf(page);
	const intro = page.locator('div[data-wc-field="intro"]');

	// In rich text, the Insert tab's key is italic.
	await intro.focus();
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.press("ControlOrMeta+i");
	await page.waitForFunction(() =>
		/<(i|em)\b/.test(document.querySelector('div[data-wc-field="intro"]')?.innerHTML ?? ""),
	);
	expect(await menu.count()).toBe(0);
	// Nothing there uses the Actions tab's key (a link is the toolbar's): it opens the menu, never a dead key.
	await page.keyboard.press("ControlOrMeta+k");
	await menu.getByRole("tab", { name: /^Actions/, selected: true }).waitFor();
	await page.keyboard.press("Escape");
	await menu.waitFor({ state: "hidden" });
	expect(await intro.evaluate((element) => element === document.activeElement)).toBe(true);
	// Go to's key works there too, and focus goes back into the text.
	await page.keyboard.press("ControlOrMeta+p");
	await menu.getByRole("tab", { name: /^Go to/, selected: true }).waitFor();
	await page.keyboard.press("Escape");
	await menu.waitFor({ state: "hidden" });
	expect(await intro.evaluate((element) => element === document.activeElement)).toBe(true);

	// Plain text has no formatting: the menu's keys open it from there.
	await page.locator('h1[data-wc-field="title"]').focus();
	await page.keyboard.press("ControlOrMeta+k");
	await menu.getByRole("tab", { name: /^Actions/, selected: true }).waitFor();
	// An Entry has no Page layout: no Insert tab, no Placements to go to.
	expect(await menu.getByRole("tab").count()).toBe(2);
	await page.keyboard.press("Escape");
	await menu.waitFor({ state: "hidden" });

	// In the Body the same key asks for a link's address, as the block editor binds it; the menu stays shut.
	await page.goto(install.siteUrl(site.slug, "/articles/long-read"));
	await searchButton(page).waitFor();
	const paragraph = page.locator('[data-wc-type="body"] [data-wc-block-id]').first();
	await paragraph.click();
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByRole("textbox", { name: "Link", exact: true }).waitFor();
	expect(await menu.count()).toBe(0);
	await page.keyboard.press("Escape");
	// The search button opens the menu from the Body all the same.
	await searchButton(page).click();
	await menu.getByRole("tab", { name: /^Actions/, selected: true }).waitFor();
});

test("the menu in Italian, for a Member whose Admin language it is", async () => {
	const site = await fixture("menu-italian");
	const member = await site.local.createMember({ workspaceId: site.workspaceId, role: "author" });
	await member.browser.api.me.updatePreferences({ adminLanguage: "it" });
	const page = await install.newPage("light");
	page.setDefaultTimeout(10_000);
	await page.setViewportSize({ width: 1280, height: 800 });
	await install.signIn(page, member.account);
	await page.goto(install.adminUrl(`/sites/${site.siteId}`));
	await page.getByRole("button", { name: "Modifica sul sito" }).click();
	await page.waitForURL((url) => url.hostname.startsWith(site.slug));
	const button = page.getByRole("button", { name: "Menu comandi", exact: true });
	await button.click();
	const menu = page.getByRole("dialog", { name: "Menu comandi" });
	await menu.waitFor();
	const command = (await onApple(page)) ? "Comando" : "Controllo";
	expect(await options(menu)).toEqual([
		`Salva bozza, Pagina, ${command} S`,
		"Invia in revisione, Pagina",
		`Annulla, Pagina, ${command} Z, Niente da annullare.`,
		`Ripeti, Pagina, ${command} Maiuscole Z, Niente da ripetere.`,
		"Anteprima, Pagina",
		"Esci dalla modalità modifica, Pagina",
	]);
	await page.keyboard.press("ControlOrMeta+p");
	await menu.getByRole("option").first().waitFor();
	expect(await menu.getByRole("combobox").getAttribute("aria-label")).toBe("Vai a una pagina o a un Placement");
	expect(await groups(menu)).toEqual(["Pagine", "Stories", "Placement in questa pagina"]);
	await page.keyboard.press("Escape");
	await page.keyboard.press("ControlOrMeta+/");
	const list = page.getByRole("dialog", { name: "Scorciatoie da tastiera" });
	await list.waitFor();
	expect(await list.locator("caption").allTextContents()).toEqual(["Menu comandi", "Editor", "Layout della Pagina"]);
	expect(await list.locator("tbody tr td:last-child").allTextContents()).toContain("Spostati tra i Placement");
});

test("a page without a Page layout that starts under 768px gets the menu once the window widens", async () => {
	const site = await fixture("menu-narrow-entry");
	const member = await site.local.createMember({ workspaceId: site.workspaceId, role: "editor" });
	const page = await enter("light", site, member.account, 767);
	// An Entry's own page: nothing of Edit mode's tools is loaded for a narrow window there.
	await page.goto(install.siteUrl(site.slug, "/stories/first-tale"));
	await page.locator('h1[data-wc-field="title"][contenteditable]').waitFor();
	await page.waitForTimeout(300);
	expect(await searchButton(page).count()).toBe(0);
	await page.keyboard.press("ControlOrMeta+k");
	await page.waitForTimeout(300);
	expect(await menuOf(page).count()).toBe(0);

	await page.setViewportSize({ width: 768, height: 800 });
	await searchButton(page).waitFor();
	await page.keyboard.press("ControlOrMeta+k");
	await menuOf(page)
		.getByRole("tab", { name: /^Actions/, selected: true })
		.waitFor();
	expect(await menuOf(page).getByRole("tab").count()).toBe(2);
});

test("the menu isn't offered in a window under 768px, and comes back when it widens", async () => {
	const site = await fixture("menu-narrow");
	const member = await site.local.createMember({ workspaceId: site.workspaceId, role: "editor" });
	const page = await enter("light", site, member.account, 767);
	await page.getByRole("button", { name: "Page layout", exact: true }).waitFor();
	expect(await searchButton(page).count()).toBe(0);
	await page.keyboard.press("ControlOrMeta+k");
	await page.waitForTimeout(300);
	expect(await menuOf(page).count()).toBe(0);

	await page.setViewportSize({ width: 768, height: 800 });
	await searchButton(page).waitFor();
	await expectNoAxeViolations(page, "Edit bar with the search button, 768px");
	await page.keyboard.press("ControlOrMeta+k");
	await menuOf(page).waitFor();
	// Narrowed while it is open, it closes.
	await page.setViewportSize({ width: 700, height: 800 });
	await menuOf(page).waitFor({ state: "hidden" });
	expect(await searchButton(page).count()).toBe(0);
});
