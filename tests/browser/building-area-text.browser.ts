// Content typed in place in the building area (ADR 0037, BA-07; SPEC 10 and 13), in Chromium:
// - typing in a title, a text Field and a Global saves each to its Draft; rich text is cleaned;
// - text that takes formatting gets the floating toolbar: Alt+F10 reaches it, the arrow keys move in
//   it, its tools act on the text, Escape gives focus back to the text, and it never covers the text;
// - a region's problem shows beside it and is said;
// - the Draft state beside Publish says each state, in a Member's words (SPEC 13.8, BA-14): No changes
//   yet, Saving…, Saved, N changes not published, Sent for review and Could not save (a save the server
//   refuses);
// - two people on one page each see the other's text arrive, and their name on the region they are in;
// - the shell with the toolbar open passes the accessibility checks, light and dark.
// The building area's own test of the old editing bar's typing, toolbar and Presence cases
// (`edit-mode.browser.ts`, `edit-mode-in-place.browser.ts`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Cookie, Frame, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { announced, enterBuildingArea, eventually, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let editor: TestAccount;
let staff: TestAccount;
let siteId: string;
let breadId: string;
let ryeId: string;
const slug = "bakery";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Erin Editor" })).account;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).account;

	await api.globals.setFields({
		siteId,
		fields: [
			{ key: "tagline", label: "Tagline", type: "text" },
			{ key: "note", label: "Note", type: "richText" },
		],
	});
	await api.globals.saveDraft({
		siteId,
		fields: { tagline: "Open every day from seven.", note: "<p>Closed on Mondays.</p>" },
	});
	await api.globals.publish({ siteId });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: [
			'<header><nav aria-label="Main"><a href="/blog/fresh-bread">Fresh bread</a> <a href="/blog/rye-loaf">Rye loaf</a></nav></header>',
			"<main>{{@outlet}}</main>",
			"<footer><p>{{ site.tagline }}</p><div>{{ site.note }}</div></footer>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "subtitle", label: "Subtitle", type: "text", required: true },
			{ key: "intro", label: "Intro", type: "richText" },
		],
	});
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1><p>{{ subtitle }}</p><div>{{ intro }}</div></article>",
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const post = async (title: string, fields: Record<string, string>) => {
		const { entry: made } = await api.entries.create({ siteId, postTypeId: postType.id, title, fields });
		await api.entries.publish({ siteId, entryId: made.id });
		return made.id;
	};
	breadId = await post("Fresh bread", {
		subtitle: "Out of the oven at seven",
		intro: "<p>Sourdough, rye and spelt, baked by hand.</p>",
	});
	ryeId = await post("Rye loaf", { subtitle: "Dark and dense", intro: "<p>A loaf for the week.</p>" });
});

afterAll(async () => {
	await install?.close();
});

/** What the admin sees of an Entry's Draft and of the Globals' Draft now. */
async function drafts() {
	const { api } = await install.install.superadmin();
	const [bread, rye, globals] = await Promise.all([
		api.entries.get({ siteId, entryId: breadId }),
		api.entries.get({ siteId, entryId: ryeId }),
		api.globals.get({ siteId }),
	]);
	return { bread: bread.entry.draft, rye: rye.entry.draft, globals: globals.globals.draft };
}

/** The text as a person reads it: a typed trailing space is a no-break space in some browsers. */
const plain = (text: string | null | undefined) => (text ?? "").replaceAll(" ", " ");

/** Waits until the frame shows `path` with its regions editable. */
async function framedAt(page: Page, path: string): Promise<Frame> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const frame = await frameOf(page);
		if (new URL(frame.url()).pathname === path) {
			await frame.locator("[data-wc-item][contenteditable]").first().waitFor();
			return frame;
		}
		await page.waitForTimeout(50);
	}
	throw new Error(`The frame never showed ${path}.`);
}

