// Client editing on a phone and a tablet (ADR 0037, BA-19; SPEC 13.9, `client-flows/06`), in Chromium
// with a touch screen, as the old editing bar's phone checks were:
// - at 390 × 844 the phone's one bar (Undo, the page's name, Edit, More, Publish) replaces the rail and
//   the bar, and the page is edge to edge; More is a sheet from the bottom with Preview, the language,
//   Sections, Page details, Redo, Help, Exit, the Draft's state and Publish;
// - every panel and popover is a sheet from the bottom: Publish, a photo's popover (the photo kept in
//   view above it; Escape gives focus back to it), Page details, Sections with its moves, Settings and
//   the picker, the list of Pages; Help;
// - every control people tap is at least 44 px; the text toolbar sits on the on-screen keyboard and
//   what is being edited stays above it;
// - Undo on the bar and Redo in More, each naming its step;
// - the first visit on a phone is one line over the page; Help shows the whole card;
// - at 768 (a tablet) the desktop shell with its words kept only where they are needed;
// - the layout follows the window at every width, no notice covers it, and nothing is wider than the
//   window; the page isn't loaded again.
// The building area's own test of the phone cases of `edit-mode-in-place.browser.ts`,
// `page-layouts.browser.ts`, `edit-mode-history.browser.ts` and the client part of
// `window-width.browser.ts`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiClient } from "@webcraft/api";
import { EDITOR_LAYOUT_VERSION } from "@webcraft/core";
import type { Frame, Locator, Page } from "playwright";

import { photo, upload } from "../harness/images.ts";
import type { TestAccount } from "../harness/index.ts";
import { enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let api: ApiClient;
let editor: TestAccount;
let siteId: string;
let homeId: string;
let breadId: string;
const slug = "bakery";
const bread = "/bakes/fresh-bread";
const PHONE = { width: 390, height: 844 };

type Component = Awaited<ReturnType<ApiClient["components"]["create"]>>["component"];
let hero: Component;
let quote: Component;

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	({ api } = await local.superadmin());
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Giulia Romano" })).account;
	await api.languages.add({ siteId, code: "it" });
	const { media } = await api.media.upload({
		siteId,
		file: upload(await photo({ width: 640, height: 480 }), "loaf.jpg"),
	});
	await api.media.update({ siteId, mediaId: media.id, alt: "A round sourdough loaf" });
	await local.drainJobs();

	await api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	await api.globals.saveDraft({ siteId, fields: { tagline: "Baked daily" } });
	await api.globals.publish({ siteId });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: [
			"<header><p>Acme Bakery</p><p>{{ site.tagline }}</p></header>",
			"<main>{{@outlet}}</main>",
			"<footer><p>Harbour Street, Cork.</p></footer>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: site.template.id });

	const made = async (
		name: string,
		props: NonNullable<Parameters<ApiClient["components"]["create"]>[0]["props"]>,
		markup: string,
	) => {
		const { component } = await api.components.create({ siteId, name, props });
		await api.components.saveMarkup({ siteId, componentId: component.id, markup });
		await api.components.publish({ siteId, componentId: component.id });
		return component;
	};
	hero = await made(
		"Hero",
		[{ key: "heading", label: "Heading", type: "text", translatable: true }],
		"<section><h1>{{ props.heading }}</h1></section>",
	);
	quote = await made(
		"Quote",
		[{ key: "quote", label: "Quote", type: "text", default: "Best bread in Cork." }],
		"<section><blockquote>{{ props.quote }}</blockquote></section>",
	);
	await api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [hero.id, quote.id] });

	const pagesId = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id ?? "";
	const { entry: home } = await api.entries.create({ siteId, postTypeId: pagesId, title: "Home", slug: "home" });
	homeId = home.id;
	await api.pages.setHomePage({ siteId, pageId: homeId });
	await resetHome();
	await api.entries.publish({ siteId, entryId: homeId });

	const { postType } = await api.postTypes.create({
		siteId,
		name: "Bakes",
		urlPattern: "/bakes/{slug}",
		fields: [
			{ key: "subtitle", label: "Subtitle", type: "text" },
			{ key: "photo", label: "Hero photo", type: "media" },
			{ key: "intro", label: "Intro", type: "richText" },
			{ key: "cta", label: "Order button", type: "link" },
		],
	});
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: [
			"<article><h1>{{ title }}</h1><p>{{ subtitle }}</p>",
			'<img src="{{ photo }}" width="320" height="240">',
			"<div>{{ intro }}</div>",
			'<p><a href="{{ cta.url }}">{{ cta.text }}</a></p>',
			"<p>Every loaf is shaped by hand and baked on stone. ".repeat(12),
			"</p></article>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: {
			subtitle: "Out of the oven at seven",
			photo: media.id,
			intro: "<p>Sourdough, pastries and cakes, baked by hand.</p>",
			cta: { url: "/", text: "Order now" },
		},
	});
	breadId = entry.id;
	await api.entries.publish({ siteId, entryId: breadId });
});

