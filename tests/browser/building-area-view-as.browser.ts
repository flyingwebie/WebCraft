// The editor's view (FX-04), for Staff, in Chromium at 1440 × 900:
// - "View as a client" on the rail offers the Member roles that change different things (an Owner or
//   Editor, an Author); choosing one draws client editing as a Member of that role gets it, with
//   "Viewing as a client" and the way back across the top, and nothing of Staff's (no docks, panels,
//   insert row, Staff's places, Insert in the Command menu, Templates in Go to); Sections offer only the
//   Allowed components, an Author's Publish sends for review and their Media has no folders to manage;
//   a reload stays in the view; the way back restores Staff's document, selection and panels;
// - "Preview on the site" on the bar opens the page in a new tab as visitors will see it once published;
// - the insert row's Image and Insert's Image and Figure: a Figure arrives holding its img (selected)
//   and a figcaption;
// - the view and the rail's menu pass the accessibility checks, light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Locator, Page } from "playwright";

import { photo, upload } from "../harness/images.ts";
import type { TestAccount } from "../harness/index.ts";
import { enterBuildingArea, eventually, frameOf, selectionIs, settled } from "./building-area.ts";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let imageId: string;
let heroId: string;
let bannerId: string;
const slug = "bakery";
const post = "/blog/fresh-bread";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).account;

	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>Acme Bakery</p></header><main>{{@outlet}}</main><footer><p>Harbour Street</p></footer>",
	});
	await api.templates.publish({ siteId, templateId: site.template.id });

	// Two Components; Members may arrange Pages with the first only.
	const made: string[] = [];
	for (const name of ["HeroSplit", "PriceBanner"]) {
		const { component } = await api.components.create({
			siteId,
			name,
			props: [{ key: "headline", label: "Headline", type: "text" }] as never,
		});
		await api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: "<section><h2>{{ props.headline }}</h2></section>",
		});
		await api.components.publish({ siteId, componentId: component.id });
		made.push(component.id);
	}
	[heroId = "", bannerId = ""] = made;
	await api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [heroId] });

	const pagesId = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id ?? "";
	const { entry: home } = await api.entries.create({ siteId, postTypeId: pagesId, title: "Home", slug: "home" });
	const heroProps = (await api.components.get({ siteId, componentId: heroId })).component.draft.props;
	const layout = await api.pageLayouts.get({ siteId, entryId: home.id });
	await api.pageLayouts.save({
		siteId,
		entryId: home.id,
		basedOn: layout.version,
		layout: {
			placements: [{ id: "hero", component: heroId, props: heroProps, values: { headline: { en: "Fresh daily" } } }],
		},
	});
	await api.entries.publish({ siteId, entryId: home.id });
	await api.pages.setHomePage({ siteId, pageId: home.id });

	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "subtitle", label: "Subtitle", type: "text" }],
	});
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1><p>{{ subtitle }}</p></article>",
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven at seven" },
	});
	await api.entries.publish({ siteId, entryId: entry.id });
	// Its Draft since: what the preview shows, and visitors don't yet.
	await api.entries.saveDraft({ siteId, entryId: entry.id, fields: { subtitle: "Rye on Fridays" } });

	const { media } = await api.media.upload({
		siteId,
		file: upload(await photo({ width: 640, height: 427 }), "loaf.jpg"),
	});
	await api.media.update({ siteId, mediaId: media.id, alt: "A sourdough loaf" });
	imageId = media.id;
	await local.drainJobs();
});

afterAll(async () => {
	await (await sharedPage)
		?.context()
		.close()
		.catch(() => {});
	await install?.close();
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
			.getByRole("treeitem", { name: /^article/ })
			.first()
			.waitFor();
		return page;
	})();
	return sharedPage;
}

const tree = (page: Page) => page.getByRole("tree", { name: "Elements of the page" });
const menu = (page: Page) => page.locator("dialog[data-wc-command-menu]");
const banner = (page: Page) => page.locator("[data-wc-as-client]");
const picker = (page: Page) => page.locator("[data-wc-media-picker]");

/** Each dock's panels, as Staff's shell draws them now. */
async function docksOf(page: Page): Promise<Record<string, string[]>> {
	return page.evaluate(() => {
		const docks: Record<string, string[]> = {};
		for (const dock of document.querySelectorAll<HTMLElement>("[data-wc-dock]"))
			docks[dock.dataset.wcDock ?? ""] = [...dock.querySelectorAll<HTMLElement>("[data-wc-panel]")].map(
				(panel) => panel.dataset.wcPanel ?? "",
			);
		return docks;
	});
}

