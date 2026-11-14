// The admin shell in a real browser: the inset frame, the short navigation of each level with its
// secondary sidebars (one current row per level), the parts that open over a page (the context
// switcher, the person's menu, Search), the theme in the person's menu, the settings foot bar and its
// guard, the line under the top bar while a page loads, "Edit on site" for the page on screen, and the
// top bar at phone width; in light and dark, with the keyboard and axe.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let workspaceId: string;
let siteId: string;
let careersId: string;
let pagesId: string;
let blogId: string;
let menuId: string;
let breadId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin({ name: "Davide Del Gatto" });
	const local = install.install;
	const workspace = await local.createWorkspace("Acme Ltd");
	workspaceId = workspace.id;
	await local.createWorkspace("Northwind Studio");
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	careersId = (await local.createSite(workspaceId, { name: "Acme Careers", slug: "careers" })).id;
	const { api } = await local.superadmin();
	const { postTypes } = await api.postTypes.list({ siteId });
	pagesId = postTypes.find((postType) => postType.builtIn === "page")?.id ?? "";
	const { entry: menu } = await api.entries.create({ siteId, postTypeId: pagesId, title: "Menu" });
	menuId = menu.id;
	const { postType: blog } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [],
	});
	blogId = blog.id;
	breadId = (await api.entries.create({ siteId, postTypeId: blogId, title: "Fresh bread" })).entry.id;
	await api.dashboards.create({ siteId, name: "Orders" });
});

afterAll(async () => {
	await install.close();
});

async function open(page: Page, path: string): Promise<void> {
	await install.signIn(page, superadmin);
	await page.goto(install.adminUrl(path));
	await page.waitForLoadState("networkidle");
}

/** The rows that say they are current, in the sidebar and in the secondary sidebar. */
async function currentRows(page: Page): Promise<{ primary: string[]; secondary: string[] }> {
	return page.evaluate(() => {
		const read = (root: Element | null) =>
			[...(root?.querySelectorAll("[aria-current]") ?? [])].map(
				(row) => `${row.textContent?.trim() ?? ""} (${row.getAttribute("aria-current")})`,
			);
		return {
			primary: read(document.querySelector('nav[aria-label="Admin"]')),
			secondary: read(document.querySelector('[data-slot="secondary-sidebar"]')),
		};
	});
}

