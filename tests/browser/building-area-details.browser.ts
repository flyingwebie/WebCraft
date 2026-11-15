// The Entry panel (Staff) and Page details / Post details (Members) in the building area (ADR 0037,
// BA-13; SPEC 5, 13.5 and 13.7; `builder/08`, `client-flows/01` and `03`), in Chromium:
// - the Entry panel is collapsed under Layers at first; opened, it has the Entry's Title, Address,
//   status and languages, then its Fields that don't show on the page (those on the page are changed
//   there), each typed: text, a choice, a Relationship, a file chosen in the Media picker;
// - every value saves to the Draft as it is typed (read back over the Management API);
// - a slug another page has is said beside the address box;
// - a page never published moves to its new address with its slug, and the shell's address follows;
// - Search and sharing counts against 60 and 160 and previews the search result;
// - a Member gets Page details on a Page (title, address, Search and sharing, the picture, Hide from
//   search engines) and Post details on a post (its Fields, then Search and sharing as a screen of its
//   own, its Back returning focus), in client editing's side panel;
// - the panels pass the accessibility checks, light and dark.
// The building area's own test of the old Page details drawer (`edit-mode-in-place.browser.ts` ›
// Page details; `tests/edit-mode/page-details.test.ts`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Page } from "playwright";

import { photo, upload } from "../harness/images.ts";
import type { TestAccount } from "../harness/index.ts";
import { enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, forgetPageErrors, pageErrors, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let editor: TestAccount;
let siteId: string;
let postTypeId: string;
let breadId: string;
let speltId: string;
let aboutId: string;
let writerId: string;
let photoId: string;
const slug = "bakery";

/**
 * The bottom bar's language button (BA-04's, `bottom-bar/LanguageMenu.tsx`) shows the code ("EN") but
 * is named "Language: English", which axe's `label-content-name-mismatch` refuses. It shows only on a
 * Site with several languages, as this one is; it isn't these panels', so it is left out of their
 * checks and reported to its owners.
 */
const CHECKED = { exclude: ["[data-wc-language]"] };

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).account;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Erin Editor" })).account;
	await api.languages.add({ siteId, code: "it" });

	const site = await api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main>{{@outlet}}</main>" });
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType: team } = await api.postTypes.create({
		siteId,
		name: "Team",
		urlPattern: "/team/{slug}",
		fields: [],
	});
	writerId = (await api.entries.create({ siteId, postTypeId: team.id, title: "Priya Shah" })).entry.id;
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "subtitle", label: "Subtitle", type: "text" },
			{ key: "excerpt", label: "Excerpt", type: "text", translatable: true },
			{
				key: "category",
				label: "Category",
				type: "select",
				translatable: false,
				options: [
					{ value: "baking", label: "Baking" },
					{ value: "recipes", label: "Recipes" },
				],
			},
			{ key: "writer", label: "Author", type: "relationship", postTypes: [team.key] },
			{ key: "cover", label: "Cover image", type: "media", translatable: false },
		],
	});
	postTypeId = postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: "<article><h1>{{ title }}</h1><p>{{ subtitle }}</p></article>",
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const post = async (title: string, publish: boolean) => {
		const { entry: made } = await api.entries.create({
			siteId,
			postTypeId,
			title,
			fields: { subtitle: `All about ${title.toLowerCase()}` },
		});
		if (publish) await api.entries.publish({ siteId, entryId: made.id });
		return made.id;
	};
	breadId = await post("Fresh bread", true);
	await post("Rye loaf", true);
	speltId = await post("Spelt", false);

	const pages = (await api.postTypes.list({ siteId })).postTypes.find((each) => each.builtIn === "page");
	const { entry: about } = await api.entries.create({ siteId, postTypeId: pages?.id ?? "", title: "About us" });
	await api.entries.publish({ siteId, entryId: about.id });
	aboutId = about.id;

	const { media } = await api.media.upload({
		siteId,
		file: upload(await photo({ width: 400, height: 300 }), "starter.jpg"),
	});
	await local.drainJobs();
	await api.media.update({ siteId, mediaId: media.id, alt: "A jar of starter" });
	photoId = media.id;
});

afterAll(async () => {
	await install?.close();
});

/** What `read` gives once `done` accepts it, waiting up to 6 seconds (a save waits for typing to pause). */
async function eventually<Value>(read: () => Promise<Value>, done: (value: Value) => boolean): Promise<Value> {
	const deadline = Date.now() + 6000;
	let value = await read();
	while (!done(value) && Date.now() < deadline) {
		await Bun.sleep(150);
		value = await read();
	}
	return value;
}