/** Waits until focus is on a locator's element. */
async function focused(locator: Locator): Promise<void> {
	await eventually(
		() => locator.evaluate((element) => element === document.activeElement).catch(() => false),
		(value) => value,
		{ what: "Focus on the element" },
	);
}

/** Chooses a role from the rail's "View as a client", and waits for client editing to show the page. */
async function viewAs(page: Page, role: "Owner or Editor" | "Author"): Promise<Frame> {
	await page.locator('[data-wc-rail="view-as-client"]').click();
	const choices = page.getByRole("menu", { name: "View the page as a client" });
	await choices.waitFor();
	await choices.getByRole("menuitemradio", { name: new RegExp(`^${role}`) }).click();
	await banner(page).waitFor();
	await page.locator("[data-wc-client]").waitFor();
	const frame = await frameOf(page);
	await frame.waitForLoadState("load");
	return frame;
}

/** Back to Staff's view from the band, and waits for Staff's shell. */
async function backToStaff(page: Page): Promise<void> {
	await page.locator("[data-wc-as-client-back]").click();
	await page.locator("[data-wc-staff]").waitFor();
	await banner(page).waitFor({ state: "detached" });
	await settled(page);
}

/** Selects a row of the tree by its name, as a click does, and answers its reference. */
async function selectRow(page: Page, name: RegExp): Promise<string> {
	const row = tree(page).getByRole("treeitem", { name }).first();
	await row.click();
	await eventually(
		async () => row.getAttribute("aria-selected"),
		(value) => value === "true",
		{ what: `The row ${name}` },
	);
	return (await row.getAttribute("data-wc-ref")) ?? "";
}

/** Chooses the uploaded image in the Media picker. */
async function pickImage(page: Page): Promise<void> {
	await picker(page).waitFor();
	await picker(page).locator(`[data-wc-pick="${imageId}"]`).click();
	await picker(page).locator("[data-wc-pick-select]").click();
	await picker(page).waitFor({ state: "detached" });
}

