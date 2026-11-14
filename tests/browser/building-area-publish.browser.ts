// Publish in the building area's bottom bar (ADR 0037 › 1.5, BA-12; SPEC 10 and 13.8), in Chromium:
// - Staff publish a page with a changed Entry template and a changed Entry in one step, through the
//   sheet ⌘↵ opens; visitors then see both. The cell reads Publish with its count, Try again,
//   Publishing… and Published for 2 s, and never changes width (112 × 32); the toast offers the live page;
// - a Member's Revert puts one change back; Publish later schedules; Discard all asks first;
// - an Author's cell is "Send for review", 164 wide: they send the page with a note, then withdraw it;
// - the shell with the sheet open passes the accessibility checks, light and dark.
// The building area's own test of the editing bar's Publish menu (`tests/edit-mode/publish-menu.test.ts`),
// the Edit mode parts of `review.browser.ts` and the Builder's Publish (`builder.browser.ts`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Cookie, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";
import { announced, enterBuildingArea, frameOf } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let editor: TestAccount;
let author: TestAccount;
let workspaceId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).account;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Erin Editor" })).account;
	author = (await local.createMember({ workspaceId, role: "author", name: "Aidan Author" })).account;
});

afterAll(async () => {
	await install?.close();
});

type Bakery = { siteId: string; slug: string; postTypeId: string; entryId: string };

let sites = 0;

const PATH = "/blog/fresh-bread";
const ENTRY_TEMPLATE =
	'<article><h1>{{ title }}</h1><p data-part="subtitle">{{ subtitle }}</p><div>{{ intro }}</div></article>';

/** A Site with a Blog Post Type, its Entry template and one published post at /blog/fresh-bread. */
async function bakery(): Promise<Bakery> {
	const { api } = await install.install.superadmin();
	const slug = `bakery-${++sites}`;
	const siteId = (await install.install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const site = await api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main>{{@outlet}}</main>" });
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "subtitle", label: "Subtitle", type: "text" },
			{ key: "intro", label: "Intro", type: "richText" },
		],
	});
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: ENTRY_TEMPLATE,
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven", intro: "<p>Baked at seven.</p>" },
	});
	await api.entries.publish({ siteId, entryId: entry.id });
	return { siteId, slug, postTypeId: postType.id, entryId: entry.id };
}

/** Changes the post's Draft as someone else would, outside the building area. */
async function changeEntry(site: Bakery, fields: Record<string, string>): Promise<void> {
	const { api } = await install.install.superadmin();
	await api.entries.saveDraft({ siteId: site.siteId, entryId: site.entryId, fields });
}

/** The post's Draft and published values, as the admin reads them. */
async function entryOf(site: Bakery) {
	const { api } = await install.install.superadmin();
	return (await api.entries.get({ siteId: site.siteId, entryId: site.entryId })).entry;
}

const cell = (page: Page) => page.locator("[data-wc-publish]");
const sheet = (page: Page) => page.locator("[data-wc-publish-sheet]");

async function sizeOfCell(page: Page): Promise<{ width: number; height: number }> {
	const box = await cell(page).boundingBox();
	return { width: Math.round(box?.width ?? 0), height: Math.round(box?.height ?? 0) };
}

/** Waits until the cell is in `state` (`ready`, `publishing`, `published`, `failed`, `review`). */
async function cellIs(page: Page, state: string, timeout = 8000): Promise<void> {
	await page.waitForFunction(
		(wanted) => document.querySelector("[data-wc-publish]")?.getAttribute("data-wc-publish") === wanted,
		state,
		{ timeout },
	);
}

/** The rows of the open sheet, as their first line reads. */
async function rows(page: Page): Promise<string[]> {
	return page.locator("[data-wc-publish-rows] > li > span:nth-child(2) > span:first-child").allTextContents();
}

/** Waits for the sheet's rows to read `wanted`. */
async function rowsAre(page: Page, wanted: string[]): Promise<void> {
	const deadline = Date.now() + 8000;
	let seen = await rows(page);
	while (JSON.stringify(seen) !== JSON.stringify(wanted) && Date.now() < deadline) {
		await page.waitForTimeout(100);
		seen = await rows(page);
	}
	expect(seen).toEqual(wanted);
}

