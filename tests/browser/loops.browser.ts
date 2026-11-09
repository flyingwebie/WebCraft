// The Loop screens and the Data tabs in a browser: axe and keyboard checks in light and dark for a
// query Loop's settings, a Loop of its own items (its Fields and its items), and the Data tabs of a
// Loop, an Entry template and the Globals; the tabs move with the arrow keys, and a binding is copied
// without a mouse.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let recipesId: string;
let queryLoopId: string;
let itemsLoopId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Ciara Byrne" })).account;
	const admin = await local.superadmin();
	await admin.api.languages.add({ siteId, code: "fr" });
	const { postType: chefs } = await admin.api.postTypes.create({
		siteId,
		name: "Chefs",
		key: "chefs",
		urlPattern: "/chefs/{slug}",
		fields: [{ key: "bio", label: "Bio", type: "text" }],
	});
	const { postType: recipes } = await admin.api.postTypes.create({
		siteId,
		name: "Recipes",
		key: "recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "minutes", label: "Minutes", type: "number" },
			{
				key: "difficulty",
				label: "Difficulty",
				type: "select",
				options: [
					{ value: "easy", label: "Easy" },
					{ value: "hard", label: "Hard" },
				],
			},
			{ key: "cooked_on", label: "Cooked on", type: "date" },
			{ key: "chef", label: "Chef", type: "relationship", postTypes: ["chefs"] },
		],
	});
	recipesId = recipes.id;
	const { entry: ada } = await admin.api.entries.create({
		siteId,
		postTypeId: chefs.id,
		title: "Ada",
		fields: { bio: "Pastry" },
	});
	await admin.api.entries.publish({ siteId, entryId: ada.id });
	const { entry: brioche } = await admin.api.entries.create({
		siteId,
		postTypeId: recipes.id,
		title: "Brioche",
		fields: { minutes: 20, difficulty: "easy", chef: ada.id },
	});
	await admin.api.entries.publish({ siteId, entryId: brioche.id });
	const { loop: query } = await admin.api.loops.create({
		siteId,
		name: "quick-recipes",
		source: "query",
		query: {
			postTypes: ["recipes"],
			filters: [
				{ type: "field", field: "minutes", operator: "atMost", value: 30 },
				{ type: "relationship", field: "chef", to: "entries", entries: [ada.id] },
				{ type: "date", field: "publishedAt", window: "last", amount: 12, unit: "months" },
				{ type: "status", statuses: ["published"] },
			],
			sort: [{ by: "minutes", direction: "asc" }],
			limit: 6,
			paginate: true,
		},
	});
	queryLoopId = query.id;
	const { loop: items } = await admin.api.loops.create({
		siteId,
		name: "opening-hours",
		source: "items",
		fields: [
			{ key: "day", label: "Day", type: "text", required: true },
			{ key: "hours", label: "Hours", type: "text" },
		],
	});
	itemsLoopId = items.id;
	await admin.api.loops.saveItems({ siteId, loopId: items.id, items: [{ day: "Monday", hours: "8–18" }, { day: "" }] });
	await admin.api.globals.setFields({ siteId, fields: [{ key: "phone", label: "Phone", type: "text" }] });
	await admin.api.globals.saveDraft({ siteId, fields: { phone: "+353 1 234 5678" } });
});

afterAll(async () => {
	await install.close();
});

async function open(page: Page, path: string): Promise<void> {
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(path));
	await page.waitForLoadState("networkidle");
}

