// The Media place and the Media picker in the building area (ADR 0037, BA-22; SPEC 8, 10 and 13.6), in
// Chromium at 1440 × 900:
// - the place opens from the rail over the canvas (a column of 300 with All files, Unfiled, the folders,
//   New Folder and the Trash, the file count and storage at its foot; a card with the list), and its
//   part of the library and its view are in the shell's address, so Back restores them;
// - Upload adds a file, as the admin's does;
// - folders are made, filled, renamed and deleted;
// - Delete moves a file to the Trash after a dialog that starts on Cancel, and Restore takes it back;
// - a file's details open in place: its alt text saved per language, its Focal point from the keyboard,
//   Escape back to the list;
// - the grid selects files for Move to Folder and Delete from the selection bar;
// - the picker (this place in a dialog) answers the image chosen to whoever asked, and nothing on Cancel;
// - a Member gets the same place;
// - the place, a file's details and the picker pass the accessibility checks, light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import { photo, upload } from "../harness/images.ts";
import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { enterBuildingArea, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let editor: TestAccount;
let admin: TestBrowser;
let siteId: string;
let breadsId: string;
let heroId: string;
let loafId: string;
const slug = "bakery";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	admin = await local.superadmin();
	const { api } = admin;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).account;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Giulia Romano" })).account;
	await api.languages.add({ siteId, code: "it" });

	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>Acme Bakery</p></header><main>{{@outlet}}</main>",
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const pagesType = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	const { entry: home } = await api.entries.create({
		siteId,
		postTypeId: pagesType?.id ?? "",
		title: "Menu",
		slug: "menu",
	});
	await api.entries.publish({ siteId, entryId: home.id });

	breadsId = (await api.media.folders.create({ siteId, name: "Breads" })).folder.id;
	await api.media.folders.create({ siteId, name: "Cakes" });
	const files: [string, number, number, string | null][] = [
		["hero-bakery-morning.jpg", 960, 640, "Fresh bread cooling on the bakery counter"],
		["sourdough-loaf.png", 600, 450, null],
		["team-photo-kitchen.jpg", 800, 533, "The bakery team in the kitchen"],
		["cakes-display-case.jpg", 640, 427, null],
		["opening-hours-sign.png", 450, 300, null],
	];
	for (const [name, width, height, alt] of files) {
		const { media } = await api.media.upload({ siteId, file: upload(await photo({ width, height }), name) });
		if (alt) await api.media.update({ siteId, mediaId: media.id, alt });
		if (name.startsWith("hero")) heroId = media.id;
		if (name.startsWith("sourdough")) loafId = media.id;
	}
	await api.media.update({ siteId, mediaId: loafId, folderId: breadsId });
	await local.drainJobs();
});

afterAll(async () => {
	await install?.close();
});

/** The shell's parameters in its address. */
function params(page: Page): URLSearchParams {
	return new URL(page.url()).searchParams;
}