/** Opens another page of the Site in the shell, as following its link does in a Member's Preview (no reload). */
async function openThrough(page: Page, frame: Frame, path: string): Promise<Frame> {
	await page.locator('[data-wc-segment="preview"]').click();
	await frame.locator(`nav a[href="${path}"]`).click();
	await page.waitForURL((url) => url.pathname === `/_webcraft/build/page${path}`);
	const shown = await framedAt(page, path);
	await page.locator('[data-wc-segment="edit"]').click();
	return shown;
}

/** Puts the caret at the end of a region, from the pointer, as a person does. */
async function caretAtEnd(page: Page, frame: Frame, selector: string): Promise<void> {
	const region = frame.locator(selector);
	await region.scrollIntoViewIfNeeded();
	await settled(page);
	const box = await region.boundingBox();
	if (!box) throw new Error(`${selector} isn't shown.`);
	await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
	await page.keyboard.press("End");
}

/** Selects a region's whole text from the keyboard, the caret in it. */
async function selectAllIn(page: Page, frame: Frame, selector: string): Promise<void> {
	await caretAtEnd(page, frame, selector);
	await page.keyboard.press("ControlOrMeta+a");
}

const draftState = (page: Page) => page.locator("[data-wc-draft-state]");
const toolbar = (page: Page) => page.getByRole("toolbar", { name: /^Text formatting/ });
/** Waits until focus is on the toolbar's tool `id`. */
async function onTool(page: Page, id: string): Promise<void> {
	await page.waitForFunction((id) => document.activeElement?.getAttribute("data-wc-tool") === id, id, {
		timeout: 3000,
	});
}
/** What has focus in the page in the frame, as `localName[data-wc-field]`, and whether the frame has the shell's focus. */
async function focusInPage(page: Page, frame: Frame) {
	const shell = await page.evaluate(() => document.activeElement?.localName ?? null);
	const inside = await frame.evaluate(() => {
		const element = document.activeElement;
		return element ? `${element.localName}[${element.getAttribute("data-wc-field") ?? ""}]` : null;
	});
	return { shell, inside };
}

