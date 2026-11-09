// Site search in a real browser, in the device's light and dark themes: a page with the Search
// element in its header, the search results page with hits (and links to more pages) and with none,
// each checked with axe-core and the keyboard and served under the Site's strict policy. Searching
// works from the keyboard without JavaScript: type, press Enter, land on the hits. Then the Site
// search tab of the Post Types & Fields screen, from the keyboard.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { TestAccount } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let recipesId: string;
const slug = "bakery";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Ciara Byrne" })).account;
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header><p><a href="/">Acme Bakery</a></p>{{@search}}</header><main>{{@outlet}}</main><footer><p>Open every day.</p></footer>',
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Recipes",
		key: "recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "body", label: "Body", type: "body" },
			{ key: "origin", label: "Origin", type: "group", fields: [{ key: "city", label: "City", type: "text" }] },
		],
	});
	recipesId = postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: recipesId,
		markup: "<article><h1>{{ title }}</h1>{{ body }}</article>",
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	for (let index = 1; index <= 12; index++) {
		const { entry: recipe } = await api.entries.create({
			siteId,
			postTypeId: recipesId,
			title: index === 1 ? "Brioche" : `Butter cake ${index}`,
			fields: { body: [{ type: "paragraph", text: "Rich and buttery, baked every morning with butter." }] },
		});
		await api.entries.publish({ siteId, entryId: recipe.id });
	}
	const { postTypes } = await api.postTypes.list({ siteId });
	const pages = postTypes.find((each) => each.builtIn === "page");
	const { entry: search } = await api.entries.create({ siteId, postTypeId: pages?.id ?? "", title: "Search" });
	await api.entries.publish({ siteId, entryId: search.id });
	await api.pages.setSearchPage({ siteId, pageId: search.id });
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Site search, ${theme}`, () => {
		for (const [name, path] of [
			["a page with the Search element", "/recipes/brioche"],
			["the search results page with hits and more pages", "/search?q=butter"],
			["the second page of hits", "/search?q=butter&page=2"],
			["the search results page with no hits", "/search?q=croissant"],
			["the search results page before searching", "/search"],
		] as const) {
			test(name, async () => {
				// The same answer, through the web handler in this process: the Site's strict policy, no inline code.
				const local = install.install;
				await expectSafePage(await local.request(`https://${slug}.${local.sitesDomain}${path}`));
				const page = await install.newPage(theme);
				await page.goto(install.siteUrl(slug, path));
				await page.waitForLoadState("load");

				await expectAccessibleScreen(page, `${name} (${theme})`);
			});
		}
	});
}

describe("searching from the keyboard", () => {
	test("type in the header's search box, press Enter, and land on the hits", async () => {
		const page = await install.newPage("light");
		await page.goto(install.siteUrl(slug, "/recipes/brioche"));
		await page.waitForLoadState("load");
		// The skip link, the Site's name, then the search box.
		for (let press = 0; press < 3; press++) await page.keyboard.press("Tab");
		const box = page.getByRole("searchbox", { name: "Search the site" });
		expect(await box.evaluate((element) => element === document.activeElement)).toBe(true);

		await page.keyboard.type("brioche");
		await page.keyboard.press("Enter");
		await page.waitForURL((url) => url.pathname === "/search" && url.searchParams.get("q") === "brioche");

		await page.getByRole("link", { name: "Brioche" }).waitFor();
		expect(await page.getByText("1 result for “brioche”").count()).toBe(1);
		expect(await page.getByRole("searchbox", { name: "Search the site" }).first().inputValue()).toBe("brioche");
		expect(await page.title()).toBe("Results for “brioche” · Acme Bakery");
	});
});

for (const theme of THEMES) {
	describe(`the Site search tab, ${theme}`, () => {
		test("Staff choose what is searched and its weight, from the keyboard, and save", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, staff);
			await page.goto(install.adminUrl(`/sites/${siteId}/post-types/${recipesId}?tab=search`));
			await page.getByRole("heading", { level: 2, name: "Site search" }).waitFor();
			await expectAccessibleScreen(page, `the Site search tab (${theme})`);

			const summary = page.getByRole("checkbox", { name: "Search Summary" });
			await summary.focus();
			await page.keyboard.press("Space");
			const weight = page.getByRole("combobox", { name: "Weight of Summary" });
			await weight.selectOption("C");
			await page.getByRole("checkbox", { name: "Search Origin › City" }).click();
			await page.getByRole("button", { name: "Save changes" }).click();
			await page.getByText("Saved. Site search follows within a minute.").waitFor();
			await expectAccessibleScreen(page, `the Site search tab, saved (${theme})`);

			const { api } = await install.install.superadmin();
			const { postType } = await api.postTypes.get({ siteId, postTypeId: recipesId });
			expect(postType.searchedFields).toContainEqual({ field: "summary", weight: "C" });
			expect(postType.searchedFields).toContainEqual({ field: "origin.city", weight: "B" });
			await api.postTypes.update({
				siteId,
				postTypeId: recipesId,
				searchedFields: [
					{ field: "title", weight: "A" },
					{ field: "body", weight: "B" },
				],
			});
		});
	});
}
