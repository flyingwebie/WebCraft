// The building area's ground (ADR 0037, BA-01): the shell on the Site's address, the page in a frame
// of the same origin with the page agent first in its head, and the overlay drawn over it. Editing
// across the frame's edge is where the engines differ most, so every check of it runs in Chromium,
// Firefox and WebKit, on a page whose own script adds content and stops click propagation:
// - the Site's own script runs in the frame, an outside script shows its placeholder, Safe mode runs
//   none, and the shell runs no Site code;
// - the selected outline and its chip stay on the element at 100 %, zoomed, after the frame scrolls,
//   after the Site's script changes the page and after the window is resized;
// - a drag from a shell button across the frame's edge finds the element under the drop;
// - typing in a text region saves to the Draft, plain text stays on one line, links don't leave;
// - F6 and Shift+F6 move focus rail → the open docks → page → bar and back, focus visible on each;
// - a page opened at the top level lands in the shell on that page.
// The shell's chrome passes the accessibility checks (Chromium, light and dark), and the admin's way
// in and the logo tile's way back are checked there too.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Page } from "playwright";

import type { TestAccount, TestBrowser } from "../harness/index.ts";
import {
	announced,
	ENGINES,
	type Engine,
	type EnginePage,
	enginePages,
	enterBuildingArea,
	expectNoErrors,
	focusShellStart,
	frameOf,
	outlineDrift,
	settled,
	shellFocusVisible,
	zoomFrame,
} from "./building-area.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let pages: ReturnType<typeof enginePages>;
let staff: TestAccount;
let editor: TestAccount;
let superadmin: TestBrowser;
let siteId: string;
let entryId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";

/** The Site's own script: it marks the page, adds content on demand and stops clicks and pointer moves. */
const SITE_SCRIPT = [
	'document.documentElement.setAttribute("data-site-script", "ran");',
	'window.addEventListener("click", (event) => event.stopImmediatePropagation(), true);',
	'document.addEventListener("pointermove", (event) => event.stopPropagation(), true);',
	"window.addBanner = () => {",
	'\tconst banner = document.createElement("p");',
	'\tbanner.className = "site-banner";',
	'\tbanner.textContent = "Added by the Site\'s own script, above everything else.";',
	"\tdocument.body.prepend(banner);",
	"};",
].join("\n");

beforeAll(async () => {
	install = await startBrowserInstall();
	pages = enginePages(install);
	const local = install.install;
	superadmin = await local.superadmin();
	const { api } = superadmin;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).account;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Erin Editor" })).account;

	const filler = Array.from(
		{ length: 24 },
		(_, index) => `<p>Line ${index + 1} of the bakery's story, long enough to make the page scroll.</p>`,
	).join("");
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: [
			'<header><p>Welcome to <a href="/">Acme Bakery</a>.</p></header>',
			"<main>{{@outlet}}</main>",
			`<footer>${filler}</footer>`,
		].join(""),
	});
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
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup:
			'<article><h1>{{ title }}</h1><p>{{ subtitle }}</p><div>{{ intro }}</div><p>Read <a href="/blog/rye">about rye</a>.</p></article>',
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: post } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven at seven", intro: "<p>Sourdough, rye and spelt, baked by hand.</p>" },
	});
	entryId = post.id;
	await api.entries.publish({ siteId, entryId });
	const pagesType = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	const { entry: home } = await api.entries.create({
		siteId,
		postTypeId: pagesType?.id ?? "",
		title: "Home",
		slug: "home",
	});
	await api.entries.publish({ siteId, entryId: home.id });
	await api.pages.setHomePage({ siteId, pageId: home.id });
	const { script } = await api.scripts.saveDraft({ siteId, entryId: null, code: SITE_SCRIPT });
	await api.scripts.publish({ siteId, scriptId: script.id });
	await api.outsideScripts.add({
		siteId,
		name: "Chat widget",
		placement: "bodyEnd",
		consentCategory: "marketing",
		source: { kind: "url", url: "https://widgets.example.com/chat.js" },
	});
});

afterAll(async () => {
	await pages?.close();
	await install?.close();
});

/** The Entry's title as its Draft holds it now, read over the Management API. */
async function draftTitle(): Promise<string> {
	const { entry } = await superadmin.api.entries.get({ siteId, entryId });
	return entry.draft.title;
}

/** Waits until `read` answers `expected` (a save lands 0.8 s after typing stops). */
async function eventually<T>(read: () => Promise<T>, expected: T, timeout = 8000): Promise<T> {
	const deadline = Date.now() + timeout;
	let last = await read();
	while (!Object.is(last, expected) && Date.now() < deadline) {
		await Bun.sleep(150);
		last = await read();
	}
	return last;
}