afterAll(async () => {
	await install?.close();
});

/** Puts the home page's two sections back as they began, in its Draft. */
async function resetHome(): Promise<void> {
	const state = await api.pageLayouts.get({ siteId, entryId: homeId });
	await api.pageLayouts.save({
		siteId,
		entryId: homeId,
		basedOn: state.version,
		layout: {
			placements: (
				[
					["north", "North"],
					["south", "South"],
				] as const
			).map(([id, heading]) => ({
				id,
				component: hero.id,
				props: hero.draft.props,
				values: { heading: { en: heading } } as never,
			})),
		},
	});
}

type Box = { x: number; y: number; width: number; height: number };

async function box(locator: Locator): Promise<Box> {
	const found = await locator.boundingBox();
	if (!found) throw new Error("It isn't shown.");
	return found;
}

/** Waits until the shell has said `text`. */
async function said(page: Page, text: string): Promise<void> {
	await page.waitForFunction(
		(text) => (document.querySelector("[data-wc-messages]")?.textContent ?? "").replaceAll(" ", "").includes(text),
		text,
		{ timeout: 8000 },
	);
}

/** Waits until a value read over the API is what `ok` wants; answers the last one read. */
async function eventually<T>(read: () => Promise<T>, ok: (value: T) => boolean): Promise<T> {
	let last = await read();
	for (let attempt = 0; attempt < 60 && !ok(last); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 150));
		last = await read();
	}
	return last;
}

const tagline = (frame: Frame) => frame.locator('header [data-wc-field="tagline"]');
const taglineNow = async () =>
	String((await api.globals.get({ siteId })).globals.draft.tagline ?? "").replaceAll(" ", " ");
const bar = (page: Page) => page.locator("[data-wc-client-bar]");
const more = (page: Page) => page.locator('[data-wc-phone-bar="more"]');
const moreSheet = (page: Page) => page.getByRole("dialog", { name: "More", exact: true });

