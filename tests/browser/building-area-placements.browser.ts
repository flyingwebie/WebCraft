// Placements, Props, Components edited in place, Loops and Conditions in the building area (BA-09;
// SPEC 5 and 7, `builder/05`, `06`, `07`), for Staff, in Chromium:
// - a Page's Placement is selected from the page and from Layers (outline and chip in the Component
//   colour, its row, the Props panel with "On N pages…"), and a Placement in a Template from Layers;
// - changing a Prop changes the page in place, and Undo takes it back;
// - "Edit Component" edits it in place: the rest of the page dimmed and locked, the Component panel on
//   the left (its Props and "+"), changes saved to the Component's Draft, Done back on the page with the
//   Placement selected;
// - an element a Loop repeats shows the Loop's settings, and `{{ post.` offers the item's values; a
//   Condition's panel changes its Otherwise;
// - a Placement moves in Layers by Alt with the arrows and by dragging, saving the Page layout; the Site
//   template's rows refuse it;
// - the shell with the Props panel, and while editing in place, passes the accessibility checks.
// The building area's own test of `code-layers` (Placements' Props, Loops, branches),
// `components-from-code` (Edit the Component), `component-history` (steps) and the Staff part of
// `page-layout-props` / `page-layouts` (moves in the tree).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { announced, enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectKeyboardUsable, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let homeId: string;
let quoteId: string;
let postTypeId: string;
const slug = "bakery";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).account;

	for (const name of ["site-header", "page", "hero", "quote", "quote__text", "post__title"]) {
		await api.designSystem.createClass({ siteId, name, styles: "" });
	}
	await api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	await api.globals.saveDraft({ siteId, fields: { tagline: "Open every day from seven." } });
	await api.globals.publish({ siteId });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header class="site-header"><p>Acme Bakery</p></header><main class="page">{{@outlet}}</main><footer><p>Harbour Street</p></footer>',
	});
	await api.templates.publish({ siteId, templateId: site.template.id });

	const component = async (name: string, props: object[], markup: string) => {
		const { component: made } = await api.components.create({ siteId, name, props: props as never });
		await api.components.saveMarkup({ siteId, componentId: made.id, markup });
		await api.components.publish({ siteId, componentId: made.id });
		return (await api.components.get({ siteId, componentId: made.id })).component;
	};
	const hero = await component(
		"HeroSplit",
		[{ key: "headline", label: "Headline", type: "text" }],
		'<section class="hero"><h1>{{ props.headline }}</h1></section>',
	);
	const quote = await component(
		"CustomerQuote",
		[
			{ key: "quote", label: "Quote", type: "text" },
			{ key: "name", label: "Name", type: "text" },
			{ key: "rating", label: "Show rating", type: "boolean" },
		],
		'<section class="quote"><p class="quote__text">{{ props.quote }}</p><p>{{ props.name }}</p>{{@if props.rating}}<p>★★★★★</p>{{/if}}</section>',
	);
	quoteId = quote.id;

	const pagesId = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id ?? "";
	for (const [title, pageSlug] of [
		["Home", "home"],
		["About", "about"],
	] as const) {
		const { entry } = await api.entries.create({ siteId, postTypeId: pagesId, title, slug: pageSlug });
		const state = await api.pageLayouts.get({ siteId, entryId: entry.id });
		await api.pageLayouts.save({
			siteId,
			entryId: entry.id,
			basedOn: state.version,
			layout: {
				placements: [
					...(pageSlug === "home"
						? [
								{
									id: "hero",
									component: hero.id,
									props: hero.draft.props,
									values: { headline: { en: "Fresh every morning" } },
								},
							]
						: []),
					{
						id: "quote",
						component: quote.id,
						props: quote.draft.props,
						values: { quote: { en: "The cardamom buns are the reason" }, name: { en: "Aoife Murphy" } },
					},
				],
			},
		});
		await api.entries.publish({ siteId, entryId: entry.id });
		if (pageSlug === "home") homeId = entry.id;
	}

	// Blog posts, a Loop of them, and an Entry template that places HeroSplit, repeats the Loop and tests a value.
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		key: "post",
		urlPattern: "/blog/{slug}",
	});
	postTypeId = postType.id;
	for (const title of ["Our sourdough starter, explained", "Five pastries for a rainy Tuesday"]) {
		const { entry } = await api.entries.create({ siteId, postTypeId, title });
		await api.entries.publish({ siteId, entryId: entry.id });
	}
	const { loop } = await api.loops.create({
		siteId,
		name: "latest-posts",
		source: "query",
		query: { postTypes: ["post"], sort: [{ by: "publishedAt", direction: "desc" }], limit: 3 },
	});
	await api.loops.publish({ siteId, loopId: loop.id });
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: [
			"<article>",
			'<HeroSplit headline="From the blog" />',
			"<h2>{{ title }}</h2>",
			'{{@loop latest-posts as post}}<h3 class="post__title">{{ post.title }}</h3>{{/loop}}',
			"{{@if site.tagline}}<p>{{ site.tagline }}</p>{{/if}}",
			"</article>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
});

