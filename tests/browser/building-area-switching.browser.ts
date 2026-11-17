// Before the cutover (BA-34), Staff moving between documents in one tab, in Chromium:
// - the admin's Filters screen opens the Archive template holding the Filter in the building area,
//   with the element placing the whole Filter selected (not the search box placed on its own in the
//   Site template's header), light and dark (`filter-builder` 328);
// - markup typed and not saved (it can't be read), the selection and the Entry previewed survive
//   another document and coming back, by Back or by the document switcher; markup that can be read
//   is saved on the way out (`builder-navigation` 119, 266, 380);
// - a conflict waiting for its choice (a Component's markup someone saved meanwhile) is asked again
//   once the document is back, with what was typed (`builder-navigation` 14);
// - a Class's rule saved on the way out, and one typed while the next document is being found kept
//   with its problem for when it shows again (`builder-navigation` 71, 176, 421, 474, 533);
// - an Entry chosen in the picker whose page is slow to be found never replaces a later choice
//   (`builder-navigation` 331);
// - a Popup's Component: Publish counts the Popup's change and sends it to its review in the admin,
//   where it is published with its settings, light and dark (`popup-builder` 79).
// The edit link may only be followed a few times a minute from one address: one page is shared.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Page } from "playwright";

import { buildShop, SHOP_MARKUP, type Shop } from "../filters/shop.ts";
import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { eventually, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let shop: Shop;
let staff: TestAccount;
let api: TestBrowser["api"];
let siteId: string;
let storiesId: string;
let firstId: string;
let newestId: string;
let noticeId: string;
let noteClassId: string;
let popupId: string;
let popupComponentId: string;
const slug = "switching";
const ENTRY_MARKUP =
	'<article><h1 data-wc-id="title">{{ title }}</h1><p data-wc-id="note" class="note">Before</p><Notice data-wc-id="notice" /></article>';

beforeAll(async () => {
	install = await startBrowserInstall();
	shop = await buildShop(install.install, slug, async (id) => {
		await install.goLive(id);
		return new URL(install.liveUrl(slug, "/")).origin;
	});
	siteId = shop.siteId;
	api = shop.staff.api;
	// The controls' ids say what they are (the search box is placed on its own as `search`).
	const ids = ["search", "category", "baker", "vegan", "price", "baked", "sort", "chips", "count"];
	const { filter } = await api.filters.get({ siteId, filterId: shop.filterId });
	await api.filters.saveDraft({
		siteId,
		filterId: shop.filterId,
		controls: filter.draft.controls.map((control, index) => ({ ...control, id: ids[index] })),
	});
	await api.filters.publish({ siteId, filterId: shop.filterId });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header><p><a href="/">Acme Bakery</a></p>{{@filter shop for="products" control="search"}}</header><main>{{@outlet}}</main>',
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const archive = await api.templates.saveArchiveTemplateMarkup({
		siteId,
		postTypeId: shop.productsId,
		markup: `<h1>Shop</h1>${SHOP_MARKUP}`,
	});
	await api.templates.publish({ siteId, templateId: archive.template.id });

	noteClassId = (await api.designSystem.createClass({ siteId, name: "note", styles: "color: rgb(1, 2, 3);" })).class.id;
	const { component } = await api.components.create({ siteId, name: "Notice" });
	noticeId = component.id;
	await api.components.saveMarkup({ siteId, componentId: noticeId, markup: '<p data-wc-id="inner">Notice</p>' });
	await api.components.saveScriptDraft({ siteId, componentId: noticeId, code: "// Original" });
	await api.components.publish({ siteId, componentId: noticeId });
	storiesId = (await api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" })).postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: storiesId, markup: ENTRY_MARKUP });
	await api.templates.publish({ siteId, templateId: entry.template.id });
	for (const title of ["First", "Newest"]) {
		const { entry: story } = await api.entries.create({ siteId, postTypeId: storiesId, title });
		await api.entries.publish({ siteId, entryId: story.id });
		if (title === "First") firstId = story.id;
		else newestId = story.id;
		await install.install.clock.advance(1000);
	}

	const { popup } = await api.popups.create({ siteId, name: "Offer", key: "offer" });
	popupId = popup.id;
	popupComponentId = popup.componentId;
	await api.components.saveMarkup({ siteId, componentId: popupComponentId, markup: "<p>Original Popup tree</p>" });
	await api.popups.publish({ siteId, popupId });
	await api.popups.saveDraft({ siteId, popupId, popup: { layout: "bar", barPosition: "top", barBehavior: "push" } });

	staff = (await install.install.createStaff({ workspaces: [shop.workspaceId], name: "Sam Staff" })).account;
});

let sharedPage: Promise<Page> | undefined;

afterAll(async () => {
	await (
		await sharedPage
	)
		?.context()
		.close()
		.catch(() => {});
	await install?.close();
});

const tree = (page: Page) => page.getByRole("tree", { name: "Elements of the page" });
const box = (page: Page, id: "html" | "css" | "js") => page.locator(`textarea[data-wc-code-box="${id}"]`);
const pane = (page: Page, id: "html" | "css" | "js") => page.locator(`[data-wc-panel="${id}"]`);

/** The shell's address, after `/_webcraft/build`, without what is selected. */
function addressOf(page: Page): string {
	const url = new URL(page.url());
	url.searchParams.delete("wc-select");
	return `${url.pathname.slice("/_webcraft/build".length)}${url.search}`;
}

/** Waits until the shell's address (without the selection) is `address`. */
async function addressed(page: Page, address: string): Promise<void> {
	for (let attempt = 0; attempt < 100 && addressOf(page) !== address; attempt++) await page.waitForTimeout(100);
	expect(addressOf(page)).toBe(address);
}

/** What is selected, as the address keeps it. */
function selectedIn(page: Page): string | null {
	return new URL(page.url()).searchParams.get("wc-select");
}

/** Waits until the frame shows `path` (any page under it when it ends with `/`), and answers the frame. */
async function framedAt(page: Page, path: string): Promise<Frame> {
	await page.waitForFunction(
		(expected) => {
			const shown =
				document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]")?.contentWindow?.location.pathname;
			if (!shown) return false;
			return expected.endsWith("/") ? shown.startsWith(expected) && shown !== expected : shown === expected;
		},
		path,
		{ timeout: 15_000 },
	);
	const frame = await frameOf(page);
	await frame.waitForLoadState("load");
	await settled(page);
	return frame;
}

/** Opens a shell address in the page (as a bookmark does), on the address the shell was entered on (the live domain). */
async function go(page: Page, address: string): Promise<void> {
	await page.goto(`${new URL(page.url()).origin}/_webcraft/build${address}`);
}

/** Clicks an element of the page in the frame, as a person does. */
async function clickIn(page: Page, frame: Frame, selector: string): Promise<void> {
	const element = frame.locator(selector).first();
	await element.scrollIntoViewIfNeeded();
	const found = await element.boundingBox();
	if (!found) throw new Error(`${selector} isn't on the page.`);
	await page.mouse.click(found.x + Math.min(12, found.width / 2), found.y + found.height / 2);
	await settled(page);
}

/** Puts `text` in a pane's box as typed, all of it. */
async function typeInto(page: Page, id: "html" | "css" | "js", text: string): Promise<void> {
	await box(page, id).click();
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.insertText(text);
}

/** Runs `step`; if it fails, says what the shell shows (the address, the panels, the boxes), then fails. */
async function said<Value>(page: Page, label: string, step: () => Promise<Value>): Promise<Value> {
	try {
		return await step();
	} catch (failure) {
		const shows = await page
			.evaluate(() => ({
				panels: [...document.querySelectorAll<HTMLElement>("[data-wc-panel]")].map((each) => each.dataset.wcPanel),
				boxes: [...document.querySelectorAll<HTMLTextAreaElement>("textarea[data-wc-code-box]")].map(
					(each) => `${each.dataset.wcCodeBox}: ${each.value.slice(0, 160)}`,
				),
				outline: document.querySelector("[data-wc-outline=selected]") !== null,
			}))
			.catch(() => null);
		console.log(`BA-34 ${label}`, page.url(), JSON.stringify(shows));
		throw failure;
	}
}

/** Opens a document from the Layers header's document switcher, by its name in the menu. */
async function switchTo(page: Page, name: RegExp): Promise<void> {
	await page.locator('[data-wc-panel="layers"] [data-wc-document-title]').click();
	const menu = page.getByRole("menu", { name: /^Switch document: / });
	await menu.waitFor();
	await menu.getByRole("menuitemradio", { name }).first().click();
}

/** The Entry template's Draft markup now. */
async function storiesMarkup(): Promise<string> {
	return (await api.templates.getEntryTemplateMarkup({ siteId, postTypeId: storiesId })).markup?.draft ?? "";
}

/** The `note` Class's styles in the Design system's Draft now. */
async function noteStyles(): Promise<string> {
	const { designSystem } = await api.designSystem.get({ siteId });
	return designSystem.draft.classes.find((each) => each.id === noteClassId)?.styles ?? "";
}

/** The page in the building area, entered from the admin's Filters screen (the one way in this file uses). */
function shared(): Promise<Page> {
	sharedPage ??= (async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}/filters/${shop.filterId}?tab=layout`));
		await page.getByRole("link", { name: "Open Products · Archive template in the building area" }).click();
		await page.waitForURL((url) => url.pathname === `/_webcraft/build/archive-template/${shop.productsId}`, {
			timeout: 15_000,
		});
		return page;
	})();
	return sharedPage;
}

describe("documents across switches", () => {
	test("the Filters screen opens the Archive template with its Filter selected, light and dark", async () => {
		const page = await shared();
		await framedAt(page, "/shop");
		// The whole Filter, in the Archive template: not its search box on its own in the Site template's header.
		await eventually(
			async () => selectedIn(page),
			(selected) => selected !== null,
		);
		expect(selectedIn(page)).toMatch(/^content#/);
		expect(new URL(page.url()).searchParams.get("wc-filter")).toBeNull();
		const row = tree(page).getByRole("treeitem", { selected: true });
		await row.waitFor();
		expect(await row.count()).toBe(1);
		expect(await row.textContent()).toContain("{{@filter}}");
		// The canvas outlines the Filter's form: the first element its command draws (BA-28).
		const frame = await framedAt(page, "/shop");
		const outline = page.locator('[data-wc-outline="selected"]');
		await outline.waitFor({ state: "visible" });
		const form = await frame.locator("aside form[data-wc-filter]").boundingBox();
		const drawn = await outline.boundingBox();
		expect(form).not.toBeNull();
		expect(drawn).not.toBeNull();
		if (form && drawn) {
			expect(Math.abs(drawn.x - form.x)).toBeLessThan(4);
			expect(Math.abs(drawn.y - form.y)).toBeLessThan(4);
			expect(Math.abs(drawn.width - form.width)).toBeLessThan(4);
		}
		// The JS pane reads the scripts of a selected command too (its source's): nothing it can't read.
		await pane(page, "js").locator("[data-wc-script-tab]").first().waitFor();
		// The logo tile goes back to the Filter's Layout tab.
		expect(await page.getByRole("link", { name: "Back to the admin" }).getAttribute("href")).toBe(
			install.adminUrl(`/sites/${siteId}/filters/${shop.filterId}?tab=layout`),
		);
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await page.mouse.move(24, 460);
			await page.waitForTimeout(1800);
			await expectAccessibleScreen(page, `a Filter selected (${theme})`);
		}
		await page.emulateMedia({ colorScheme: "light" });
	});

	test("unreadable markup, the selection and the Entry previewed come back with the document", async () => {
		const page = await shared();
		await go(page, `/entry-template/${storiesId}?entry=${firstId}`);
		let frame = await framedAt(page, "/stories/first");
		await clickIn(page, frame, "p.note");
		await eventually(
			async () => selectedIn(page),
			(selected) => selected === "content#note",
		);
		await page.waitForFunction(() =>
			document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="html"]')?.value.includes("Before"),
		);
		const original = await box(page, "html").inputValue();
		const unfinished = `${original.replace("Before", "Half typed")}\n<`;
		await typeInto(page, "html", unfinished);
		await pane(page, "html").locator("[data-wc-html-problems] li").first().waitFor();

		// Another document (on another page) and Back: the same Entry, the same selection, the same text.
		await switchTo(page, /^Products · Archive template/);
		await addressed(page, `/archive-template/${shop.productsId}`);
		await framedAt(page, "/shop");
		expect(await storiesMarkup()).not.toContain("Half typed");
		await page.goBack();
		await said(page, "html back address", () => addressed(page, `/entry-template/${storiesId}?entry=${firstId}`));
		frame = await framedAt(page, "/stories/first");
		await eventually(
			async () => selectedIn(page),
			(selected) => selected === "content#note",
		);
		await said(page, "html back", () =>
			page.waitForFunction(
				(typed) => document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="html"]')?.value === typed,
				unfinished,
				{ timeout: 10_000 },
			),
		);
		await pane(page, "html").locator("[data-wc-html-problems] li").first().waitFor();
		// Not saved (markup that can't be read is never shown on the page either).
		expect(await frame.locator("p.note").textContent()).toBe("Before");
		expect(await storiesMarkup()).not.toContain("Half typed");

		// The same by the switcher (no Back): the Entry template remembers its selection.
		await switchTo(page, /^Products · Archive template/);
		await framedAt(page, "/shop");
		await switchTo(page, /^Stories · Entry template/);
		await framedAt(page, "/stories/");
		await eventually(
			async () => selectedIn(page),
			(selected) => selected === "content#note",
		);
		await page.waitForFunction(
			(typed) => document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="html"]')?.value === typed,
			unfinished,
		);

		// Another Entry in the picker: the same Template, what was typed still there.
		const onFirst = (await frameOf(page)).url().includes("/stories/first");
		await page.locator('[data-wc-bar="preview"]').click();
		await page.getByRole("menu", { name: /^The Entry this Template previews: / }).waitFor();
		await page.getByRole("menuitemradio", { name: onFirst ? /^Newest/ : /^First/ }).click();
		await addressed(page, `/entry-template/${storiesId}?entry=${onFirst ? newestId : firstId}`);
		await framedAt(page, onFirst ? "/stories/newest" : "/stories/first");
		await page.waitForFunction(
			(typed) => document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="html"]')?.value === typed,
			unfinished,
		);

		// Finished, it is saved on the way out to another document.
		await typeInto(page, "html", original.replace("Before", "Saved on the way out"));
		await switchTo(page, /^Products · Archive template/);
		await framedAt(page, "/shop");
		expect(await eventually(storiesMarkup, (markup) => markup.includes("Saved on the way out"))).toContain(
			"Saved on the way out",
		);
		await api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: storiesId, markup: ENTRY_MARKUP });
	});

	test("a conflict waiting for its choice is asked again, with what was typed, once the document is back", async () => {
		const page = await shared();
		// Back and Forward between two documents of this shell (a page loaded anew would start afresh).
		await go(page, `/archive-template/${shop.productsId}`);
		await framedAt(page, "/shop");
		await switchTo(page, /^Stories · Entry template/);
		await page.waitForURL(
			(url) => url.pathname === `/_webcraft/build/entry-template/${storiesId}` && url.search.includes("entry="),
		);
		// The Entry template shows on one of its Entries' pages (the visual builder's choice): read which.
		const shownAt = await page
			.waitForFunction(() => {
				const shown =
					document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]")?.contentWindow?.location.pathname;
				return shown?.startsWith("/stories/") ? shown : null;
			})
			.then((handle) => handle.jsonValue() as Promise<string>);
		let frame = await framedAt(page, shownAt);
		// The Notice Component's markup, from inside its Placement.
		await clickIn(page, frame, '[data-wc-code$="#inner"]');
		await page.waitForFunction(() =>
			document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="html"]')?.value.includes("Notice"),
		);
		const mine = (await box(page, "html").inputValue()).replace(">Notice<", ">Mine<");
		await typeInto(page, "html", mine);
		await frame.waitForFunction(() => document.querySelector('[data-wc-code$="#inner"]')?.textContent === "Mine");
		// Someone saves theirs meanwhile; leaving the box asks.
		await api.components.saveMarkup({ siteId, componentId: noticeId, markup: '<p data-wc-id="inner">Theirs</p>' });
		await frame.waitForFunction(
			() => document.querySelector('[data-wc-code$="#inner"]')?.textContent === "Theirs",
			undefined,
			{
				timeout: 30_000,
			},
		);
		await page.locator('[data-wc-rail="panels"]').focus();
		const dialog = page.getByRole("alertdialog", { name: "Someone saved a newer version" });
		await dialog.waitFor();

		// Back (the browser's: a modal dialog leaves nothing else) and Forward: asked again, mine kept.
		await page.goBack();
		await dialog.waitFor({ state: "detached" });
		await framedAt(page, "/shop");
		await page.goForward();
		frame = await framedAt(page, shownAt);
		await said(page, "conflict back", () => dialog.waitFor({ timeout: 10_000 }));
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-conflict-reload"))).toBe(true);
		expect(await box(page, "html").inputValue()).toBe(mine);
		// Under the modal question everything else is inert: axe reads the scrolling panels behind it as
		// having nothing to reach, which is the question's purpose.
		await expectNoAxeViolations(page, "a conflict asked again", ["scrollable-region-focusable"]);
		await dialog.getByRole("button", { name: "Overwrite with mine" }).click();
		expect(
			await eventually(
				async () => (await api.components.getMarkup({ siteId, componentId: noticeId })).markup?.draft ?? "",
				(markup) => markup.includes("Mine"),
			),
		).toContain("Mine");
		await api.components.saveMarkup({ siteId, componentId: noticeId, markup: '<p data-wc-id="inner">Notice</p>' });
	});

	test("a Class's rule is saved on the way out; one typed while the next document is found is kept", async () => {
		const page = await shared();
		await go(page, `/entry-template/${storiesId}?entry=${firstId}`);
		const frame = await framedAt(page, "/stories/first");
		await clickIn(page, frame, "p.note");
		await page.waitForFunction(() =>
			document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="css"]')?.value.includes(".note"),
		);
		// A peer's change to the Class arrives first: mine, typed over the rule as shown, asks (BA-33's
		// Reload theirs or Overwrite with mine); overwritten, it is saved before the next document opens.
		await api.designSystem.updateClass({ siteId, classId: noteClassId, styles: "color: rgb(7, 8, 9);" });
		await typeInto(page, "css", ".note {\n  color: rgb(10, 11, 12);\n}");
		const asked = page.getByRole("alertdialog", { name: "Someone saved a newer version" });
		await asked.waitFor();
		await asked.getByRole("button", { name: "Overwrite with mine" }).click();
		await asked.waitFor({ state: "detached" });
		await typeInto(page, "css", ".note {\n  color: rgb(10, 11, 12);\n  margin: 0;\n}");
		await switchTo(page, /^Products · Archive template/);
		await framedAt(page, "/shop");
		expect(await eventually(noteStyles, (styles) => styles.includes("margin: 0"))).toContain("rgb(10, 11, 12)");

		// Typed while the next document is still being found: kept, with its problem, for when it shows again.
		await page.goBack();
		await framedAt(page, "/stories/first");
		await said(page, "css back", () =>
			page.waitForFunction(
				() =>
					document
						.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="css"]')
						?.value.includes("rgb(10, 11, 12)"),
				undefined,
				{ timeout: 10_000 },
			),
		);
		const captured = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		await page.route("**/_webcraft/build/api/rpc/builder/destinations", async (route) => {
			const response = await route.fetch();
			captured.resolve();
			await release.promise;
			await route.fulfill({ response });
		});
		try {
			await switchTo(page, /^Products · Archive template/);
			await captured.promise;
			await typeInto(page, "css", ".note {\n  color:");
			release.resolve();
			await framedAt(page, "/shop");
			await page.goBack();
			await framedAt(page, "/stories/first");
			await page.waitForFunction(() =>
				document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="css"]')?.value.endsWith("color:"),
			);
			expect(await noteStyles()).toContain("rgb(10, 11, 12)");
		} finally {
			release.resolve();
			await page.unroute("**/_webcraft/build/api/rpc/builder/destinations");
		}
		await typeInto(page, "css", ".note {\n  color: rgb(1, 2, 3);\n}");
		expect(await eventually(noteStyles, (styles) => styles.includes("rgb(1, 2, 3)"))).toContain("rgb(1, 2, 3)");
	});

	test("an Entry whose page is slow to be found never replaces the one chosen after it", async () => {
		const page = await shared();
		await go(page, `/entry-template/${storiesId}?entry=${newestId}`);
		await framedAt(page, "/stories/newest");
		const captured = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const delivered = Promise.withResolvers<void>();
		await page.route("**/_webcraft/build/api/rpc/builder/destinations", async (route) => {
			if (!route.request().postData()?.includes(firstId)) return route.continue();
			const response = await route.fetch();
			captured.resolve();
			await release.promise;
			await route.fulfill({ response });
			delivered.resolve();
		});
		try {
			const choose = async (name: RegExp) => {
				await page.locator('[data-wc-bar="preview"]').click();
				await page.getByRole("menu", { name: /^The Entry this Template previews: / }).waitFor();
				await page.getByRole("menuitemradio", { name }).click();
			};
			await choose(/^First/);
			await captured.promise;
			await choose(/^Newest/);
			release.resolve();
			await delivered.promise;
			await page.waitForTimeout(500);
			await addressed(page, `/entry-template/${storiesId}?entry=${newestId}`);
			const frame = await framedAt(page, "/stories/newest");
			expect(await frame.locator("h1").textContent()).toBe("Newest");
			expect(await page.locator('[data-wc-bar="preview"]').textContent()).toContain("Preview: Newest");
		} finally {
			release.resolve();
			await page.unroute("**/_webcraft/build/api/rpc/builder/destinations");
		}
	});

	test("a Popup's Component goes to its review before publishing, light and dark", async () => {
		const page = await shared();
		await go(page, `/component/${popupComponentId}`);
		await page.waitForFunction(
			() => document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]")?.contentWindow?.location.pathname,
		);
		await api.components.saveMarkup({ siteId, componentId: popupComponentId, markup: "<p>Revised Popup tree</p>" });
		const cell = page.locator("[data-wc-publish]");
		await eventually(
			async () => cell.getAttribute("aria-disabled"),
			(disabled) => disabled !== "true",
		);
		expect(await cell.textContent()).toContain("1");
		await cell.click();
		const sheet = page.locator("[data-wc-publish-sheet]");
		const review = sheet.locator("[data-wc-publish-popup-review]");
		await review.waitFor();
		expect(await sheet.locator('[data-wc-publish-popup="changed"]').textContent()).toContain("Popup · Offer");
		// Nothing of it is published from here: no Publish, only the review.
		expect(await sheet.locator("[data-wc-publish-now]").count()).toBe(0);
		expect(await review.getAttribute("href")).toBe(install.adminUrl(`/sites/${siteId}/popups?popup=${popupId}`));
		expect(await review.getAttribute("target")).toBe("_blank");
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await expectNoAxeViolations(page, `the Popup review (${theme})`);
		}
		await page.emulateMedia({ colorScheme: "light" });

		// The review in the admin publishes the tree with the Popup's settings.
		const [admin] = await Promise.all([page.context().waitForEvent("page"), review.click()]);
		await admin.waitForURL((url) => url.pathname === `/sites/${siteId}/popups`);
		await admin.getByRole("combobox", { name: "Layout", exact: true }).waitFor();
		expect(await admin.getByRole("combobox", { name: "Layout", exact: true }).inputValue()).toBe("bar");
		expect((await api.components.getMarkup({ siteId, componentId: popupComponentId })).markup.published).toContain(
			"Original Popup tree",
		);
		await admin.getByRole("button", { name: "Publish", exact: true }).last().click();
		await admin.getByRole("status").filter({ hasText: "Published" }).waitFor();
		expect((await api.components.getMarkup({ siteId, componentId: popupComponentId })).markup.published).toContain(
			"Revised Popup tree",
		);
		expect((await api.popups.get({ siteId, popupId })).popup.published?.layout).toBe("bar");
		await admin.close();
		await page.keyboard.press("Escape");
	});
});