/** Opens a page in the shell (the session's cookies are there: the link was followed once). */
async function open(page: Page, path: string): Promise<Frame> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build/page${path}`));
	for (let attempt = 0; attempt < 100; attempt++) {
		const frame = await frameOf(page);
		if (new URL(frame.url()).pathname === path) {
			await frame.locator("[data-wc-item][contenteditable]").first().waitFor({ state: "attached" });
			await bar(page).waitFor();
			// The Draft's state has been read: Publish knows what it covers.
			await page.locator("[data-wc-publish]").waitFor();
			return frame;
		}
		await page.waitForTimeout(50);
	}
	throw new Error(`The frame never showed ${path}.`);
}

/** Every control a finger may tap in the shell (not the page in the frame) that is smaller than 44 × 44. */
async function smallTargets(page: Page, within = "[data-wc-client]"): Promise<string[]> {
	return page.evaluate((within) => {
		const controls = [
			...document.querySelectorAll<HTMLElement>(
				`${within} :is(button, a[href], input:not([type=checkbox], [type=radio], [type=hidden], [type=file]), select, textarea, [role=button], [role=switch], [role=tab], [role=treeitem], [role=option], [role=menuitem])`,
			),
		];
		return controls
			.filter((control) => {
				if (control.closest("[inert], .sr-only") || control.classList.contains("sr-only")) return false;
				const rect = control.getBoundingClientRect();
				if (rect.width === 0 || rect.height === 0) return false;
				const style = getComputedStyle(control);
				if (style.visibility === "hidden") return false;
				return rect.height < 43.5 || rect.width < 43.5;
			})
			.map(
				(control) =>
					`${control.getAttribute("aria-label") ?? control.textContent?.trim() ?? control.localName} (${Math.round(control.getBoundingClientRect().width)} × ${Math.round(control.getBoundingClientRect().height)})`,
			);
	}, within);
}

/** Whether a sheet is along the bottom of the window, as wide as it. */
async function alongTheBottom(page: Page, sheet: Locator): Promise<void> {
	const shown = await box(sheet);
	const window = page.viewportSize() ?? PHONE;
	expect(Math.round(shown.x)).toBe(0);
	expect(Math.round(shown.width)).toBe(window.width);
	expect(Math.abs(shown.y + shown.height - window.height)).toBeLessThanOrEqual(1);
}

/** Whether nothing in the shell's window is wider than it. */
async function overflow(page: Page): Promise<{ page: number; bar: number }> {
	return page.evaluate(() => {
		const shownBar = document.querySelector<HTMLElement>("[data-wc-client-bar]");
		return {
			page: document.documentElement.scrollWidth - window.innerWidth,
			bar: shownBar ? shownBar.scrollWidth - shownBar.clientWidth : -1,
		};
	});
}

describe("client editing on a phone", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light", { touch: true });
		await page.setViewportSize(PHONE);
		await enterBuildingArea(install, page, { as: editor, siteId, slug, open: "/page/" });
		await bar(page).waitFor();
	});

	afterAll(async () => {
		await page?.context().close();
	});

	for (const theme of ["light", "dark"] as const) {
		test(`one bar, the page edge to edge, and More as a sheet from the bottom (${theme})`, async () => {
			await page.emulateMedia({ colorScheme: theme });
			await open(page, bread);
			expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
			expect(await page.locator("[data-wc-client]").getAttribute("data-wc-layout")).toBe("phone");

			// No rail: one bar along the bottom, 60 high, Undo, the page's name, Edit, More and Publish.
			expect(await page.locator("[data-wc-client-rail]").count()).toBe(0);
			expect(await page.locator("[data-wc-narrow]").count()).toBe(0);
			const shownBar = await box(bar(page));
			expect(shownBar).toEqual({ x: 0, y: PHONE.height - 60, width: PHONE.width, height: 60 });
			const order = await bar(page).evaluate((element) =>
				[...element.querySelectorAll<HTMLElement>("button")].map(
					(button) =>
						button.dataset.wcBar ??
						button.dataset.wcPhoneBar ??
						(button.hasAttribute("data-wc-page-switcher") ? "page" : null) ??
						(button.hasAttribute("data-wc-publish") ? "publish" : "?"),
				),
			);
			expect(order).toEqual(["undo", "page", "edit", "more", "publish"]);
			expect(await page.locator("[data-wc-page-switcher]").textContent()).toContain("Fresh bread");
			expect(await page.locator('[data-wc-phone-bar="edit"]').getAttribute("aria-pressed")).toBe("true");
			// The page edge to edge, square, from the top of the screen to the bar.
			const sheet = await box(page.locator("[data-wc-frame-box]"));
			expect(sheet).toEqual({ x: 0, y: 0, width: PHONE.width, height: PHONE.height - 60 });
			expect(
				await page.locator("[data-wc-frame-box]").evaluate((element) => getComputedStyle(element).borderRadius),
			).toBe("0px");
			const frame = await frameOf(page);
			expect(await frame.evaluate(() => window.innerWidth)).toBe(PHONE.width);
			expect(await overflow(page)).toEqual({ page: 0, bar: 0 });
			expect(await smallTargets(page)).toEqual([]);
			await expectAccessibleScreen(page, `Client editing on a phone (${theme})`);

			// More: a sheet from the bottom, the page dimmed behind it.
			await more(page).tap();
			const sheetShown = moreSheet(page);
			await sheetShown.waitFor();
			await alongTheBottom(page, sheetShown);
			expect(await more(page).getAttribute("aria-expanded")).toBe("true");
			const rows = await sheetShown
				.locator("[data-wc-phone-row]")
				.evaluateAll((all) => all.map((row) => [row.getAttribute("data-wc-phone-row"), row.textContent?.trim()]));
			expect(rows).toEqual([
				["mode", "Preview"],
				["language", "LanguageEnglish"],
				["page-details", "Page details"],
				["redo", "Redo"],
				["help", "Help"],
				["exit", "Exit"],
			]);
			expect(await sheetShown.locator("[data-wc-phone-draft-state]").textContent()).toContain("No changes yet");
			expect(await sheetShown.locator("[data-wc-phone-publish]").textContent()).toBe("Publish");
			// Focus starts on its first row.
			expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-phone-row"))).toBe("mode");
			expect(await smallTargets(page, "[data-wc-phone-sheet]")).toEqual([]);
			await expectNoAxeViolations(page, `Client editing on a phone › More (${theme})`);

			// Escape closes it, and focus goes back to More.
			await page.keyboard.press("Escape");
			await sheetShown.waitFor({ state: "hidden" });
			expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-phone-bar"))).toBe("more");
			expect(await more(page).getAttribute("aria-expanded")).toBe("false");
		});
	}

	test("Preview from More takes the marks away; Edit brings them back; a tap on the dimmed page closes More", async () => {
		await page.emulateMedia({ colorScheme: "light" });
		const frame = await open(page, bread);
		await more(page).tap();
		await moreSheet(page).locator('[data-wc-phone-row="mode"]').tap();
		await moreSheet(page).waitFor({ state: "hidden" });
		await said(page, "Preview: the page as visitors will see it");
		expect(await page.locator('[data-wc-phone-bar="edit"]').getAttribute("aria-pressed")).toBe("false");
		expect(await frame.locator('[data-wc-field="subtitle"]').getAttribute("contenteditable")).toBe("false");
		expect(await page.locator("[data-wc-client-mark]").count()).toBe(0);

		// The bar's Edit brings editing back.
		await page.locator('[data-wc-phone-bar="edit"]').tap();
		expect(await page.locator('[data-wc-phone-bar="edit"]').getAttribute("aria-pressed")).toBe("true");
		await frame.locator('[data-wc-field="subtitle"][contenteditable="plaintext-only"]').waitFor({ state: "attached" });

		// A tap on the page dimmed behind More closes it.
		await more(page).tap();
		await moreSheet(page).waitFor();
		await page.mouse.click(PHONE.width / 2, 100);
		await moreSheet(page).waitFor({ state: "hidden" });
	});

	test("a photo's popover is a sheet; the photo stays in view above it; Escape gives focus back to the photo", async () => {
		await page.emulateMedia({ colorScheme: "dark" });
		const frame = await open(page, bread);
		const image = frame.locator('img[data-wc-field="photo"]');
		await image.tap();
		const sheet = page.locator('[data-wc-popover="photo"]');
		await sheet.waitFor();
		await alongTheBottom(page, sheet);
		expect(await sheet.getAttribute("role")).toBe("dialog");
		await sheet.getByRole("textbox", { name: /^Describe the photo/ }).waitFor();
		// Nothing covers the photo: the page has scrolled it above the sheet.
		await settled(page);
		await page.waitForFunction(() => {
			const frame = document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]");
			const photo = frame?.contentDocument?.querySelector('img[data-wc-field="photo"]');
			const sheet = document.querySelector("[data-wc-popover]");
			if (!frame || !photo || !sheet) return false;
			return (
				frame.getBoundingClientRect().top + photo.getBoundingClientRect().bottom <= sheet.getBoundingClientRect().top
			);
		});
		expect(await smallTargets(page, "[data-wc-popover]")).toEqual([]);
		await expectNoAxeViolations(page, "Client editing on a phone › a photo's sheet (dark)");

		await page.keyboard.press("Escape");
		await sheet.waitFor({ state: "hidden" });
		expect(await image.evaluate((element) => element === document.activeElement)).toBe(true);
	});

	test("Publish from More opens Publish as a sheet from the bottom", async () => {
		await page.emulateMedia({ colorScheme: "light" });
		const frame = await open(page, bread);
		await tagline(frame).tap();
		await page.keyboard.press("End");
		await page.keyboard.type(" and fresh");
		await tagline(frame).evaluate((region: HTMLElement) => region.blur());
		await eventually(taglineNow, (now) => now === "Baked daily and fresh");
		await page.locator('[data-wc-publish="ready"]:not([aria-disabled])').waitFor();

		await more(page).tap();
		await moreSheet(page)
			.locator("[data-wc-phone-draft-state]")
			.filter({ hasText: "1 change not published" })
			.waitFor();
		await moreSheet(page).locator("[data-wc-phone-publish]").tap();
		const publish = page.locator("[data-wc-publish-sheet]");
		await publish.waitFor();
		await moreSheet(page).waitFor({ state: "hidden" });
		await alongTheBottom(page, publish);
		await page.waitForFunction(() => document.querySelector("[data-wc-publish-change]") !== null);
		expect(await smallTargets(page, "[data-wc-publish-sheet]")).toEqual([]);
		await expectNoAxeViolations(page, "Client editing on a phone › Publish");

		// Revert puts the tagline back: nothing left to publish for the next checks.
		await publish
			.getByRole("button", { name: /^Revert/ })
			.first()
			.tap();
		await eventually(taglineNow, (now) => now === "Baked daily");
		await page.keyboard.press("Escape");
		await publish.waitFor({ state: "hidden" });
	});

	test("Undo on the bar and Redo in More each name the step they would take", async () => {
		await page.emulateMedia({ colorScheme: "light" });
		const frame = await open(page, bread);
		await tagline(frame).tap();
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.type("Typed on a phone");
		await tagline(frame).evaluate((region: HTMLElement) => region.blur());
		const undo = page.locator('[data-wc-bar="undo"]');
		await page.waitForFunction(() => {
			const button = document.querySelector('[data-wc-bar="undo"]');
			return button?.getAttribute("aria-label") === "Undo Edit Tagline" && !button.hasAttribute("aria-disabled");
		});
		expect(await eventually(taglineNow, (now) => now === "Typed on a phone")).toBe("Typed on a phone");

		await more(page).tap();
		expect(await moreSheet(page).locator('[data-wc-phone-row="redo"]').getAttribute("aria-disabled")).toBe("true");
		await page.keyboard.press("Escape");
		await undo.tap();
		await said(page, "Undid Edit Tagline");
		await tagline(frame)
			.filter({ hasText: /^Baked daily$/ })
			.waitFor();

		await more(page).tap();
		const redo = moreSheet(page).getByRole("button", { name: "Redo Edit Tagline", exact: true });
		await redo.tap();
		await said(page, "Redid Edit Tagline");
		expect(await eventually(taglineNow, (now) => now === "Typed on a phone")).toBe("Typed on a phone");
		await page.keyboard.press("Escape");
		await moreSheet(page).waitFor({ state: "hidden" });

		// Back as it was, for the next checks.
		await undo.tap();
		await eventually(taglineNow, (now) => now === "Baked daily");
	});

	test("the text toolbar sits on the keyboard, and the text being edited stays above it", async () => {
		await page.emulateMedia({ colorScheme: "light" });
		const frame = await open(page, bread);
		const intro = frame.locator('div[data-wc-field="intro"]');
		await intro.tap();
		const toolbar = page.locator("[data-wc-text-toolbar]");
		await toolbar.waitFor();
		expect(await toolbar.getAttribute("data-wc-text-toolbar")).toBe("docked");
		// The on-screen keyboard leaves the top of the screen to the page: the visual viewport shrinks.
		await page.setViewportSize({ width: PHONE.width, height: 460 });
		await page.keyboard.type(" ");
		await settled(page);
		const placed = await page.evaluate(() => {
			const shown = document.querySelector("[data-wc-text-toolbar]")?.getBoundingClientRect();
			const frame = document.querySelector("iframe[data-wc-frame]")?.getBoundingClientRect();
			const region = (document.querySelector("iframe[data-wc-frame]") as HTMLIFrameElement | null)?.contentDocument
				?.querySelector('[data-wc-field="intro"]')
				?.getBoundingClientRect();
			return {
				gap: (window.visualViewport?.height ?? window.innerHeight) - (shown?.bottom ?? 0),
				width: shown?.width ?? 0,
				regionBottom: (frame?.top ?? 0) + (region?.bottom ?? 0),
				toolbarTop: shown?.top ?? 0,
			};
		});
		expect(placed.gap).toBeGreaterThanOrEqual(0);
		expect(placed.gap).toBeLessThan(16);
		expect(placed.width).toBe(PHONE.width);
		expect(placed.regionBottom).toBeLessThanOrEqual(placed.toolbarTop);
		// The tools a phone holds, named; the bar under it is out of reach.
		const tools = await page
			.locator("[data-wc-text-toolbar] [data-wc-tool]")
			.evaluateAll((all) => all.map((tool) => tool.getAttribute("data-wc-tool")));
		expect(tools).toEqual(["bold", "italic", "link", "bulletList", "undo", "done"]);
		expect(await page.getByRole("toolbar", { name: /Intro/ }).count()).toBe(1);
		expect(await bar(page).getAttribute("inert")).not.toBeNull();
		expect(await smallTargets(page, "[data-wc-text-toolbar]")).toEqual([]);
		await expectNoAxeViolations(page, "Client editing on a phone › the toolbar on the keyboard");

		// Done: the bar is back.
		await page.locator('[data-wc-tool="done"]').tap();
		await toolbar.waitFor({ state: "hidden" });
		expect(await bar(page).getAttribute("inert")).toBeNull();
		await page.setViewportSize(PHONE);
		await eventually(
			async () => (await api.entries.get({ siteId, entryId: breadId })).entry.draft.fields.intro,
			(intro) => typeof intro === "string",
		);
		await api.entries.saveDraft({
			siteId,
			entryId: breadId,
			fields: { intro: "<p>Sourdough, pastries and cakes, baked by hand.</p>" },
		});
	});

	test("Page details is a sheet; a tap on the dimmed page puts it away and focus goes back to More", async () => {
		await page.emulateMedia({ colorScheme: "light" });
		await open(page, "/");
		await more(page).tap();
		await moreSheet(page).locator('[data-wc-phone-row="page-details"]').tap();
		const details = page.locator('[data-wc-side-panel="pageDetails"]');
		await details.waitFor();
		await alongTheBottom(page, details);
		expect((await box(details)).height).toBeLessThanOrEqual(PHONE.height * 0.85 + 1);
		await details
			.getByRole("textbox", { name: /^Title/ })
			.first()
			.waitFor();
		expect(await smallTargets(page, '[data-wc-side-panel="pageDetails"]')).toEqual([]);
		await expectNoAxeViolations(page, "Client editing on a phone › Page details");

		await page.mouse.click(PHONE.width / 2, 40);
		await details.waitFor({ state: "hidden" });
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-phone-bar"))).toBe("more");
	});

	test("Sections on a phone: a sheet; a section moved, its Settings typed, one added from the picker", async () => {
		await page.emulateMedia({ colorScheme: "light" });
		await resetHome();
		const frame = await open(page, "/");
		await frame.locator("html.wc-arrange-on").waitFor({ state: "attached" });
		await more(page).tap();
		await moreSheet(page).locator('[data-wc-phone-row="sections"]').tap();
		const sheet = page.locator('[data-wc-side-panel="sections"]');
		await sheet.waitFor();
		await alongTheBottom(page, sheet);
		expect(await smallTargets(page, '[data-wc-side-panel="sections"]')).toEqual([]);
		await expectNoAxeViolations(page, "Client editing on a phone › Sections");

		// A section moved down from its menu.
		const north = sheet.getByRole("treeitem", { name: /North/ });
		await north.tap();
		await sheet.locator('[data-wc-section-menu="north"], [aria-haspopup="menu"]').first().tap();
		await page.getByRole("menuitem", { name: "Move down", exact: true }).tap();
		await frame.waitForFunction(() =>
			document.querySelector("main [data-wc-page-placement]")?.textContent?.includes("South"),
		);
		await eventually(
			async () => (await api.pageLayouts.get({ siteId, entryId: homeId })).placements.map((each) => each.id),
			(ids) => ids[0] === "south",
		);

		// Its Settings: the Heading typed shows on the page.
		await sheet.getByRole("treeitem", { name: /North/ }).tap();
		await page.keyboard.press("Enter");
		const heading = sheet.getByLabel("Heading", { exact: true });
		await heading.waitFor();
		await heading.fill("Phone North");
		await heading.press("Tab");
		await frame.locator("h1").filter({ hasText: "Phone North" }).waitFor();
		await expectNoAxeViolations(page, "Client editing on a phone › a section's Settings");

		// The picker: only the Allowed components; a tap adds one.
		await sheet.locator("[data-wc-side-panel-back]").tap();
		await sheet
			.getByRole("button", { name: /Add section/ })
			.first()
			.tap();
		const card = sheet.getByRole("button", { name: /^Quote/ }).first();
		await card.waitFor();
		await card.tap();
		await frame.waitForFunction(() => document.querySelectorAll("main [data-wc-page-placement]").length === 3);

		// Close gives focus back to More.
		await sheet.locator("[data-wc-side-panel-close]").tap();
		await sheet.waitFor({ state: "hidden" });
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-phone-bar"))).toBe("more");
		await resetHome();
	});

	test("the page's languages are a list in More; choosing one opens the page in it", async () => {
		await page.emulateMedia({ colorScheme: "light" });
		await open(page, bread);
		await more(page).tap();
		await moreSheet(page).locator('[data-wc-phone-row="language"]').tap();
		const list = page.getByRole("dialog", { name: "Languages of the page", exact: true });
		await list.waitFor();
		expect(await list.locator("[data-wc-phone-language]").allTextContents()).toEqual(["English", "Italiano"]);
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-phone-language"))).toBe("en");
		await expectNoAxeViolations(page, "Client editing on a phone › the languages");
		// Back to More, focus on Language.
		await list.locator("[data-wc-phone-sheet-back]").tap();
		await moreSheet(page).waitFor();
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-phone-row"))).toBe("language");
		await moreSheet(page).locator('[data-wc-phone-row="language"]').tap();
		await list.locator('[data-wc-phone-language="it"]').tap();
		await list.waitFor({ state: "hidden" });
		for (let attempt = 0; attempt < 100; attempt++) {
			const frame = await frameOf(page);
			if (new URL(frame.url()).pathname === `/it${bread}`) return;
			await page.waitForTimeout(50);
		}
		throw new Error("The page never opened in Italian.");
	});

	test("the list of Pages and Entries is a sheet", async () => {
		await page.emulateMedia({ colorScheme: "light" });
		await open(page, bread);
		await page.locator("[data-wc-page-switcher]").tap();
		const list = page.locator("[data-wc-page-list]");
		await list.waitFor();
		await alongTheBottom(page, list);
		await list.locator('[data-wc-switch="/"]').tap();
		for (let attempt = 0; attempt < 100; attempt++) {
			const frame = await frameOf(page);
			if (new URL(frame.url()).pathname === "/") return;
			await page.waitForTimeout(50);
		}
		throw new Error("The home page never opened.");
	});

	test("the first visit on a phone is one line over the page; Help in More shows the whole card", async () => {
		await page.emulateMedia({ colorScheme: "light" });
		const person = await install.install.signIn(editor);
		await person.api.me.saveEditorPreferences({
			siteId,
			preferences: { version: EDITOR_LAYOUT_VERSION, hintSeen: false },
		});
		await open(page, bread);
		const hint = page.locator("[data-wc-phone-hint]");
		await hint.waitFor();
		expect(await hint.textContent()).toContain("Tap the dashed outline to make changes.");
		const shown = await box(hint);
		expect(shown.y + shown.height).toBeLessThanOrEqual(PHONE.height - 60);
		expect(await page.locator('[data-wc-help-card="first"]').count()).toBe(0);
		await expectNoAxeViolations(page, "Client editing on a phone › the first visit");
		await hint.getByRole("button", { name: "Got it" }).tap();
		await hint.waitFor({ state: "hidden" });
		await eventually(
			async () => (await person.api.me.editorPreferences({ siteId })).hintSeen,
			(seen) => seen === true,
		);

		await more(page).tap();
		await moreSheet(page).locator('[data-wc-phone-row="help"]').tap();
		const card = page.locator('[data-wc-help-card="help"]');
		await card.waitFor();
		await alongTheBottom(page, card);
		await card.locator("[data-wc-help-keys]").waitFor();
		await expectNoAxeViolations(page, "Client editing on a phone › Help");
		await page.keyboard.press("Escape");
		await card.waitFor({ state: "hidden" });
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-phone-bar"))).toBe("more");
	});

	test("on a tablet: the desktop shell, its words kept only where they are needed", async () => {
		await page.emulateMedia({ colorScheme: "light" });
		await page.setViewportSize({ width: 768, height: 1024 });
		try {
			await open(page, "/");
			expect(await page.locator("[data-wc-client]").getAttribute("data-wc-layout")).toBe("tablet");
			expect(await page.locator("[data-wc-narrow]").count()).toBe(0);
			expect((await box(page.locator("[data-wc-client-rail]"))).width).toBe(76);
			expect(await bar(page).getAttribute("data-wc-client-bar")).toBe("");
			expect((await box(bar(page))).height).toBe(56);
			// Sections, Page details, Edit and Preview keep their names, their words in tooltips.
			for (const [selector, name] of [
				['[data-wc-bar="sections"]', "Sections"],
				['[data-wc-bar="page-details"]', "Page details"],
				['[data-wc-segment="edit"]', "Edit"],
				['[data-wc-segment="preview"]', "Preview"],
			] as const) {
				const button = page.locator(selector);
				expect(await button.evaluate((element) => element.querySelector("span:not(.sr-only):not([data-wc-tip])"))).toBe(
					null,
				);
				expect(await page.getByRole("button", { name, exact: true }).count()).toBeGreaterThanOrEqual(1);
			}
			// The Draft's state and Publish keep their words; nothing is wider than the window.
			expect(await page.locator("[data-wc-publish]").textContent()).toBe("Publish");
			expect(await overflow(page)).toEqual({ page: 0, bar: 0 });
			const clusters = await bar(page).evaluate((element) => {
				const outer = element.getBoundingClientRect();
				return [...element.querySelectorAll("[data-wc-bar-cluster] > *")].every((child) => {
					const inner = child.getBoundingClientRect();
					return inner.left >= outer.left - 0.5 && inner.right <= outer.right + 0.5;
				});
			});
			expect(clusters).toBe(true);
			expect(await smallTargets(page)).toEqual([]);
			await expectAccessibleScreen(page, "Client editing on a tablet (light)");
			await page.emulateMedia({ colorScheme: "dark" });
			await expectAccessibleScreen(page, "Client editing on a tablet (dark)");

			// Sections pushes the page, as on a desktop.
			await page.locator('[data-wc-bar="sections"]').tap();
			const panel = page.locator('[data-wc-side-panel="sections"]');
			await panel.waitFor();
			const shown = await box(panel);
			expect(shown.width).toBe(360);
			expect(shown.x + shown.width).toBe(768);
			const sheet = await box(page.locator("[data-wc-frame-box]"));
			expect(sheet.x + sheet.width).toBeLessThanOrEqual(shown.x - 12 + 0.5);
		} finally {
			await page.setViewportSize(PHONE);
		}
	});

	test("at every width the layout follows the window, nothing is wider than it, and the page isn't loaded again", async () => {
		await page.emulateMedia({ colorScheme: "light" });
		await page.setViewportSize({ width: 1280, height: 900 });
		try {
			const frame = await open(page, bread);
			await frame.evaluate(() => {
				(window as unknown as { stillHere: boolean }).stillHere = true;
			});
			for (const [width, layout] of [
				[1280, "desktop"],
				[1024, "desktop"],
				[1023, "tablet"],
				[900, "tablet"],
				[768, "tablet"],
				[641, "tablet"],
				[640, "phone"],
				[390, "phone"],
				[360, "phone"],
				[1280, "desktop"],
			] as const) {
				await page.setViewportSize({ width, height: 900 });
				await page.waitForFunction(
					(layout) => document.querySelector("[data-wc-client]")?.getAttribute("data-wc-layout") === layout,
					layout,
				);
				await settled(page);
				expect({ width, notice: await page.locator("[data-wc-narrow]").count() }).toEqual({ width, notice: 0 });
				expect({ width, overflow: await overflow(page) }).toEqual({ width, overflow: { page: 0, bar: 0 } });
				expect({ width, rail: await page.locator("[data-wc-client-rail]").count() }).toEqual({
					width,
					rail: layout === "phone" ? 0 : 1,
				});
				// The page in the frame is the same one, with what it had.
				expect(await frame.evaluate(() => (window as unknown as { stillHere?: boolean }).stillHere)).toBe(true);
			}
		} finally {
			await page.setViewportSize(PHONE);
		}
	});
});