let sharedPage: Promise<{ page: Page }> | undefined;

/** The one page in the building area the checks share (entering is rate-limited), at 1440 × 900, on Home. */
function shared() {
	sharedPage ??= (async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: "/page/home" });
		await settled(page);
		await tree(page)
			.getByRole("treeitem", { name: /CustomerQuote/ })
			.waitFor();
		return { page };
	})();
	return sharedPage;
}

/** Opens a page of the Site in the shell (the address, as a reload would), and waits for its tree. */
async function openPage(page: Page, path: string, row: RegExp): Promise<Frame> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build/page${path}`));
	const frame = await frameOf(page);
	await settled(page);
	await tree(page).getByRole("treeitem", { name: row }).first().waitFor();
	return frame;
}

afterAll(async () => {
	await (await sharedPage)?.page
		.context()
		.close()
		.catch(() => {});
	await install?.close();
});

const tree = (page: Page) => page.getByRole("tree", { name: "Elements of the page" });
const inspector = (page: Page) => page.locator('[data-wc-panel-body="inspector"]');
const chip = (page: Page) => page.locator("[data-wc-chip]");
const selectedIn = (page: Page) => new URL(page.url()).searchParams.get("wc-select");

/** What `read` gives once `done` accepts it, waiting up to 8 seconds. */
async function eventually<Value>(read: () => Promise<Value>, done: (value: Value) => boolean): Promise<Value> {
	const deadline = Date.now() + 8000;
	let value = await read();
	while (!done(value) && Date.now() < deadline) {
		await Bun.sleep(100);
		value = await read();
	}
	return value;
}

/** Home's Placements in order, and their Quote values, as the API reads the Draft. */
async function homeLayout(): Promise<{ order: string[]; quote: unknown }> {
	const { api } = await install.install.superadmin();
	const state = await api.pageLayouts.get({ siteId, entryId: homeId });
	return {
		order: state.placements.map((each) => each.id),
		quote: state.placements.find((each) => each.id === "quote")?.values.quote,
	};
}

/**
 * Lets the canvas's size readout leave before a keyboard walk: a pointer or a walk on a gutter shows
 * it, and it fades out after a moment (BA-04), its controls going with it mid-walk otherwise.
 */
async function readoutGone(page: Page): Promise<void> {
	await page.mouse.move(700, 450);
	await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
	await page.waitForTimeout(1800);
}

/** Clicks an element of the page in the frame, at its middle, as a person does. */
async function clickIn(page: Page, frame: Frame, selector: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			const element = frame.locator(selector).first();
			await element.scrollIntoViewIfNeeded({ timeout: 5000 });
			const box = await element.boundingBox();
			if (!box) throw new Error(`${selector} isn't on the page.`);
			await page.mouse.click(box.x + Math.min(12, box.width / 2), box.y + box.height / 2);
			await settled(page);
			return;
		} catch (failure) {
			if (attempt >= 3) throw failure;
			await page.waitForTimeout(250);
		}
	}
}

