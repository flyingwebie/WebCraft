// One-off styles and generated Classes in the building area's CSS pane (BA-33), in Chromium:
// - a Class added and a new one made from the pane, then a one-off style for one element saved as a
//   generated Class, announced, one Undo step in the tab's one history;
// - a generated Class's chip says so; changing its rule makes it a normal Class, and the pane offers to
//   name it (Rename);
// - taking a generated Class off the element keeps a peer's change made meanwhile;
// - a one-off style typed for one element and left by selecting another is saved to the first, and the
//   second shows its own Classes;
// - a one-off style keeps a peer's change made while it waited to save;
// - inline styles typed in the HTML pane and saved one after the other are separate Undo steps;
// - the shell with the one-off box open, and with the rename offered, passes the accessibility checks,
//   light and dark.
// The building area's own test of `builder` 417, `css-panel` 333, `editor-concurrency` 541, 586, 688,
// 782, 828 and 1207, and `editor-history` 238 and 872.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ElementTree, TreeNode } from "@webcraft/renderer/builder";
import type { Locator, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { announced, enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).account;
	for (const name of ["intro", "note"]) await api.designSystem.createClass({ siteId, name });
	const site = await api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main>{{@outlet}}</main>" });
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	postTypeId = postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: [
			"<article>",
			"<h1>{{ title }}</h1>",
			'<p class="intro">First words</p>',
			"<p>Second words</p>",
			'<p style="color: darkgreen">Green words</p>',
			"<p>Fourth words</p>",
			"<p>Fifth words</p>",
			"<p>Sixth words</p>",
			"</article>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: made } = await api.entries.create({ siteId, postTypeId, title: "Fresh bread" });
	await api.entries.publish({ siteId, entryId: made.id });
});

let sharedPage: Promise<Page> | undefined;

/** The one page in the building area the checks share (entering is rate-limited), at 1440 × 900. */
function shared() {
	sharedPage ??= (async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: `/page${path}` });
		await settled(page);
		await page.getByRole("tree", { name: "Elements of the page" }).getByRole("treeitem").first().waitFor();
		return page;
	})();
	return sharedPage;
}

afterAll(async () => {
	await (await sharedPage)
		?.context()
		.close()
		.catch(() => {});
	await install?.close();
});

const css = (page: Page) => page.locator('[data-wc-panel="css"]');
const box = (page: Page, id: string) => page.locator(`textarea[data-wc-code-box="${id}"]`);

async function eventually<Value>(read: () => Promise<Value>, done: (value: Value) => boolean): Promise<Value> {
	const deadline = Date.now() + 15000;
	let value = await read();
	while (!done(value) && Date.now() < deadline) {
		await Bun.sleep(100);
		value = await read();
	}
	return value;
}

async function announces(page: Page, words: string): Promise<void> {
	expect(
		await eventually(
			() => announced(page),
			(seen) => seen.includes(words),
		),
	).toContain(words);
}

async function clickIn(page: Page, selector: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			const element = (await frameOf(page)).locator(selector).first();
			await element.scrollIntoViewIfNeeded({ timeout: 5000 });
			const found = await element.boundingBox();
			if (!found) throw new Error(`${selector} isn't on the page.`);
			await page.mouse.click(found.x + Math.min(12, found.width / 2), found.y + found.height / 2);
			await settled(page);
			return;
		} catch (failure) {
			if (attempt >= 3) throw failure;
			await page.waitForTimeout(250);
		}
	}
}

/** Selects the paragraph holding `words` and waits for the CSS pane to follow it. */
async function selectParagraph(page: Page, words: string): Promise<void> {
	await clickIn(page, `p:text-is("${words}")`);
	await css(page).waitFor();
	await page.locator("[data-wc-css-pane]").first().waitFor();
}

async function entryMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return ((await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "").replace(
		/ data-wc-id="[^"]*"/g,
		"",
	);
}

async function draftClasses() {
	const { api } = await install.install.superadmin();
	return (await api.designSystem.get({ siteId })).designSystem.draft.classes;
}

/** A peer changes the Entry template's Draft tree (ids kept, as another editor's change would). */
async function peerRenames(from: string, to: string): Promise<void> {
	const { api } = await install.install.superadmin();
	const { template } = await api.templates.getEntryTemplate({ siteId, postTypeId });
	const tree = template?.draft as ElementTree;
	const change = (nodes: TreeNode[]): TreeNode[] =>
		nodes.map((node) =>
			node.type === "text" && node.text === from
				? { ...node, text: to }
				: node.type === "element"
					? { ...node, children: change(node.children) }
					: node,
		);
	await api.templates.saveEntryTemplate({ siteId, postTypeId, tree: { ...tree, nodes: change(tree.nodes) } });
	await eventually(entryMarkup, (markup) => markup.includes(to));
}

