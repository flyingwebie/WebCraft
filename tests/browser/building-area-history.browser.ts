// The Undo history in the building area (ADR 0036, ADR 0037 › 1.5, BA-07), in Chromium: one history
// for the tab, since the shell is never left.
// - text typed in place is a step each finished burst; Undo and Redo step through it from the bottom
//   bar, the keys in the page and the keys in the shell, across two pages opened in the shell without a
//   reload, saying where a step was made when it isn't on this page; a reload clears it;
// - Undo while still typing saves the text first and takes that burst back, focus staying in the text;
// - the text toolbar's Undo is the same history;
// - a step someone else's change made obsolete is skipped, with its reason;
// - a Member and Staff on one Draft each take back only their own steps.
// The building area's own test of the old editing bar's history cases (`edit-mode-history.browser.ts`):
// its hand-over cases become "kept across documents in one tab".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

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
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Mia Member" })).account;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).account;

	await api.globals.setFields({
		siteId,
		fields: [
			{ key: "tagline", label: "Tagline", type: "text" },
			{ key: "note", label: "Note", type: "richText" },
		],
	});
	await api.globals.saveDraft({ siteId, fields: { tagline: "Baked daily", note: "<p>Open daily.</p>" } });
	await api.globals.publish({ siteId });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: [
			'<header><p>{{ site.tagline }}</p><nav aria-label="Main"><a href="/blog/fresh-bread">Fresh bread</a> <a href="/blog/rye-loaf">Rye loaf</a></nav></header>',
			"<main>{{@outlet}}</main>",
			"<footer><div>{{ site.note }}</div></footer>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "subtitle", label: "Subtitle", type: "text" }],
	});
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1><p>{{ subtitle }}</p></article>",
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const post = async (title: string, subtitle: string) => {
		const { entry: made } = await api.entries.create({ siteId, postTypeId: postType.id, title, fields: { subtitle } });
		await api.entries.publish({ siteId, entryId: made.id });
		return made.id;
	};
	breadId = await post("Fresh bread", "Out of the oven");
	ryeId = await post("Rye loaf", "Dark and dense");
});

afterAll(async () => {
	await install?.close();
});

/** What the Drafts hold now, as the admin reads them. */
async function read() {
	const { api } = await install.install.superadmin();
	const [bread, rye, globals] = await Promise.all([
		api.entries.get({ siteId, entryId: breadId }),
		api.entries.get({ siteId, entryId: ryeId }),
		api.globals.get({ siteId }),
	]);
	const plain = (value: unknown) => String(value ?? "").replaceAll(" ", " ");
	return {
		bread: plain(bread.entry.draft.title),
		breadSubtitle: plain(bread.entry.draft.fields.subtitle),
		rye: plain(rye.entry.draft.title),
		tagline: plain(globals.globals.draft.tagline),
	};
}

/**
 * Waits until the Drafts hold what `wanted` names: an Undo or a Redo changes the page at once, and
 * reaches the server through its save a moment later (later still on a busy machine).
 */
async function drafts(wanted: Partial<Awaited<ReturnType<typeof read>>>): Promise<void> {
	const picked = (seen: Awaited<ReturnType<typeof read>>) =>
		Object.fromEntries(Object.keys(wanted).map((key) => [key, seen[key as keyof typeof seen]]));
	let seen = picked(await read());
	for (let attempt = 0; attempt < 150 && JSON.stringify(seen) !== JSON.stringify(wanted); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		seen = picked(await read());
	}
	expect(seen).toEqual(wanted);
}

/** The title of each page this file opens, as the shell names it once it has read the page's state. */
const TITLES: Record<string, string> = { "/blog/fresh-bread": "Fresh bread", "/blog/rye-loaf": "Rye loaf" };

/**
 * Waits until the frame shows `path` with its regions editable, and the shell has read the page's
 * state (the page switcher names it): a step typed before that knows no page title to say "on" with.
 */
async function framedAt(page: Page, path: string): Promise<Frame> {
	for (let attempt = 0; attempt < 300; attempt++) {
		const frame = await frameOf(page);
		if (new URL(frame.url()).pathname === path) {
			await frame.locator("[data-wc-item][contenteditable]").first().waitFor();
			await named(page, path);
			return frame;
		}
		await page.waitForTimeout(50);
	}
	throw new Error(`The frame never showed ${path}.`);
}

