// The building area's documents and addresses (ADR 0037, BA-06; plan 1.4), in Chromium:
// - each form of address opens its document (a page, the Site template on the home page, an Entry
//   template on its Entry's page, an Archive template on its archive, a Component and a Search
//   results template with no page on the stand-in, a Form waiting for its place), and a reload
//   reopens it;
// - Back returns to the previous document and Forward goes again; "Back to {page}" goes back to the
//   page a Template was opened from;
// - "Rendered by" on an Entry's page opens its Entry template there; the Entry picker swaps the page
//   in place (the address names the Entry, Back doesn't step through Entries);
// - with the interface hidden, a link clicked in the frame opens that page and the address follows;
// - an address naming nothing of the Site (another Site's Component, a path off the Site) opens
//   nothing, and says so;
// - Templates and Components rows in the admin open the building area at them;
// - the chrome passes the accessibility checks with the document's controls, light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Page } from "playwright";

import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { announced, enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, forgetPageErrors, pageErrors, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let superadmin: TestBrowser;
let siteId: string;
let postTypeId: string;
let freshId: string;
let ryeId: string;
let componentId: string;
let otherComponentId: string;
const slug = "bakery";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	superadmin = await local.superadmin();
	const { api } = superadmin;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).account;

	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: [
			'<header><p>Welcome to <a href="/">Acme Bakery</a>.</p>',
			'<nav><a href="/menu">Our menu</a> <a href="https://example.com/elsewhere">Elsewhere</a></nav></header>',
			"<main>{{@outlet}}</main>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	postTypeId = postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: "<article><h1>{{ title }}</h1><p>From the blog</p></article>",
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const archive = await api.templates.saveArchiveTemplateMarkup({
		siteId,
		postTypeId,
		markup: "<h1>All our posts</h1>",
	});
	await api.templates.publish({ siteId, templateId: archive.template.id });
	await api.templates.saveSearchTemplateMarkup({ siteId, markup: "<h1>Found for you</h1>" });
	for (const title of ["Rye loaf", "Fresh bread"]) {
		const { entry: post } = await api.entries.create({ siteId, postTypeId, title });
		await api.entries.publish({ siteId, entryId: post.id });
		if (title === "Rye loaf") ryeId = post.id;
		else freshId = post.id;
	}
	const pagesType = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	for (const [title, pageSlug] of [
		["Home", "home"],
		["Our menu", "menu"],
	] as const) {
		const { entry: page } = await api.entries.create({
			siteId,
			postTypeId: pagesType?.id ?? "",
			title,
			slug: pageSlug,
		});
		await api.entries.publish({ siteId, entryId: page.id });
		if (pageSlug === "home") await api.pages.setHomePage({ siteId, pageId: page.id });
	}
	const { component } = await api.components.create({ siteId, name: "CustomerQuote" });
	componentId = component.id;
	await api.components.saveMarkup({ siteId, componentId, markup: "<blockquote>Best rye in Cork.</blockquote>" });
	const otherId = (await local.createSite(workspaceId, { name: "Other", slug: "other" })).id;
	otherComponentId = (await api.components.create({ siteId: otherId, name: "Elsewhere" })).component.id;
});

afterAll(async () => {
	await install?.close();
});

/** The shell's address, after `/_webcraft/build`. */
function shellAddress(page: Page): string {
	const url = new URL(page.url());
	// What is selected (`wc-select`, BA-08) is kept beside the document, never part of its address.
	url.searchParams.delete("wc-select");
	return `${url.pathname.slice("/_webcraft/build".length)}${url.search}`;
}

/** Waits until the frame shows `path` (its path on the Site, or the stand-in's), and answers the frame. */
async function framedAt(page: Page, path: string): Promise<Frame> {
	const frame = await frameOf(page);
	await page.waitForFunction(
		(expected) => {
			const shown = document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]")?.contentWindow?.location;
			return shown ? `${shown.pathname}${shown.search}` === expected : false;
		},
		path,
		{ timeout: 10_000 },
	);
	await frame.waitForLoadState("load");
	await settled(page);
	return frame;
}

/** Waits until the shell's address is `address` (after `/_webcraft/build`). */
async function addressed(page: Page, address: string): Promise<void> {
	await page.waitForURL((url) => `${url.pathname.slice("/_webcraft/build".length)}${url.search}` === address, {
		timeout: 10_000,
	});
}