for (const theme of THEMES) {
	describe(`admin shell, ${theme}`, () => {
		test("the page is a card on the sidebar's colour, 8 px from the edges, and scrolls inside it", async () => {
			const page = await install.newPage(theme);
			await open(page, `/sites/${siteId}/entries/${pagesId}`);
			const card = await page.evaluate(() => {
				const inset = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]');
				const wrapper = document.querySelector<HTMLElement>('[data-slot="sidebar-wrapper"]');
				const box = inset?.getBoundingClientRect();
				const style = inset ? getComputedStyle(inset) : null;
				return {
					top: box?.top,
					right: window.innerWidth - (box?.right ?? 0),
					bottom: window.innerHeight - (box?.bottom ?? 0),
					rounded: style?.borderTopRightRadius,
					windowScrolls: document.scrollingElement ? document.scrollingElement.scrollHeight > window.innerHeight : null,
					windowTakesSidebarColour:
						wrapper && inset ? getComputedStyle(wrapper).backgroundColor !== style?.backgroundColor : null,
				};
			});
			expect(card).toEqual({
				top: 8,
				right: 8,
				bottom: 8,
				rounded: "14px",
				windowScrolls: false,
				windowTakesSidebarColour: true,
			});
			await expectAccessibleScreen(page, `Site › Pages in the inset shell (${theme})`);
		});

		test("Site settings open a secondary sidebar in their groups, with one current row at each level", async () => {
			const page = await install.newPage(theme);
			await open(page, `/sites/${siteId}/domains`);
			const settings = page.getByRole("navigation", { name: "Site settings" });
			for (const group of ["General", "Translation", "Search and privacy", "Integrations", "Data"])
				await settings.getByText(group, { exact: true }).waitFor();
			expect(await currentRows(page)).toEqual({
				primary: ["Site settings (true)"],
				secondary: ["Domains & Staging (page)"],
			});
			const crumbs = page.getByRole("navigation", { name: "Breadcrumb" });
			expect(await crumbs.getByRole("link").allTextContents()).toEqual(["Acme Ltd", "Acme Bakery", "Settings"]);
			await expectAccessibleScreen(page, `Site settings › Domains & Staging (${theme})`);
		});

		test("Structure and Analytics are one row each, with their own secondary sidebar", async () => {
			const page = await install.newPage(theme);
			await open(page, `/sites/${siteId}`);
			const navigation = page.getByRole("navigation", { name: "Admin" });
			expect(await currentRows(page)).toEqual({ primary: ["Overview (page)"], secondary: [] });

			await navigation.getByRole("link", { name: /^Structure/ }).click();
			const structure = page.getByRole("navigation", { name: "Structure" });
			await structure.getByRole("link", { name: "Templates" }).click();
			await page.getByRole("heading", { level: 1, name: "Templates" }).waitFor();
			expect((await currentRows(page)).secondary).toEqual(["Templates (page)"]);
			await expectAccessibleScreen(page, `Structure › Templates (${theme})`);

			await navigation.getByRole("link", { name: "Analytics" }).click();
			const analytics = page.getByRole("navigation", { name: "Analytics" });
			await analytics.getByRole("link", { name: "Orders" }).waitFor();
			await analytics.getByRole("link", { name: "New Dashboard" }).waitFor();
			expect(await currentRows(page)).toEqual({ primary: ["Analytics (true)"], secondary: ["Orders (page)"] });
		});

		test("the Workspace and the Install have their own short navigation, settings pinned at the foot", async () => {
			const page = await install.newPage(theme);
			await open(page, `/workspaces/${workspaceId}`);
			const navigation = page.getByRole("navigation", { name: "Admin" });
			await navigation.getByRole("link", { name: /^Workspace settings/ }).waitFor();
			expect(await currentRows(page)).toEqual({ primary: ["Sites2 (page)"], secondary: [] });
			await expectAccessibleScreen(page, `Workspace › Sites (${theme})`);

			await page.goto(install.adminUrl("/install/health"));
			await page.getByRole("navigation", { name: "Logs and health" }).waitFor();
			expect(await currentRows(page)).toEqual({
				primary: ["Logs and health (true)"],
				secondary: ["Install health (page)"],
			});
			await expectAccessibleScreen(page, `Logs and health › Install health (${theme})`);
		});

		test("the context switcher opens and closes from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: /Switch Workspace or Site/ }),
				"dialog",
				`context switcher (${theme})`,
			);
		});

		test("the account menu opens and closes from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: /Open the account menu/ }),
				"menu",
				`account menu (${theme})`,
			);
		});

		test("Search opens and closes from the keyboard", async () => {
			const page = await install.newPage(theme);
			await open(page, `/sites/${siteId}`);

			await expectOverlayUsable(page, page.getByRole("button", { name: /^Search/ }), "dialog", `Search (${theme})`);
		});

		test("the Master key help opens and closes from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "How to back up" }),
				"dialog",
				`Master key help (${theme})`,
			);
		});

		test("the settings foot bar: Save waits for a change, and leaving with changes asks first", async () => {
			const page = await install.newPage(theme);
			await open(page, "/settings/general");
			const bar = page.getByRole("region", { name: "Saving this screen" });
			const save = bar.getByRole("button", { name: "Save" });
			await bar.getByText("No changes").waitFor();
			expect(await save.isDisabled()).toBe(true);

			await page.getByLabel("Install name").fill("Acme Agency");
			await bar.getByText("Unsaved changes").waitFor();
			expect(await save.isDisabled()).toBe(false);
			await expectAccessibleScreen(page, `Install settings › General with unsaved changes (${theme})`);

			await page
				.getByRole("navigation", { name: "Admin" })
				.getByRole("link", { name: /^Workspaces/ })
				.click();
			const guard = page.getByRole("dialog", { name: "Leave without saving?" });
			await guard.waitFor();
			// Focus lands on "Keep editing", the choice that loses nothing.
			await page.waitForFunction(() => document.activeElement?.textContent === "Keep editing", undefined, {
				timeout: 2000,
			});
			await page.keyboard.press("Enter");
			await guard.waitFor({ state: "hidden" });
			expect(new URL(page.url()).pathname).toBe("/settings/general");

			await bar.getByRole("button", { name: "Discard" }).click();
			await bar.getByText("No changes").waitFor();
			expect(await page.getByLabel("Install name").inputValue()).toBe("");
		});
	});
}

