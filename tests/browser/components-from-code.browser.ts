// Components from Code mode and the Builder (#134) in a real browser, light and dark: Make Component
// from the tree's right-click menu (and the keyboard's Shift+F10), with fixed text turned into a Prop,
// leaving a Placement and the same page; New Component from the insert toolbar's Component button,
// placed at the insert point with its empty markup in the HTML panel; the Command menu's actions; the
// Inspector's Props section rewriting the {{@props}} block; Bind to Prop on a link; the quick fix for
// `{{ props.x }}`; and a Placement's "on N pages" badge opening Go to on that Component's Placements.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let workspaceId: string;

const openedPages: Page[] = [];
async function testPage(theme: "light" | "dark") {
	const page = await install.newPage(theme);
	page.setDefaultTimeout(10000);
	openedPages.push(page);
	return page;
}
afterEach(async () => {
	await Promise.all(openedPages.splice(0).map((page) => page.close()));
});

beforeAll(async () => {
	install = await startBrowserInstall();
	workspaceId = (await install.install.createWorkspace("Parts Ltd")).id;
	staff = (await install.install.createStaff({ workspaces: [workspaceId] })).account;
});

afterAll(async () => {
	await install.close();
});

const SITE_TEMPLATE =
	'<header data-wc-id="header"><div data-wc-label="Promo" data-wc-id="promo">' +
	'<h2 data-wc-id="promo-title">Fresh today</h2><a href="/menu" data-wc-id="promo-link">See the menu</a></div>' +
	'<p data-wc-id="hello" data-wc-label="Greeting">Hello</p></header><main data-wc-id="main">{{@outlet}}</main>';

let sites = 0;

/** A Site of its own, with a home page and the Site template above. */
async function site(): Promise<{ siteId: string; slug: string }> {
	const { api } = await install.install.superadmin();
	const slug = `parts-${++sites}`;
	const { id: siteId } = await install.install.createSite(workspaceId, { name: `Parts ${sites}`, slug });
	const pages = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	if (!pages) throw new Error("Page Post Type missing");
	const home = (await api.entries.create({ siteId, postTypeId: pages.id, title: "Welcome" })).entry;
	await api.pages.setHomePage({ siteId, pageId: home.id });
	await api.templates.saveSiteTemplateMarkup({ siteId, markup: SITE_TEMPLATE });
	return { siteId, slug };
}

