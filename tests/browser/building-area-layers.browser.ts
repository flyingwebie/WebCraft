// Staff's Layers beyond selecting (BA-33), in Chromium:
// - cut, copy, paste, duplicate, delete and rename in place, from the keyboard, each announced;
// - Space picks a layer up, the arrows move it, Escape puts it back (no Undo step), Space puts it down
//   (one Undo step); a peer's change meanwhile means it can no longer be put back;
// - a Condition's Else and a Loop's "When there are no items" are rows of their own: what is pasted
//   on one goes into it, and selecting one outlines what it shows on the page;
// - a row under the pointer outlines its element on the canvas, and an element under the pointer marks
//   its row, never changing the selection;
// - the same Component placed twice changes in both places at once;
// - a branch selected: the JS pane reads the scripts of the source it is in, with no error (UI-21);
// - the selection moving on within a source whose markup the HTML pane is still reading: its lines are
//   looked for in that source's markup, never in the previous one's (BA-28);
// - Layers with its branches passes the accessibility checks, light and dark.
// The building area's own test of `builder` 171 and 196, `code-layers` 378 and 572, `code-selection`
// 39 and 394, and `editor-concurrency` 443 and 497.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ElementTree, TreeNode } from "@webcraft/renderer/builder";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { drift, enterBuildingArea, eventually, frameOf, settled, stays } from "./building-area.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, pageErrors, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
let cardId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).account;
	for (const name of ["top", "source", "box", "card"]) await api.designSystem.createClass({ siteId, name });
	const { loop } = await api.loops.create({
		siteId,
		name: "days",
		source: "items",
		fields: [{ key: "day", label: "Day", type: "text" }],
	});
	await api.loops.publish({ siteId, loopId: loop.id });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: [
			'<header class="top"><p class="source">Copied value</p>',
			'{{@if site.language == "it"}}<span>Italian</span>{{@else}}{{/if}}',
			"{{@loop days as item}}<span>{{ item.day }}</span>{{@empty}}{{/loop}}",
			"</header><main>{{@outlet}}</main>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { component } = await api.components.create({ siteId, name: "Card" });
	cardId = component.id;
	await api.components.saveMarkup({
		siteId,
		componentId: cardId,
		markup: '<div class="card"><h2>Card title</h2></div>',
	});
	await api.components.publish({ siteId, componentId: cardId });
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	postTypeId = postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: [
			"<article>",
			"<h1>{{ title }}</h1>",
			'<section class="box"></section>',
			"<ul><li>One</li></ul>",
			"<p>Fresh from the oven</p>",
			"<Card />",
			"<Card />",
			"</article>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: made } = await api.entries.create({ siteId, postTypeId, title: "Fresh bread" });
	await api.entries.publish({ siteId, entryId: made.id });
});

let sharedPage: Promise<Page> | undefined;

function shared() {
	sharedPage ??= (async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: `/page${path}` });
		await settled(page);
		await tree(page).getByRole("treeitem").first().waitFor();
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

const tree = (page: Page) => page.getByRole("tree", { name: "Elements of the page" });
/** The Entry template's plain paragraph (not the Site template's `p .source`, listed before it). */
const entryP = /^p(?! \.source)\b/;
const row = (page: Page, name: string | RegExp) => tree(page).getByRole("treeitem", { name }).first();

/** Opens every closed row of Layers, so each row can be found by its name. */
async function openRows(page: Page): Promise<void> {
	for (let pass = 0; pass < 40; pass++) {
		const closed = tree(page).locator('[role="treeitem"][aria-expanded="false"]').first();
		if ((await closed.count()) === 0) return;
		await closed.locator("svg").first().click();
		await settled(page);
	}
}

async function announces(page: Page, words: string): Promise<void> {
	// The shell's messages and Layers' own (its moves, picks and refusals).
	const said = async () =>
		(await page.locator('[aria-live], [role="status"], [role="alert"]').allTextContents()).join(" | ");
	expect(await eventually(said, (seen) => seen.includes(words))).toContain(words);
}

async function entryMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return ((await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "").replace(
		/ data-wc-id="[^"]*"/g,
		"",
	);
}

async function siteMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return ((await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft ?? "").replace(
		/ data-wc-id="[^"]*"/g,
		"",
	);
}

/** The order of the article's elements in the Entry template's Draft, by their tag. */
async function order(): Promise<string[]> {
	const markup = await entryMarkup();
	const inside = markup.replace(/^<article>/, "").replace(/<\/article>$/, "");
	return [...inside.matchAll(/<(h1|section|ul|p|Card)\b/g)].map((match) => match[1] ?? "");
}