describe("a Page's Placements, for Staff", () => {
	test("a Placement is selected from the page and from Layers: outline, chip, row and the Props panel", async () => {
		const { page } = await shared();
		const frame = await frameOf(page);
		await clickIn(page, frame, "p.quote__text");
		await page.locator('[data-wc-outline="selected"]').waitFor();
		expect(await chip(page).textContent()).toMatch(/^CustomerQuote · \d+ × \d+$/);
		expect(await page.locator('[data-wc-outline="selected"]').getAttribute("class")).toContain("border-[#a78bfa]");
		const row = tree(page).getByRole("treeitem", { name: /^CustomerQuote/ });
		expect(await row.getAttribute("aria-selected")).toBe("true");
		expect(await page.locator('[data-wc-panel="inspector"] h2').textContent()).toBe("Props");
		expect(await page.locator('[data-wc-panel="inspector"]').textContent()).toContain("CustomerQuote");
		await inspector(page).locator("[data-wc-warning]").waitFor();
		expect(await inspector(page).locator("[data-wc-warning]").textContent()).toBe(
			"On 2 pages: editing the Component changes all.",
		);
		expect(await inspector(page).getByLabel("Quote").inputValue()).toBe("The cardamom buns are the reason");
		expect(await inspector(page).getByLabel("Name").inputValue()).toBe("Aoife Murphy");
		expect(await inspector(page).getByRole("switch", { name: "Show rating" }).getAttribute("aria-checked")).toBe(
			"false",
		);
		expect(selectedIn(page)).toBe("content/quote");

		// From Layers: the other Placement, and the canvas follows.
		await tree(page)
			.getByRole("treeitem", { name: /^HeroSplit/ })
			.click();
		await settled(page);
		expect(await chip(page).textContent()).toMatch(/^HeroSplit · /);
		expect(selectedIn(page)).toBe("content/hero");
		expect(await inspector(page).getByLabel("Headline").inputValue()).toBe("Fresh every morning");
		// HeroSplit shows on Home and on both Blog posts (their Entry template places it).
		expect(await inspector(page).locator("[data-wc-warning]").textContent()).toBe(
			"On 3 pages: editing the Component changes all.",
		);
	});

	test("changing a Prop changes the page in place; Undo takes it back", async () => {
		const { page } = await shared();
		const frame = await frameOf(page);
		await frame.evaluate(() => {
			(window as unknown as { kept?: boolean }).kept = true;
		});
		await tree(page)
			.getByRole("treeitem", { name: /^CustomerQuote/ })
			.click();
		const quote = inspector(page).getByLabel("Quote");
		await quote.fill("Warm, flaky and gone by nine");
		await quote.press("Enter");
		await (await frameOf(page)).locator("p.quote__text", { hasText: "Warm, flaky and gone by nine" }).waitFor();
		expect(await (await frameOf(page)).evaluate(() => (window as unknown as { kept?: boolean }).kept === true)).toBe(
			true,
		);
		expect((await eventually(homeLayout, (layout) => layout.quote === "Warm, flaky and gone by nine")).quote).toBe(
			"Warm, flaky and gone by nine",
		);
		// A switch is one step too.
		await inspector(page).getByRole("switch", { name: "Show rating" }).click();
		await (await frameOf(page)).locator("p", { hasText: "★★★★★" }).waitFor();

		await page.getByRole("button", { name: "Undo" }).first().click();
		await (await frameOf(page)).locator("p", { hasText: "★★★★★" }).waitFor({ state: "detached" });
		await page.getByRole("button", { name: "Undo" }).first().click();
		await (await frameOf(page)).locator("p.quote__text", { hasText: "The cardamom buns are the reason" }).waitFor();
		expect((await eventually(homeLayout, (layout) => layout.quote === "The cardamom buns are the reason")).quote).toBe(
			"The cardamom buns are the reason",
		);
		// The Page's Draft is changed through the shell's one copy of it: the person is never shown to
		// themselves as someone else editing the page.
		expect(await page.locator("[data-wc-messages]").textContent()).not.toContain("is editing this page too");
		expect(await page.locator('[data-wc-mark="person"]').count()).toBe(0);
	});

	test("a Placement moves in Layers by Alt with the arrows and by dragging; the Site template's rows refuse it", async () => {
		const { page } = await shared();
		const hero = tree(page).getByRole("treeitem", { name: /^HeroSplit/ });
		await hero.click();
		await page.keyboard.press("Alt+ArrowDown");
		expect((await eventually(homeLayout, (layout) => layout.order[0] === "quote")).order).toEqual(["quote", "hero"]);
		await (await frameOf(page)).locator("main section.quote + section.hero").waitFor();
		// At the end there is nowhere further to go: said, and nothing saved.
		await tree(page)
			.getByRole("treeitem", { name: /^HeroSplit/ })
			.click();
		await page.keyboard.press("Alt+ArrowDown");
		expect(await tree(page).locator("..").locator('[role="status"]').last().textContent()).toContain(
			"HeroSplit can't move further",
		);

		// By dragging HeroSplit's row onto the top half of CustomerQuote's.
		const source = tree(page).getByRole("treeitem", { name: /^HeroSplit/ });
		const target = tree(page).getByRole("treeitem", { name: /^CustomerQuote/ });
		await source.dragTo(target, { targetPosition: { x: 40, y: 3 } });
		expect((await eventually(homeLayout, (layout) => layout.order[0] === "hero")).order).toEqual(["hero", "quote"]);
		await (await frameOf(page)).locator("main section.hero + section.quote").waitFor();

		// Onto the Site template's footer row: refused, nothing saved.
		const footer = tree(page).getByRole("treeitem", { name: /^footer/ });
		await tree(page)
			.getByRole("treeitem", { name: /^CustomerQuote/ })
			.dragTo(footer, { targetPosition: { x: 40, y: 20 } });
		expect(await tree(page).locator("..").locator('[role="status"]').last().textContent()).toContain(
			"CustomerQuote stays in the Page layout",
		);
		expect((await homeLayout()).order).toEqual(["hero", "quote"]);

		// Each move was one step.
		await page.getByRole("button", { name: "Undo" }).first().click();
		expect((await eventually(homeLayout, (layout) => layout.order[0] === "quote")).order).toEqual(["quote", "hero"]);
		await page.getByRole("button", { name: "Undo" }).first().click();
		expect((await eventually(homeLayout, (layout) => layout.order[0] === "hero")).order).toEqual(["hero", "quote"]);
	});

	test("Edit Component edits it in place: the rest dimmed and locked, saved to its Draft, Done back on the Placement", async () => {
		const { page } = await shared();
		await tree(page)
			.getByRole("treeitem", { name: /^CustomerQuote/ })
			.click();
		await page.getByRole("button", { name: "Edit Component" }).click();
		await page.locator("[data-wc-in-place]").waitFor();
		expect(await announced(page)).toContain("Editing CustomerQuote in place");
		// The Component panel on the left, titled with its name; Done in the bar.
		const panel = page.locator('[data-wc-dock="left"] [data-wc-panel="component"]');
		await panel.waitFor();
		expect(await panel.locator("[data-wc-in-place-title]").textContent()).toBe("CustomerQuote");
		await page.getByRole("button", { name: "Done", exact: true }).waitFor();
		// Its first element is selected; the rest of the page is inert.
		expect(selectedIn(page)).toMatch(/^content\/quote#/);
		const frame = await frameOf(page);
		expect(await frame.locator("header.site-header").getAttribute("inert")).toBe("");
		expect(await frame.locator("section.hero").getAttribute("inert")).toBe("");
		expect(await frame.locator("section.quote").getAttribute("inert")).toBeNull();
		// While it is edited in place the rest of the page is inert, its h1 among it: the page has no
		// level-one heading to offer then, by design (it is locked, as a modal's background is).
		await readoutGone(page);
		await expectNoAxeViolations(page, "Component edited in place, light", ["page-has-heading-one"]);
		await expectKeyboardUsable(page, "Component edited in place, light");

		// Its elements change as a Template's do, saved to the Component's Draft.
		await clickIn(page, frame, "p.quote__text");
		expect(await chip(page).textContent()).toMatch(/^p · Paragraph · /);
		await inspector(page).getByLabel("Tag").selectOption("h3");
		await (await frameOf(page)).locator("h3.quote__text").waitFor();
		const { api } = await install.install.superadmin();
		const markup = async () => (await api.components.getMarkup({ siteId, componentId: quoteId })).markup?.draft ?? "";
		expect(await eventually(markup, (text) => /<h3[^>]* class="quote__text"/.test(text))).toMatch(
			/<h3[^>]* class="quote__text"/,
		);
		// The Component's Props, and "+" adds one.
		expect(await panel.locator("[data-wc-prop]").count()).toBe(3);
		await page.locator("[data-wc-add-prop]").click();
		await page.getByRole("menuitem", { name: "Text", exact: true }).click();
		await panel.locator('[data-wc-prop="text"]').waitFor();
		const props = async () => (await api.components.get({ siteId, componentId: quoteId })).component.draft.props;
		expect((await eventually(props, (list) => list.length === 4)).map((prop) => prop.key)).toEqual([
			"quote",
			"name",
			"rating",
			"text",
		]);
		// The rest of the page is locked: a click there leaves the selection where it was.
		const before = selectedIn(page);
		await page.mouse.click(700, 60);
		await settled(page);
		expect(selectedIn(page)).toBe(before);

		await page.getByRole("button", { name: "Done", exact: true }).click();
		await page.locator("[data-wc-in-place]").waitFor({ state: "detached" });
		expect(selectedIn(page)).toBe("content/quote");
		expect(await page.locator('[data-wc-panel="component"]').count()).toBe(0);
		expect(await (await frameOf(page)).locator("header.site-header").getAttribute("inert")).toBeNull();
		// Each was one step: the new Prop, then the Tag, are taken back.
		await page.getByRole("button", { name: "Undo" }).first().click();
		expect((await eventually(props, (list) => list.length === 3)).length).toBe(3);
		await page.getByRole("button", { name: "Undo" }).first().click();
		expect(await eventually(markup, (text) => /<p[^>]* class="quote__text"/.test(text))).toMatch(
			/<p[^>]* class="quote__text"/,
		);
	});

	test("the shell with the Props panel open passes the accessibility checks, light and dark", async () => {
		const { page } = await shared();
		await tree(page)
			.getByRole("treeitem", { name: /^CustomerQuote/ })
			.click();
		await inspector(page).getByLabel("Quote").waitFor();
		await readoutGone(page);
		await expectAccessibleScreen(page, "Props panel, light");
		await page.emulateMedia({ colorScheme: "dark" });
		try {
			await readoutGone(page);
			await expectAccessibleScreen(page, "Props panel, dark");
		} finally {
			await page.emulateMedia({ colorScheme: "light" });
		}
	});

	test("a Prop typed in while its declaration is replaced is saved into the new one: nothing is dropped unsaid", async () => {
		const { page } = await shared();
		const { api } = await install.install.superadmin();
		const { component } = await api.components.create({
			siteId,
			name: "Notice",
			props: [{ key: "first", label: "First", type: "text", default: "Baseline" }],
		});
		const markup = "<section><h2>{{ props.first }}</h2></section>";
		await api.components.saveMarkup({ siteId, componentId: component.id, markup });
		await api.components.publish({ siteId, componentId: component.id });
		const notice = (await api.components.get({ siteId, componentId: component.id })).component;
		const pagesId = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id ?? "";
		const { entry } = await api.entries.create({ siteId, postTypeId: pagesId, title: "Notices", slug: "notices" });
		const state = await api.pageLayouts.get({ siteId, entryId: entry.id });
		await api.pageLayouts.save({
			siteId,
			entryId: entry.id,
			basedOn: state.version,
			layout: { placements: [{ id: "notice", component: notice.id, props: notice.draft.props, values: {} }] },
		});
		await api.entries.publish({ siteId, entryId: entry.id });

		await openPage(page, "/notices", /^Notice/);
		await tree(page)
			.getByRole("treeitem", { name: /^Notice/ })
			.click();
		const first = inspector(page).getByLabel("First");
		await first.fill("Old declaration input");
		// Someone declares `first` again, as a new Prop with the same key, while it is typed in.
		const replacement = crypto.randomUUID();
		await api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: `{{@props}}\nfirst: text id="${replacement}" default="Replacement"\n{{/props}}\n${markup}`,
		});
		await api.components.publish({ siteId, componentId: component.id });
		await first.press("Enter");

		// Staff's Draft holds the new declaration by the time the value is written (publishing moves the
		// Page's Draft to it): what was typed is saved into it and shows, so there is nothing to tell.
		await (await frameOf(page)).locator("main h2", { hasText: "Old declaration input" }).waitFor();
		const placement = (
			await eventually(
				() => api.pageLayouts.get({ siteId, entryId: entry.id }),
				(read) => JSON.stringify(read.layout.placements[0]?.values ?? {}).includes("Old declaration input"),
			)
		).layout.placements[0];
		expect(placement?.props[0]?.id).toBe(replacement);
		expect(placement?.values).toEqual({ first: { en: "Old declaration input" } });
		expect(await announced(page)).not.toContain("wasn't kept");
	});
});