async function codeModePage(theme: "light" | "dark", siteId: string, slug: string): Promise<Page> {
	const page = await testPage(theme);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/sites/${siteId}`));
	await page.getByRole("button", { name: "Edit on site" }).click();
	await page.waitForURL((url) => url.hostname.startsWith(slug));
	await page.getByRole("button", { name: "Code", exact: true }).click();
	await page.getByRole("tree", { name: "Layers" }).getByRole("treeitem").first().waitFor();
	return page;
}

function layer(page: Page, name: string | RegExp) {
	return page.getByRole("tree", { name: "Layers" }).getByRole("treeitem", { name });
}

async function expectAnnounced(page: Page, text: string | RegExp): Promise<void> {
	await page.getByRole("status").filter({ hasText: text }).first().waitFor({ timeout: 10_000 });
}

/** The element with focus, through shadow roots: its role and accessible name. */
async function focused(page: Page): Promise<{ role: string | null; text: string }> {
	return page.evaluate(() => {
		let active = document.activeElement;
		while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
		return {
			role: active?.getAttribute("role") ?? active?.tagName.toLowerCase() ?? null,
			text: (active?.getAttribute("aria-label") ?? active?.textContent ?? "").trim(),
		};
	});
}

async function waitForFocus(page: Page, role: string, text: RegExp): Promise<void> {
	for (let attempt = 0; attempt < 60; attempt++) {
		const now = await focused(page);
		if (now.role === role && text.test(now.text)) return;
		await page.waitForTimeout(50);
	}
	expect(await focused(page)).toEqual({ role, text: String(text) });
}

/** Polls until `check` holds of what the API reads, failing with the last value read. */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
	let value = await read();
	for (let attempt = 0; attempt < 80 && !check(value); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		value = await read();
	}
	expect(check(value)).toBe(true);
	return value;
}

for (const theme of THEMES) {
	describe(`Components from Code mode, ${theme}`, () => {
		test("Make Component from the tree's right-click menu: a Placement, the same page, fixed text as a Prop", async () => {
			const { siteId, slug } = await site();
			const { api } = await install.install.superadmin();
			const page = await codeModePage(theme, siteId, slug);

			// The keyboard opens the same menu: Shift+F10 on the row, Escape puts focus back.
			await layer(page, /^Greeting/).click();
			await page.keyboard.press("Shift+F10");
			const menu = page.getByRole("menu", { name: "Layer actions" });
			await waitForFocus(page, "menuitem", /^Make Component$/);
			await page.keyboard.press("Escape");
			await menu.waitFor({ state: "hidden" });
			await waitForFocus(page, "treeitem", /^Greeting/);

			await layer(page, /^Promo/).click({ button: "right" });
			await menu.getByRole("menuitem", { name: "Make Component" }).click();
			const dialog = page.getByRole("dialog", { name: "Make Component" });
			await dialog.waitFor();
			expect(await dialog.getByRole("textbox", { name: "Name" }).inputValue()).toBe("Promo");
			await page.waitForTimeout(250);
			await expectNoAxeViolations(page, `Make Component dialog (${theme})`, ["region"]);
			await dialog.getByRole("checkbox", { name: /Turn the fixed text into a Prop.*Fresh today/ }).check();
			await dialog.getByRole("textbox", { name: "Prop name" }).fill("heading");
			await dialog.getByRole("button", { name: "Make Component", exact: true }).click();
			await dialog.waitFor({ state: "hidden" });
			await expectAnnounced(page, "Made the Component Promo: a Placement of it is here now.");

			const template = await eventually(
				async () => (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "",
				(markup) => markup.includes("<Promo "),
			);
			expect(template).not.toContain("See the menu");
			const promo = (await api.components.list({ siteId })).components.find((each) => each.name === "Promo");
			expect(promo?.draft.props).toEqual([
				expect.objectContaining({ key: "heading", type: "text", default: "Fresh today" }),
			]);
			const { markup } = await api.components.getMarkup({ siteId, componentId: promo?.id ?? "" });
			expect(markup.draft).toContain("{{ props.heading }}");
			expect(markup.draft).toContain("See the menu");
			// The page shows the same words, now through the Placement.
			await page.locator("header h2", { hasText: "Fresh today" }).waitFor();
			await page.locator("header a", { hasText: "See the menu" }).waitFor();
			await layer(page, /^Promo/)
				.and(page.locator("[aria-selected=true]"))
				.waitFor();
		});

		test("New Component from the insert toolbar's Component button goes at the insert point; its markup opens", async () => {
			const { siteId, slug } = await site();
			const { api } = await install.install.superadmin();
			const page = await codeModePage(theme, siteId, slug);
			await layer(page, /^Greeting/).click();
			await page.getByRole("button", { name: "Component", exact: true }).click();
			const menu = page.getByRole("dialog", { name: "Command menu" });
			const option = menu.getByRole("option", { name: /^New Component…/ });
			await option.waitFor();
			await page.keyboard.press("Enter");
			const dialog = page.getByRole("dialog", { name: "New Component" });
			await dialog.waitFor();
			await page.waitForTimeout(250);
			await expectNoAxeViolations(page, `New Component dialog (${theme})`, ["region"]);
			await dialog.getByRole("textbox", { name: "Name" }).fill("banner");
			await dialog.getByRole("button", { name: "Create Component" }).click();
			// The name is checked first: a PascalCase tag.
			await dialog.getByRole("alert").filter({ hasText: "PascalCase" }).waitFor();
			await dialog.getByRole("textbox", { name: "Name" }).fill("Promo");
			const { component: taken } = await api.components.create({ siteId, name: "Promo" });
			expect(taken.name).toBe("Promo");
			await dialog.getByRole("button", { name: "Create Component" }).click();
			await dialog.getByRole("alert").filter({ hasText: /Promo/ }).waitFor();
			await dialog.getByRole("textbox", { name: "Name" }).fill("Banner");
			await dialog.getByRole("button", { name: "Create Component" }).click();
			await dialog.waitFor({ state: "hidden" });
			await expectAnnounced(page, "Created the Component Banner.");

			const template = await eventually(
				async () => (await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "",
				(markup) => markup.includes("<Banner "),
			);
			// After the selected Greeting, inside the header.
			expect(template.indexOf("<Banner ")).toBeGreaterThan(template.indexOf("Hello"));
			expect(template.indexOf("<Banner ")).toBeLessThan(template.indexOf("</header>"));
			// Its empty markup is what the HTML panel shows now.
			const html = page.getByRole("textbox", { name: /^HTML of Banner/ });
			await html.waitFor();

			// Typing `{{ props.x }}` for a Prop it doesn't have offers to declare it, its type guessed from where it is read.
			await html.fill('<img src="{{ props.photo }}" alt="">');
			const fix = page.getByRole("button", { name: "Create the Prop “photo” (media)" });
			await fix.waitFor();
			await fix.click();
			await eventually(
				() => html.inputValue(),
				(text) => text.startsWith("{{@props}}\n  photo: media\n{{/props}}\n"),
			);
			const banner = (await api.components.list({ siteId })).components.find((each) => each.name === "Banner");
			await eventually(
				async () => (await api.components.get({ siteId, componentId: banner?.id ?? "" })).component.draft.props,
				(props) => props.some((prop) => prop.key === "photo" && prop.type === "media"),
			);
		});
	});
}

test("Bind to Prop on an image in Code mode: the Component's Prop, the image reading it", async () => {
	const { siteId, slug } = await site();
	const { api } = await install.install.superadmin();
	const { component } = await api.components.create({ siteId, name: "Photo" });
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<figure data-wc-id="figure"><img src="/bread.png" alt="Bread" data-wc-id="photo"></figure>',
	});
	await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: SITE_TEMPLATE.replace("</header>", '<Photo data-wc-id="photo-placement" /></header>'),
	});
	const page = await codeModePage("dark", siteId, slug);
	await page.locator('img[data-wc-code$="#photo"]').click();
	await page.getByRole("button", { name: /^Bind to Prop\s*:\s*Image$/ }).click();
	const dialog = page.getByRole("dialog", { name: "Bind the image to a Prop" });
	await dialog.waitFor();
	await expectNoAxeViolations(page, "Bind the image to a Prop (Code mode, dark)", ["region"]);
	await dialog.getByRole("button", { name: "Bind to Prop" }).click();
	await dialog.waitFor({ state: "hidden" });
	const saved = await eventually(
		() => api.components.getMarkup({ siteId, componentId: component.id }),
		(read) => read.markup.draft.includes('src="{{ props.image }}"'),
	);
	expect(saved.component.draft.props).toEqual([expect.objectContaining({ key: "image", type: "media" })]);
});

describe("the Command menu and the Builder", () => {
	test("Make Component and New Component are Actions; the Props section, Bind to Prop and the quick fix", async () => {
		const { siteId, slug } = await site();
		const { api } = await install.install.superadmin();
		const code = await codeModePage("light", siteId, slug);
		await layer(code, /^Greeting/).click();
		await code.keyboard.press("ControlOrMeta+k");
		const search = code.getByRole("dialog", { name: "Command menu" }).getByRole("combobox");
		for (const name of ["Make Component", "New Component"]) {
			await search.fill(name);
			await code
				.getByRole("option", { name: new RegExp(`^${name}`) })
				.first()
				.waitFor();
		}
		await code.keyboard.press("Enter");
		await code.getByRole("dialog", { name: "New Component" }).waitFor();
		await code.keyboard.press("Escape");

		const { component } = await api.components.create({ siteId, name: "Card" });
		await api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup:
				'<article data-wc-id="card"><a href="/menu" data-wc-id="more">Menu</a>' +
				'<img src="/bread.png" alt="Bread" data-wc-id="photo"></article>',
		});
		const page = await testPage("light");
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/builder/${siteId}/component/${component.id}`));
		await page.getByRole("tree", { name: "Layers" }).waitFor();
		await page.frameLocator("iframe[title^='Canvas']").getByText("Menu").waitFor();
		// The shared Draft is connected: changes can be made.
		await eventually(
			() => page.getByText("Connecting…").count(),
			(count) => count === 0,
		);
		const html = page.getByRole("textbox", { name: "Template markup" });

		// The Props section writes the Props; the {{@props}} block follows.
		const props = page.getByRole("region", { name: "Props of Card" });
		await props.getByText("No Props yet.").waitFor();
		await props.getByRole("button", { name: "Add a Prop" }).click();
		await eventually(
			() => html.inputValue(),
			(text) => text.startsWith("{{@props}}\n  prop: text"),
		);
		const name = props.getByRole("textbox", { name: "Name" });
		await name.fill("title");
		await name.press("Enter");
		await props.getByRole("checkbox", { name: "Required" }).check();
		await eventually(
			() => html.inputValue(),
			(text) => text.startsWith("{{@props}}\n  title: text required"),
		);

		// Bind to Prop on the link: a new Link Prop, its default the address there now.
		await page.getByRole("tree", { name: "Layers" }).getByRole("treeitem", { name: "a", exact: true }).click();
		await page.getByRole("button", { name: /^Bind to Prop\s*:\s*Link$/ }).click();
		const bind = page.getByRole("dialog", { name: "Bind the link to a Prop" });
		await bind.waitFor();
		await expectNoAxeViolations(page, "Bind to Prop dialog", ["region"]);
		await bind.getByRole("button", { name: "Bind to Prop" }).click();
		await bind.waitFor({ state: "hidden" });
		await eventually(
			() => html.inputValue(),
			(text) => text.includes('href="{{ props.link.url }}"') && text.includes("  link: link"),
		);

		// Bind to Prop on the image: a new Media Prop; the image then reads it.
		await page.getByRole("tree", { name: "Layers" }).getByRole("treeitem", { name: /^img/ }).click();
		await page.getByRole("button", { name: /^Bind to Prop\s*:\s*Image$/ }).click();
		const image = page.getByRole("dialog", { name: "Bind the image to a Prop" });
		await image.getByRole("textbox", { name: "Label" }).fill("Photo");
		await image.getByRole("button", { name: "Bind to Prop" }).click();
		await image.waitFor({ state: "hidden" });
		await eventually(
			() => html.inputValue(),
			(text) => text.includes('src="{{ props.photo }}"') && text.includes("  photo: media"),
		);

		// `{{ props.price }}` has no Prop: the quick fix declares it, its type guessed from where it is read.
		// Blank lines before the block are still the block, as the server reads it: no second block is made.
		const typed = `\n\n${(await html.inputValue()).replace(">Menu<", ">Menu {{ props.price.url }}<")}`;
		await html.fill(typed);
		const fix = page.getByRole("button", { name: "Create the Prop price (link)" });
		await fix.waitFor();
		await fix.click();
		const fixed = await eventually(
			() => html.inputValue(),
			(text) => text.includes("  price: link\n{{/props}}"),
		);
		expect(fixed.split("{{@props}}").length).toBe(2);
		await page.keyboard.press("ControlOrMeta+s");
		const saved = await eventually(
			() => api.components.get({ siteId, componentId: component.id }),
			(read) => read.component.draft.props.some((prop) => prop.key === "price"),
		);
		expect(saved.component.draft.props).toEqual([
			expect.objectContaining({ key: "title", type: "text", required: true }),
			expect.objectContaining({ key: "link", type: "link", default: { url: "/menu", text: "" } }),
			expect.objectContaining({ key: "photo", type: "media" }),
			expect.objectContaining({ key: "price", type: "link" }),
		]);

		// An error in the block blocks the save: the Draft keeps its Props.
		await html.fill((await html.inputValue()).replace("  price: link\n", "  price: nonsense\n"));
		await page
			.getByRole("button", { name: /^Line \d+, column \d+:$/ })
			.first()
			.waitFor();
		await page.keyboard.press("ControlOrMeta+s");
		await page.waitForTimeout(500);
		expect(
			(await api.components.get({ siteId, componentId: component.id })).component.draft.props.map((prop) => prop.type),
		).toEqual(["text", "link", "media", "link"]);
	});

	test("Make Component from the Builder's Inspector: Props for the Entry's values, bound on the Placement", async () => {
		const { siteId } = await site();
		const { api } = await install.install.superadmin();
		const { postType } = await api.postTypes.create({
			siteId,
			name: "Breads",
			urlPattern: "/breads/{slug}",
			fields: [{ key: "crust", label: "Crust", type: "text" }],
		});
		await api.entries.create({ siteId, postTypeId: postType.id, title: "Rye", fields: { crust: "Dark" } });
		await api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup:
				'<article data-wc-id="a"><div data-wc-id="d" data-wc-label="Bread"><h2 data-wc-id="h">{{ title }}</h2><p data-wc-id="p">{{ crust }}</p></div></article>',
		});
		const page = await testPage("dark");
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/builder/${siteId}/entry-template/${postType.id}`));
		await page.frameLocator("iframe[title^='Canvas']").getByText("Dark").waitFor();
		await layer(page, /^Bread/).click();
		await page.getByRole("button", { name: "Make Component" }).click();
		const dialog = page.getByRole("dialog", { name: "Make Component" });
		expect(await dialog.getByRole("textbox", { name: "Name" }).inputValue()).toBe("Bread");
		await dialog.getByRole("button", { name: "Make Component", exact: true }).click();
		await dialog.waitFor({ state: "hidden" });
		const markup = await eventually(
			async () => (await api.templates.getEntryTemplateMarkup({ siteId, postTypeId: postType.id })).markup?.draft ?? "",
			(text) => text.includes("<Bread "),
		);
		expect(markup).toContain('title="{{ title }}" crust="{{ crust }}"');
		await page.frameLocator("iframe[title^='Canvas']").getByText("Dark").waitFor();
		await layer(page, /^Bread/)
			.and(page.locator("[aria-selected=true]"))
			.waitFor();
	});

	test("a Placement's “on N pages” badge opens Go to on that Component's Placements", async () => {
		const { siteId, slug } = await site();
		const { api } = await install.install.superadmin();
		const pages = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
		if (!pages) throw new Error("Page Post Type missing");
		const { component } = await api.components.create({ siteId, name: "Notice" });
		await api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: '<p data-wc-id="n">Closed on Sundays</p>',
		});
		await api.components.publish({ siteId, componentId: component.id });
		const saved = await api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: `${SITE_TEMPLATE.replace("</header>", '<Notice data-wc-id="notice" /></header>')}`,
		});
		await api.templates.publish({ siteId, templateId: saved.template.id });
		for (const title of ["Welcome", "About us"]) {
			const listed = (await api.entries.list({ siteId, postTypeId: pages.id })).entries;
			const entry =
				listed.find((each) => each.draft.title === title) ??
				(await api.entries.create({ siteId, postTypeId: pages.id, title })).entry;
			await api.entries.publish({ siteId, entryId: entry.id });
		}
		const page = await codeModePage("light", siteId, slug);
		const badge = page.getByRole("button", { name: "on 2 pages" });
		await badge.waitFor();
		await badge.click();
		const menu = page.getByRole("dialog", { name: "Command menu" });
		await menu.getByRole("group", { name: "Placements of Notice" }).waitFor();
		const options = menu.getByRole("option");
		expect(await options.allTextContents()).toEqual([
			expect.stringContaining("Site template"),
			expect.stringContaining("Notice"),
		]);
		await page.waitForTimeout(250);
		await expectNoAxeViolations(page, "Go to, filtered to a Component's Placements", ["region"]);
	});
});