/** Waits for the live region to say `text`. */
async function said(page: Page, text: string): Promise<void> {
	const deadline = Date.now() + 8000;
	while ((await announced(page)) !== text && Date.now() < deadline) await page.waitForTimeout(100);
	expect(await announced(page)).toBe(text);
}

describe("Staff publish what the page shows", () => {
	let page: Page;
	let site: Bakery;
	let live: string;
	let cookies: Cookie[];

	beforeAll(async () => {
		site = await bakery();
		const { api } = await install.install.superadmin();
		// A changed Entry and a changed Entry template.
		await changeEntry(site, { subtitle: "Still warm" });
		await api.templates.saveEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			markup: ENTRY_TEMPLATE.replace("</article>", '<p data-part="new">Baked today</p></article>'),
		});
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId: site.siteId, slug: site.slug, open: `/page${PATH}` });
		cookies = await page.context().cookies();
		// The Site goes live once the building area is open on its Staging address: its live page is on its domain.
		live = await goLive(install.install, site.siteId, "live.localhost");
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("the cell counts the page's changes; ⌘↵ opens the sheet with the Entry's change and the Template", async () => {
		await page.waitForFunction(
			() => document.querySelector("[data-wc-publish]")?.textContent?.startsWith("Publish2"),
			undefined,
			{ timeout: 8000 },
		);
		expect(await sizeOfCell(page)).toEqual({ width: 112, height: 32 });
		expect(await cell(page).getAttribute("aria-keyshortcuts")).toMatch(/^(Meta|Control)\+Enter$/);
		expect(await cell(page).textContent()).toBe("Publish2, 2 changes");

		await page.locator("[data-wc-bar='undo']").focus();
		await page.keyboard.press("ControlOrMeta+Enter");
		await sheet(page).waitFor();
		expect(await cell(page).getAttribute("aria-expanded")).toBe("true");
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-publish-sheet"))).toBe(true);
		expect(await page.getByRole("dialog", { name: "Publish Fresh bread" }).isVisible()).toBe(true);
		await rowsAre(page, ["Subtitle: words changed", "Entry template · Blog posts: changed"]);
		// The Entry's change has Revert; the Template, a whole item, doesn't.
		expect(await page.locator("[data-wc-publish-revert]").count()).toBe(1);
		expect(await page.getByRole("button", { name: "Revert Subtitle: words changed" }).isVisible()).toBe(true);
		// The sheet sits above the button, inside the window.
		const [sheetBox, cellBox] = [await sheet(page).boundingBox(), await cell(page).boundingBox()];
		expect((sheetBox?.y ?? 0) + (sheetBox?.height ?? 0)).toBeLessThan(cellBox?.y ?? 0);
		expect((sheetBox?.x ?? 0) + (sheetBox?.width ?? 0)).toBeLessThanOrEqual(1440);
		// Escape closes it and gives focus back to the cell.
		await page.keyboard.press("Escape");
		await sheet(page).waitFor({ state: "detached" });
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-publish"))).toBe(true);
	});

	for (const theme of THEMES) {
		test(`the sheet and the shell pass the accessibility checks (${theme})`, async () => {
			const checked = await install.newPage(theme);
			await checked.setViewportSize({ width: 1440, height: 900 });
			await checked.context().addCookies(cookies);
			await checked.goto(install.siteUrl(site.slug, `/_webcraft/build/page${PATH}`));
			await frameOf(checked);
			await checked.waitForFunction(
				() => document.querySelector("[data-wc-publish]")?.getAttribute("data-wc-publish") === "ready",
			);
			await cellIs(checked, "ready");
			await checked.waitForFunction(() => !document.querySelector("[data-wc-publish]")?.hasAttribute("aria-disabled"));
			await cell(checked).click();
			await sheet(checked).waitFor();
			await rowsAre(checked, ["Subtitle: words changed", "Entry template · Blog posts: changed"]);
			await checked.locator("[data-wc-publish-later-switch]").click();
			await expectNoAxeViolations(checked, `building area Publish sheet (${theme})`);
			await checked.keyboard.press("Escape");
			await sheet(checked).waitFor({ state: "detached" });
			await expectAccessibleScreen(checked, `building area with Publish (${theme})`);
			await checked.context().close();
		});
	}

	test("a refused publish reads Try again; trying again publishes both together, and visitors see both", async () => {
		const sizes = new Set<string>();
		const measure = async () => sizes.add(JSON.stringify(await sizeOfCell(page)));
		await measure();
		// The first try can't reach the server.
		await page.route("**/_webcraft/build/api/rpc/publishing/publishAll", (route) => route.abort(), { times: 1 });
		await cell(page).click();
		await sheet(page).waitFor();
		await page.locator("[data-wc-publish-now='publish']").click();
		await cellIs(page, "failed");
		await measure();
		expect(await cell(page).textContent()).toBe("Try again");
		await said(page, "Couldn't publish: the server couldn't be reached.");
		expect((await entryOf(site)).published?.fields.subtitle).toBe("Out of the oven");

		// Trying again: Publishing… while the server answers (held a moment), then Published for 2 s.
		await page.route("**/_webcraft/build/api/rpc/publishing/publishAll", async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 400));
			await route.continue();
		});
		await cell(page).click();
		await cellIs(page, "publishing");
		await measure();
		expect(await cell(page).textContent()).toBe("Publishing…");
		await cellIs(page, "published");
		await measure();
		const publishedAt = Date.now();
		expect(await cell(page).textContent()).toBe("Published");
		await said(page, "Published. Visitors see the changes now.");
		// The toast: Published, with the live page.
		const toast = page.locator("[data-wc-publish-toast]");
		await toast.waitFor();
		// On the Site's live domain, as the Install writes a development domain's address.
		const href = (await page.locator("[data-wc-publish-live]").getAttribute("href")) ?? "";
		expect(new URL(href).hostname).toBe(new URL(live).hostname);
		expect(new URL(href).pathname).toBe(PATH);
		expect(await page.locator("[data-wc-publish-live]").textContent()).toBe("View live page");
		await cellIs(page, "ready");
		expect(Date.now() - publishedAt).toBeGreaterThanOrEqual(1500);
		await measure();
		// Nothing is left to publish: the cell is quiet and does nothing.
		await page.waitForFunction(
			() => document.querySelector("[data-wc-publish]")?.getAttribute("aria-disabled") === "true",
		);
		await measure();
		// The button never changed width.
		expect([...sizes]).toEqual([JSON.stringify({ width: 112, height: 32 })]);
		await page.unroute("**/_webcraft/build/api/rpc/publishing/publishAll");

		// Visitors see the Entry's change and the Template's.
		const response = await install.install.request(new Request(href));
		const html = await response.text();
		expect(html).toContain("Still warm");
		expect(html).toContain('data-part="new"');
	});
});