/** Clicks an element of the page through the shell, as a pointer would, at a point of its box. */
async function clickIn(page: Page, frame: Frame, selector: string, at: "centre" | "end" = "centre"): Promise<void> {
	await frame.locator(selector).scrollIntoViewIfNeeded();
	await settled(page);
	const box = await frame.locator(selector).boundingBox();
	if (!box) throw new Error(`${selector} isn't shown.`);
	const x = at === "end" ? box.x + box.width - 3 : box.x + box.width / 2;
	await page.mouse.click(x, box.y + box.height / 2);
}

/** Drags from the shell's test control to the middle of an element of the page; answers what the shell reported. */
async function dragTo(page: Page, frame: Frame, selector: string): Promise<string | null> {
	await frame.locator(selector).scrollIntoViewIfNeeded();
	await settled(page);
	const from = await page.locator('[data-wc-drag="test"]').boundingBox();
	const to = await frame.locator(selector).boundingBox();
	if (!from || !to) throw new Error("Nothing to drag from or to.");
	await page.evaluate(() => {
		(window as unknown as { dropped?: string | null }).dropped = undefined;
	});
	await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
	await page.mouse.up();
	await settled(page);
	return page.evaluate(() => (window as unknown as { dropped?: string | null }).dropped ?? null);
}

/**
 * Puts the shell back as it opens: the window at 1280 × 900, the frame unzoomed and scrolled to the
 * top, focus and the pointer outside the page, so one check's state never reaches the next.
 */
async function reset(page: Page, frame: Frame): Promise<void> {
	await page.setViewportSize({ width: 1280, height: 900 });
	await page.evaluate(() => {
		const element = document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]");
		for (const property of ["width", "height", "transform"]) element?.style.removeProperty(property);
	});
	await frame.evaluate(() => window.scrollTo(0, 0));
	await page.mouse.move(1, 1);
	await focusShellStart(page);
	await settled(page);
}