describe("navigation", () => {
	test("the context switcher shows another Workspace's Sites, and closes after a choice", async () => {
		const page = await install.newPage("light");
		await open(page, `/sites/${siteId}`);
		await page.getByRole("button", { name: /Switch Workspace or Site/ }).click();
		const switcher = page.getByRole("dialog", { name: "Switch Workspace or Site" });
		await switcher.getByText("Sites in Acme Ltd").waitFor();

		await switcher.getByRole("link", { name: "Northwind Studio" }).hover();
		await switcher.getByText("Sites in Northwind Studio").waitFor();
		await switcher.getByText("No Sites here yet.").waitFor();

		await switcher.getByRole("link", { name: "Acme Ltd" }).hover();
		await switcher.getByRole("link", { name: /Acme Careers/ }).click();
		await page.waitForURL((url) => url.pathname === `/sites/${careersId}`);
		await switcher.waitFor({ state: "hidden" });
	});

	test("Search goes to a screen inside a secondary sidebar, with the keyboard", async () => {
		const page = await install.newPage("light");
		await open(page, `/sites/${siteId}`);
		await page.keyboard.press("ControlOrMeta+k");
		const search = page.getByRole("dialog", { name: "Search the admin" });
		await search.waitFor();
		await page.keyboard.type("Crawlers");
		await page.keyboard.press("Enter");
		await page.waitForURL((url) => url.pathname === `/sites/${siteId}/crawlers`);
		await search.waitFor({ state: "hidden" });
		await page.getByRole("heading", { level: 1, name: "Crawlers" }).waitFor();
		expect((await currentRows(page)).secondary).toEqual(["Crawlers (page)"]);
	});

	test("a slow route change shows a thin line under the top bar", async () => {
		const page = await install.newPage("light");
		await open(page, `/sites/${siteId}`);
		await page.route("**/api/rpc/**", async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 600));
			await route.continue();
		});
		await page.getByRole("navigation", { name: "Admin" }).getByRole("link", { name: "Media" }).click();
		await page.getByRole("progressbar", { name: "Loading the page" }).waitFor();
		await page.getByRole("heading", { level: 1, name: "Media" }).waitFor();
		await page.getByRole("progressbar", { name: "Loading the page" }).waitFor({ state: "hidden" });
	});

	test("Edit on site opens the Page or Entry on screen, and the home page elsewhere", async () => {
		const page = await install.newPage("light");
		const asked: string[] = [];
		await page.route("**/api/rpc/editMode/open", async (route) => {
			asked.push(/"path":"([^"]*)"/.exec(route.request().postData() ?? "")?.[1] ?? "");
			await route.abort();
		});
		const editOnSite = page.getByRole("button", { name: "Edit on site", exact: true });
		for (const [path, expected] of [
			[`/sites/${siteId}/entries/${pagesId}/${menuId}`, "/menu"],
			[`/sites/${siteId}/entries/${blogId}/${breadId}`, "/blog/fresh-bread"],
			[`/sites/${siteId}/media`, "/"],
		] as const) {
			await open(page, path);
			const before = asked.length;
			await editOnSite.click();
			for (let wait = 0; wait < 50 && asked.length === before; wait++) await page.waitForTimeout(100);
			expect({ path, opened: asked.at(-1) }).toEqual({ path, opened: expected });
		}
	});

	test("the person's menu holds the theme: System follows the device, Light and Dark are kept", async () => {
		const page = await install.newPage("dark");
		await open(page, "/");
		const menu = page.getByRole("button", { name: /Open the account menu/ });
		expect(await page.evaluate(() => document.documentElement.className)).toBe("");

		await menu.click();
		await page.getByRole("menuitemradio", { name: "Light" }).click();
		await page.waitForFunction(() => document.documentElement.className === "light");
		await page.keyboard.press("Escape");
		// The choice is kept: the next page opens light although the device is dark.
		await page.reload();
		await page.waitForLoadState("networkidle");
		expect(await page.evaluate(() => document.documentElement.className)).toBe("light");
		await expectAccessibleScreen(page, "Install › Overview (switched to light)");

		await menu.click();
		await page.getByRole("menuitemradio", { name: "Dark" }).click();
		await page.waitForFunction(() => document.documentElement.className === "dark");
		await page.keyboard.press("Escape");

		await page.reload();
		await page.waitForLoadState("networkidle");
		expect(await page.evaluate(() => document.documentElement.className)).toBe("dark");
		await menu.click();
		expect(await page.getByRole("menuitemradio", { name: "Dark" }).getAttribute("aria-checked")).toBe("true");
		await page.getByRole("menuitemradio", { name: "System" }).click();
		await page.waitForFunction(() => document.documentElement.className === "");
		await page.keyboard.press("Escape");
		// Nothing of the light/dark switch is left at the sidebar's foot.
		expect(await page.getByRole("button", { name: "Dark theme" }).count()).toBe(0);
	});
});

describe("at phone width", () => {
	for (const theme of THEMES)
		test(`the top bar keeps to one line, the page is edge to edge, and the sidebar is a sheet (${theme})`, async () => {
			const page = await install.newPage(theme);
			await page.setViewportSize({ width: 390, height: 844 });
			await open(page, `/sites/${siteId}/entries/${pagesId}`);
			const layout = await page.evaluate(() => {
				const bar = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"] > header');
				const inset = document.querySelector<HTMLElement>('[data-slot="sidebar-inset"]')?.getBoundingClientRect();
				return {
					pageScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
					barOverflows: bar ? bar.scrollWidth > bar.clientWidth : null,
					barHeight: bar?.getBoundingClientRect().height,
					edgeToEdge: inset ? [inset.left, inset.top, window.innerWidth - inset.right] : null,
				};
			});
			expect(layout).toEqual({ pageScrollsSideways: false, barOverflows: false, barHeight: 56, edgeToEdge: [0, 0, 0] });
			await expectAccessibleScreen(page, `Site › Pages at phone width (${theme})`);

			await page.getByRole("button", { name: "Show or hide the sidebar" }).click();
			const sheet = page.getByRole("dialog", { name: "Admin" });
			await sheet.getByRole("link", { name: "Media" }).click();
			await page.waitForURL((url) => url.pathname === `/sites/${siteId}/media`);
			await sheet.waitFor({ state: "hidden" });
		});
});
