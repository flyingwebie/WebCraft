// The Media place and the picker after FX-03, in Chromium:
// - the masonry grid: each file in its own shape, laid out before the pictures arrive (nothing moves
//   as they load), its name and size under the pointer, a file that isn't an image showing its kind,
//   the arrow keys moving between the pictures and Enter opening one;
// - List or Grid is remembered for the next time, in the place and in the picker; the picker shows the
//   grid by default when choosing an image, and its arrow keys move the choice across the columns;
// - Add folder asks for the name in place (Enter saves, Escape cancels), in the place and the picker;
// - the folders' order: A–Z or Custom, kept for the Site; in Custom, folders move by drag and drop and
//   by Move up and Move down in their menu;
// - the picker on a Member's phone: the folders above the files, nothing wider than the screen;
// - all of it passes the accessibility checks, light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page, Response } from "playwright";

import { pdf, photo, upload } from "../harness/images.ts";
import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { enterBuildingArea, settled } from "./building-area.ts";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let editor: TestAccount;
let admin: TestBrowser;
let siteId: string;
let page: Page;
const folderIds: Record<string, string> = {};
const fileIds: Record<string, string> = {};
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

	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>Acme Bakery</p></header><main>{{@outlet}}</main>",
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const pagesType = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	const { entry } = await api.entries.create({ siteId, postTypeId: pagesType?.id ?? "", title: "Menu", slug: "menu" });
	await api.entries.publish({ siteId, entryId: entry.id });

	for (const name of ["Products", "Blog", "Team"])
		folderIds[name] = (await api.media.folders.create({ siteId, name })).folder.id;
	// Oldest first: the list is newest first, so the price list comes first, then the pictures.
	const pictures: [string, number, number][] = [
		["tall-baguette.jpg", 300, 600],
		["wide-counter.jpg", 800, 400],
		["square-bun.jpg", 400, 400],
		["landscape-oven.jpg", 600, 400],
		["portrait-baker.jpg", 400, 560],
		["croissant-tray.jpg", 640, 480],
	];
	for (const [name, width, height] of pictures)
		fileIds[name] = (await api.media.upload({ siteId, file: upload(await photo({ width, height }), name) })).media.id;
	fileIds["price-list.pdf"] = (
		await api.media.upload({ siteId, file: upload(pdf("price-list.pdf"), "price-list.pdf") })
	).media.id;
	await local.drainJobs();

	page = await install.newPage("light");
	await page.setViewportSize({ width: 1440, height: 900 });
	await enterBuildingArea(install, page, { as: staff, siteId, slug, open: "/page/menu" });
});

afterAll(async () => {
	await page?.context().close();
	await install?.close();
});

