// The building area loads each place when it is opened (BA-30), in Chromium:
// - the shell's first load fetches its first file and its person's shell (Staff's, or a Member's) with
//   the parts it shares, each once, and no place's code nor the other person's shell (the network list);
// - each place opens from the rail, from its address on a reload, and from Back and Forward, its file
//   fetched once in the page's life;
// - the Media picker's file is fetched the first time a file is asked for, once;
// - a place whose file can't be fetched shows its frame and header, says so in words, and Try again
//   loads it; when the shell's own files are gone (WebCraft updated meanwhile), Try again loads the page
//   again, which opens the place; a picker that can't be fetched says so in a toast and answers null;
//   a person's shell that can't be fetched says so, and Reload draws it;
// - the loading and failed frames pass axe and the keyboard check, light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page, Route } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { enterBuildingArea } from "./building-area.ts";
import { expectAccessibleScreen, expectKeyboardUsable, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let editor: TestAccount;
let siteId: string;
const slug = "bakery";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
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
	for (const [title, pageSlug] of [
		["Home", "home"],
		["Menu", "menu"],
	] as const) {
		const { entry } = await api.entries.create({ siteId, postTypeId: pagesType?.id ?? "", title, slug: pageSlug });
		await api.entries.publish({ siteId, entryId: entry.id });
		if (pageSlug === "home") await api.pages.setHomePage({ siteId, pageId: entry.id });
	}
	await api.forms.create({ siteId, name: "Contact" });
});

afterAll(async () => {
	await install?.close();
});

/** The shell's own scripts (`/_webcraft/edit/assets/shell-…js`) a page asked for, each with how many times. */
function shellRequests(page: Page): Map<string, number> {
	const asked = new Map<string, number>();
	page.on("request", (request) => {
		const name = new URL(request.url()).pathname.match(/^\/_webcraft\/edit\/assets\/(shell-[^/]+\.js)$/)?.[1];
		if (name) asked.set(name, (asked.get(name) ?? 0) + 1);
	});
	return asked;
}

/** The file each place's code is in, by the module that draws it (`ContentPlace`), as the server names it. */
const PLACE_FILES: Record<string, string> = {
	content: "ContentPlace",
	templates: "TemplatesPlace",
	media: "MediaPlace",
	styles: "StylesPlace",
	loops: "LoopsPlace",
	components: "ComponentsPlace",
	forms: "FormsPlace",
};

/** How many times the page asked for the file of a module (`ContentPlace`, `Picker`). */
function asked(requests: ReadonlyMap<string, number>, module: string): number {
	const pattern = new RegExp(`^shell-${module}-[0-9a-f]{16}\\.js$`);
	return [...requests].filter(([name]) => pattern.test(name)).reduce((sum, [, count]) => sum + count, 0);
}

/** The files of a module of the shell's other than its first file and the parts they share. */
function moduleFiles(requests: ReadonlyMap<string, number>): string[] {
	return [...requests.keys()].filter((name) => !/^shell-(main-)?[0-9a-f]{16}\.js$/.test(name));
}

/** The files of a place's code (or the Media picker's) the page asked for: none of a person's shell. */
function placeFiles(requests: ReadonlyMap<string, number>): string[] {
	return moduleFiles(requests).filter((name) => !/^shell-(Client)?Shell-/.test(name));
}

/** What a first load fetched: its first file, the person's shell, the shared parts, each once and nothing else. */
function expectFirstLoad(requests: ReadonlyMap<string, number>, shell: "Shell" | "ClientShell"): void {
	expect(moduleFiles(requests).map(moduleOf)).toEqual([shell]);
	expect([...requests.keys()].filter((name) => /^shell-[0-9a-f]{16}\.js$/.test(name))).toHaveLength(1);
	expect([...requests.values()].every((count) => count === 1)).toBe(true);
}

/** The module a file of the shell's holds (`ContentPlace` for `shell-ContentPlace-<hash>.js`). */
function moduleOf(name: string): string {
	return name.replace(/^shell-/, "").replace(/-[0-9a-f]{16}\.js$/, "");
}