describe("View as a client", () => {
	test("client editing as an Owner or Editor gets it, none of Staff's parts; back restores document, selection and panels", async () => {
		const page = await shared();
		// Staff's view as they leave it: the title selected, the Entry panel switched off.
		const frame = await frameOf(page);
		await frame.locator("article h1").click();
		const selected = await selectionIs(page, "article h1");
		await page.locator('[data-wc-rail="panels"]').click();
		await page.getByRole("menu", { name: "Panels" }).getByRole("menuitemcheckbox", { name: "Entry" }).click();
		await page.keyboard.press("Escape");
		const docks = await docksOf(page);
		expect(docks.right).not.toContain("entry");
		const staffAddress = page.url();

		const client = await viewAs(page, "Owner or Editor");
		// The band names the view and the role; focus is on the way back.
		expect(await banner(page).getAttribute("data-wc-as-client")).toBe("editor");
		expect(await banner(page).textContent()).toContain("Viewing as a client");
		expect(await banner(page).textContent()).toContain("As Owner or Editor");
		await focused(page.locator("[data-wc-as-client-back]"));
		// The same page, as client editing's document: no selection of Staff's.
		const address = new URL(page.url());
		expect(address.pathname).toBe(`/_webcraft/build/page${post}`);
		expect(address.searchParams.get("wc-select")).toBeNull();
		expect(new URL(client.url()).pathname).toBe(post);
		// Marked as a Member's page is: dashed at rest.
		await page.locator('[data-wc-client-mark="rest"]').first().waitFor();
		expect(await client.evaluate(() => document.documentElement.hasAttribute("data-wc-as-client"))).toBe(true);

		// Not hidden: absent.
		for (const absent of [
			"[data-wc-staff]",
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
			'[data-wc-rail="view-as-client"]',
		])
			expect({ absent, count: await page.locator(absent).count() }).toEqual({ absent, count: 0 });
		expect(await page.locator("[data-wc-client-rail] [data-wc-place]").allTextContents()).toEqual([
			"Page",
			"Content",
			"Media",
		]);

		// The Command menu is a Member's: Actions and Go to, no Insert, no Templates or Components.
		await page.keyboard.press("ControlOrMeta+k");
		await menu(page).waitFor();
		expect(await menu(page).getByRole("tab").allTextContents()).toEqual([
			expect.stringMatching(/^Actions/),
			expect.stringMatching(/^Go to/),
		]);
		await page.keyboard.press("ControlOrMeta+p");
		await menu(page).getByRole("option", { name: /^Home/ }).waitFor();
		await page.keyboard.type("template");
		await eventually(
			() => menu(page).getByRole("option").count(),
			(count) => count === 0,
			{ what: "No Template in Go to" },
		);
		await page.keyboard.press("Escape");
		await menu(page).waitFor({ state: "hidden" });

		// The Content place is the Members' (no Post Types); Media manages folders, as an Editor does.
		await page.locator('[data-wc-place="content"]').click();
		await page.locator("[data-wc-place-frame]").waitFor();
		await page.locator("[data-wc-new-entry]").first().waitFor();
		expect(await page.locator('[data-wc-content-row="post-types"]').count()).toBe(0);
		await page.locator('[data-wc-place="media"]').click();
		await page.locator("[data-wc-media-row]").first().waitFor();
		expect(await page.locator("[data-wc-new-folder]").count()).toBe(1);
		await page.locator('[data-wc-place="page"]').click();
		await page.locator("[data-wc-place-frame]").waitFor({ state: "detached" });

		// A reload stays in the view.
		await page.reload();
		await banner(page).waitFor();
		await page.locator('[data-wc-client-mark="rest"]').first().waitFor();

		await backToStaff(page);
		expect(page.url()).toBe(staffAddress);
		await selectionIs(page, "article h1");
		expect(new URL(page.url()).searchParams.get("wc-select")).toBe(selected);
		expect(await docksOf(page)).toEqual(docks);
		await focused(page.locator('[data-wc-rail="view-as-client"]'));

		// The Entry panel back on, for the checks after.
		await page.locator('[data-wc-rail="panels"]').click();
		await page.getByRole("menu", { name: "Panels" }).getByRole("menuitemcheckbox", { name: "Entry" }).click();
		await page.keyboard.press("Escape");
	});

	test("Sections offer the Allowed components only; an Author sends for review and manages no folders", async () => {
		const page = await shared();
		await page.goto(install.siteUrl(slug, "/_webcraft/build/page/"));
		await page.locator("[data-wc-staff]").waitFor();
		await settled(page);

		await viewAs(page, "Owner or Editor");
		await page.locator('[data-wc-bar="sections"]').click();
		await page.locator("[data-wc-sections-add]").click();
		const cards = page.locator("[data-wc-section-card]");
		await cards.first().waitFor();
		expect(await cards.evaluateAll((all) => all.map((card) => card.getAttribute("data-wc-section-card")))).toEqual([
			heroId,
		]);
		expect(bannerId).not.toBe(heroId);
		await page.keyboard.press("Escape");
		await backToStaff(page);

		// On the post, whose Draft has a change: an Author's Publish sends it for review.
		await page.goto(install.siteUrl(slug, `/_webcraft/build/page${post}`));
		await page.locator("[data-wc-staff]").waitFor();
		await settled(page);
		await viewAs(page, "Author");
		expect(await banner(page).textContent()).toContain("As Author");
		await eventually(
			async () => ((await page.locator("[data-wc-publish]").textContent()) ?? "").trim(),
			(text) => text.includes("Send for review"),
			{ what: "An Author's Publish" },
		);
		await page.locator('[data-wc-place="media"]').click();
		await page.locator("[data-wc-media-row]").first().waitFor();
		expect(await page.locator("[data-wc-new-folder]").count()).toBe(0);
		await page.locator('[data-wc-place="page"]').click();
		await backToStaff(page);
	});

	for (const theme of THEMES) {
		test(`the view and the rail's menu pass the accessibility checks, with the page in ${theme}`, async () => {
			const page = await shared();
			await page.emulateMedia({ colorScheme: theme });
			await page.goto(install.siteUrl(slug, `/_webcraft/build/page${post}`));
			await page.locator("[data-wc-staff]").waitFor();
			await settled(page);
			await page.locator('[data-wc-rail="view-as-client"]').click();
			await page.getByRole("menu", { name: "View the page as a client" }).waitFor();
			await expectNoAxeViolations(page, `building area, View as a client's menu (${theme})`);
			await page.keyboard.press("Escape");
			await viewAs(page, "Owner or Editor");
			await page.locator('[data-wc-client-mark="rest"]').first().waitFor();
			await expectNoAxeViolations(page, `building area, viewing as a client (${theme})`);
			await backToStaff(page);
		});
	}
});