/** The one-off box for the selected element, open and focused. */
async function oneOffBox(page: Page): Promise<Locator> {
	await css(page).getByRole("button", { name: "Style only this element" }).click();
	await box(page, "one-off").waitFor();
	return box(page, "one-off");
}

/** The markup of the paragraph holding `words`, as the Draft has it. */
async function paragraph(words: string): Promise<string> {
	return (await entryMarkup()).match(new RegExp(`<p[^>]*>${words}</p>`))?.[0] ?? "";
}

describe("one-off styles and generated Classes", () => {
	test("the one-off box and the rename offer pass the accessibility checks, light and dark", async () => {
		const page = await shared();
		await selectParagraph(page, "Sixth words");
		await oneOffBox(page);
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await page.mouse.move(24, 460);
			await page.waitForTimeout(1800);
			await settled(page);
			await expectAccessibleScreen(page, `the one-off box (${theme})`);
		}
	});

	test("a Class added, a new one made, and a one-off style saved as a generated Class, one Undo step", async () => {
		const page = await shared();
		await selectParagraph(page, "Second words");
		const add = css(page).getByRole("button", { name: "Add a Class" });
		await add.click();
		await css(page).getByRole("textbox", { name: "Add a Class" }).fill("note");
		await page.keyboard.press("Enter");
		await css(page).locator('[data-wc-css-class="note"]').waitFor();
		await add.click();
		await css(page).getByRole("textbox", { name: "Add a Class" }).fill("lead-text");
		await page.keyboard.press("Enter");
		await css(page).locator('[data-wc-css-class="lead-text"]').waitFor();
		expect(
			await eventually(
				() => paragraph("Second words"),
				(p) => p.includes("lead-text"),
			),
		).toContain('class="note lead-text"');

		const oneOff = await oneOffBox(page);
		await oneOff.fill("color: red;");
		await page.locator('[data-wc-rail="panels"]').focus();
		await announces(page, "One-off style applied.");
		const styled = await eventually(
			() => paragraph("Second words"),
			(p) => /style-[0-9a-f]{8}/.test(p),
		);
		expect(styled).toMatch(/class="note lead-text style-[0-9a-f]{8}"/);
		// Its chip says it is generated, and it is the one chosen.
		const chip = css(page).locator("[data-wc-css-generated]");
		await chip.waitFor();
		expect(
			await css(page)
				.getByRole("button", { name: /a generated Class, for CSS/ })
				.getAttribute("aria-pressed"),
		).toBe("true");
		expect((await draftClasses()).some((each) => each.generated && each.styles.includes("color: red"))).toBe(true);

		// One step in the tab's one history: Undo takes the one-off style back, the Classes before stay.
		await page.getByRole("button", { name: "Undo" }).first().click();
		expect(
			await eventually(
				() => paragraph("Second words"),
				(p) => !/style-/.test(p),
			),
		).toContain('class="note lead-text"');
	});

	test("a generated Class's chip says so; changing its rule makes it normal, and Rename names it", async () => {
		const page = await shared();
		await selectParagraph(page, "Green words");
		await css(page).locator("[data-wc-css-generated]").waitFor();
		const rule = box(page, "css");
		await rule.waitFor();
		const name = (await rule.inputValue()).match(/^\.(style-[0-9a-f]{8})/)?.[1];
		expect(name).toBeTruthy();
		await rule.fill(`.${name} {\n  color: darkgreen;\n  font-style: italic;\n}`);
		const prompt = css(page).locator("[data-wc-css-rename]");
		await prompt.waitFor({ timeout: 10000 });
		const field = prompt.getByRole("textbox", { name: "Name" });
		expect(await field.evaluate((input) => input === document.activeElement)).toBe(true);
		await field.fill("green-note");
		await prompt.getByRole("button", { name: "Rename" }).click();
		await announces(page, "Renamed the Class to .green-note.");
		await css(page).locator('[data-wc-css-class="green-note"]').waitFor();
		const made = (await draftClasses()).find((each) => each.name === "green-note");
		expect(made).toMatchObject({ generated: false });
		expect(made?.styles).toContain("font-style: italic");
	});

	test("taking a generated Class off the element keeps a peer's change made meanwhile", async () => {
		const page = await shared();
		await selectParagraph(page, "Fourth words");
		const oneOff = await oneOffBox(page);
		await oneOff.fill("color: blue;");
		await page.locator('[data-wc-rail="panels"]').focus();
		await eventually(
			() => paragraph("Fourth words"),
			(p) => /style-/.test(p),
		);
		await css(page).locator("[data-wc-css-generated]").waitFor();
		await peerRenames("Sixth words", "Sixth words, by a peer");
		await css(page)
			.getByRole("button", { name: /^Remove \.style-/ })
			.click();
		expect(
			await eventually(
				() => paragraph("Fourth words"),
				(p) => !/style-/.test(p),
			),
		).toBe("<p>Fourth words</p>");
		expect(await entryMarkup()).toContain("Sixth words, by a peer");
	});

	test("a one-off style left by selecting another element is saved to its own; the other shows its Classes", async () => {
		const page = await shared();
		await selectParagraph(page, "Fifth words");
		const oneOff = await oneOffBox(page);
		await oneOff.fill("letter-spacing: 2px;");
		// Selected another element before it saved: it goes to the element it was typed for.
		await selectParagraph(page, "First words");
		await css(page).locator('[data-wc-css-class="intro"]').waitFor();
		expect(await box(page, "one-off").count()).toBe(0);
		expect(
			await eventually(
				() => paragraph("Fifth words"),
				(p) => /style-/.test(p),
			),
		).toMatch(/class="style-[0-9a-f]{8}"/);
		expect(await paragraph("First words")).toBe('<p class="intro">First words</p>');
	});

	test("a one-off style keeps a peer's change made while it waited to save", async () => {
		const page = await shared();
		await selectParagraph(page, "Fourth words");
		const oneOff = await oneOffBox(page);
		await oneOff.fill("text-transform: uppercase;");
		await peerRenames("Second words", "Second words, by a peer");
		await page.locator('[data-wc-rail="panels"]').focus();
		await announces(page, "One-off style applied.");
		const markup = await eventually(entryMarkup, (text) => /<p class="style-[0-9a-f]{8}">Fourth words/.test(text));
		expect(markup).toMatch(/<p class="style-[0-9a-f]{8}">Fourth words<\/p>/);
		expect(markup).toContain("Second words, by a peer");
	});

	test("inline styles typed in the HTML pane and saved one after the other are separate Undo steps", async () => {
		const page = await shared();
		await selectParagraph(page, "First words");
		const html = box(page, "html");
		await html.waitFor();
		// What the checks above saved (a peer's text, a one-off style) is in the box first, else saving
		// rightly asks Reload theirs or Overwrite with mine.
		const withoutIds = (text: string) => text.replace(/ data-wc-id="[^"]*"/g, "");
		const draft = await entryMarkup();
		const before = await eventually(
			() => html.inputValue(),
			(text) => withoutIds(text) === draft,
		);
		expect(withoutIds(before)).toBe(draft);
		// The box prints each element with its id (`<h1 data-wc-id="…">`): a style is added after the tag.
		const styled = before.replace(/<h1\b/, '<h1 style="color: purple"');
		expect(styled).not.toBe(before);
		await html.fill(styled);
		await page.locator('[data-wc-rail="panels"]').focus();
		const firstSave = await eventually(entryMarkup, (text) => /<h1 class="style-/.test(text));
		expect(firstSave).toMatch(/<h1 class="style-/);
		await selectParagraph(page, "First words");
		expect(
			await eventually(
				() => html.inputValue(),
				(text) => /<h1 class="style-/.test(text),
			),
		).toMatch(/<h1 class="style-/);
		const again = await html.inputValue();
		// The second save is held on its way, and Undo is pressed while it is (BA-33's one run: Undo
		// took back the first save while the second was still being answered).
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		await page.route("**/_webcraft/edit/api/code/save", async (route) => {
			held.resolve();
			await release.promise;
			await route.continue();
		});
		try {
			const teal = again.replace('<p class="intro"', '<p class="intro" style="color: teal"');
			expect(teal).not.toBe(again);
			await html.fill(teal);
			await page.locator('[data-wc-rail="panels"]').focus();
			await held.promise;
			await page.getByRole("button", { name: "Undo" }).first().click();
			await page.waitForTimeout(300);
			// Nothing taken back yet: Undo waits for the save under way.
			expect(await entryMarkup()).toMatch(/<h1 class="style-[0-9a-f]{8}">/);
			release.resolve();
			const undone = await eventually(entryMarkup, (text) => !/<p class="intro style-/.test(text));
			// The step taken back is the second save; the first one's generated Class stays on the h1.
			expect(undone).toContain('<p class="intro">First words</p>');
			expect(undone).toMatch(/<h1 class="style-[0-9a-f]{8}">/);
		} finally {
			release.resolve();
			await page.unrouteAll({ behavior: "wait" });
		}
		// The next Undo takes back the first save: no generated Class left on the h1.
		await page.getByRole("button", { name: "Undo" }).first().click();
		const first = await eventually(entryMarkup, (text) => !/<h1 class="style-/.test(text));
		expect(first).toContain("<h1>{{ title }}</h1>");
	});
});