describe("Placements, Loops and Conditions of a Template, for Staff", () => {
	test("a Placement in a Template: its Props change its Template's Draft, one Undo step", async () => {
		const { page } = await shared();
		await openPage(page, "/blog/our-sourdough-starter-explained", /^article/);
		// The Entry template's article opens in the tree on its HeroSplit.
		await tree(page)
			.getByRole("treeitem", { name: /^article/ })
			.click();
		await page.keyboard.press("ArrowRight");
		await tree(page)
			.getByRole("treeitem", { name: /^HeroSplit/ })
			.click();
		expect(await page.locator('[data-wc-panel="inspector"] h2').textContent()).toBe("Props");
		const headline = inspector(page).getByLabel("Headline");
		expect(await headline.inputValue()).toBe("From the blog");
		await headline.fill("{{ title }}");
		await headline.press("Enter");
		await (await frameOf(page)).locator("section.hero h1", { hasText: "Our sourdough starter, explained" }).waitFor();
		const { api } = await install.install.superadmin();
		const markup = async () => (await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "";
		expect(await eventually(markup, (text) => text.includes('headline="{{ title }}"'))).toContain(
			'headline="{{ title }}"',
		);
		await page.getByRole("button", { name: "Undo" }).first().click();
		await (await frameOf(page)).locator("section.hero h1", { hasText: "From the blog" }).waitFor();
	});

	test("an element a Loop repeats shows the Loop's settings, and {{ post. offers the item's values", async () => {
		const { page } = await shared();
		const frame = await frameOf(page);
		await clickIn(page, frame, "h3.post__title");
		expect(await page.locator('[data-wc-panel="inspector"] h2').textContent()).toBe("Loop");
		const loop = inspector(page).locator("[data-wc-loop-panel]");
		await loop.waitFor();
		expect(await loop.getByLabel("Loop", { exact: true }).inputValue()).toBe("latest-posts");
		expect(await loop.getByLabel("Each item is called").inputValue()).toBe("post");
		expect(await loop.locator("[data-wc-loop-summary]").textContent()).toBe(
			"Entries of Blog posts, newest first, 3 at most. The Loop sets this, not the markup.",
		);
		await loop.getByRole("button", { name: "Open in Loops" }).waitFor();

		// A value of the item's element: `{{ post.` offers what the Loop's items hold.
		await inspector(page).getByRole("button", { name: "Add attribute" }).click();
		await inspector(page).getByLabel("Attribute name").fill("title");
		await inspector(page).getByLabel("Value", { exact: true }).fill("Read");
		await page.keyboard.press("Enter");
		const value = inspector(page).getByLabel("Value of title");
		await value.click();
		await value.press("End");
		await value.pressSequentially(" {{ post.ti");
		const options = page.getByRole("listbox", { name: "Values" }).getByRole("option");
		await options.first().waitFor();
		expect(await options.allTextContents()).toContain("post.title");
		await value.press("Enter");
		expect(await value.inputValue()).toBe("Read {{ post.title }}");
		await value.press("Enter");
		await (await frameOf(page)).locator('h3.post__title[title^="Read "]').first().waitFor();
	});

	test("a Condition's panel: its test, and Otherwise added and taken back", async () => {
		const { page } = await shared();
		await tree(page)
			.getByRole("treeitem", { name: /^\{\{@if\}\}/ })
			.click();
		expect(await page.locator('[data-wc-panel="inspector"] h2').textContent()).toBe("Condition");
		const panel = inspector(page).locator("[data-wc-condition-panel]");
		expect(await panel.getByLabel("Shows when").inputValue()).toBe("site.tagline");
		await panel.getByRole("switch", { name: "Otherwise" }).click();
		const { api } = await install.install.superadmin();
		const markup = async () => (await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "";
		expect(await eventually(markup, (text) => text.includes("{{@else}}"))).toContain("{{@else}}");
		await page.getByRole("button", { name: "Undo" }).first().click();
		expect(await eventually(markup, (text) => !text.includes("{{@else}}"))).not.toContain("{{@else}}");
	});
});