/** Opens a shell address in the page (as a bookmark or a typed address does). */
async function go(page: Page, address: string): Promise<void> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build${address}`));
}

const placeFrame = (page: Page) => page.locator("[data-wc-place-frame]");
const loading = (page: Page) => page.locator("[data-wc-place-load]");

/** Waits until the open place is drawn by its own code (its file has arrived; no loading or failed line). */
async function placeDrawn(page: Page, place: string): Promise<void> {
	await page.locator(`[data-wc-place-frame^="${place}"]`).waitFor();
	await loading(page).waitFor({ state: "detached" });
}

/** Opens a place as the rail does: its button, or Forms from "more". */
async function openFromRail(page: Page, place: string): Promise<void> {
	if (place === "forms") {
		await page.locator('[data-wc-place="more"]').click();
		await page.locator('[data-wc-choice="forms"]').click();
	} else {
		await page.locator(`[data-wc-place="${place}"]`).click();
	}
	await placeDrawn(page, place);
}

/** Leaves the open place with its back button, and waits for the canvas. */
async function leave(page: Page): Promise<void> {
	await page.locator("[data-wc-place-back]").click();
	await placeFrame(page).waitFor({ state: "detached" });
}

/** Asks for a file as the shell's parts do (`pickMedia()`), and answers what came back: an id, or null. */
async function pick(page: Page): Promise<string | null> {
	await page.evaluate(() => {
		const holder = window as unknown as { picked?: Promise<string | null> };
		holder.picked = new Promise((resolve) => {
			const detail = {
				kind: "image",
				current: null,
				taken: false,
				answer: (item: { id: string } | null) => resolve(item?.id ?? null),
			};
			document.dispatchEvent(new CustomEvent("webcraft:pick-media", { detail }));
			if (!detail.taken) resolve(null);
		});
	});
	return page.evaluate(() => (window as unknown as { picked: Promise<string | null> }).picked);
}

describe("the shell loads each place when it is opened, for Staff", () => {
	let page: Page;
	let requests: Map<string, number>;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		requests = shellRequests(page);
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: "/page/menu" });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("the first load fetches Staff's shell and no place's code", async () => {
		await page.locator('[data-wc-place="content"]').waitFor();
		expectFirstLoad(requests, "Shell");
	});

	test("each place opens from the rail, its file fetched the first time only", async () => {
		for (const [place, module] of Object.entries(PLACE_FILES)) {
			await openFromRail(page, place);
			expect({ place, fetched: asked(requests, module) }).toEqual({ place, fetched: 1 });
			await leave(page);
		}
		// Opened again: drawn at once, nothing fetched again.
		const before = new Map(requests);
		for (const place of Object.keys(PLACE_FILES)) {
			await openFromRail(page, place);
			await leave(page);
		}
		expect(requests).toEqual(before);
		expect(placeFiles(requests).map(moduleOf).sort()).toEqual(Object.values(PLACE_FILES).sort());
	});

	test("a place opens from its address on a reload, and from Back and Forward, its file fetched once", async () => {
		await openFromRail(page, "media");
		requests.clear();
		await page.reload();
		await placeDrawn(page, "media");
		// The new page fetched the Media place's code with its first file, and no other place's.
		expect(placeFiles(requests)).toEqual([expect.stringMatching(/^shell-MediaPlace-[0-9a-f]{16}\.js$/)]);

		await page.locator('[data-wc-place="content"]').click();
		await placeDrawn(page, "content");
		await page.goBack();
		await placeDrawn(page, "media");
		expect(new URL(page.url()).searchParams.get("wc-place")).toBe("media");
		await page.goForward();
		await placeDrawn(page, "content");
		expect(asked(requests, "MediaPlace")).toBe(1);
		expect(asked(requests, "ContentPlace")).toBe(1);
		await leave(page);
	});

	test("the Media picker's file is fetched the first time a file is asked for, once", async () => {
		expect(asked(requests, "Picker")).toBe(0);
		const first = pick(page);
		await page.locator("[data-wc-media-picker]").waitFor();
		await page.keyboard.press("Escape");
		expect(await first).toBeNull();
		const second = pick(page);
		await page.locator("[data-wc-media-picker]").waitFor();
		await page.getByRole("button", { name: "Cancel" }).click();
		expect(await second).toBeNull();
		expect(asked(requests, "Picker")).toBe(1);
	});

	for (const theme of THEMES) {
		test(`a place's frame shows while its code loads, with the page in ${theme}`, async () => {
			await page.emulateMedia({ colorScheme: theme });
			await go(page, "/page/menu");
			await page.locator('[data-wc-place="content"]').waitFor();
			// The place's file is held back until the frame has been checked.
			let release: () => void = () => {};
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const hold = async (route: Route) => {
				await held;
				await route.continue();
			};
			await page.route(/\/shell-ContentPlace-[0-9a-f]{16}\.js$/, hold);
			await page.locator('[data-wc-place="content"]').click();
			await page.locator('[data-wc-place-load="loading"]').waitFor();
			expect(await page.locator("[data-wc-place-frame] h1").textContent()).toBe("Content");
			expect(await page.locator('[data-wc-place-load="loading"]').textContent()).toBe("Loading Content…");
			expect(await page.locator("[data-wc-place-header]").boundingBox()).toMatchObject({ height: 40 });
			expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-place-back"))).toBe(true);
			await expectAccessibleScreen(page, `building area, a place loading (${theme})`);
			release();
			await placeDrawn(page, "content");
			await page.unroute(/\/shell-ContentPlace-[0-9a-f]{16}\.js$/, hold);
			await leave(page);
		});
	}
});

