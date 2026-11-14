// The Templates and Components places of the building area (ADR 0037, BA-23; SPEC 8 and 10;
// `places-content/04`, `05`, `docking/08`), in Chromium:
// - Templates: a column for the Site, one per Post Type and a note for Pages; each Template made is a
//   167 × 209 card with Draft or Published and where it shows; "+" lists only the kinds not made yet,
//   and making an Archive template opens it on its archive page; Edit opens a Template as the
//   document; Revert to published takes a second click and puts the published version back;
// - Components: a card grid with search and the filters All · Allowed for Members · Unused in the
//   address; the details panel (Props, Allowed for Members, Used on, Edit, Duplicate, Delete);
//   Allowed for Members changes what a Member may add to a Page; deleting a placed Component names its
//   pages in a dialog that starts on Cancel, and removes its Placements; New Component makes one and
//   opens it;
// - a Member gets neither place;
// - both places and the dialog pass the accessibility checks, light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { announced, enterBuildingArea, frameOf, shellFocusVisible } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, forgetPageErrors, pageErrors, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let editor: TestAccount;
let superadmin: TestBrowser;
let siteId: string;
let blogId: string;
let teamId: string;
let pagesId: string;
let homeId: string;
let heroId: string;
let quoteId: string;
const slug = "bakery";

/** A published Component with one text Prop. */
async function component(name: string, publish = true) {
	const { api } = superadmin;
	const { component: made } = await api.components.create({
		siteId,
		name,
		props: [
			{ key: "headline", label: "Headline", type: "text" },
			{ key: "image", label: "Image", type: "media" },
		],
	});
	await api.components.saveMarkup({
		siteId,
		componentId: made.id,
		markup: "<section><h2>{{ props.headline }}</h2></section>",
	});
	if (publish) await api.components.publish({ siteId, componentId: made.id });
	return (await api.components.get({ siteId, componentId: made.id })).component;
}

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	superadmin = await local.superadmin();
	const { api } = superadmin;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).account;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Giulia Romano" })).account;

	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>Acme Bakery</p></header><main>{{@outlet}}</main>",
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	// The Search results template: published, then changed.
	const search = await api.templates.saveSearchTemplateMarkup({ siteId, markup: "<h1>Results</h1>" });
	await api.templates.publish({ siteId, templateId: search.template.id });
	await api.templates.saveSearchTemplateMarkup({ siteId, markup: "<h1>Search results</h1>" });

	pagesId = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id ?? "";
	const hero = await component("HeroSplit");
	heroId = hero.id;
	quoteId = (await component("CustomerQuote")).id;
	await component("OpeningHours", false);
	for (const [title, pageSlug] of [
		["Home", "home"],
		["Menu", "menu"],
	] as const) {
		const { entry } = await api.entries.create({ siteId, postTypeId: pagesId, title, slug: pageSlug });
		const state = await api.pageLayouts.get({ siteId, entryId: entry.id });
		await api.pageLayouts.save({
			siteId,
			entryId: entry.id,
			basedOn: state.version,
			layout: {
				placements: [{ id: "hero", component: hero.id, props: hero.draft.props, values: { headline: { en: title } } }],
			},
		});
		await api.entries.publish({ siteId, entryId: entry.id });
		if (pageSlug === "home") {
			homeId = entry.id;
			await api.pages.setHomePage({ siteId, pageId: entry.id });
		}
	}
	await api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [quoteId] });

	const blog = await api.postTypes.create({ siteId, name: "Blog posts", key: "post", urlPattern: "/blog/{slug}" });
	blogId = blog.postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: blogId,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	for (const [title, publish] of [
		["Rye", true],
		["Spelt", true],
		["Sourdough", false],
	] as const) {
		const made = await api.entries.create({ siteId, postTypeId: blogId, title });
		if (publish) await api.entries.publish({ siteId, entryId: made.entry.id });
	}
	teamId = (await api.postTypes.create({ siteId, name: "Team", key: "team", urlPattern: "/team/{slug}" })).postType.id;
});