async function go(address: string): Promise<void> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build${address}`));
}

async function openPicker(kind: "image" | null = "image"): Promise<void> {
	await go("/page/menu");
	await page.locator("iframe[data-wc-frame]").waitFor();
	await page.evaluate((asked) => {
		const detail = { kind: asked ?? undefined, current: null, taken: false, answer: () => {} };
		document.dispatchEvent(new CustomEvent("webcraft:pick-media", { detail }));
	}, kind);
	await page.locator("[data-wc-pick-list]").waitFor();
}

async function closePicker(): Promise<void> {
	await page.locator("[data-wc-media-picker]").getByRole("button", { name: "Cancel" }).click();
	await page.locator("[data-wc-media-picker]").waitFor({ state: "detached" });
}

type Box = { x: number; y: number; width: number; height: number };

async function boxes(selector: string): Promise<Box[]> {
	return page.locator(selector).evaluateAll((elements) =>
		elements.map((element) => {
			const { x, y, width, height } = element.getBoundingClientRect();
			return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
		}),
	);
}

/** The tiles of a grid, in the order of the files, each with its id and where it is. */
async function tilesOf(selector: string, attribute: string): Promise<(Box & { id: string })[]> {
	return page.locator(selector).evaluateAll(
		(elements, name) =>
			elements.map((element) => {
				const { x, y, width, height } = element.getBoundingClientRect();
				return { id: element.getAttribute(name) ?? "", x: Math.round(x), y: Math.round(y), width, height };
			}),
		attribute,
	);
}

const focusedFile = () => page.evaluate(() => document.activeElement?.getAttribute("data-wc-media-open") ?? null);
const folderNames = () => page.locator("[data-wc-media-folders] [data-wc-media-row]").allTextContents();

describe("the Media place's grid", () => {
	test("is a masonry: files in their own shapes, in place before the pictures arrive", async () => {
		await go("/page/menu?wc-place=media&wc-view=view%3Dgrid");
		await page.locator("[data-wc-media-grid]").waitFor();
		const first = await boxes("[data-wc-media-grid] > li");
		// 1440 wide: the card fits several columns of about 196.
		expect(Number(await page.locator("[data-wc-media-grid]").getAttribute("data-wc-grid-columns"))).toBeGreaterThan(3);

		const tall = page.locator(`[data-wc-media-file="${fileIds["tall-baguette.jpg"]}"]`);
		const wide = page.locator(`[data-wc-media-file="${fileIds["wide-counter.jpg"]}"]`);
		const tallBox = await tall.boundingBox();
		const wideBox = await wide.boundingBox();
		expect(Math.round(((tallBox?.height ?? 0) / (tallBox?.width ?? 1)) * 10) / 10).toBe(2);
		expect(Math.round(((wideBox?.height ?? 0) / (wideBox?.width ?? 1)) * 10) / 10).toBe(0.5);

		// Every picture loaded: no box moved.
		await page.waitForFunction(() =>
			[...document.querySelectorAll<HTMLImageElement>("[data-wc-media-grid] img")].every((image) => image.complete),
		);
		await settled(page);
		expect(await boxes("[data-wc-media-grid] > li")).toEqual(first);
		for (const image of await page.locator("[data-wc-media-grid] img").all())
			expect(await image.getAttribute("loading")).toBe("lazy");
	});

	test("shows a file's name and size under the pointer, and the kind of a file that isn't an image", async () => {
		const id = fileIds["square-bun.jpg"] ?? "";
		const caption = page.locator(`[data-wc-media-file="${id}"] [data-wc-media-caption]`);
		expect(await caption.evaluate((element) => getComputedStyle(element).opacity)).toBe("0");
		await page.locator(`[data-wc-media-file="${id}"]`).hover();
		await page.waitForFunction(
			(file) =>
				getComputedStyle(document.querySelector(`[data-wc-media-file="${file}"] [data-wc-media-caption]`) as Element)
					.opacity === "1",
			id,
		);
		expect(await caption.textContent()).toMatch(/^square-bun\.jpg\d+ (B|KB)$/);
		expect(await page.locator(`[data-wc-media-file="${fileIds["price-list.pdf"]}"]`).textContent()).toContain("PDF");
	});

	test("the arrow keys move between the pictures; Enter opens one", async () => {
		const tiles = await tilesOf("[data-wc-media-grid] > li", "data-wc-media-file");
		const order = tiles.map((tile) => tile.id);
		const at = (id: string | null) => tiles.find((tile) => tile.id === id);
		const columns = [...new Set(tiles.map((tile) => tile.x))].sort((a, b) => a - b);

		await page.locator(`[data-wc-media-open="${order[0]}"]`).focus();
		await page.keyboard.press("ArrowRight");
		// Right goes to the next column; files are laid left to right, so the second file is at its top.
		expect(await focusedFile()).toBe(order[1] ?? null);
		expect(at(await focusedFile())?.x).toBe(columns[1]);
		await page.keyboard.press("ArrowLeft");
		expect(at(await focusedFile())?.x).toBe(columns[0]);
		await page.keyboard.press("End");
		expect(await focusedFile()).toBe(order.at(-1) ?? null);
		await page.keyboard.press("Home");
		expect(await focusedFile()).toBe(order[0] ?? null);

		// Down goes to the file under, in the same column. A picture, as Enter opens it at its alt text below:
		// the files arrive close together, so where the PDF lands in the grid varies.
		const stacked = tiles.find(
			(tile) => tile.id !== fileIds["price-list.pdf"] && tiles.some((other) => other.x === tile.x && other.y > tile.y),
		);
		const under = tiles
			.filter((tile) => tile.x === stacked?.x && tile.y > (stacked?.y ?? 0))
			.sort((a, b) => a.y - b.y)[0];
		expect(under).toBeDefined();
		await page.locator(`[data-wc-media-open="${stacked?.id}"]`).focus();
		await page.keyboard.press("ArrowDown");
		expect(await focusedFile()).toBe(under?.id ?? null);
		await page.keyboard.press("ArrowUp");
		expect(await focusedFile()).toBe(stacked?.id ?? null);

		await page.keyboard.press("Enter");
		await page.waitForURL((url) => url.searchParams.get("wc-view")?.includes(`file=${stacked?.id}`) ?? false);
		await page.locator("[data-wc-media-alt-text]").waitFor();
	});

	test("List or Grid is remembered for the next time", async () => {
		await go("/page/menu?wc-place=media");
		await page.locator("[data-wc-media-list]").waitFor();
		await page.locator('[data-wc-media-layout="grid"]').click();
		await page.locator("[data-wc-media-grid]").waitFor();
		expect(await page.locator('[data-wc-media-layout="grid"]').getAttribute("aria-pressed")).toBe("true");

		await go("/page/menu?wc-place=media");
		await page.locator("[data-wc-media-grid]").waitFor();
		await page.locator('[data-wc-media-layout="list"]').click();
		await page.locator("[data-wc-media-list]").waitFor();
		await go("/page/menu?wc-place=media");
		await page.locator("[data-wc-media-list]").waitFor();
	});
});

describe("the picker", () => {
	test("shows an image's choice as a grid by default, with names and sizes; arrows choose across the columns", async () => {
		await openPicker("image");
		expect(await page.locator("[data-wc-pick-list]").getAttribute("data-wc-pick-layout-shown")).toBe("grid");
		expect(await page.locator('[data-wc-pick-layout="grid"]').getAttribute("aria-pressed")).toBe("true");
		const options = page.locator('[data-wc-pick-grid] [role="option"]');
		const order = await options.evaluateAll((elements) =>
			elements.map((element) => element.getAttribute("data-wc-pick")),
		);
		expect(await page.locator(`[data-wc-pick="${order[0]}"]`).textContent()).toMatch(/\.jpg\d+ (B|KB)$/);

		const tiles = await tilesOf('[data-wc-pick-grid] [role="option"]', "data-wc-pick");
		const at = (id: string | null) => tiles.find((tile) => tile.id === id);
		const columns = [...new Set(tiles.map((tile) => tile.x))].sort((a, b) => a - b);
		expect(columns.length).toBeGreaterThan(2);

		await page.locator("[data-wc-pick-list]").focus();
		await page.keyboard.press("Home");
		const chosen = () => page.locator('[role="option"][aria-selected="true"]').getAttribute("data-wc-pick");
		expect(await chosen()).toBe(order[0] ?? null);
		await page.keyboard.press("ArrowRight");
		expect(await chosen()).toBe(order[1] ?? null);
		expect(at(await chosen())?.x).toBe(columns[1]);
		const stacked = tiles.find((tile) => tiles.some((other) => other.x === tile.x && other.y > tile.y));
		const under = tiles
			.filter((tile) => tile.x === stacked?.x && tile.y > (stacked?.y ?? 0))
			.sort((a, b) => a.y - b.y)[0];
		await page.locator(`[data-wc-pick="${stacked?.id}"]`).click();
		await page.locator("[data-wc-pick-list]").focus();
		await page.keyboard.press("ArrowDown");
		expect(await chosen()).toBe(under?.id ?? null);
		await closePicker();
	});

	test("List or Grid is remembered for the picker", async () => {
		await openPicker("image");
		await page.locator('[data-wc-pick-layout="list"]').click();
		expect(await page.locator("[data-wc-pick-list]").getAttribute("data-wc-pick-layout-shown")).toBe("list");
		await closePicker();
		await openPicker("image");
		expect(await page.locator("[data-wc-pick-list]").getAttribute("data-wc-pick-layout-shown")).toBe("list");
		await page.locator('[data-wc-pick-layout="grid"]').click();
		await closePicker();
	});

	test("Add folder asks for the name in place: Escape cancels, Enter saves, the picker stays open", async () => {
		await openPicker("image");
		const picker = page.locator("[data-wc-media-picker]");
		await picker.locator("[data-wc-new-folder-button]").click();
		const name = picker.getByLabel("Name of the new folder");
		await name.fill("Never");
		await page.keyboard.press("Escape");
		await name.waitFor({ state: "detached" });
		expect(await picker.count()).toBe(1);
		await page.waitForFunction(() => document.activeElement?.hasAttribute("data-wc-new-folder-button"));

		await page.keyboard.press("Enter");
		await name.fill("Events");
		await page.keyboard.press("Enter");
		await picker.locator("[data-wc-media-row]", { hasText: "Events" }).waitFor();
		expect((await admin.api.media.folders.list({ siteId })).folders.map((folder) => folder.name)).toContain("Events");
		expect((await admin.api.media.folders.list({ siteId })).folders.map((folder) => folder.name)).not.toContain(
			"Never",
		);

		// A name the Site has is said under the box.
		await picker.locator("[data-wc-new-folder-button]").click();
		await name.fill("blog");
		await page.keyboard.press("Enter");
		await picker.locator("[data-wc-add-folder-error]").waitFor();
		expect(await name.getAttribute("aria-invalid")).toBe("true");
		// Focus stays in the box: Escape cancels the name, and the picker stays.
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-add-folder-name"))).toBe(true);
		await page.keyboard.press("Escape");
		await name.waitFor({ state: "detached" });
		folderIds.Events =
			(await admin.api.media.folders.list({ siteId })).folders.find((f) => f.name === "Events")?.id ?? "";
		await closePicker();
	});

	test("on a Member's phone, the folders sit above the files and nothing is wider than the screen", async () => {
		const phone = await install.newPage("light", { touch: true });
		try {
			await phone.setViewportSize({ width: 390, height: 844 });
			await enterBuildingArea(install, phone, { as: editor, siteId, slug, open: "/page/menu" });
			for (const theme of THEMES) {
				await phone.emulateMedia({ colorScheme: theme });
				await phone.evaluate(() => {
					const detail = { kind: "image", current: null, taken: false, answer: () => {} };
					document.dispatchEvent(new CustomEvent("webcraft:pick-media", { detail }));
				});
				await phone.locator("[data-wc-pick-list]").waitFor();
				const dialog = await phone.locator("[data-wc-media-picker]").boundingBox();
				const nav = await phone.locator("[data-wc-media-picker] nav").boundingBox();
				const files = await phone.locator("[data-wc-pick-list]").boundingBox();
				expect((dialog?.x ?? -1) >= 0 && (dialog?.x ?? 0) + (dialog?.width ?? 0) <= 390).toBe(true);
				expect((nav?.y ?? 0) + (nav?.height ?? 0)).toBeLessThanOrEqual((files?.y ?? 0) + 1);
				expect(files?.width ?? 0).toBeGreaterThan(300);
				// An Editor may add folders, here too.
				expect(await phone.locator("[data-wc-media-picker] [data-wc-new-folder-button]").count()).toBe(1);
				expect(
					await phone.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
				).toBe(true);
				await expectNoAxeViolations(phone, `building area, Media picker on a phone (${theme})`);
				await phone.locator("[data-wc-media-picker]").getByRole("button", { name: "Cancel" }).click();
				await phone.locator("[data-wc-media-picker]").waitFor({ state: "detached" });
			}
		} finally {
			await phone.context().close();
		}
	});
});

describe("the folders' order", () => {
	test("A–Z by default; Custom is kept for the Site", async () => {
		await go("/page/menu?wc-place=media");
		await page.locator("[data-wc-media-list]").waitFor();
		expect(await page.locator('[data-wc-folder-order="name"]').getAttribute("aria-pressed")).toBe("true");
		expect(await folderNames()).toEqual(["Blog0", "Events0", "Products0", "Team0"]);

		await page.locator('[data-wc-folder-order="custom"]').click();
		await page.waitForFunction(
			() => document.querySelector("[data-wc-media-folders]")?.getAttribute("data-wc-folders-order") === "custom",
		);
		for (let tries = 0; tries < 50 && (await admin.api.media.folders.list({ siteId })).order !== "custom"; tries++)
			await page.waitForTimeout(100);
		expect((await admin.api.media.folders.list({ siteId })).order).toBe("custom");
		// The order they were made in.
		await page.waitForFunction(
			() => document.querySelector("[data-wc-media-folders] [data-wc-media-row]")?.textContent === "Products0",
		);
		expect(await folderNames()).toEqual(["Products0", "Blog0", "Team0", "Events0"]);
	});

	test("in Custom, Move up and Move down in a folder's menu move it, and say so", async () => {
		const team = folderIds.Team ?? "";
		// The two moves end in the order they started from, so the server's order says nothing until both
		// saves have answered.
		let answered = 0;
		const count = (response: Response) => {
			if (response.request().method() === "POST" && response.url().includes("reorder")) answered++;
		};
		page.on("response", count);
		await page.locator(`[data-wc-folder="${team}"]`).hover();
		await page.locator(`[data-wc-folder-actions="${team}"]`).click();
		await page.getByRole("menuitem", { name: "Move up" }).click();
		await page.waitForFunction(
			() => document.querySelectorAll("[data-wc-media-folders] [data-wc-media-row]")[1]?.textContent === "Team0",
		);
		expect(await page.locator("[data-wc-folder-said]").textContent()).toMatch(/^Team moved to place 2 of 4\./);
		// Focus stays on the folder's menu button, which moved with it.
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-folder-actions"))).toBe(team);

		await page.keyboard.press("Enter");
		await page.getByRole("menuitem", { name: "Move up" }).waitFor();
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await page.waitForFunction(
			() => document.querySelectorAll("[data-wc-media-folders] [data-wc-media-row]")[1]?.textContent === "Blog0",
		);
		for (let tries = 0; tries < 100 && answered < 2; tries++) await page.waitForTimeout(100);
		page.off("response", count);
		expect(answered).toBe(2);
		expect((await admin.api.media.folders.list({ siteId })).folders.map((folder) => folder.name)).toEqual([
			"Products",
			"Blog",
			"Team",
			"Events",
		]);
	});

	test("in Custom, a folder is dragged to its place", async () => {
		const events = page.locator(`[data-wc-folder="${folderIds.Events}"]`);
		const products = page.locator(`[data-wc-folder="${folderIds.Products}"]`);
		await events.dragTo(products, { targetPosition: { x: 40, y: 4 } });
		await page.waitForFunction(
			() => document.querySelector("[data-wc-media-folders] [data-wc-media-row]")?.textContent === "Events0",
		);
		for (let tries = 0; tries < 50; tries++) {
			const names = (await admin.api.media.folders.list({ siteId })).folders.map((folder) => folder.name);
			if (names[0] === "Events") break;
			await page.waitForTimeout(100);
		}
		expect((await admin.api.media.folders.list({ siteId })).folders.map((folder) => folder.name)).toEqual([
			"Events",
			"Products",
			"Blog",
			"Team",
		]);
	});

	test("A–Z again sorts by name and offers no moving; the picker lists the folders the same way", async () => {
		await page.locator('[data-wc-folder-order="name"]').click();
		await page.waitForFunction(
			() => document.querySelector("[data-wc-media-folders] [data-wc-media-row]")?.textContent === "Blog0",
		);
		expect(await folderNames()).toEqual(["Blog0", "Events0", "Products0", "Team0"]);
		const team = folderIds.Team ?? "";
		await page.locator(`[data-wc-folder="${team}"]`).hover();
		await page.locator(`[data-wc-folder-actions="${team}"]`).click();
		expect(await page.getByRole("menuitem").allTextContents()).toEqual(["Rename", "Delete"]);
		await page.keyboard.press("Escape");

		await openPicker("image");
		expect(
			await page.locator("[data-wc-media-picker] [data-wc-media-folders] [data-wc-media-row]").allTextContents(),
		).toEqual(["Blog0", "Events0", "Products0", "Team0"]);
		await closePicker();
	});
});

for (const theme of THEMES) {
	test(`the grid, Add folder, the order control and the picker's grid pass the accessibility checks in ${theme}`, async () => {
		await page.emulateMedia({ colorScheme: theme });
		await go("/page/menu?wc-place=media&wc-view=view%3Dgrid");
		await page.locator("[data-wc-media-grid]").waitFor();
		await page.locator('[data-wc-folder-order="custom"]').click();
		await page.waitForFunction(
			() => document.querySelector("[data-wc-media-folders]")?.getAttribute("data-wc-folders-order") === "custom",
		);
		await page.locator("[data-wc-new-folder-button]").click();
		await page.getByLabel("Name of the new folder").waitFor();
		await page.locator(`[data-wc-media-file="${fileIds["square-bun.jpg"]}"]`).hover();
		await expectNoAxeViolations(page, `building area, Media place grid with Add folder (${theme})`);
		await page.getByLabel("Name of the new folder").press("Escape");
		await page.locator('[data-wc-folder-order="name"]').click();

		await openPicker("image");
		await expectNoAxeViolations(page, `building area, Media picker grid (${theme})`);
		await page.locator('[data-wc-pick-layout="list"]').click();
		await expectNoAxeViolations(page, `building area, Media picker list (${theme})`);
		await page.locator('[data-wc-pick-layout="grid"]').click();
		await closePicker();
	});
}