/** Whether two boxes overlap. */
function overlaps(
	a: { x: number; y: number; width: number; height: number },
	b: { x: number; y: number; width: number; height: number },
) {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The edit and building-area cookies, to open more pages in the same session (the link works once). */
let cookies: Cookie[] = [];

describe("content typed in place, for a Member", () => {
	let page: Page;
	let frame: Frame;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		frame = await enterBuildingArea(install, page, { as: editor, siteId, slug, open: "/page/blog/fresh-bread" });
		cookies = (await page.context().cookies()).filter((cookie) => cookie.name.includes("webcraft."));
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("a title, a text Field and a Global save to their Drafts; rich text is cleaned", async () => {
		await caretAtEnd(page, frame, "h1");
		await page.keyboard.type(" today");
		await page.keyboard.press("Tab");
		await caretAtEnd(page, frame, 'article [data-wc-field="subtitle"]');
		// Saved 0.8 s after typing stops, without leaving.
		await page.keyboard.type(", every day");
		await selectAllIn(page, frame, 'footer [data-wc-field="tagline"]');
		await page.keyboard.type("Open from six.");
		await page.keyboard.press("Tab");
		const saved = await eventually(drafts, (now) => now.globals.tagline === "Open from six.");
		expect(plain(saved.bread.title)).toBe("Fresh bread today");
		expect(plain(String(saved.bread.fields.subtitle))).toBe("Out of the oven at seven, every day");
		expect(saved.globals.tagline).toBe("Open from six.");

		// Formatted text from elsewhere (a paste): what isn't formatting, lists or links goes.
		await caretAtEnd(page, frame, 'article [data-wc-field="intro"]');
		await frame.evaluate(() =>
			document.execCommand(
				"insertHTML",
				false,
				' <span style="color: red" class="loud">Ask</span> <b onclick="alert(1)">us</b><img src="/x.png" alt="x">',
			),
		);
		await page.keyboard.press("Tab");
		const cleaned = await eventually(drafts, (now) => String(now.bread.fields.intro).includes("Ask"));
		const intro = String(cleaned.bread.fields.intro);
		// The span's and the bold's words stay; what they wrapped them in goes.
		expect(intro).toContain("Ask");
		expect(intro).toContain("us");
		for (const gone of ["<span", "style=", "class=", "onclick", "<img"]) expect(intro).not.toContain(gone);
		// The region shows the text as it was stored, once the person has moved on.
		await frame.waitForFunction(
			() => !document.querySelector('[data-wc-field="intro"] span, [data-wc-field="intro"] img'),
		);
		// Title, Subtitle and Intro of the Entry, and the Globals' Tagline.
		await page.locator('[data-wc-draft-state="changes"]').filter({ hasText: "4 changes not published" }).waitFor();
	});

	test("the text toolbar: Alt+F10 reaches it, the arrows move, its tools act, Escape goes back, it never covers the text", async () => {
		const intro = 'article [data-wc-field="intro"]';
		await caretAtEnd(page, frame, intro);
		// Plain text has no toolbar; text that takes formatting shows it, named by its Field.
		await toolbar(page).waitFor();
		expect(await toolbar(page).getAttribute("aria-label")).toBe("Text formatting: Intro");
		const region = await frame.locator(intro).boundingBox();
		const drawn = await page.locator("[data-wc-text-toolbar]").boundingBox();
		if (!region || !drawn) throw new Error("No toolbar or region.");
		expect(overlaps(region, drawn)).toBe(false);
		// The selection's chip is not drawn while the toolbar names the region.
		await page.locator("[data-wc-chip]").waitFor({ state: "hidden" });

		// Select the first word (plain so far), then reach the toolbar from the text.
		await page.keyboard.press("Home");
		await page.keyboard.down("Shift");
		for (let index = 0; index < 9; index++) await page.keyboard.press("ArrowRight");
		await page.keyboard.up("Shift");
		await page.keyboard.press("Alt+F10");
		await onTool(page, "bold");
		await page.keyboard.press("ArrowRight");
		await onTool(page, "italic");
		await page.keyboard.press("End");
		await onTool(page, "done");
		await page.keyboard.press("Home");
		await onTool(page, "bold");
		// Bold acts on the selected text and gives focus back to it.
		await page.keyboard.press("Enter");
		await frame.waitForFunction(() =>
			document.querySelector('[data-wc-field="intro"] b, [data-wc-field="intro"] strong'),
		);
		expect(await focusInPage(page, frame)).toEqual({ shell: "iframe", inside: "div[intro]" });
		await page.locator('[data-wc-text-toolbar] [data-wc-tool="bold"][aria-pressed="true"]').waitFor();

		// Escape from the toolbar goes back to the text, the selection as it was.
		await page.keyboard.press("Alt+F10");
		await onTool(page, "bold");
		await page.keyboard.press("Escape");
		expect(await focusInPage(page, frame)).toEqual({ shell: "iframe", inside: "div[intro]" });

		// A link from the link field.
		await page.keyboard.press("Alt+F10");
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("ArrowRight");
		await onTool(page, "link");
		await page.keyboard.press("Enter");
		await page.getByLabel("Link address").fill("https://example.com/menu");
		await page.keyboard.press("Enter");
		await frame.waitForFunction(() =>
			document.querySelector('[data-wc-field="intro"] a[href="https://example.com/menu"]'),
		);
		expect(await focusInPage(page, frame)).toEqual({ shell: "iframe", inside: "div[intro]" });

		// Done from the keyboard puts the toolbar away and keeps focus in the text; typing brings it back.
		await page.keyboard.press("Alt+F10");
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await toolbar(page).waitFor({ state: "detached" });
		expect(await focusInPage(page, frame)).toEqual({ shell: "iframe", inside: "div[intro]" });
		await page.keyboard.press("End");
		await page.keyboard.type(".");
		await toolbar(page).waitFor();
		await expectNoAxeViolations(page, "building area text toolbar, open");
		await page.keyboard.press("Tab");
		const saved = await eventually(drafts, (now) => String(now.bread.fields.intro).includes("example.com/menu"));
		expect(String(saved.bread.fields.intro)).toContain("example.com/menu");
		expect(String(saved.bread.fields.intro)).toMatch(/<(strong|b)>/);
		await toolbar(page).waitFor({ state: "detached" });
	});

	test("a region's problem shows beside it and is said", async () => {
		const subtitle = 'article [data-wc-field="subtitle"]';
		await selectAllIn(page, frame, subtitle);
		await page.keyboard.press("Backspace");
		await page.waitForFunction(() => document.querySelector("[data-wc-region-problem]") !== null, null, {
			timeout: 6000,
		});
		expect(await page.locator("[data-wc-region-problem]").textContent()).toBe("This can't be empty.");
		expect(await announced(page)).toContain("This can't be empty.");
		const region = await frame.locator(subtitle).boundingBox();
		const note = await page.locator("[data-wc-region-problem]").boundingBox();
		if (!region || !note) throw new Error("No note or region.");
		expect(overlaps(region, note)).toBe(false);
		// Fixed, the problem goes.
		await page.keyboard.type("Out of the oven");
		await page.locator("[data-wc-region-problem]").waitFor({ state: "detached", timeout: 6000 });
		await page.keyboard.press("Tab");
		// Saved once the problem is fixed.
		expect(
			(await eventually(drafts, (now) => now.bread.fields.subtitle === "Out of the oven")).bread.fields.subtitle,
		).toBe("Out of the oven");
	});

	test("the Draft state says No changes yet, Saving…, Saved, N changes not published, Sent for review and Could not save", async () => {
		// The Rye loaf's page shows the Globals too: with them published, it has no change at all.
		const { api } = await install.install.superadmin();
		await api.globals.publish({ siteId });
		frame = await openThrough(page, frame, "/blog/rye-loaf");
		try {
			await draftStateCase();
		} finally {
			frame = await openThrough(page, frame, "/blog/fresh-bread");
		}
	});

	async function draftStateCase() {
		expect(await draftState(page).getAttribute("data-wc-draft-state")).toBe("none");
		expect(await draftState(page).textContent()).toContain("No changes yet");

		// A save under way: "Saving…" until it is answered, then the page's changes.
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		await page.route("**/_webcraft/edit/api/save", async (route) => {
			await held;
			await route.continue();
		});
		await caretAtEnd(page, frame, "h1");
		await page.keyboard.type(" for the week");
		await page.keyboard.press("Tab");
		await page.locator('[data-wc-draft-state="saving"]').waitFor();
		expect(await draftState(page).textContent()).toContain("Saving…");
		release();
		// "Saved" for a moment, then what is left to publish.
		await page.locator('[data-wc-draft-state="saved"]').waitFor();
		expect(await draftState(page).textContent()).toContain("Saved");
		await page.locator('[data-wc-draft-state="changes"]').waitFor();
		expect(await draftState(page).textContent()).toContain("1 change not published");
		await page.unroute("**/_webcraft/edit/api/save");

		// Sent for Review: the page's state says so with its next change.
		const { api } = await install.install.superadmin();
		await api.reviews.submit({ siteId, items: [{ kind: "entry", id: ryeId }] });
		await caretAtEnd(page, frame, 'article [data-wc-field="subtitle"]');
		await page.keyboard.type("!");
		await page.keyboard.press("Tab");
		await page.locator('[data-wc-draft-state="review"]').waitFor({ timeout: 6000 });
		expect(await draftState(page).textContent()).toContain("Sent for review");

		// A save the server refuses (a value it doesn't let this page change).
		await frame.evaluate(() =>
			document.querySelector('article [data-wc-field="subtitle"]')?.setAttribute("data-wc-field", "nope"),
		);
		await caretAtEnd(page, frame, 'article [data-wc-field="nope"]');
		await page.keyboard.type("?");
		await page.keyboard.press("Tab");
		await page.locator('[data-wc-draft-state="failed"]').waitFor({ timeout: 6000 });
		expect(await draftState(page).textContent()).toContain("Could not save");
		expect(await page.locator('[data-wc-messages] [role="alert"]').textContent()).toContain("Couldn't save");
		// The next save that goes through says where the Draft is again.
		await caretAtEnd(page, frame, "h1");
		await page.keyboard.type(".");
		await page.keyboard.press("Tab");
		await page.locator('[data-wc-draft-state="review"]').waitFor({ timeout: 6000 });
	}

	test("two people on one page see each other's text arrive, and their name on the region they are in", async () => {
		const other = await install.newPage("light");
		await other.setViewportSize({ width: 1440, height: 900 });
		try {
			const theirs = await enterBuildingArea(install, other, {
				as: staff,
				siteId,
				slug,
				open: "/page/blog/fresh-bread",
			});
			// Erin is in the Subtitle: Sam sees her colour and name on it.
			await caretAtEnd(page, frame, 'article [data-wc-field="subtitle"]');
			const mark = other.locator("[data-wc-mark-name]").filter({ hasText: "Erin Editor" });
			await mark.waitFor({ timeout: 8000 });
			const outline = await other.locator('[data-wc-mark="person"]').first().boundingBox();
			const region = await theirs.locator('article [data-wc-field="subtitle"]').boundingBox();
			if (!outline || !region) throw new Error("No outline.");
			expect(Math.abs(outline.x - region.x)).toBeLessThanOrEqual(1);
			expect(Math.abs(outline.width - region.width)).toBeLessThanOrEqual(1);

			// Sam types the Tagline and the Note: Erin sees both arrive, and Sam's name while he is there.
			await selectAllIn(other, theirs, 'footer [data-wc-field="tagline"]');
			await page.locator("[data-wc-mark-name]").filter({ hasText: "Sam Staff" }).waitFor({ timeout: 8000 });
			await other.keyboard.type("Open from five.");
			await other.keyboard.press("Tab");
			await frame
				.locator('footer [data-wc-field="tagline"]')
				.filter({ hasText: /^Open from five\.$/ })
				.waitFor({
					timeout: 8000,
				});
			await caretAtEnd(other, theirs, 'footer [data-wc-field="note"]');
			await other.keyboard.type(" And Tuesdays.");
			await other.keyboard.press("Tab");
			await frame
				.locator('footer [data-wc-field="note"]')
				.filter({ hasText: "And Tuesdays." })
				.waitFor({ timeout: 8000 });
			// Once Sam is gone, so is his name.
			await other.context().close();
			await page.locator("[data-wc-mark-name]").filter({ hasText: "Sam Staff" }).waitFor({
				state: "detached",
				timeout: 8000,
			});
		} finally {
			await other
				.context()
				.close()
				.catch(() => {});
		}
	});
});

for (const theme of THEMES) {
	test(`the text toolbar and the shell pass the accessibility checks (${theme})`, async () => {
		const page = await install.newPage(theme);
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.context().addCookies(cookies);
		await page.goto(install.siteUrl(slug, "/_webcraft/build/page/blog/rye-loaf"));
		const frame = await framedAt(page, "/blog/rye-loaf");
		await caretAtEnd(page, frame, 'article [data-wc-field="intro"]');
		await toolbar(page).waitFor();
		await expectNoAxeViolations(page, `building area text toolbar (${theme})`);
		// The toolbar is there while the text has focus: the keyboard's walk starts outside it.
		await page.keyboard.press("Tab");
		await toolbar(page).waitFor({ state: "detached" });
		await expectAccessibleScreen(page, `building area, after editing text (${theme})`);
		await page.context().close();
	});
}