async function draftOf(entryId: string, language?: string) {
	const { api } = await install.install.superadmin();
	return (await api.entries.get({ siteId, entryId, ...(language ? { language } : {}) })).entry;
}

/** Waits until the frame shows `path`. */
async function framedAt(page: Page, path: string): Promise<Frame> {
	for (let attempt = 0; attempt < 120; attempt++) {
		const frame = await frameOf(page);
		if (new URL(frame.url()).pathname === path) return frame;
		await page.waitForTimeout(50);
	}
	throw new Error(`The frame never showed ${path}.`);
}

/** Opens a document of the shell in the same session (no new link: entering is limited per minute). */
async function go(page: Page, address: string): Promise<Frame> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build${address}`));
	return framedAt(page, address.replace(/^\/page/, "").split("?")[0] ?? "/");
}

/** Opens the Entry panel (collapsed at first) and waits for the Entry to be read. */
async function openEntryPanel(page: Page): Promise<void> {
	const panel = page.locator('[data-wc-panel="entry"]');
	await panel.waitFor();
	if ((await panel.getAttribute("data-collapsed")) !== null)
		await page.locator('[data-wc-panel-expand="entry"]').click();
	await page
		.locator('[data-wc-details-field="title"], [data-wc-details="post"], [data-wc-details="page"]')
		.first()
		.waitFor();
}

describe("the Entry panel, for Staff", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: "/page/blog/fresh-bread" });
		await framedAt(page, "/blog/fresh-bread");
	});

	test("is collapsed under Layers at first; opened, it has the Entry's own values, then the Fields not on the page", async () => {
		const panels = await page
			.locator('[data-wc-dock="right"] [data-wc-panel]')
			.evaluateAll((all) =>
				all.map((each) => ({ id: each.getAttribute("data-wc-panel"), collapsed: each.hasAttribute("data-collapsed") })),
			);
		expect(panels).toEqual([
			{ id: "layers", collapsed: false },
			{ id: "entry", collapsed: true },
		]);
		const header = await page.locator('[data-wc-panel="entry"] [data-wc-panel-header]').boundingBox();
		expect(header?.height).toBe(28);

		await openEntryPanel(page);
		const panel = page.locator("[data-wc-entry-panel]");
		expect(await panel.getByLabel("Title · English").inputValue()).toBe("Fresh bread");
		expect(await panel.locator('[data-wc-details-field="address"] [data-wc-details-prefix]').textContent()).toBe(
			"/blog/",
		);
		expect(await panel.getByLabel("Address · English", { exact: true }).inputValue()).toBe("fresh-bread");
		expect(await panel.locator("[data-wc-entry-status]").textContent()).toBe("Published");
		// Each language's translation, once read: the Italian has none of its own yet.
		await panel.locator('[data-wc-language-chip="it"][data-state="missing"]').waitFor();
		expect(
			await panel
				.locator("[data-wc-language-chip]")
				.evaluateAll((all) => all.map((each) => [each.getAttribute("data-wc-language-chip"), each.textContent])),
		).toEqual([
			["en", "ENEnglish: translated"],
			["it", "ITItaliano: not translated yet"],
		]);
		// The Subtitle shows on the page (a region): it is changed there, not here.
		expect(
			await panel
				.locator("[data-wc-entry-field]")
				.evaluateAll((all) => all.map((each) => each.getAttribute("data-wc-entry-field"))),
		).toEqual(["excerpt", "category", "writer", "cover"]);
		// The header's actions: find a Field, collapse the sections.
		await page.getByRole("button", { name: "Find a Field" }).click();
		await page.locator("[data-wc-entry-find]").fill("cat");
		expect(
			await panel
				.locator("[data-wc-entry-field]")
				.evaluateAll((all) => all.map((each) => each.getAttribute("data-wc-entry-field"))),
		).toEqual(["category"]);
		await page.locator("[data-wc-entry-find]").press("Escape");
		expect(await panel.locator("[data-wc-entry-field]").count()).toBe(4);
		await page.getByRole("button", { name: "Collapse the sections" }).click();
		expect(await panel.locator("[data-wc-entry-field]").count()).toBe(0);
		await page.getByRole("button", { name: "Expand the sections" }).click();
		expect(await panel.locator("[data-wc-entry-field]").count()).toBe(4);
	});

	test("every value saves to the Draft as it is typed or chosen", async () => {
		const panel = page.locator("[data-wc-entry-panel]");
		await panel.getByLabel("Excerpt · English").fill("Twelve years of one starter.");
		await panel.getByLabel("Category").selectOption("recipes");
		await panel.getByLabel("Author").selectOption(writerId);
		// A file comes from the Media picker.
		await panel.getByRole("button", { name: "Choose a file for Cover image" }).click();
		const picker = page.locator("[data-wc-media-picker]");
		await picker.locator(`[data-wc-pick="${photoId}"]`).click();
		await picker.locator("[data-wc-pick-select]").click();
		await picker.waitFor({ state: "detached" });

		const draft = await eventually(
			() => draftOf(breadId),
			(entry) => entry.draft.fields.cover === photoId && entry.draft.fields.excerpt !== undefined,
		);
		expect(draft.draft.fields).toMatchObject({
			excerpt: "Twelve years of one starter.",
			category: "recipes",
			writer: writerId,
			cover: photoId,
		});
		expect(draft.published?.fields.category ?? null).toBeNull();
		const cover = panel.locator('[data-wc-entry-field="cover"]');
		expect(await cover.getByText("starter.jpg").count()).toBe(1);
		expect(await cover.getByText("Alt: A jar of starter").count()).toBe(1);
		await eventually(
			() => panel.locator("[data-wc-entry-status]").textContent(),
			(text) => text === "PublishedUnpublished changes",
		);
		// The Draft state beside Publish counts the changes.
		expect(await page.locator("[data-wc-draft-state]").textContent()).toContain("Draft");

		// The title typed here shows in the page's title, which is the same value.
		await panel.getByLabel("Title · English").fill("Fresh bread, daily");
		expect(
			(
				await eventually(
					() => draftOf(breadId),
					(entry) => entry.draft.title === "Fresh bread, daily",
				)
			).draft.title,
		).toBe("Fresh bread, daily");
		const frame = await frameOf(page);
		expect(
			await eventually(
				() => frame.locator("h1").textContent(),
				(text) => text === "Fresh bread, daily",
			),
		).toBe("Fresh bread, daily");
	});

	test("a slug another page has is said beside the address box, and nothing is saved", async () => {
		const address = page.locator("[data-wc-entry-panel]").getByLabel("Address · English", { exact: true });
		const reported = pageErrors(page).length;
		await address.fill("rye-loaf");
		const problem = page.locator('[data-wc-details-field="address"] [data-wc-details-problem]');
		await problem.waitFor();
		expect(await problem.textContent()).toBe("Another page already has this address. Choose another one.");
		expect(await address.getAttribute("aria-invalid")).toBe("true");
		expect((await draftOf(breadId)).draft.slug).toBe("fresh-bread");
		// The refusal is the server's answer this test asks for, not a fault of the page.
		forgetPageErrors(page, reported, (error) => error.includes("status of 409"));

		await address.fill("fresh-bread");
		await problem.waitFor({ state: "detached" });
	});

	test("Search and sharing counts against 60 and 160 and previews the result", async () => {
		const panel = page.locator("[data-wc-entry-panel]");
		const section = panel.getByRole("button", { name: "Search and sharing" });
		if ((await section.getAttribute("aria-expanded")) !== "true") await section.click();
		const seoTitle = panel.getByLabel("Title in search results · English");
		expect(await seoTitle.getAttribute("placeholder")).toBe("Fresh bread, daily · Acme Bakery");
		await seoTitle.fill("Sourdough in Cork");
		expect(await panel.locator("[data-wc-details-counter]").first().textContent()).toBe("17 of 60");
		expect(await panel.locator("[data-wc-details-preview]").textContent()).toContain("Sourdough in Cork");
		expect(
			(
				await eventually(
					() => draftOf(breadId),
					(entry) => entry.draft.seo.title !== null,
				)
			).draft.seo.title,
		).toBe("Sourdough in Cork");
	});

	test("a language's chip shows the page in it", async () => {
		await page.locator('[data-wc-language-chip="it"]').click();
		await framedAt(page, "/it/blog/fresh-bread");
		await page.locator('[data-wc-language-chip="it"][aria-current="page"]').waitFor();
		await page.locator("[data-wc-entry-panel]").getByLabel("Title · Italian").waitFor();
		await page.locator('[data-wc-language-chip="en"]').click();
		await framedAt(page, "/blog/fresh-bread");
	});

	test("a page never published moves to its new address, and the shell's address follows", async () => {
		await go(page, "/page/blog/spelt");
		await openEntryPanel(page);
		await page.locator("[data-wc-entry-panel]").getByLabel("Address · English", { exact: true }).fill("spelt-loaf");

		await page.waitForURL((url) => url.pathname === "/_webcraft/build/page/blog/spelt-loaf");
		await framedAt(page, "/blog/spelt-loaf");
		expect((await draftOf(speltId)).draft.slug).toBe("spelt-loaf");
		expect(
			await page.locator("[data-wc-entry-panel]").getByLabel("Address · English", { exact: true }).inputValue(),
		).toBe("spelt-loaf");
	});

	for (const theme of THEMES) {
		test(`with the Entry panel open, the shell passes the accessibility checks, the page in ${theme}`, async () => {
			await page.emulateMedia({ colorScheme: theme });
			await go(page, "/page/blog/fresh-bread");
			await openEntryPanel(page);
			await settled(page);
			await page.mouse.move(0, 0);
			await expectAccessibleScreen(page, `building area, Entry panel (${theme})`, CHECKED);
		});
	}
});

/** Opens a Member's Page details (or Post details) from client editing's bar, and waits for the Entry. */
async function openDetails(page: Page): Promise<void> {
	if ((await page.locator('[data-wc-side-panel="pageDetails"]').count()) === 0)
		await page.locator('[data-wc-bar="page-details"]').click();
	await page.locator('[data-wc-details="post"], [data-wc-details="page"]').first().waitFor();
}

describe("Page details and Post details, for a Member", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: editor, siteId, slug, open: "/page/about-us" });
		await framedAt(page, "/about-us");
	});

	test("a Page gets Page details: its title, address, Search and sharing and the switch for search engines", async () => {
		await openDetails(page);
		const details = page.locator('[data-wc-details="page"]');
		expect(await page.locator("[data-wc-side-panel] h2").textContent()).toContain("Page details");
		expect(await details.getByLabel("Title · English").inputValue()).toBe("About us");
		expect(await details.locator("[data-wc-details-prefix]").textContent()).toMatch(/\/$/);

		const seoTitle = details.getByLabel("Title in search results · English");
		await seoTitle.fill("About Acme Bakery in Cork");
		const description = details.getByLabel("Description in search results · English");
		await description.fill("Three generations of bakers on Harbour Street.");
		const counters = details.locator("[data-wc-details-counter]");
		expect(await counters.nth(0).textContent()).toBe("25 of 60");
		expect(await counters.nth(1).textContent()).toBe("46 of 160");
		expect(await details.locator("[data-wc-details-preview]").textContent()).toContain("Three generations");
		await details.getByRole("switch", { name: "Hide from search engines" }).click();

		const saved = await eventually(
			() => draftOf(aboutId),
			(entry) => entry.draft.seo.noindex && entry.draft.seo.description !== null,
		);
		expect(saved.draft.seo).toMatchObject({
			title: "About Acme Bakery in Cork",
			description: "Three generations of bakers on Harbour Street.",
			noindex: true,
		});
		expect(saved.published?.seo.noindex).toBe(false);
	});

	test("a post gets Post details: its Fields, then Search and sharing as a screen of its own", async () => {
		await go(page, "/page/blog/rye-loaf");
		await openDetails(page);
		expect(await page.locator("[data-wc-side-panel] h2").textContent()).toContain("Post details");
		const details = page.locator('[data-wc-details="post"]');
		await details.getByLabel("Category").selectOption("baking");
		await details.locator("[data-wc-details-search]").click();
		const search = page.locator('[data-wc-details="search"]');
		await search.waitFor();
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-details-back"))).toBe(true);
		expect(await search.getByLabel("Address · English", { exact: true }).inputValue()).toBe("rye-loaf");
		await search.getByRole("button", { name: "Back to Post details" }).click();
		await page.locator('[data-wc-details="post"]').waitFor();
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-details-search"))).toBe(true);
		const { api } = await install.install.superadmin();
		const rye = (await api.entries.list({ siteId, postTypeId })).entries.find(
			(each) => each.draft.title === "Rye loaf",
		);
		expect(
			(
				await eventually(
					() => draftOf(rye?.id ?? ""),
					(entry) => entry.draft.fields.category === "baking",
				)
			).draft.fields.category,
		).toBe("baking");
	});

	for (const theme of THEMES) {
		test(`Post details and Page details pass the accessibility checks, the page in ${theme}`, async () => {
			await page.emulateMedia({ colorScheme: theme });
			await go(page, "/page/blog/rye-loaf");
			await openDetails(page);
			await settled(page);
			await page.mouse.move(0, 0);
			await expectAccessibleScreen(page, `building area, Post details (${theme})`);
			await page.locator("[data-wc-details-search]").click();
			await page.locator('[data-wc-details="search"]').waitFor();
			await expectNoAxeViolations(page, `building area, Post details › Search and sharing (${theme})`, []);

			// This Site's About page has no heading of its own (its Page layout is empty): the page's, not the panel's.
			await go(page, "/page/about-us");
			await openDetails(page);
			await settled(page);
			await expectNoAxeViolations(page, `building area, Page details (${theme})`, ["page-has-heading-one"]);
		});
	}
});