describe("a Member's sheet", () => {
	let page: Page;
	let site: Bakery;

	beforeAll(async () => {
		site = await bakery();
		await changeEntry(site, { subtitle: "Still warm", intro: "<p>Baked at six.</p>" });
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: editor, siteId: site.siteId, slug: site.slug, open: `/page${PATH}` });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("Revert puts one change back", async () => {
		await page.waitForFunction(
			() => !document.querySelector("[data-wc-publish]")?.hasAttribute("aria-disabled"),
			undefined,
			{
				timeout: 8000,
			},
		);
		await cell(page).click();
		await rowsAre(page, ["Subtitle: words changed", "Intro: words changed"]);
		// No Structure for a Member, and no translation note on a Site with one language.
		expect(await page.locator("[data-wc-publish-draft]").count()).toBe(0);
		expect(await page.locator("[data-wc-publish-translations]").count()).toBe(0);

		await page.getByRole("button", { name: "Revert Intro: words changed" }).click();
		await rowsAre(page, ["Subtitle: words changed"]);
		await said(page, "Reverted Intro: words changed.");
		const entry = await entryOf(site);
		expect(entry.draft.fields.intro).toEqual(entry.published?.fields.intro);
		expect(entry.draft.fields.subtitle).not.toEqual(entry.published?.fields.subtitle);
		expect(await cell(page).textContent()).toBe("Publish1, 1 change");
	});

	test("Publish later schedules the page's changes; nothing goes live yet", async () => {
		await page.locator("[data-wc-publish-later-switch]").click();
		expect(await page.locator("[data-wc-publish-later-switch]").getAttribute("aria-checked")).toBe("true");
		expect(await page.locator("[data-wc-publish-now]").textContent()).toBe("Schedule");
		// A time in the past is refused where it is chosen.
		await page.locator("[data-wc-publish-day]").fill("2020-01-01");
		await page.locator("[data-wc-publish-now]").click();
		expect(await page.getByRole("alert").filter({ hasText: "Choose a time in the future." }).count()).toBe(1);
		const year = new Date().getFullYear() + 1;
		await page.locator("[data-wc-publish-day]").fill(`${year}-03-02`);
		await page.locator("[data-wc-publish-time]").fill("09:30");
		await page.locator("[data-wc-publish-now]").click();
		await sheet(page).waitFor({ state: "detached" });
		await page.waitForFunction(() =>
			document.querySelector("[data-wc-messages]")?.textContent?.includes("Scheduled to publish on"),
		);

		const { api } = await install.install.superadmin();
		const { scheduled } = await api.publishing.scheduled({ siteId: site.siteId });
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]?.items.map((each) => each.item)).toEqual([{ kind: "entry", id: site.entryId }]);
		expect(new Date(scheduled[0]?.at ?? 0).getFullYear()).toBe(year);
		expect((await entryOf(site)).published?.fields.subtitle).toBe("Out of the oven");
	});

	test("Discard all asks first; Keep them keeps them, Discard puts the page back as published", async () => {
		await cell(page).click();
		await rowsAre(page, ["Subtitle: words changed"]);
		await page.locator("[data-wc-publish-discard]").click();
		expect(await page.locator("[data-wc-publish-discard-confirm]").textContent()).toContain(
			"Discard every change on this page? This can't be undone.",
		);
		// Focus starts on "Keep them".
		expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Keep them");
		await page.keyboard.press("Enter");
		await page.locator("[data-wc-publish-discard-confirm]").waitFor({ state: "detached" });
		await rowsAre(page, ["Subtitle: words changed"]);

		await page.locator("[data-wc-publish-discard]").click();
		await page.locator("[data-wc-publish-discard-yes]").click();
		await said(page, "Changes discarded.");
		await page.locator("[data-wc-publish-sheet] p", { hasText: "There are no changes here." }).waitFor();
		const entry = await entryOf(site);
		expect(entry.draft.fields.subtitle).toEqual(entry.published?.fields.subtitle);
	});
});