/** Focuses a row (selecting it), as a click on it does. */
async function focusRow(page: Page, name: string | RegExp): Promise<void> {
	await openRows(page);
	await row(page, name).click();
	await row(page, name).focus();
	await settled(page);
}

describe("Layers: arranging from the keyboard, branches, hover", () => {
	test("Layers with its branches passes the accessibility checks, light and dark", async () => {
		const page = await shared();
		// Its branches shown, one of them selected (the code panes read the Condition's source).
		await focusRow(page, "Else");
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await page.mouse.move(24, 460);
			await page.waitForTimeout(1800);
			await settled(page);
			await expectAccessibleScreen(page, `Layers with branches (${theme})`);
		}
	});

	test("cut, copy, paste, duplicate, delete and rename, each announced", async () => {
		const page = await shared();
		await focusRow(page, entryP);
		await page.keyboard.press("ControlOrMeta+c");
		await announces(page, "Copied p.");
		await focusRow(page, "section .box");
		await page.keyboard.press("ControlOrMeta+v");
		await announces(page, "Paste section.box");
		expect(await eventually(order, (tags) => tags.join() === "h1,section,p,ul,p,Card,Card")).toEqual([
			"h1",
			"section",
			"p",
			"ul",
			"p",
			"Card",
			"Card",
		]);
		await focusRow(page, entryP);
		await page.keyboard.press("ControlOrMeta+d");
		await announces(page, "Duplicate p");
		const paragraphs = (tags: string[]) => tags.filter((tag) => tag === "p").length;
		expect(paragraphs(await eventually(order, (tags) => paragraphs(tags) === 3))).toBe(3);
		await page.keyboard.press("Delete");
		await announces(page, "Delete p");
		expect(paragraphs(await eventually(order, (tags) => paragraphs(tags) === 2))).toBe(2);

		await focusRow(page, /^ul\b/);
		await page.keyboard.press("ControlOrMeta+x");
		await announces(page, "Cut ul.");
		expect(await eventually(order, (tags) => !tags.includes("ul"))).not.toContain("ul");
		await focusRow(page, "h1");
		await page.keyboard.press("ControlOrMeta+v");
		expect(await eventually(order, (tags) => tags[1] === "ul")).toEqual([
			"h1",
			"ul",
			"section",
			"p",
			"p",
			"Card",
			"Card",
		]);

		await focusRow(page, /^ul\b/);
		await page.keyboard.press("F2");
		const rename = page.getByRole("textbox", { name: "Layer label of ul" });
		await rename.fill("Steps");
		await rename.press("Enter");
		await announces(page, "Renamed Steps.");
		const steps = row(page, /^Steps/);
		await steps.waitFor();
		expect(await steps.getAttribute("aria-selected")).toBe("true");
		const { api } = await install.install.superadmin();
		const labelled = await eventually(
			async () => JSON.stringify((await api.templates.getEntryTemplate({ siteId, postTypeId })).template?.draft),
			(draft) => draft.includes('"label":"Steps"'),
		);
		expect(labelled).toContain('"label":"Steps"');
	});

	test("Space picks a layer up, the arrows move it, Escape puts it back with no step, Space puts it down as one", async () => {
		const page = await shared();
		const before = await order();
		await focusRow(page, "section .box");
		const undo = page.locator('[data-wc-bar="undo"]');
		const lastStep = await undo.getAttribute("aria-label");
		await page.keyboard.press(" ");
		await announces(page, "Picked up section.");
		expect(await row(page, "section .box").getAttribute("data-grabbed")).toBe("true");
		await page.keyboard.press("ArrowUp");
		// Moved for real (in the Draft) before Escape puts it back.
		expect(
			(await eventually(order, (tags) => tags.indexOf("section") < before.indexOf("section"))).indexOf("section"),
		).toBeLessThan(before.indexOf("section"));
		await page.keyboard.press("Escape");
		await announces(page, "Put section back where it was.");
		expect(await eventually(order, (tags) => tags.join() === before.join())).toEqual(before);
		expect(await row(page, "section .box").getAttribute("data-grabbed")).toBeNull();
		expect(await row(page, "section .box").getAttribute("aria-selected")).toBe("true");
		expect(await undo.getAttribute("aria-label")).toBe(lastStep);

		await page.keyboard.press(" ");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press(" ");
		await announces(page, "Put down section: 1 of");
		expect(await eventually(order, (tags) => tags[0] === "section")).toEqual([
			"section",
			...before.filter((tag) => tag !== "section"),
		]);
		expect(
			await eventually(
				() => undo.getAttribute("aria-label"),
				(label) => label === "Undo Move section",
			),
		).toBe("Undo Move section");
		// One step: one Undo puts it back where it was before it was picked up.
		await undo.click();
		expect(await eventually(order, (tags) => tags.join() === before.join())).toEqual(before);
	});

	test("a peer's change while a layer is picked up means Escape puts it down; Undo keeps the peer's change", async () => {
		const page = await shared();
		const before = await order();
		await focusRow(page, "section .box");
		await page.keyboard.press(" ");
		await page.keyboard.press("ArrowDown");
		const moved = await eventually(order, (tags) => tags.indexOf("section") > before.indexOf("section"));
		expect(moved.indexOf("section")).toBeGreaterThan(before.indexOf("section"));
		// A peer changes the Entry template meanwhile (ids kept).
		const { api } = await install.install.superadmin();
		const { template } = await api.templates.getEntryTemplate({ siteId, postTypeId });
		const draft = template?.draft as ElementTree;
		const relabel = (nodes: TreeNode[]): TreeNode[] =>
			nodes.map((node) =>
				node.type === "element" && node.tag === "h1"
					? { ...node, label: "Peer title" }
					: node.type === "element"
						? { ...node, children: relabel(node.children) }
						: node,
			);
		await api.templates.saveEntryTemplate({ siteId, postTypeId, tree: { ...draft, nodes: relabel(draft.nodes) } });
		await row(page, /^Peer title/).waitFor();
		await announces(page, "This move can no longer be cancelled");
		await row(page, "section .box").focus();
		await page.keyboard.press("Escape");
		// Escape puts it down where it is: the move is a step of its own, and the Draft keeps it.
		const undo = page.locator('[data-wc-bar="undo"]');
		expect(
			await eventually(
				() => undo.getAttribute("aria-label"),
				(label) => label === "Undo Move section",
			),
		).toBe("Undo Move section");
		expect(await row(page, "section .box").getAttribute("data-grabbed")).toBeNull();
		await stays(order, (tags) => tags.join() === moved.join(), { what: "The order after Escape" });
		await undo.click();
		expect(await eventually(order, (tags) => tags.join() === before.join())).toEqual(before);
		expect(JSON.stringify((await api.templates.getEntryTemplate({ siteId, postTypeId })).template?.draft)).toContain(
			"Peer title",
		);
	});

	test("Else and When there are no items are rows: pasting on them puts the copy inside", async () => {
		const page = await shared();
		await row(page, "header .top").waitFor();
		await focusRow(page, "p .source");
		await page.keyboard.press("ControlOrMeta+c");
		await focusRow(page, "Else");
		await page.keyboard.press("ControlOrMeta+v");
		await focusRow(page, "When there are no items");
		await page.keyboard.press("ControlOrMeta+v");
		const saved = await eventually(siteMarkup, (text) => (text.match(/Copied value/g) ?? []).length === 3);
		expect(saved).toMatch(/\{\{@else\}\}\s*<p class="source">Copied value<\/p>\s*\{\{\/if\}\}/);
		expect(saved).toMatch(/\{\{@empty\}\}\s*<p class="source">Copied value<\/p>\s*\{\{\/loop\}\}/);
	});

	test("a branch selected: the JS pane reads the scripts of the source it is in, with no error", async () => {
		const page = await shared();
		const errors = pageErrors(page).length;
		const js = page.locator('[data-wc-panel="js"]');
		for (const name of ["Else", "When there are no items"]) {
			// An element of another source first: the pane reads a source's scripts when the selection
			// moves into it, so each branch's are read anew.
			await focusRow(page, "h1");
			await openRows(page);
			const ref = (await row(page, name).getAttribute("data-wc-ref")) ?? "";
			const source = ref.slice(0, ref.indexOf("#"));
			expect(source).not.toBe("");
			const read = page.waitForResponse(
				(response) =>
					response.url().includes("/code/scripts") &&
					(JSON.parse(response.request().postData() ?? "{}") as { ref?: string }).ref?.startsWith(source) === true,
			);
			await focusRow(page, name);
			// The pane asked for the scripts of the source the branch is in, and was answered.
			const answer = await read;
			expect({ name, status: answer.status() }).toEqual({ name, status: 200 });
			await js.locator('[data-wc-js-pane="ready"]').waitFor();
			// Its scripts shown: the Site's tab is there, in the box, whichever tab the person keeps open.
			expect(await js.locator('[data-wc-script-tab="site"]').count()).toBe(1);
			await page.locator('textarea[data-wc-code-box="js"]').waitFor();
			expect(await js.textContent()).not.toContain("Couldn't read it");
		}
		expect(pageErrors(page).slice(errors)).toEqual([]);
	});

	test("the selection moving on while the HTML pane reads another source: its part is found in that source's markup", async () => {
		const page = await shared();
		const errors = pageErrors(page).length;
		await focusRow(page, "h1");
		await openRows(page);
		const box = page.locator('textarea[data-wc-code-box="html"]');
		await page.waitForFunction(() =>
			document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="html"]')?.value.startsWith("<h1"),
		);
		// The Site template's markup is held on its way while the selection moves on within it.
		const held = Promise.withResolvers<void>();
		await page.route("**/_webcraft/edit/api/code/editorMarkup", async (route) => {
			await held.promise;
			await route.continue();
		});
		const statuses: number[] = [];
		page.on("response", (response) => {
			if (response.url().includes("/code/editorRead")) statuses.push(response.status());
		});
		await focusRow(page, "Else");
		await focusRow(page, "When there are no items");
		await settled(page);
		held.resolve();
		await page.waitForFunction(() =>
			document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="html"]')?.value.startsWith("{{@loop"),
		);
		await page.unroute("**/_webcraft/edit/api/code/editorMarkup");
		// The empty branch shows its Loop's own markup, cut from the Site template's (FX-02).
		expect(await box.inputValue()).toContain("{{@empty}}");
		expect(await box.inputValue()).not.toContain("<header");
		expect(statuses.length).toBeGreaterThan(0);
		expect(statuses.filter((status) => status !== 200)).toEqual([]);
		expect(pageErrors(page).slice(errors)).toEqual([]);
	});

	test("selecting When there are no items outlines what it shows on the page", async () => {
		const page = await shared();
		await focusRow(page, "When there are no items");
		expect(await row(page, "When there are no items").getAttribute("aria-selected")).toBe("true");
		const frame = await frameOf(page);
		// The Loop lists nothing, so its empty branch's copy is what the page shows after the Condition's.
		// The original, Else's copy and the empty branch's copy (pasted above): the last is the empty one's.
		expect(await frame.locator("header p.source").count()).toBe(3);
		const shown = frame.locator("header p.source").last();
		await shown.waitFor();
		const outline = page.locator('[data-wc-outline="selected"]');
		await outline.waitFor();
		const element = await shown.boundingBox();
		const drawn = await outline.boundingBox();
		if (!element || !drawn) throw new Error("Nothing is outlined.");
		expect(drift(element, drawn)).toBeLessThanOrEqual(2);
	});

	test("hovering a row outlines its element; hovering an element marks its row; the selection stays", async () => {
		const page = await shared();
		await focusRow(page, /^Steps/);
		const selected = await tree(page).getByRole("treeitem", { selected: true }).getAttribute("aria-label");
		await row(page, "h1").hover();
		const hoverOutline = page.locator('[data-wc-outline="hover"]');
		await hoverOutline.waitFor({ state: "visible" });
		const frame = await frameOf(page);
		const heading = await frame.locator("h1").boundingBox();
		const drawn = await hoverOutline.boundingBox();
		if (!heading || !drawn) throw new Error("The heading isn't outlined.");
		expect(drift(heading, drawn)).toBeLessThanOrEqual(2);

		const paragraph = await frame.locator("article > p").first().boundingBox();
		if (!paragraph) throw new Error("No paragraph.");
		await page.mouse.move(paragraph.x + 10, paragraph.y + paragraph.height / 2);
		await tree(page).locator('[role="treeitem"][data-hovered="true"]').first().waitFor();
		expect(await tree(page).locator('[data-hovered="true"]').first().getAttribute("aria-label")).toMatch(/^p\b/);
		expect(await tree(page).getByRole("treeitem", { selected: true }).getAttribute("aria-label")).toBe(selected);
	});

	test("the same Component placed twice changes in both places at once", async () => {
		const page = await shared();
		const frame = await frameOf(page);
		const first = frame.locator(".card h2").first();
		const box = await first.boundingBox();
		if (!box) throw new Error("No card.");
		await page.mouse.click(box.x + 10, box.y + box.height / 2);
		await settled(page);
		await page.locator('[data-wc-panel-body="inspector"]').getByLabel("Tag").selectOption("h3");
		await (await frameOf(page)).locator(".card h3").nth(1).waitFor();
		expect(await (await frameOf(page)).locator(".card h3").count()).toBe(2);
		expect(await (await frameOf(page)).locator(".card h2").count()).toBe(0);
		const { api } = await install.install.superadmin();
		const read = await eventually(
			() => api.components.getMarkup({ siteId, componentId: cardId }),
			(got) => got.markup.draft.replace(/ data-wc-id="[^"]*"/g, "").includes("<h3>"),
		);
		expect(read.markup.draft.replace(/ data-wc-id="[^"]*"/g, "")).toContain(
			'<div class="card"><h3>Card title</h3></div>',
		);
	});
});