describe("Preview on the site", () => {
	test("opens the page in a new tab as visitors will see it once its Draft is published", async () => {
		const page = await shared();
		await page.goto(install.siteUrl(slug, `/_webcraft/build/page${post}`));
		await page.locator("[data-wc-staff]").waitFor();
		await settled(page);
		const button = page.locator('[data-wc-bar="site-preview"]');
		// The test Site has no domain: the building area is on its Staging address, whose pages show the Drafts.
		expect(await button.getAttribute("data-wc-preview")).toBe("draft");
		expect(await button.getAttribute("aria-label")).toBe("Preview the Draft on the site (opens in a new tab)");
		expect(await button.getAttribute("href")).toBe(`${post}?wc-visitor=`);
		expect(await button.getAttribute("target")).toBe("_blank");

		const [opened] = await Promise.all([page.context().waitForEvent("page"), button.click()]);
		await opened.waitForLoadState("load");
		expect(new URL(opened.url()).pathname).toBe(post);
		// The Draft, as a visitor reads it: no shell, no agent, nothing marked.
		expect(await opened.locator("article p").textContent()).toBe("Rye on Fridays");
		expect(await opened.locator("[data-wc-item], [data-wc-code]").count()).toBe(0);
		expect(await opened.locator("#webcraft-building-area").count()).toBe(0);
		await opened.close();
	});
});

describe("Image and Figure", () => {
	test("the row's Image and Insert's Image; a Figure holds its img, selected, and a figcaption", async () => {
		const page = await shared();
		await page.goto(install.siteUrl(slug, `/_webcraft/build/page${post}`));
		await page.locator("[data-wc-staff]").waitFor();
		await settled(page);
		await tree(page)
			.getByRole("treeitem", { name: /^article/ })
			.first()
			.waitFor();

		// The row offers Image; Insert finds it by its tag, and Figure by its name and tag.
		expect(await page.locator('[data-wc-insert="image"]').getAttribute("aria-label")).toBe("Image");
		await page.keyboard.press("ControlOrMeta+i");
		await menu(page).waitFor();
		await page.keyboard.type("img");
		await menu(page)
			.getByRole("option", { name: /^Image/ })
			.waitFor();
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.type("figure");
		await menu(page)
			.getByRole("option", { name: /^Figure/ })
			.waitFor();
		// The bare <figure> element isn't listed besides it.
		expect(
			await menu(page)
				.getByRole("option", { name: /^<figure>/ })
				.count(),
		).toBe(0);
		await page.keyboard.press("Escape");
		await menu(page).waitFor({ state: "hidden" });

		// A Figure inside the article: the img selected, though the article could hold it.
		await selectRow(page, /^article/);
		await page.keyboard.press("ControlOrMeta+i");
		await menu(page).waitFor();
		await page.keyboard.type("figure");
		await menu(page)
			.getByRole("option", { name: /^Figure/ })
			.click();
		await pickImage(page);
		const frame = await frameOf(page);
		// The picture first (Media's sizes around its img), the caption under it.
		await frame.locator("article figure > :first-child img").waitFor();
		await frame.locator("article figure > figcaption:last-child").waitFor();
		expect(await frame.locator("article figure figcaption").textContent()).toBe("Caption");
		expect(await frame.locator("article figure img").getAttribute("alt")).toBe("A sourdough loaf");
		await selectionIs(page, "article figure img");
		await page.locator('[data-wc-bar="undo"]').click();
		await frame.locator("article figure").waitFor({ state: "detached" });

		// The row's Image, after the title: ⌘ forces after (a heading could hold a picture).
		await (await frameOf(page)).locator("article h1").click();
		await selectionIs(page, "article h1");
		await page.locator('[data-wc-insert="image"]').click({ modifiers: ["ControlOrMeta"] });
		await pickImage(page);
		await (await frameOf(page)).locator("article h1 + picture img").waitFor();
		await selectionIs(page, "article h1 + picture img");
		await page.locator('[data-wc-bar="undo"]').click();
		await (await frameOf(page)).locator("article h1 + picture").waitFor({ state: "detached" });
	});
});