afterAll(async () => {
	await install?.close();
});

/** Opens a shell address in the page (as a bookmark or a typed address does). */
async function go(page: Page, address: string): Promise<void> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build${address}`));
}

/** The shell's address with a place open over the menu page. */
const placed = (place: string, view?: string) =>
	`/page/menu?wc-place=${encodeURIComponent(place)}${view ? `&wc-view=${encodeURIComponent(view)}` : ""}`;

/** Waits until the API reads what the place saved. */
async function eventually(read: () => Promise<unknown>, expected: unknown): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt++) {
		if (JSON.stringify(await read()) === JSON.stringify(expected)) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	expect(await read()).toEqual(expected);
}

const searchParam = (page: Page, name: string) => new URL(page.url()).searchParams.get(name);

describe("Templates and Components, for Staff", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: "/page/menu" });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("Templates: a column for the Site, each Post Type and Pages; cards say Draft or Published and where they show", async () => {
		await page.locator('[data-wc-place="templates"]').click();
		await page.locator("[data-wc-template-columns]").waitFor();
		expect(searchParam(page, "wc-place")).toBe("templates");
		expect(await page.locator('[data-wc-place="templates"]').getAttribute("aria-pressed")).toBe("true");
		const columns = await page
			.locator("[data-wc-template-column]")
			.evaluateAll((all) => all.map((column) => column.getAttribute("data-wc-template-column")));
		expect(columns).toEqual(["site", blogId, teamId, "pages"]);
		// Sizes (SPEC 8): columns 200 wide, heads 44 high, cards 167 × 209.
		const head = await page.locator('[data-wc-template-column="site"] [data-wc-column-head]').boundingBox();
		expect([head?.width, head?.height]).toEqual([200, 44]);
		const card = page.locator('[data-wc-template-card="site"]');
		const picture = await card.locator("> div").first().boundingBox();
		expect([picture?.width, picture?.height]).toEqual([167, 209]);

		expect(await card.textContent()).toContain("Site templatePublishedevery page");
		expect(await page.locator('[data-wc-template-card="search"]').textContent()).toContain(
			"Search results templateUnpublished changes",
		);
		expect(await page.locator(`[data-wc-template-card="entry:${blogId}"]`).textContent()).toContain(
			"Entry templatePublished2 pages",
		);
		// Both the Site's are made: its column has no "+". Blog posts lacks only its Archive template.
		expect(await page.locator('[data-wc-template-column="site"] [data-wc-template-add]').count()).toBe(0);
		await page.locator(`[data-wc-template-column="${blogId}"] [data-wc-template-add]`).click();
		const menu = page.locator("[data-wc-template-make-menu]");
		await menu.waitFor();
		expect(await menu.textContent()).toBe("Not made yetArchive template");
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-template-make"))).toBe("archive");
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "detached" });
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-template-add"))).toBe(true);
		// Team has none: its dashed box makes the first, and lists both kinds.
		const empty = page.locator(`[data-wc-template-column="${teamId}"] [data-wc-template-empty]`);
		expect(await empty.textContent()).toContain("No templates yet.Create your first one.");
		await empty.locator("[data-wc-template-add]").click();
		expect(await menu.textContent()).toBe("Not made yetEntry templateArchive template");
		await page.keyboard.press("Escape");
		// Pages: a note, and the way to them.
		expect(await page.locator('[data-wc-template-column="pages"]').textContent()).toContain(
			"Pages are arranged with Components, not a Template.",
		);
		await page.locator("[data-wc-open-pages]").click();
		await page.waitForURL((url) => url.searchParams.get("wc-place") === "content/pages");
		await page.goBack();
		await page.locator("[data-wc-template-columns]").waitFor();
	});

	test("Revert to published takes a second click, and puts the published version back", async () => {
		await go(page, placed("templates"));
		const card = page.locator('[data-wc-template-card="search"]');
		await card.waitFor();
		// The keyboard reaches Edit and Revert, which show while focus is on them.
		await card.locator("[data-wc-template-edit]").focus();
		expect(await card.locator("[data-wc-template-edit]").isVisible()).toBe(true);
		await page.keyboard.press("Tab");
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-template-revert"))).toBe(true);
		expect(await shellFocusVisible(page)).toBe(true);
		await page.keyboard.press("Enter");
		expect(await card.locator("[data-wc-template-revert]").textContent()).toBe("Click again to revert");
		expect(
			(await superadmin.api.templates.list({ siteId })).templates.find((each) => each.kind === "search")?.template
				?.status,
		).toBe("changed");
		await page.keyboard.press("Enter");
		await card.locator("[data-wc-template-revert]").waitFor({ state: "detached" });
		expect(await card.textContent()).toContain("Search results templatePublished");
		const markup = await superadmin.api.templates.getSearchTemplateMarkup({ siteId });
		expect(markup.markup?.draft).toBe(markup.markup?.published);
		expect(markup.markup?.draft).toContain("Results");
		expect(await announced(page)).toBe("The Search results template is back to its published version");
		// Revert is gone with the changes: focus stays on the card, on Edit.
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-template-edit"))).toBe(true);
	});

	test("Edit opens a Template as the document", async () => {
		await go(page, placed("templates"));
		await page.locator(`[data-wc-template-card="entry:${blogId}"] [data-wc-template-edit]`).click();
		await page.waitForURL((url) => url.pathname.startsWith(`/_webcraft/build/entry-template/${blogId}`));
		expect(searchParam(page, "wc-place")).toBeNull();
		await page.locator("[data-wc-place-frame]").waitFor({ state: "detached" });
	});

	test("making an Archive template from + opens it on its archive page", async () => {
		const reported = pageErrors(page).length;
		await go(page, placed("templates"));
		await page.locator(`[data-wc-template-column="${blogId}"] [data-wc-template-add]`).click();
		await page.locator('[data-wc-template-make="archive"]').click();
		await page.waitForURL((url) => url.pathname === `/_webcraft/build/archive-template/${blogId}`);
		const made = (await superadmin.api.templates.list({ siteId })).templates.find(
			(each) => each.kind === "archive" && each.postType?.id === blogId,
		);
		expect(made?.template?.status).toBe("draft");
		const frame = await frameOf(page);
		await page.waitForFunction(() => {
			const shown = document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]")?.contentWindow?.location;
			return shown?.pathname === "/blog";
		});
		expect(new URL(frame.url()).pathname).toBe("/blog");
		// The frame shows published Structure for now: a never-published Archive template's page answers
		// 404 there, which the browser reports. Drafts of Structure on the canvas come with BA-08.
		forgetPageErrors(page, reported, (error) => error.includes("404 (Not Found)"));
		// Back in the place, Blog posts has both, and no "+".
		await go(page, placed("templates"));
		await page.locator(`[data-wc-template-card="archive:${blogId}"]`).waitFor();
		expect(await page.locator(`[data-wc-template-column="${blogId}"] [data-wc-template-add]`).count()).toBe(0);
	});

	test("Components: cards, the filters and the search in the address, and the details of the chosen one", async () => {
		await go(page, placed("templates"));
		await page.locator("[data-wc-template-columns]").waitFor();
		await page.locator('[data-wc-place="components"]').click();
		await page.locator("[data-wc-component-grid]").waitFor();
		expect(searchParam(page, "wc-place")).toBe("components");
		const names = () =>
			page
				.locator("[data-wc-component-card]")
				.evaluateAll((all) => all.map((card) => card.querySelector("[data-wc-component-name]")?.textContent));
		expect(await names()).toEqual(["CustomerQuote", "HeroSplit", "OpeningHours"]);
		const hero = page.locator(`[data-wc-component-card="${heroId}"]`);
		expect(await hero.textContent()).toBe("HeroSpliton 2 pages");
		expect(await page.locator(`[data-wc-component-card="${quoteId}"]`).textContent()).toBe(
			"CustomerQuoteon 0 pagesAllowed",
		);
		expect(await page.locator("[data-wc-component-card]", { hasText: "OpeningHours" }).textContent()).toContain(
			"Draft",
		);
		// Sizes (SPEC 8): cards 200 wide, the details panel 300.
		expect((await hero.boundingBox())?.width).toBe(200);
		expect((await page.locator("[data-wc-component-details]").boundingBox())?.width).toBe(300);

		// The first is chosen until another is.
		expect(await page.locator("[data-wc-component-details]").getAttribute("data-wc-component-details")).toBe(quoteId);
		await hero.click();
		expect(searchParam(page, "wc-view")).toBe(`component=${heroId}`);
		expect(await hero.getAttribute("aria-pressed")).toBe("true");
		const details = page.locator(`[data-wc-component-details="${heroId}"]`);
		expect(await details.locator("[data-wc-component-props]").textContent()).toBe("PropsheadlineTextimageMedia");
		expect(await details.locator("[data-wc-component-used-on]").textContent()).toBe("Used onHomeMenu");
		expect(await details.locator("[data-wc-component-allowed]").getAttribute("aria-checked")).toBe("false");

		// Unused is a filter, a history entry; the search replaces the address.
		await page.locator('[data-wc-component-filter="unused"]').click();
		await page.waitForURL((url) => url.searchParams.get("wc-view")?.includes("filter=unused") ?? false);
		expect(await names()).toEqual(["CustomerQuote", "OpeningHours"]);
		await page.locator("[data-wc-component-search]").fill("hours");
		await page.waitForURL((url) => url.searchParams.get("wc-view")?.includes("q=hours") ?? false);
		expect(await names()).toEqual(["OpeningHours"]);
		await page.goBack();
		await page.waitForURL((url) => !url.searchParams.get("wc-view")?.includes("filter=unused"));
		expect(await names()).toEqual(["CustomerQuote", "HeroSplit", "OpeningHours"]);
		expect(await page.locator(`[data-wc-component-details="${heroId}"]`).count()).toBe(1);
	});

	test("Allowed for Members changes what a Member may add to a Page", async () => {
		await go(page, placed("components", `component=${heroId}`));
		const allowed = page.locator(`[data-wc-component-details="${heroId}"] [data-wc-component-allowed]`);
		await allowed.click();
		await eventually(
			async () => (await superadmin.api.pageLayouts.settings({ siteId })).allowedComponents.includes(heroId),
			true,
		);
		expect(await allowed.getAttribute("aria-checked")).toBe("true");
		expect(await page.locator(`[data-wc-component-card="${heroId}"]`).textContent()).toContain("Allowed");
		await page.locator('[data-wc-component-filter="allowed"]').click();
		await page.locator(`[data-wc-component-card="${heroId}"]`).waitFor();
		expect(await page.locator("[data-wc-component-card]").count()).toBe(2);
		// What a Member is offered on a Page.
		const member = await install.install.signIn(editor);
		const offered = await member.api.pageLayouts.get({ siteId, entryId: homeId });
		expect(JSON.stringify(offered)).toContain(heroId);
	});

	test("Duplicate makes a copy with its Props and chooses it", async () => {
		await go(page, placed("components", `component=${quoteId}`));
		await page.locator(`[data-wc-component-details="${quoteId}"] [data-wc-component-duplicate]`).click();
		await page.locator("[data-wc-component-card]", { hasText: "CustomerQuoteCopy" }).waitFor();
		const copy = (await superadmin.api.components.list({ siteId })).components.find(
			(each) => each.name === "CustomerQuoteCopy",
		);
		expect(copy?.draft.props.map((prop) => prop.key)).toEqual(["headline", "image"]);
		expect(searchParam(page, "wc-view")).toBe(`component=${copy?.id}`);
		expect(await announced(page)).toBe("Duplicated as CustomerQuoteCopy");
		const markup = await superadmin.api.components.getMarkup({ siteId, componentId: copy?.id ?? "" });
		expect(markup.markup.draft).toContain("{{ props.headline }}");
	});

	test("deleting a placed Component: the dialog names its pages and starts on Cancel; Delete removes its Placements", async () => {
		await go(page, placed("components", `component=${heroId}`));
		const remove = page.locator(`[data-wc-component-details="${heroId}"] [data-wc-component-delete]`);
		await remove.click();
		const dialog = page.locator(`[data-wc-delete-component="${heroId}"]`);
		await dialog.locator("[data-wc-dialog-delete]:not([disabled])").waitFor();
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-dialog-cancel"))).toBe(true);
		expect(await shellFocusVisible(page)).toBe(true);
		expect(await dialog.textContent()).toContain(
			"Delete “HeroSplit”?Used on 2 pages, including Home. Deleting it removes every instance.",
		);
		expect(await dialog.locator("[data-wc-used-in]").textContent()).toBe("HomeMenu");
		await expectNoAxeViolations(page, "building area, deleting a Component");
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "detached" });
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-component-delete"))).toBe(true);
		expect(searchParam(page, "wc-place")).toBe("components");
		expect((await superadmin.api.components.get({ siteId, componentId: heroId })).component.name).toBe("HeroSplit");

		await remove.click();
		await dialog.locator("[data-wc-dialog-delete]:not([disabled])").click();
		await dialog.waitFor({ state: "detached" });
		await page.locator(`[data-wc-component-card="${heroId}"]`).waitFor({ state: "detached" });
		expect(await announced(page)).toBe("HeroSplit deleted");
		await expect(superadmin.api.components.get({ siteId, componentId: heroId })).rejects.toMatchObject({
			code: "COMPONENT_NOT_FOUND",
		});
		expect((await superadmin.api.pageLayouts.get({ siteId, entryId: homeId })).placements).toEqual([]);
		expect((await superadmin.api.pageLayouts.settings({ siteId })).allowedComponents).not.toContain(heroId);
	});

	test("New Component makes one from its name and opens it", async () => {
		await go(page, placed("components"));
		await page.locator("[data-wc-component-new]").click();
		const form = page.locator("[data-wc-component-create]");
		await form.waitFor();
		await page.keyboard.type("Price card");
		expect(await form.locator("[data-wc-component-tag]").textContent()).toBe("Tag: <PriceCard />");
		await page.keyboard.press("Enter");
		await page.waitForURL((url) => /^\/_webcraft\/build\/component\/[0-9a-f-]{36}$/.test(url.pathname));
		const made = (await superadmin.api.components.list({ siteId })).components.find(
			(each) => each.name === "PriceCard",
		);
		expect(new URL(page.url()).pathname).toBe(`/_webcraft/build/component/${made?.id}`);
	});

	for (const theme of THEMES) {
		test(`both places pass the accessibility checks, with the page in ${theme}`, async () => {
			await page.emulateMedia({ colorScheme: theme });
			await go(page, placed("templates"));
			await page.locator("[data-wc-template-card]").first().waitFor();
			await expectAccessibleScreen(page, `building area, Templates (${theme})`);
			await go(page, placed("components"));
			await page.locator("[data-wc-component-details]").waitFor();
			await expectAccessibleScreen(page, `building area, Components (${theme})`);
			await page.emulateMedia({ colorScheme: "light" });
		});
	}
});

describe("Templates and Components, for a Member", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: editor, siteId, slug, open: "/page/menu" });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("a Member gets neither place, even at their addresses", async () => {
		await go(page, placed("templates"));
		await page.locator('[data-wc-place-frame="templates"]').waitFor();
		await page.locator("[data-wc-place-pane]", { hasText: "only Staff change them" }).waitFor();
		expect(await page.locator("[data-wc-template-columns]").count()).toBe(0);
		await go(page, placed("components"));
		await page.locator("[data-wc-place-pane]", { hasText: "only Staff change them" }).waitFor();
		expect(await page.locator("[data-wc-component-grid]").count()).toBe(0);
		expect(await page.locator("[data-wc-component-new]").count()).toBe(0);
	});
});