/** Opens a shell address in the page (as a bookmark or a typed address does). */
async function go(page: Page, address: string): Promise<void> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build${address}`));
}

const placeFrame = (page: Page) => page.locator('[data-wc-place-frame^="media"]');
const row = (page: Page, key: string) => page.locator(`[data-wc-media-row="${key}"]`);
const fileRow = (page: Page, id: string) => page.locator(`[data-wc-media-file="${id}"]`);

/** The file names the list or the grid shows, in its order. */
async function names(page: Page): Promise<string[]> {
	return page.locator("[data-wc-media-open]").allTextContents();
}

/** A file of the library, as the admin reads it. */
async function fileOf(id: string, language?: string) {
	return (await admin.api.media.get({ siteId, mediaId: id, ...(language ? { language } : {}) })).media;
}

/** Waits until the admin reads what the place saved (a change saves as it is made). */
async function until(page: Page, read: () => Promise<unknown>, expected: unknown): Promise<void> {
	for (let tries = 0; tries < 100 && !Bun.deepEquals(await read(), expected); tries++) await page.waitForTimeout(100);
	expect(await read()).toEqual(expected);
}

describe("the Media place, for Staff", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: "/page/menu" });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("opens from the rail over the canvas: the column, the card and the list, its place in the address", async () => {
		await page.locator('[data-wc-place="media"]').click();
		await placeFrame(page).waitFor();
		await page.locator("[data-wc-media-list]").waitFor();

		expect(params(page).get("wc-place")).toBe("media");
		expect((await page.locator("[data-wc-place-sidebar]").boundingBox())?.width).toBe(300);
		expect((await page.locator("[data-wc-place-header]").boundingBox())?.height).toBe(40);
		expect(await page.locator("[data-wc-media-row]").allTextContents()).toEqual([
			"All files5",
			"Unfiled4",
			"Breads1",
			"Cakes0",
			"Trash0",
		]);
		expect(await page.locator("[data-wc-media-heading]").textContent()).toBe("All files");
		expect(await page.locator("[data-wc-media-count]").textContent()).toMatch(/^5 files · .+/);
		expect(await page.locator("[data-wc-media-tiles]").textContent()).toContain("5files");
		expect((await names(page)).sort()).toEqual([
			"cakes-display-case.jpg",
			"hero-bakery-morning.jpg",
			"opening-hours-sign.png",
			"sourdough-loaf.png",
			"team-photo-kitchen.jpg",
		]);
		expect(await page.locator("[data-wc-media-list] th").allTextContents()).toEqual([
			"Name",
			"Alt text (EN)",
			"Type",
			"Pixels",
			"Size",
			"Added",
			"Used",
			"Actions",
		]);
		expect(await fileRow(page, loafId).textContent()).toContain("add alt text…");
		expect((await fileRow(page, heroId).boundingBox())?.height).toBe(50);

		// A folder, a search and the grid are in the address; Back returns to each.
		await row(page, breadsId).click();
		await page.waitForURL((url) => url.searchParams.get("wc-place") === `media/${breadsId}`);
		await page.waitForFunction(() => document.querySelectorAll("[data-wc-media-open]").length === 1);
		expect(await names(page)).toEqual(["sourdough-loaf.png"]);
		await page.locator('[data-wc-media-layout="grid"]').click();
		await page.waitForURL((url) => url.searchParams.get("wc-view") === "view=grid");
		await page.locator("[data-wc-media-grid]").waitFor();
		await page.goBack();
		await page.locator("[data-wc-media-list]").waitFor();
		await page.goBack();
		await page.waitForURL((url) => url.searchParams.get("wc-place") === "media");
		await page.waitForFunction(() => document.querySelectorAll("[data-wc-media-open]").length === 5);
		await page.locator("[data-wc-media-search]").fill("team");
		await page.waitForURL((url) => url.searchParams.get("wc-view") === "q=team");
		await page.waitForFunction(() => document.querySelectorAll("[data-wc-media-open]").length === 1);
		expect(await names(page)).toEqual(["team-photo-kitchen.jpg"]);
		await page.locator("[data-wc-media-search]").fill("");
		await page.waitForFunction(() => document.querySelectorAll("[data-wc-media-open]").length === 5);

		// Escape with no field focused goes back to the canvas.
		await page.locator("[data-wc-media-heading]").focus();
		await page.keyboard.press("Escape");
		await placeFrame(page).waitFor({ state: "detached" });
		expect(params(page).get("wc-place")).toBeNull();
	});

	test("Upload adds a file to the folder shown", async () => {
		await go(page, `/page/menu?wc-place=media%2F${breadsId}`);
		await page.locator("[data-wc-media-list]").waitFor();

		await page.locator("[data-wc-media-upload] input[type=file]").setInputFiles({
			name: "rye-loaf.jpg",
			mimeType: "image/jpeg",
			buffer: Buffer.from(await photo({ width: 300, height: 200 })),
		});

		await page.locator("[data-wc-toast=success]").filter({ hasText: "rye-loaf.jpg uploaded." }).waitFor();
		await page.waitForFunction(() => document.querySelectorAll("[data-wc-media-open]").length === 2);
		expect((await names(page)).sort()).toEqual(["rye-loaf.jpg", "sourdough-loaf.png"]);
		const { items } = await admin.api.media.list({ siteId, folderId: breadsId });
		expect(items.map((item) => item.fileName).sort()).toEqual(["rye-loaf.jpg", "sourdough-loaf.png"]);
		await install.install.drainJobs();
	});

	test("folders: New Folder, a file moved into it, renamed and deleted", async () => {
		await go(page, "/page/menu?wc-place=media");
		await page.locator("[data-wc-media-list]").waitFor();

		await page.locator("[data-wc-new-folder-button]").click();
		await page.getByRole("dialog").getByLabel("Name").fill("Pastries");
		await page.getByRole("button", { name: "Create folder" }).click();
		await page.locator("[data-wc-media-row]", { hasText: "Pastries" }).waitFor();
		const pastries = (await admin.api.media.folders.list({ siteId })).folders.find((each) => each.name === "Pastries");
		expect(pastries).toBeDefined();
		const pastriesId = pastries?.id ?? "";

		await page.locator(`[data-wc-media-move="${heroId}"]`).click();
		await page.getByRole("menuitemradio", { name: "Pastries" }).click();
		await page.waitForFunction(
			(id) => document.querySelector(`[data-wc-media-row="${id}"]`)?.textContent === "Pastries1",
			pastriesId,
		);
		expect((await fileOf(heroId)).folderId).toBe(pastriesId);

		await row(page, pastriesId).hover();
		await page.locator(`[data-wc-folder-actions="${pastriesId}"]`).click();
		await page.getByRole("menuitem", { name: "Rename" }).click();
		await page.getByRole("dialog").getByLabel("Name").fill("Viennoiserie");
		await page.getByRole("button", { name: "Rename" }).click();
		await page.locator("[data-wc-media-row]", { hasText: "Viennoiserie" }).waitFor();

		await row(page, pastriesId).hover();
		await page.locator(`[data-wc-folder-actions="${pastriesId}"]`).click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		await page.getByRole("button", { name: "Delete folder" }).click();
		await row(page, pastriesId).waitFor({ state: "detached" });
		expect((await fileOf(heroId)).folderId).toBeNull();
	});

	test("Delete moves a file to the Trash, after a dialog that starts on Cancel; Restore takes it back", async () => {
		await go(page, "/page/menu?wc-place=media");
		await page.locator("[data-wc-media-list]").waitFor();

		await page.locator(`[data-wc-media-delete="${loafId}"]`).click();
		const dialog = page.getByRole("dialog");
		await dialog.getByRole("button", { name: "Move to the Trash" }).waitFor();
		await page.waitForFunction(() => document.activeElement?.hasAttribute("data-wc-dialog-cancel"));
		await page.waitForFunction(() =>
			[...document.querySelectorAll("button")].some(
				(button) => button.textContent === "Move to the Trash" && !button.disabled,
			),
		);
		await dialog.getByRole("button", { name: "Move to the Trash" }).click();
		await dialog.waitFor({ state: "detached" });
		await fileRow(page, loafId).waitFor({ state: "detached" });
		expect(await row(page, "trash").textContent()).toBe("Trash1");
		expect((await fileOf(loafId)).trashedAt).not.toBeNull();

		await row(page, "trash").click();
		await page.waitForURL((url) => url.searchParams.get("wc-place") === "media/trash");
		await page.locator(`[data-wc-media-restore="${loafId}"]`).click();
		await fileRow(page, loafId).waitFor({ state: "detached" });
		expect((await fileOf(loafId)).trashedAt).toBeNull();
		expect(await row(page, "trash").textContent()).toBe("Trash0");
	});

	test("a file's details open in place: alt text saved per language, the Focal point from the keyboard", async () => {
		await go(page, "/page/menu?wc-place=media");
		await page.locator("[data-wc-media-list]").waitFor();

		await page.locator(`[data-wc-media-open="${loafId}"]`).click();
		await page.waitForURL((url) => url.searchParams.get("wc-view") === `file=${loafId}`);
		await page.locator("[data-wc-media-alt-text]").waitFor();
		expect(await page.locator("[data-wc-media-open-badge]").textContent()).toBe("Open: sourdough-loaf.png");
		// Focus starts on the file in the column beside the details.
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-media-narrow"))).toBe(loafId);
		// Both languages have no alt text yet: each tab says so.
		expect(await page.locator('[data-wc-media-language="it"]').textContent()).toMatch(
			/^it · Alt text in .+, none yet$/,
		);

		await page.locator("[data-wc-media-alt-text]").fill("A sourdough loaf on a board");
		await page.locator("[data-wc-media-alt-text]").press("Tab");
		await until(page, async () => (await fileOf(loafId)).alt, "A sourdough loaf on a board");

		await page.locator('[data-wc-media-language="it"]').click();
		await page.waitForURL((url) => url.searchParams.get("wc-view") === `file=${loafId}&language=it`);
		// A language with no text of its own shows the Default language's, as the library falls back.
		await page.locator("[data-wc-media-alt-text]").fill("Una pagnotta a lievito madre");
		await page.locator("[data-wc-media-alt-text]").blur();
		await until(page, async () => (await fileOf(loafId, "it")).alt, "Una pagnotta a lievito madre");
		expect((await fileOf(loafId)).alt).toBe("A sourdough loaf on a board");

		const across = page.getByRole("slider", { name: "Across" });
		await across.focus();
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("ArrowRight");
		for (let tries = 0; tries < 50 && (await fileOf(loafId)).focalPoint === null; tries++)
			await page.waitForTimeout(100);
		expect((await fileOf(loafId)).focalPoint).toEqual({ x: 52, y: 50 });

		await page.locator("[data-wc-media-narrow]").first().focus();
		await page.keyboard.press("Escape");
		await page.waitForURL((url) => url.searchParams.get("wc-view") === null);
		await page.locator("[data-wc-media-list]").waitFor();
		expect(await placeFrame(page).count()).toBe(1);
		await settled(page);
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-media-open"))).toBe(loafId);
	});

	test("the grid: files selected for Move to Folder and Delete from the selection bar", async () => {
		await go(page, "/page/menu?wc-place=media&wc-view=view%3Dgrid");
		await page.locator("[data-wc-media-grid]").waitFor();
		const ids = (await admin.api.media.list({ siteId, folderId: "none" })).items
			.filter((item) => item.fileName.startsWith("cakes") || item.fileName.startsWith("opening"))
			.map((item) => item.id);
		expect(ids.length).toBe(2);

		for (const id of ids) await fileRow(page, id).getByRole("checkbox").check();
		await page.locator("[data-wc-media-selection]").waitFor();
		expect(await page.locator("[data-wc-media-selection]").textContent()).toContain("2 selected");

		await page.locator("[data-wc-media-selection-move]").click();
		await page.getByRole("menuitemradio", { name: "Cakes" }).click();
		await page.locator("[data-wc-media-selection]").waitFor({ state: "detached" });
		const cakes = (await admin.api.media.folders.list({ siteId })).folders.find((each) => each.name === "Cakes");
		expect(cakes?.count).toBe(2);

		for (const id of ids) await fileRow(page, id).getByRole("checkbox").check();
		await page.locator("[data-wc-media-selection-delete]").click();
		const dialog = page.getByRole("dialog");
		await dialog.getByText("Delete 2 files?").waitFor();
		await page.waitForFunction(() =>
			[...document.querySelectorAll("button")].some(
				(button) => button.textContent === "Move to the Trash" && !button.disabled,
			),
		);
		await dialog.getByRole("button", { name: "Move to the Trash" }).click();
		await dialog.waitFor({ state: "detached" });
		expect((await admin.api.media.list({ siteId, trash: true })).items.map((item) => item.id).sort()).toEqual(
			[...ids].sort(),
		);
		for (const id of ids) await admin.api.media.restore({ siteId, mediaId: id });
	});

	test("the picker answers the image chosen to whoever asked, and nothing on Cancel", async () => {
		await go(page, "/page/menu");
		await page.locator("iframe[data-wc-frame]").waitFor();
		const ask = () =>
			page.evaluate(
				() =>
					new Promise<string | null>((resolve) => {
						const detail = {
							kind: "image",
							current: null,
							taken: false,
							answer: (item: { id: string } | null) => resolve(item ? item.id : null),
						};
						document.dispatchEvent(new CustomEvent("webcraft:pick-media", { detail }));
					}),
			);

		const chosen = ask();
		const picker = page.locator("[data-wc-media-picker]");
		await picker.waitFor();
		expect(await picker.getByRole("heading").first().textContent()).toBe("Choose a Media image");
		await picker.locator(`[data-wc-pick="${heroId}"]`).waitFor();
		await picker.locator(`[data-wc-pick="${heroId}"]`).click();
		expect(await picker.locator(`[data-wc-pick="${heroId}"]`).getAttribute("aria-selected")).toBe("true");
		await picker.locator("[data-wc-pick-select]").click();
		expect(await chosen).toBe(heroId);
		await picker.waitFor({ state: "detached" });

		const cancelled = ask();
		await picker.waitFor();
		await picker.getByRole("button", { name: "Cancel" }).click();
		expect(await cancelled).toBeNull();

		// From the keyboard: arrows choose, Enter selects.
		const keyed = ask();
		await picker.locator("[data-wc-pick-list]").waitFor();
		await picker.locator("[data-wc-pick-list]").focus();
		await page.keyboard.press("Home");
		const first = await picker.locator('[role="option"][aria-selected="true"]').getAttribute("data-wc-pick");
		await page.keyboard.press("Enter");
		expect(await keyed).toBe(first);
	});

	for (const theme of THEMES) {
		test(`the place, a file's details and the picker pass the accessibility checks, with the page in ${theme}`, async () => {
			await page.emulateMedia({ colorScheme: theme });
			await go(page, "/page/menu?wc-place=media");
			await page.locator("[data-wc-media-list]").waitFor();
			await expectAccessibleScreen(page, `building area, Media place (${theme})`);

			await go(page, "/page/menu?wc-place=media&wc-view=view%3Dgrid");
			await page.locator("[data-wc-media-grid]").waitFor();
			await expectNoAxeViolations(page, `building area, Media place, grid (${theme})`);

			await go(page, `/page/menu?wc-place=media&wc-view=file%3D${heroId}`);
			await page.locator("[data-wc-media-alt-text]").waitFor();
			await expectAccessibleScreen(page, `building area, Media place, a file's details (${theme})`);

			await go(page, "/page/menu");
			await page.locator("iframe[data-wc-frame]").waitFor();
			await page.evaluate(() => {
				const detail = { kind: "image", current: null, taken: false, answer: () => {} };
				document.dispatchEvent(new CustomEvent("webcraft:pick-media", { detail }));
			});
			await page.locator("[data-wc-pick-list]").waitFor();
			await expectNoAxeViolations(page, `building area, Media picker (${theme})`);
			await page.keyboard.press("Escape");
			await page.locator("[data-wc-media-picker]").waitFor({ state: "detached" });
		});
	}
});

describe("the Media place, for a Member", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: editor, siteId, slug, open: "/page/menu" });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("gets the same place: the files, Upload, the folders and the Trash", async () => {
		await page.locator('[data-wc-place="media"]').click();
		await page.locator("[data-wc-media-list]").waitFor();

		expect((await names(page)).length).toBeGreaterThanOrEqual(5);
		expect(await page.locator("[data-wc-media-upload]").count()).toBe(1);
		expect(await page.locator("[data-wc-new-folder-button]").count()).toBe(1);
		expect(await row(page, "trash").count()).toBe(1);
		await page.locator(`[data-wc-media-open="${heroId}"]`).click();
		await page.locator("[data-wc-media-alt-text]").waitFor();
		expect(await page.locator("[data-wc-media-alt-text]").inputValue()).toBe(
			"Fresh bread cooling on the bakery counter",
		);
	});
});