describe("the shell loads each place when it is opened, for a Member", () => {
	let page: Page;
	let requests: Map<string, number>;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		requests = shellRequests(page);
		await enterBuildingArea(install, page, { as: editor, siteId, slug, open: "/page/menu" });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("the first load fetches a Member's shell, not Staff's, and no place's code; Content comes when opened", async () => {
		await page.locator('[data-wc-place="content"]').waitFor();
		expectFirstLoad(requests, "ClientShell");

		await openFromRail(page, "content");
		expect(await page.locator("[data-wc-place-back]").textContent()).toBe("Back to Menu");
		expect(placeFiles(requests)).toEqual([expect.stringMatching(/^shell-ContentPlace-[0-9a-f]{16}\.js$/)]);
	});
});

describe("a place's code that can't be fetched", () => {
	let page: Page;
	const contentFile = /\/shell-ContentPlace-[0-9a-f]{16}\.js$/;
	const offline = (route: Route) => route.abort("internetdisconnected");

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: "/page/menu" });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("says so in words in the place's frame, and Try again loads it", async () => {
		const requests = shellRequests(page);
		await page.route(contentFile, offline);
		await page.locator('[data-wc-place="content"]').click();
		const failed = page.locator('[data-wc-place-load="failed"]');
		await failed.waitFor();
		expect(await page.locator("[data-wc-place-frame] h1").textContent()).toBe("Content");
		expect(await failed.getByRole("alert").textContent()).toBe(
			"Content couldn't be loaded. Check the connection, then try again.",
		);
		for (const theme of THEMES) {
			await page.emulateMedia({ colorScheme: theme });
			// The failed fetch is reported in the console by the browser itself: axe and the keyboard only.
			await expectNoAxeViolations(page, `building area, a place that couldn't load (${theme})`);
			await expectKeyboardUsable(page, `building area, a place that couldn't load (${theme})`);
		}

		await page.unroute(contentFile, offline);
		await failed.getByRole("button", { name: "Try again" }).click();
		await placeDrawn(page, "content");
		await page.locator("[data-wc-content-lists]").waitFor();
		expect(asked(requests, "ContentPlace")).toBe(2);
	});

	test("after WebCraft was updated (the shell's files are gone), Try again loads the page again", async () => {
		await go(page, "/page/menu");
		await page.locator('[data-wc-place="content"]').waitFor();
		const shellFile = /\/_webcraft\/edit\/assets\/shell-[0-9a-f]{16}\.js$/;
		const gone = async (route: Route) => {
			if (route.request().method() === "HEAD") await route.fulfill({ status: 404, body: "" });
			else await route.continue();
		};
		await page.route(contentFile, offline);
		await page.route(shellFile, gone);
		await page.locator('[data-wc-place="content"]').click();
		await page.locator('[data-wc-place-load="failed"]').waitFor();

		// The new files are there again once the page loads anew.
		await page.unroute(contentFile, offline);
		const reloaded = page.waitForEvent("load");
		await page.getByRole("button", { name: "Try again" }).click();
		await reloaded;
		await page.unroute(shellFile, gone);
		await placeDrawn(page, "content");
		expect(new URL(page.url()).searchParams.get("wc-place")).toBe("content/pages");
	});

	test("the shell itself that can't be fetched says so, and Reload draws it", async () => {
		const shellFile = /\/shell-Shell-[0-9a-f]{16}\.js$/;
		await page.route(shellFile, offline);
		await go(page, "/page/menu");
		const failed = page.locator("[data-wc-shell-failed]");
		await failed.waitFor();
		expect(await failed.getByRole("alert").textContent()).toBe(
			"The building area couldn't be loaded. Check the connection, then reload the page.",
		);
		await expectNoAxeViolations(page, "building area, the shell that couldn't load");
		await page.unroute(shellFile, offline);
		await failed.getByRole("button", { name: "Reload the page" }).click();
		await page.locator('[data-wc-place="content"]').waitFor();
	});

	test("the Media picker that can't be fetched says so, and the caller gets null", async () => {
		await go(page, "/page/menu");
		await page.locator('[data-wc-place="content"]').waitFor();
		const pickerFile = /\/shell-Picker-[0-9a-f]{16}\.js$/;
		await page.route(pickerFile, offline);
		expect(await pick(page)).toBeNull();
		expect(await page.locator('[data-wc-toast="error"]').textContent()).toContain(
			"The Media picker couldn't be loaded. Check the connection, then try again.",
		);
		await page.unroute(pickerFile, offline);
		// Asked again, it opens.
		const again = pick(page);
		await page.locator("[data-wc-media-picker]").waitFor();
		await page.keyboard.press("Escape");
		expect(await again).toBeNull();
	});
});