for (const theme of THEMES) {
	describe(`Loops, ${theme}`, () => {
		test("a query Loop's settings: Post Types, filters of each kind, sort, limit and pagination", async () => {
			const page = await install.newPage(theme);
			await open(page, `/sites/${siteId}/loops/${queryLoopId}`);
			await page.getByRole("heading", { level: 1, name: "quick-recipes" }).waitFor();
			await page.getByText("Chosen Entries", { exact: true }).waitFor();
			await expectAccessibleScreen(page, `Loops, a query Loop (${theme})`);
			await expectOverlayUsable(page, page.getByRole("button", { name: "New Loop" }), "dialog", `New Loop (${theme})`);
		});

		test("a query the server refuses shows each problem", async () => {
			const page = await install.newPage(theme);
			await open(page, `/sites/${siteId}/loops/${queryLoopId}`);
			await page.getByLabel("Limit").fill("500");
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await page.getByRole("alert").getByText("A query shows 1 to 100 items.").waitFor();
			await expectAccessibleScreen(page, `Loops, a refused query (${theme})`);
		});

		test("a Loop of its own items: its Fields, then its items", async () => {
			const page = await install.newPage(theme);
			// The Loops screen opens the first Loop by name.
			await open(page, `/sites/${siteId}/loops`);
			await page.getByRole("heading", { level: 1, name: "opening-hours" }).waitFor();
			await page.getByRole("heading", { level: 2, name: "Loop items' Fields" }).waitFor();
			await expectAccessibleScreen(page, `Loops, Loop items' Fields (${theme})`);

			await page.getByRole("tab", { name: "Loop items" }).click();
			await page.getByRole("tabpanel", { name: "Loop items" }).getByLabel("Day").first().waitFor();
			await expectAccessibleScreen(page, `Loops, Loop items (${theme})`);
		});

		test("the tabs move with the arrow keys", async () => {
			const page = await install.newPage(theme);
			await open(page, `/sites/${siteId}/loops/${itemsLoopId}`);
			await page.getByRole("tab", { name: "Settings" }).focus();

			await page.keyboard.press("ArrowRight");
			expect(await page.getByRole("tab", { name: "Loop items" }).getAttribute("aria-selected")).toBe("true");
			await page.keyboard.press("End");
			expect(await page.getByRole("tab", { name: "Data" }).getAttribute("aria-selected")).toBe("true");
			await page.keyboard.press("ArrowRight");
			expect(await page.getByRole("tab", { name: "Settings" }).getAttribute("aria-selected")).toBe("true");
		});
	});

	describe(`Data tabs, ${theme}`, () => {
		test("a Loop's Data tab: a binding is copied from the keyboard", async () => {
			const page = await install.newPage(theme);
			await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
				origin: new URL(install.adminUrl("/")).origin,
			});
			await open(page, `/sites/${siteId}/loops/${queryLoopId}?tab=data`);
			await page.getByRole("heading", { level: 2, name: "Data of Brioche" }).waitFor();
			await expectAccessibleScreen(page, `Loops, the Data tab (${theme})`);

			const copy = page.getByRole("button", { name: "Copy {{ item.chef.bio }}" });
			// Tab reaches the button from the one before it; Enter copies.
			await page.getByRole("button", { name: "Copy {{ item.chef.title }}" }).focus();
			await page.keyboard.press("Tab");
			await page.keyboard.press("Tab");
			expect(await copy.evaluate((button) => button === document.activeElement)).toBe(true);
			await page.keyboard.press("Enter");
			await page.getByRole("status").getByText("Copied {{ item.chef.bio }}").waitFor();
			expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("{{ item.chef.bio }}");
		});

		test("an Entry template's Data tab, and the Globals'", async () => {
			const page = await install.newPage(theme);
			await open(page, `/sites/${siteId}/post-types/${recipesId}?tab=data`);
			await page.getByRole("heading", { level: 2, name: "Data of Brioche" }).waitFor();
			await expectAccessibleScreen(page, `Post Types & Fields, the Data tab (${theme})`);

			await page.goto(install.adminUrl(`/sites/${siteId}/post-types/globals?tab=data`));
			await page.getByRole("heading", { level: 2, name: "Data of Acme Bakery" }).waitFor();
			await expectAccessibleScreen(page, `Post Types & Fields, the Globals' Data tab (${theme})`);
		});
	});
}