/** Waits until the shell's page switcher names the page at `path` (its state has been read). */
async function named(page: Page, path: string): Promise<void> {
	const title = TITLES[path];
	if (!title) return;
	await page.waitForFunction(
		(title) =>
			document.querySelector("[data-wc-page-switcher]")?.getAttribute("aria-label")?.startsWith(title) === true,
		title,
		{ timeout: 15000 },
	);
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

/** Puts the caret at the end of a region, from the pointer. */
async function caretAtEnd(page: Page, frame: Frame, selector: string): Promise<void> {
	const region = frame.locator(selector);
	await region.scrollIntoViewIfNeeded();
	await settled(page);
	const box = await region.boundingBox();
	if (!box) throw new Error(`${selector} isn't shown.`);
	await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
	await page.keyboard.press("End");
}

/** Types over a region's text and leaves it: one finished burst, one step. */
async function typeOver(page: Page, frame: Frame, selector: string, text: string): Promise<void> {
	await caretAtEnd(page, frame, selector);
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.type(text);
	await page.keyboard.press("Tab");
}

const undoButton = (page: Page) => page.locator('[data-wc-bar="undo"]');
const redoButton = (page: Page) => page.locator('[data-wc-bar="redo"]');
const tagline = (frame: Frame) => frame.locator('header [data-wc-field="tagline"]');

/** Waits until Undo offers `label` (its name is "Undo <label>"), or nothing for null. */
async function nextUndo(page: Page, label: string | null): Promise<void> {
	await page.waitForFunction(
		(label) => {
			const button = document.querySelector<HTMLButtonElement>('[data-wc-bar="undo"]');
			if (!button) return false;
			return label === null
				? button.disabled
				: !button.disabled && button.getAttribute("aria-label") === `Undo ${label}`;
		},
		label,
		{ timeout: 15000 },
	);
}

/** Waits until the shell has said `text` (its live regions, polite or assertive); says what it said instead. */
async function said(page: Page, text: string): Promise<void> {
	const now = async () => ((await page.locator("[data-wc-messages]").textContent()) ?? "").replaceAll("\u00a0", "");
	try {
		await page.waitForFunction(
			(text) =>
				(document.querySelector("[data-wc-messages]")?.textContent ?? "").replaceAll("\u00a0", "").includes(text),
			text,
			{ timeout: 15000 },
		);
	} catch {
		expect(await now()).toContain(text);
	}
}

describe("the Undo history, for a Member", () => {
	let page: Page;
	let frame: Frame;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		frame = await enterBuildingArea(install, page, { as: editor, siteId, slug, open: "/page/blog/fresh-bread" });
		await named(page, "/blog/fresh-bread");
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("steps across two pages opened in the shell, without a reload; a reload clears them", async () => {
		await nextUndo(page, null);
		await typeOver(page, frame, "h1", "Fresh bread daily");
		await nextUndo(page, "Edit Title");
		await typeOver(page, frame, 'header [data-wc-field="tagline"]', "Baked at dawn");
		await nextUndo(page, "Edit Tagline");

		// Another page in the same tab: the history comes along.
		frame = await openThrough(page, frame, "/blog/rye-loaf");
		await nextUndo(page, "Edit Tagline");
		await typeOver(page, frame, "h1", "Rye loaf, sliced");
		await nextUndo(page, "Edit Title");
		await drafts({
			bread: "Fresh bread daily",
			breadSubtitle: "Out of the oven",
			rye: "Rye loaf, sliced",
			tagline: "Baked at dawn",
		});

		// The bottom bar's Undo: this page's title, back in the page.
		await undoButton(page).click();
		await said(page, "Undid Edit Title");
		await frame
			.locator("h1")
			.filter({ hasText: /^Rye loaf$/ })
			.waitFor();
		// The keys in the page: the Tagline shows here too, so the message says no "on".
		await frame.locator("article p").click();
		await page.keyboard.press("ControlOrMeta+z");
		await said(page, "Undid Edit Tagline");
		await tagline(frame)
			.filter({ hasText: /^Baked daily$/ })
			.waitFor();
		// The keys in the shell: a step made on another page says where.
		await page.locator('[data-wc-bar="redo"]').focus();
		await page.keyboard.press("ControlOrMeta+z");
		// Where it was made: the page as it was then.
		await said(page, "Undid Edit Title on Fresh bread");
		await drafts({
			bread: "Fresh bread",
			breadSubtitle: "Out of the oven",
			rye: "Rye loaf",
			tagline: "Baked daily",
		});
		await nextUndo(page, null);

		// Redo makes them again, in order.
		expect(await redoButton(page).getAttribute("aria-label")).toBe("Redo Edit Title");
		await redoButton(page).click();
		await said(page, "Redid Edit Title on Fresh bread");
		await page.keyboard.press("ControlOrMeta+Shift+z");
		await said(page, "Redid Edit Tagline");
		await tagline(frame)
			.filter({ hasText: /^Baked at dawn$/ })
			.waitFor();
		await drafts({ bread: "Fresh bread daily" });

		// Back to the first page in the shell (no reload): the last step was made on the other page.
		await page.goBack();
		frame = await framedAt(page, "/blog/fresh-bread");
		await redoButton(page).click();
		await said(page, "Redid Edit Title on Rye loaf");
		await drafts({ rye: "Rye loaf, sliced" });
		await frame
			.locator("h1")
			.filter({ hasText: /^Fresh bread daily$/ })
			.waitFor();

		// A reload is a new history: none.
		await page.reload();
		frame = await framedAt(page, "/blog/fresh-bread");
		await nextUndo(page, null);
		expect(await redoButton(page).isDisabled()).toBe(true);
		await drafts({ tagline: "Baked at dawn" });
	});

	test("Undo while still typing saves the text first and takes that burst back; focus stays in the text", async () => {
		await caretAtEnd(page, frame, "article p");
		await page.keyboard.type(", still warm");
		// No pause, no leaving: Undo saves it as a step, then takes it back.
		await page.keyboard.press("ControlOrMeta+z");
		await said(page, "Undid Edit Subtitle");
		await frame
			.locator("article p")
			.filter({ hasText: /^Out of the oven$/ })
			.waitFor();
		expect(await frame.evaluate(() => document.activeElement?.getAttribute("data-wc-field"))).toBe("subtitle");
		await drafts({ breadSubtitle: "Out of the oven" });
		await page.keyboard.press("ControlOrMeta+Shift+z");
		await said(page, "Redid Edit Subtitle");
		await frame
			.locator("article p")
			.filter({ hasText: /still warm$/ })
			.waitFor();
	});

	test("the text toolbar's Undo is the same history, and the text keeps focus", async () => {
		await caretAtEnd(page, frame, 'footer [data-wc-field="note"]');
		await page.keyboard.type(" Closed on Mondays.");
		await page.getByRole("toolbar", { name: "Text formatting: Note" }).waitFor();
		await page.locator('[data-wc-text-toolbar] [data-wc-tool="undo"]').click();
		await said(page, "Undid Edit Note");
		await frame
			.locator('footer [data-wc-field="note"]')
			.filter({ hasText: /^Open daily\.$/ })
			.waitFor();
		expect(await frame.evaluate(() => document.activeElement?.getAttribute("data-wc-field"))).toBe("note");
		await page.keyboard.press("Tab");
	});

	test("a step someone else's change made obsolete is skipped, with its reason", async () => {
		await typeOver(page, frame, 'header [data-wc-field="tagline"]', "Mine");
		await nextUndo(page, "Edit Tagline");
		const { api } = await install.install.superadmin();
		await api.globals.saveDraft({ siteId, fields: { tagline: "Staff's" } });
		// Their change arrives in the page.
		await tagline(frame)
			.filter({ hasText: /^Staff's$/ })
			.waitFor({ timeout: 8000 });
		await undoButton(page).click();
		// Skipped, and the history goes on to the step before it.
		await said(
			page,
			"Skipped Edit Tagline. This step overlaps a newer change or its target no longer exists. Undid Edit Subtitle",
		);
		expect(await page.locator('[data-wc-messages] [role="alert"]').textContent()).toContain("Skipped Edit Tagline");
		await drafts({ tagline: "Staff's" });
		// The pointer still on Undo: its tooltip shows the keys beside the name, which stays the label.
		await undoButton(page).hover();
		await undoButton(page).locator("[data-wc-tip]").waitFor();
		await expectAccessibleScreen(page, "building area Undo history");
	});
});

test("a Member and Staff on one Draft each take back only their own steps", async () => {
	const member = await install.newPage("light");
	const peer = await install.newPage("dark");
	try {
		for (const page of [member, peer]) await page.setViewportSize({ width: 1440, height: 900 });
		const theirs = await enterBuildingArea(install, member, { as: editor, siteId, slug, open: "/page/blog/rye-loaf" });
		const mine = await enterBuildingArea(install, peer, { as: staff, siteId, slug, open: "/page/blog/rye-loaf" });
		// Their steps interleave on one Entry's Draft: Member, Staff, Member, Staff.
		await typeOver(member, theirs, "h1", "Member rye");
		await nextUndo(member, "Edit Title");
		await mine
			.locator("h1")
			.filter({ hasText: /^Member rye$/ })
			.waitFor({ timeout: 8000 });
		await typeOver(peer, mine, "article p", "Staff subtitle");
		await nextUndo(peer, "Edit Subtitle");
		await typeOver(member, theirs, 'header [data-wc-field="tagline"]', "Member tagline");
		await nextUndo(member, "Edit Tagline");
		await typeOver(peer, mine, "h1", "Staff rye");
		await nextUndo(peer, "Edit Title");

		// The Member's history holds the Member's two steps and nothing of Staff's.
		await undoButton(member).click();
		await said(member, "Undid Edit Tagline");
		await nextUndo(member, "Edit Title");
		await undoButton(member).click();
		// Staff's later title made the Member's title step obsolete: skipped, never overwriting it.
		await said(member, "Skipped Edit Title.");
		await nextUndo(member, null);
		await drafts({ rye: "Staff rye", tagline: "Staff's" });

		// Staff take back their own two, in order.
		await undoButton(peer).click();
		await said(peer, "Undid Edit Title");
		await undoButton(peer).click();
		await said(peer, "Undid Edit Subtitle");
		await nextUndo(peer, null);
		await drafts({ rye: "Member rye" });
		await theirs
			.locator("article p")
			.filter({ hasText: /^Dark and dense$/ })
			.waitFor({ timeout: 8000 });
	} finally {
		await member.context().close();
		await peer.context().close();
	}
});