describe("an Author's sheet", () => {
	let page: Page;
	let site: Bakery;

	beforeAll(async () => {
		site = await bakery();
		await changeEntry(site, { subtitle: "Still warm" });
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: author, siteId: site.siteId, slug: site.slug, open: `/page${PATH}` });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("Send for review is 164 wide; it sends the page with a note, and Withdraw takes it back", async () => {
		await cellIs(page, "review");
		await page.waitForFunction(
			() => !document.querySelector("[data-wc-publish]")?.hasAttribute("aria-disabled"),
			undefined,
			{
				timeout: 8000,
			},
		);
		expect(await sizeOfCell(page)).toEqual({ width: 164, height: 32 });
		expect(await cell(page).textContent()).toBe("Send for review");

		await cell(page).click();
		await page.getByRole("dialog", { name: "Send for review" }).waitFor();
		await rowsAre(page, ["Subtitle: words changed"]);
		// No Publish and no Publish later for an Author.
		expect(await page.locator("[data-wc-publish-now]").count()).toBe(0);
		expect(await page.locator("[data-wc-publish-later]").count()).toBe(0);
		await page.getByRole("textbox", { name: "Add a note for your Editor (optional)" }).fill("New subtitle for spring");
		await page.locator("[data-wc-publish-send]").click();
		await sheet(page).waitFor({ state: "detached" });
		await said(page, "Sent for review. An Editor or Owner checks it.");
		const { api } = await install.install.superadmin();
		const waiting = (await api.reviews.list({ siteId: site.siteId })).reviews;
		expect(waiting).toHaveLength(1);
		expect(waiting[0]).toMatchObject({ status: "inReview", note: "New subtitle for spring" });
		// The cell keeps its width, and the Draft state says In review.
		expect(await sizeOfCell(page)).toEqual({ width: 164, height: 32 });
		await page.waitForFunction(
			() => document.querySelector("[data-wc-draft-state]")?.getAttribute("data-wc-draft-state") === "review",
		);

		await cell(page).click();
		await page.locator("[data-wc-publish-withdraw]").click();
		await said(page, "Withdrawn from review.");
		const after = (await api.reviews.list({ siteId: site.siteId })).reviews;
		expect(after.filter((review) => review.status === "inReview")).toHaveLength(0);
	});
});