for (const engine of ENGINES) {
	describe(`the framed page in ${engine}`, () => {
		let opened: EnginePage;
		let page: Page;
		let frame: Frame;

		beforeAll(async () => {
			opened = await pages.open(engine);
			page = opened.page;
			frame = await enterBuildingArea(install, page, { as: staff, siteId, slug, open: `/page${path}` });
		});

		afterAll(async () => {
			await page?.context().close();
		});

		test("runs the Site's own script, shows an outside script's placeholder; the shell runs no Site code", async () => {
			expect(new URL(page.url()).pathname).toBe(`/_webcraft/build/page${path}`);
			expect(new URL(frame.url()).pathname).toBe(path);
			expect(await frame.evaluate(() => document.documentElement.getAttribute("data-site-script"))).toBe("ran");
			expect(await frame.locator("aside.wc-outside-scripts").isVisible()).toBe(true);
			expect(await frame.locator('script[src="https://widgets.example.com/chat.js"]').count()).toBe(0);
			// The agent came first, before the Site's own scripts.
			expect(await frame.evaluate(() => document.head.querySelector("script")?.getAttribute("src") ?? "")).toMatch(
				/^\/_webcraft\/edit\/assets\/agent-[0-9a-f]{16}\.js$/,
			);
			expect(
				await page.evaluate(() => ({
					siteScripts: document.querySelectorAll("[data-wc-script], [data-wc-library]").length,
					ran: document.documentElement.hasAttribute("data-site-script"),
				})),
			).toEqual({ siteScripts: 0, ran: false });
		});

		test("the selected outline and its chip stay on the element: at 100 %, scrolled, changed, resized and zoomed", async () => {
			await reset(page, frame);
			await clickIn(page, frame, "article > p:first-of-type");
			expect(await outlineDrift(page, frame, "article > p:first-of-type", "selected")).toBeLessThanOrEqual(1);
			const chip = page.locator("[data-wc-chip]");
			// Staff's page tags every element: the chip names its tag first (BA-08).
			expect(await chip.textContent()).toMatch(/^p · Subtitle · \d+ × \d+$/);
			const chipBox = await chip.boundingBox();
			const outlineBox = await page.locator('[data-wc-outline="selected"]').boundingBox();
			// The chip sits on the outline's top left corner.
			expect(Math.abs((chipBox?.x ?? 0) - (outlineBox?.x ?? 0))).toBeLessThanOrEqual(1);
			expect(Math.abs((chipBox?.y ?? 0) + (chipBox?.height ?? 0) - (outlineBox?.y ?? 0))).toBeLessThanOrEqual(1);

			// The pointer over another element outlines it, dashed.
			const title = await frame.locator("h1").boundingBox();
			await page.mouse.move((title?.x ?? 0) + 5, (title?.y ?? 0) + 5);
			expect(await outlineDrift(page, frame, "h1", "hover")).toBeLessThanOrEqual(1);

			await frame.evaluate(() => window.scrollBy(0, 120));
			expect(await outlineDrift(page, frame, "article > p:first-of-type", "selected")).toBeLessThanOrEqual(1);

			// The Site's own script adds content above it: everything below moves down.
			await frame.evaluate(() => (window as unknown as { addBanner(): void }).addBanner());
			expect(await outlineDrift(page, frame, "article > p:first-of-type", "selected")).toBeLessThanOrEqual(1);

			await page.setViewportSize({ width: 1100, height: 800 });
			expect(await outlineDrift(page, frame, "article > p:first-of-type", "selected")).toBeLessThanOrEqual(1);

			const scale = await zoomFrame(page, 1920);
			expect(scale).toBeLessThan(1);
			expect(await outlineDrift(page, frame, "article > p:first-of-type", "selected")).toBeLessThanOrEqual(1);
			await frame.evaluate(() => window.scrollTo(0, 0));
			expect(await outlineDrift(page, frame, "article > p:first-of-type", "selected")).toBeLessThanOrEqual(1);
			// The chip says the element's own size, not its size on screen.
			const own = await frame.locator("article > p:first-of-type").evaluate((element) => {
				const box = element.getBoundingClientRect();
				return `${Math.round(box.width)} × ${Math.round(box.height)}`;
			});
			expect(await chip.textContent()).toBe(`p · Subtitle · ${own}`);
		});

		test("a drag from a shell button across the frame's edge finds the element under the drop, at 100 % and zoomed", async () => {
			await reset(page, frame);
			// BA-01 has no drag source of its own yet: a control carrying `data-wc-drag`, as the insert row's will.
			await page.evaluate(() => {
				const button = document.createElement("button");
				button.type = "button";
				button.textContent = "Drag me";
				button.dataset.wcDrag = "test";
				document.querySelector('[data-building-region="bar"]')?.append(button);
				document.addEventListener("webcraft:drop", (event) => {
					const target = (event as CustomEvent<{ target: Element | null }>).detail.target;
					(window as unknown as { dropped: string | null }).dropped = target
						? `${target.localName}:${target.getAttribute("data-wc-field") ?? ""}`
						: null;
				});
			});

			expect(await dragTo(page, frame, "h1")).toBe("h1:title");
			expect(await announced(page)).toBe("Dropped on Title");
			// The catcher is gone once the pointer is up.
			expect(await page.locator("[data-wc-catcher]").count()).toBe(0);

			await zoomFrame(page, 1920);
			expect(await dragTo(page, frame, "article > p:first-of-type")).toBe("p:subtitle");
			expect(await dragTo(page, frame, "footer p:nth-of-type(3)")).toBe("p:");
		});

		test("typing in a text region saves to the Draft; plain text stays on one line; links don't leave", async () => {
			await reset(page, frame);
			const before = await frame.locator("h1").evaluate((element) => element.textContent ?? "");
			await clickIn(page, frame, "h1", "end");
			expect(await frame.evaluate(() => document.activeElement?.localName)).toBe("h1");
			await page.keyboard.press("End");
			await page.keyboard.type(` ${engine}`);
			await page.keyboard.press("Enter");
			await page.keyboard.type("!");

			const expected = `${before} ${engine}!`;
			// What a browser keeps a typed space as is its own (a no-break space at the end of a line).
			const typed = async () => (await draftTitle()).replaceAll("\u00a0", " ");
			expect(await eventually(typed, expected)).toBe(expected);
			expect(await frame.locator("h1").evaluate((element) => element.innerHTML.replaceAll("&nbsp;", " "))).toBe(
				expected,
			);
			expect(await announced(page)).toBe("Saved");

			// A link in the page is selected, never followed, while editing.
			await clickIn(page, frame, 'a[href="/blog/rye"]');
			await settled(page);
			expect(new URL(frame.url()).pathname).toBe(path);
			expect(await page.locator("[data-wc-chip]").textContent()).toMatch(/^a · Link · /);
		});

		test("F6 and Shift+F6 move focus rail → the open docks → page → bar and back, focus visible on each", async () => {
			await reset(page, frame);
			await focusShellStart(page);
			const where = () =>
				page.evaluate(() => {
					const active = document.activeElement;
					if (active?.matches("iframe[data-wc-frame]")) return "canvas";
					return active?.closest<HTMLElement>("[data-building-region]")?.dataset.buildingRegion ?? "none";
				});
			const frameRing = () => page.locator("[data-wc-frame-focus]").isVisible();

			await page.keyboard.press("F6");
			expect(await where()).toBe("rail");
			expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-logo"))).toBe(true);
			expect(await shellFocusVisible(page)).toBe(true);

			// The open docks, in order (Layers is always shown on the right; the bottom one while something is selected).
			const docks = await page.evaluate(() =>
				["left", "right", "bottom"].filter((side) => document.querySelector(`[data-wc-dock="${side}"]`) !== null),
			);
			expect(docks).toContain("right");
			for (const dock of docks) {
				await page.keyboard.press("F6");
				expect(await where()).toBe(dock);
				expect(await shellFocusVisible(page)).toBe(true);
			}

			await page.keyboard.press("F6");
			expect(await where()).toBe("canvas");
			expect(await frame.evaluate(() => document.hasFocus())).toBe(true);
			await settled(page);
			expect(await frameRing()).toBe(true);

			// From inside the page: the agent hands F6 to the shell before any Site script sees it.
			await page.keyboard.press("F6");
			expect(await where()).toBe("bar");
			expect(await shellFocusVisible(page)).toBe(true);
			await settled(page);
			expect(await frameRing()).toBe(false);

			await page.keyboard.press("F6");
			expect(await where()).toBe("rail");

			await page.keyboard.press("Shift+F6");
			expect(await where()).toBe("bar");
			await page.keyboard.press("Shift+F6");
			expect(await where()).toBe("canvas");
			await settled(page);
			expect(await frameRing()).toBe(true);
			for (const dock of [...docks].reverse()) {
				await page.keyboard.press("Shift+F6");
				expect(await where()).toBe(dock);
			}
			await page.keyboard.press("Shift+F6");
			expect(await where()).toBe("rail");
		});

		test("a page opened at the top level lands in the shell on that page", async () => {
			await page.goto(install.siteUrl(slug, "/"));
			await page.waitForURL((url) => url.pathname === "/_webcraft/build/page/");
			const home = await frameOf(page);
			expect(new URL(home.url()).pathname).toBe("/");

			await page.goto(install.siteUrl(slug, path));
			await page.waitForURL((url) => url.pathname === `/_webcraft/build/page${path}`);
			expect(new URL((await frameOf(page)).url()).pathname).toBe(path);
			expectNoErrors(`${engine}: the framed page`, opened.errors);
		});

		test("Safe mode runs none of the Site's own scripts in the frame", async () => {
			const safe = await pages.open(engine);
			try {
				const safeFrame = await enterBuildingArea(install, safe.page, {
					as: editor,
					siteId,
					slug,
					open: `/page${path}`,
					safeMode: true,
				});
				expect(await safeFrame.evaluate(() => document.documentElement.hasAttribute("data-site-script"))).toBe(false);
				expect(await safeFrame.locator('meta[name="webcraft-safe-mode"]').count()).toBe(1);
				// The agent still runs: the regions are editable.
				expect(await safeFrame.locator("h1[contenteditable]").count()).toBe(1);
				expectNoErrors(`${engine}: Safe mode`, safe.errors);
			} finally {
				await safe.page.context().close();
			}
		});
	});
}