/** Opens a shell address in the page (as a bookmark or a typed address does). */
async function go(page: Page, address: string): Promise<void> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build${address}`));
}

const bar = (page: Page, which: string) => page.locator(`[data-wc-bar="${which}"]`);

/**
 * One page at 1440 × 900 in the building area for every check (entering is rate-limited by address):
 * each check opens what it needs by its address.
 */
describe("documents and addresses", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: "/page/blog/fresh-bread" });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("each form of address opens its document, and a reload reopens it", async () => {
		const cases: { address: string; frame: string; shows: string }[] = [
			{ address: "/page/blog/fresh-bread", frame: "/blog/fresh-bread", shows: "Fresh bread" },
			{ address: "/site-template", frame: "/", shows: "Welcome to" },
			{ address: `/entry-template/${postTypeId}?entry=${ryeId}`, frame: "/blog/rye-loaf", shows: "Rye loaf" },
			{ address: `/archive-template/${postTypeId}`, frame: "/blog", shows: "All our posts" },
			{
				address: `/component/${componentId}`,
				frame: `/_webcraft/build/stand-in/component/${componentId}`,
				shows: "Best rye in Cork.",
			},
			{ address: "/search-template", frame: "/_webcraft/build/stand-in/search-template", shows: "Found for you" },
		];
		for (const each of cases) {
			await go(page, each.address);
			let frame = await framedAt(page, each.frame);
			expect([each.address, shellAddress(page)]).toEqual([each.address, each.address]);
			expect(await frame.locator("body").textContent()).toContain(each.shows);

			await page.reload();
			frame = await framedAt(page, each.frame);
			expect([each.address, shellAddress(page)]).toEqual([each.address, each.address]);
			expect(await frame.locator("body").textContent()).toContain(each.shows);
		}
		// The stand-in runs none of the Site's scripts: the agent is its only one.
		const standIn = await (async () => {
			await go(page, `/component/${componentId}`);
			return framedAt(page, `/_webcraft/build/stand-in/component/${componentId}`);
		})();
		expect(await standIn.evaluate(() => [...document.scripts].map((script) => new URL(script.src).pathname))).toEqual([
			expect.stringMatching(/^\/_webcraft\/edit\/assets\/agent-[0-9a-f]+\.js$/),
		]);
	});

	test("an Entry template without an Entry opens on the builder's sample (its newest), and the address names it", async () => {
		// Which Entry is newest is the visual builder's to say (the last one saved, which opening a page
		// in Edit mode can change): asked here as the shell asks it.
		const { entryId } = await superadmin.api.builder.destinations({
			siteId,
			target: { kind: "entryTemplate", postTypeId },
		});
		const sample =
			entryId === ryeId
				? { path: "/blog/rye-loaf", title: "Rye loaf" }
				: { path: "/blog/fresh-bread", title: "Fresh bread" };

		await go(page, `/entry-template/${postTypeId}`);

		await framedAt(page, sample.path);
		await addressed(page, `/entry-template/${postTypeId}?entry=${entryId}`);
		expect(await bar(page, "preview").textContent()).toContain(`Preview: ${sample.title}`);
	});

	test("a Form waits for its place, and says so", async () => {
		await go(page, "/form/0b5f6a1e-2c3d-4e5f-8a9b-0c1d2e3f4a5b");

		const notice = page.locator('[data-wc-no-document="later"]');
		await notice.waitFor();
		expect(await notice.getByRole("heading").textContent()).toBe("Forms open in the Forms place");
		expect(await page.locator("iframe[data-wc-frame]").count()).toBe(0);
	});

	test("Rendered by opens the Entry template on the page; Back and Forward step between the two; Back to returns", async () => {
		await go(page, "/page/blog/fresh-bread");
		await framedAt(page, "/blog/fresh-bread");
		const renderedBy = bar(page, "rendered-by");
		await renderedBy.waitFor();
		expect(await renderedBy.textContent()).toBe("Rendered by: Blog posts · Entry template");

		await renderedBy.click();
		await addressed(page, `/entry-template/${postTypeId}?entry=${freshId}`);
		await framedAt(page, "/blog/fresh-bread");
		expect(await announced(page)).toBe("Opened Blog posts · Entry template");
		expect(await bar(page, "back").getAttribute("aria-label")).toBe("Back to Fresh bread");
		expect(await bar(page, "rendered-by").count()).toBe(0);

		// Back: the page again, the bar's document controls gone; Forward: the Template again.
		await page.goBack();
		await addressed(page, "/page/blog/fresh-bread");
		await bar(page, "rendered-by").waitFor();
		expect(await bar(page, "back").count()).toBe(0);
		await page.goForward();
		await addressed(page, `/entry-template/${postTypeId}?entry=${freshId}`);
		await bar(page, "back").waitFor();

		// "Back to Fresh bread" goes back there.
		await bar(page, "back").click();
		await addressed(page, "/page/blog/fresh-bread");
		await framedAt(page, "/blog/fresh-bread");
	});

	test("the Entry picker swaps the page in place; the address names the Entry; Back skips the Entries", async () => {
		await go(page, "/page/blog/fresh-bread");
		await framedAt(page, "/blog/fresh-bread");
		await bar(page, "rendered-by").click();
		await addressed(page, `/entry-template/${postTypeId}?entry=${freshId}`);

		// The keyboard opens it upwards with the Entry in use focused.
		await bar(page, "preview").focus();
		await page.keyboard.press("ArrowUp");
		const menu = page.getByRole("menu", { name: "The Entry this Template previews: Fresh bread" });
		await menu.waitFor();
		expect(await page.evaluate(() => document.activeElement?.getAttribute("aria-checked"))).toBe("true");
		const choices = await menu.getByRole("menuitemradio").allTextContents();
		expect(choices.map((text) => text.replace(/\/blog\/.*$/, "")).sort()).toEqual(["Fresh bread", "Rye loaf"]);
		await menu.getByRole("menuitemradio", { name: /Rye loaf/ }).click();

		await addressed(page, `/entry-template/${postTypeId}?entry=${ryeId}`);
		const frame = await framedAt(page, "/blog/rye-loaf");
		expect(await frame.locator("h1").textContent()).toBe("Rye loaf");
		expect(await bar(page, "preview").textContent()).toContain("Preview: Rye loaf");
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-bar"))).toBe("preview");

		// Back goes to the page it was opened from, not to the previous Entry.
		await page.goBack();
		await addressed(page, "/page/blog/fresh-bread");
		await framedAt(page, "/blog/fresh-bread");
	});

	test("with the interface hidden, a link in the frame opens that page; Back returns", async () => {
		await go(page, "/page/blog/fresh-bread");
		let frame = await framedAt(page, "/blog/fresh-bread");
		// While editing, a link is selected, never followed.
		await frame.locator('nav a[href="/menu"]').click();
		await settled(page);
		expect(shellAddress(page)).toBe("/page/blog/fresh-bread");

		await page.getByRole("button", { name: "Hide the interface" }).click();
		frame = await frameOf(page);
		await frame.locator('nav a[href="/menu"]').click();
		await addressed(page, "/page/menu");
		frame = await framedAt(page, "/menu");
		expect(await frame.locator("main").textContent()).toBeDefined();

		// A link elsewhere opens in a new tab, never in the frame.
		await page.context().route("https://example.com/**", (route) => route.fulfill({ body: "Elsewhere" }));
		const opened = page.context().waitForEvent("page");
		await frame.locator('nav a[href="https://example.com/elsewhere"]').click();
		const tab = await opened;
		await tab.waitForURL("https://example.com/elsewhere");
		await tab.close();
		expect(shellAddress(page)).toBe("/page/menu");

		await page.goBack();
		await addressed(page, "/page/blog/fresh-bread");
		await framedAt(page, "/blog/fresh-bread");
		await page.getByRole("button", { name: "Show the interface" }).click();
	});

	test("an address naming nothing of this Site opens nothing, and says so", async () => {
		const reported = pageErrors(page).length;
		for (const address of [`/component/${otherComponentId}`, "/page//evil.example", "/component/not-an-id"]) {
			await go(page, address);
			const notice = page.locator('[data-wc-no-document="missing"]');
			await notice.waitFor();
			expect([address, await notice.getByRole("heading").textContent()]).toEqual([address, "Nothing to open here"]);
			expect(await page.locator("iframe[data-wc-frame]").count()).toBe(0);
		}
		await page.getByRole("link", { name: "Open the home page" }).click();
		await framedAt(page, "/");
		// The shell answers such an address as a 404 on purpose, which the browser reports; nothing else.
		forgetPageErrors(page, reported, (error) => error.includes("status of 404"));
		expect(pageErrors(page).slice(reported)).toEqual([]);
	});

	for (const theme of THEMES) {
		test(`the document's controls pass the accessibility checks, with the page in ${theme}`, async () => {
			await page.emulateMedia({ colorScheme: theme });
			await go(page, `/entry-template/${postTypeId}?entry=${freshId}`);
			await framedAt(page, "/blog/fresh-bread");
			await bar(page, "preview").waitFor();
			await expectAccessibleScreen(page, `building area, Entry template (${theme})`);
		});
	}
});

describe("the admin's way in", () => {
	test("a Component's row opens it in the building area, on the stand-in", async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}/components`));
		const row = page.getByRole("row", { name: /CustomerQuote/ });
		await row.waitFor();
		await row.getByRole("link", { name: /^Open in the building area/ }).click();

		await page.waitForURL((url) => url.pathname === `/_webcraft/build/component/${componentId}`);
		const frame = await framedAt(page, `/_webcraft/build/stand-in/component/${componentId}`);
		expect(await frame.locator("blockquote").textContent()).toBe("Best rye in Cork.");
		expect(await page.getByRole("link", { name: "Back to the admin" }).getAttribute("href")).toBe(
			install.adminUrl(`/sites/${siteId}/components`),
		);
		await page.context().close();
	});
});
