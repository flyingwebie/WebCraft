// The Command menu in Edit mode (#139) in a real browser, in light and dark: one menu for everyone,
// with each command shown by Permission. A Member's Actions (Save Draft, Publish, Undo and Redo,
// Preview, leaving), the selected Placement's actions through the Page layout's own controller, Go to
// (Pages, Entries, Placements by their drawer label; never Templates or Components), Insert (Allowed
// components, only where arranging is allowed), the Edit bar's search button with its key, the
// Keyboard shortcuts list (only what the person may do) and no menu under 768px. An Author sends to
// Review instead of publishing; Staff see Templates and Components too. Axe checks every open state.
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
	await api.entries.create({
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
	return { local, api, workspaceId, siteId, slug, entryId: entry.id, layout };
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

			// The Edit bar's search button, shown to everyone, with the shortcut in its tooltip.
			const button = searchButton(page);
			await button.waitFor();
			expect(await button.getAttribute("title")).toBe(`Command menu (${mod}K)`);
			expect(await button.getAttribute("aria-keyshortcuts")).toBe(`${(await onApple(page)) ? "Meta" : "Control"}+K`);
			await button.click();
			const menu = menuOf(page);
			await menu.waitFor();
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
			await search.fill("show");
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
			await page.keyboard.press("ControlOrMeta+/");
			const list = page.getByRole("dialog", { name: "Keyboard shortcuts" });
			await list.waitFor();
			const listed = async () =>
				list
					.locator("table")
					.evaluateAll((tables) =>
						tables.map((table) => [
							table.querySelector("caption")?.textContent ?? "",
							[...table.querySelectorAll("tbody tr td:last-child")].map((cell) => cell.textContent ?? ""),
						]),
					);
			expect(await listed()).toEqual([
				["Command menu", ["Actions", "Go to", "Insert", "Keyboard shortcuts"]],
				["Editor", ["Save Draft", "Move between editor regions"]],
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
		});
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
	expect(await groups(menu)).toEqual(["Pages", "Stories"]);
	// Tab goes round the two tabs there are.
	await page.keyboard.press("Tab");
	await menu.getByRole("tab", { name: /^Actions/, selected: true }).waitFor();
	await page.keyboard.press("Escape");
	// Insert's key opens nothing.
	await page.keyboard.press("ControlOrMeta+i");
	await page.waitForTimeout(300);
	expect(await menu.count()).toBe(0);

	// The shortcuts list leaves out Insert and the Page layout's keys.
	await page.keyboard.press("ControlOrMeta+/");
	const list = page.getByRole("dialog", { name: "Keyboard shortcuts" });
	await list.waitFor();
	expect(await list.locator("caption").allTextContents()).toEqual(["Command menu", "Editor"]);
	expect(await list.locator("tbody tr td:last-child").allTextContents()).toEqual([
		"Actions",
		"Go to",
		"Keyboard shortcuts",
		"Save Draft",
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
});

test("Staff see Templates and Components in Go to, and every Component in Insert", async () => {
	const site = await fixture("menu-staff");
	const staff = await site.local.createStaff({ workspaces: [site.workspaceId] });
	const page = await enter("dark", site, staff.account);
	await searchButton(page).waitFor();
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

test("Undo and Redo call the Undo history that is handed over, named after its step", async () => {
	const site = await fixture("menu-history");
	const member = await site.local.createMember({ workspaceId: site.workspaceId, role: "editor" });
	const page = await enter("light", site, member.account);
	await searchButton(page).waitFor();
	const command = (await onApple(page)) ? "Command" : "Control";
	// A history's owner hands it over in a document event, whenever it is made (here: after the menu).
	await page.evaluate(() => {
		const calls: string[] = [];
		const listeners = new Set<() => void>();
		let undone = false;
		const step = (name: string, next: boolean) => () => {
			calls.push(name);
			undone = next;
			for (const listener of listeners) listener();
		};
		Object.assign(window, { historyCalls: calls });
		document.dispatchEvent(
			new CustomEvent("webcraft:edit-history", {
				detail: {
					undo: step("undo", true),
					redo: step("redo", false),
					canUndo: () => !undone,
					canRedo: () => undone,
					undoLabel: () => (undone ? null : "Move Hero"),
					redoLabel: () => (undone ? "Move Hero" : null),
					subscribe(listener: () => void) {
						listeners.add(listener);
						return () => listeners.delete(listener);
					},
				},
			}),
		);
	});
	const calls = () => page.evaluate(() => (window as unknown as { historyCalls: string[] }).historyCalls);
	const menu = menuOf(page);
	// Undo before Redo, wherever "Recent" lists the one used last.
	const steps = async () =>
		(await options(menu))
			.filter((option) => /^(Undo|Redo)/.test(option))
			.sort()
			.reverse();

	await page.keyboard.press("ControlOrMeta+k");
	await menu.waitFor();
	expect(await steps()).toEqual([
		`Undo Move Hero, Page, ${command} Z`,
		`Redo, Page, ${command} Shift Z, Nothing to redo.`,
	]);
	await menu.getByRole("combobox").fill("undo");
	await page.keyboard.press("Enter");
	await menu.waitFor({ state: "hidden" });
	expect(await calls()).toEqual(["undo"]);

	// The menu follows the history as it changes.
	await page.keyboard.press("ControlOrMeta+k");
	await menu.waitFor();
	expect(await steps()).toEqual([
		`Undo, Page, ${command} Z, Nothing to undo.`,
		`Redo Move Hero, Page, ${command} Shift Z`,
	]);
	await menu.getByRole("combobox").fill("redo");
	await page.keyboard.press("Enter");
	await menu.waitFor({ state: "hidden" });
	expect(await calls()).toEqual(["undo", "redo"]);

	// With a history, the Keyboard shortcuts list shows Undo and Redo too.
	await page.keyboard.press("ControlOrMeta+/");
	const list = page.getByRole("dialog", { name: "Keyboard shortcuts" });
	await list.waitFor();
	expect(await list.locator("tbody tr td:last-child").allTextContents()).toEqual(
		expect.arrayContaining(["Save Draft", "Undo", "Redo"]),
	);
	await page.keyboard.press("Escape");
	await list.waitFor({ state: "hidden" });

	// Taken away again, both are disabled.
	await page.evaluate(() => document.dispatchEvent(new CustomEvent("webcraft:edit-history", { detail: null })));
	await page.keyboard.press("ControlOrMeta+k");
	await menu.waitFor();
	expect(await steps()).toEqual([
		`Undo, Page, ${command} Z, Nothing to undo.`,
		`Redo, Page, ${command} Shift Z, Nothing to redo.`,
	]);
});

test("rich text keeps its own keys: there the menu opens with Go to's key or the search button", async () => {
	const site = await fixture("menu-text");
	const member = await site.local.createMember({ workspaceId: site.workspaceId, role: "editor" });
	const page = await enter("light", site, member.account);
	await searchButton(page).waitFor();
	await page.goto(install.siteUrl(site.slug, "/stories/first-tale"));
	await searchButton(page).waitFor();
	const menu = menuOf(page);
	const intro = page.locator('div[data-wc-field="intro"]');

	// In rich text, the Insert tab's key is italic and the Actions tab's key stays the text's.
	await intro.focus();
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.press("ControlOrMeta+i");
	await page.waitForFunction(() =>
		/<(i|em)\b/.test(document.querySelector('div[data-wc-field="intro"]')?.innerHTML ?? ""),
	);
	await page.keyboard.press("ControlOrMeta+k");
	await page.waitForTimeout(300);
	expect(await menu.count()).toBe(0);
	// Go to's key works there, and focus goes back into the text.
	await page.keyboard.press("ControlOrMeta+p");
	await menu.getByRole("tab", { name: /^Go to/, selected: true }).waitFor();
	await page.keyboard.press("Escape");
	await menu.waitFor({ state: "hidden" });
	expect(await intro.evaluate((element) => element === document.activeElement)).toBe(true);
	// So does the search button.
	await searchButton(page).click();
	await menu.getByRole("tab", { name: /^Actions/, selected: true }).waitFor();
	await page.keyboard.press("Escape");
	await menu.waitFor({ state: "hidden" });

	// Plain text has no formatting: the menu's keys open it from there.
	await page.locator('h1[data-wc-field="title"]').focus();
	await page.keyboard.press("ControlOrMeta+k");
	await menu.getByRole("tab", { name: /^Actions/, selected: true }).waitFor();
	// An Entry has no Page layout: no Insert tab, no Placements to go to.
	expect(await menu.getByRole("tab").count()).toBe(2);
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
	await page.keyboard.press("ControlOrMeta+k");
	await menuOf(page).waitFor();
	// Narrowed while it is open, it closes.
	await page.setViewportSize({ width: 700, height: 800 });
	await menuOf(page).waitFor({ state: "hidden" });
	expect(await searchButton(page).count()).toBe(0);
});