describe("the shell in Chromium", () => {
	for (const theme of THEMES) {
		test(`passes the accessibility checks, with the page in ${theme}`, async () => {
			const { page } = await pages.open("chromium" satisfies Engine, theme);
			await enterBuildingArea(install, page, { as: editor, siteId, slug, open: `/page${path}` });
			await expectAccessibleScreen(page, `building area (${theme})`);
			await page.context().close();
		});
	}

	test("the admin's way in opens it for Staff, and the logo tile goes back to where they came from", async () => {
		const page = await install.newPage("light");
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}/media`));
		await page.getByRole("button", { name: "More ways to open Edit mode" }).click();
		await page.getByRole("menuitem", { name: /Open the building area/ }).click();
		await page.waitForURL((url) => url.pathname === "/_webcraft/build/page/");
		await frameOf(page);

		const logo = page.getByRole("link", { name: "Back to the admin" });
		expect(await logo.getAttribute("href")).toBe(install.adminUrl(`/sites/${siteId}/media`));
		await logo.click();
		await page.waitForURL((url) => url.href === install.adminUrl(`/sites/${siteId}/media`));
		await page.context().close();
	});

	test("Members don't get the way in from the menu while the building area is in progress", async () => {
		const page = await install.newPage("light");
		await install.signIn(page, editor);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "More ways to open Edit mode" }).click();
		await page.getByRole("menuitem", { name: /Edit in Safe mode/ }).waitFor();
		expect(await page.getByRole("menuitem", { name: /Open the building area/ }).count()).toBe(0);
		await page.context().close();
	});
});
