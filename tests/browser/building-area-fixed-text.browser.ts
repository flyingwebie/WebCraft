// Fixed text in the building area (BA-33), in Chromium:
// - Layers flags an element holding text clients can't edit, and the Inspector lists it;
// - in an Entry template it becomes a Field of the Post Type (the text its default), announced, one
//   Undo step;
// - in the Site template it becomes a Global (the text its Draft value); text longer than a Global
//   holds is refused, adding nothing;
// - in a Component it becomes a Prop (the text its default): the Prop and the binding are one Undo
//   step, taken back together;
// - the question follows its element: a peer's change elsewhere is kept, and text a peer changed
//   meanwhile is never replaced;
// - an attribute keeps a literal `{{` as text when it is edited;
// - Make Component turns the fixed text chosen into Props;
// - the shell with the question open passes the accessibility checks, light and dark.
// The building area's own test of `builder` 449, 482, 516, 543, `code-layers` 320, `editor-concurrency`
// 366 and 398, `component-history` 234 and Make Component's fixed text of `components-from-code`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ElementTree, TreeNode } from "@webcraft/renderer/builder";
import type { Frame, Locator, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { announced, enterBuildingArea, eventually, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
let noticeId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";
const terms = "Terms apply. ".repeat(200).trim();

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).account;
	for (const name of ["hours", "terms", "lead", "notice", "by"]) await api.designSystem.createClass({ siteId, name });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: [
			'<header><p class="hours">Open daily</p></header>',
			"<main>{{@outlet}}</main>",
			`<footer><p class="terms">${terms}</p></footer>`,
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { component } = await api.components.create({ siteId, name: "Notice" });
	noticeId = component.id;
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<aside class="notice"><p>Closed on Sundays</p></aside>',
	});
	await api.components.publish({ siteId, componentId: component.id });
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	postTypeId = postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: [
			"<article>",
			"<h1>{{ title }}</h1>",
			'<p class="lead">Fresh from the oven</p>',
			'<p class="by" title="Use \\{{ name }} &amp; more">Baked by hand.</p>',
			"<Notice />",
			"<p>Ask at the counter.</p>",
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
const inspector = (page: Page) => page.locator('[data-wc-panel-body="inspector"]');
const dialog = (page: Page) => page.locator("dialog[data-wc-fixed-text-dialog]");

/** Opens every closed row of Layers, so each row can be found by its name. */
async function openRows(page: Page): Promise<void> {
	for (let pass = 0; pass < 40; pass++) {
		const closed = tree(page).locator('[role="treeitem"][aria-expanded="false"]').first();
		if ((await closed.count()) === 0) return;
		await closed.locator("svg").first().click();
		await settled(page);
	}
}

async function says(locator: Locator, words: string): Promise<void> {
	const text = await eventually(
		async () => (await locator.textContent().catch(() => "")) ?? "",
		(seen) => seen.includes(words),
	);
	expect(text).toContain(words);
}

async function announces(page: Page, words: string): Promise<void> {
	expect(
		await eventually(
			() => announced(page),
			(seen) => seen.includes(words),
		),
	).toContain(words);
}

/** Clicks an element of the page in the frame, as a person does (the page may be drawn again just now). */
async function clickIn(page: Page, selector: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			const frame: Frame = await frameOf(page);
			const element = frame.locator(selector).first();
			await element.scrollIntoViewIfNeeded({ timeout: 5000 });
			const box = await element.boundingBox();
			if (!box) throw new Error(`${selector} isn't on the page.`);
			await page.mouse.click(box.x + Math.min(12, box.width / 2), box.y + box.height / 2);
			await settled(page);
			return;
		} catch (failure) {
			if (attempt >= 3) throw failure;
			await page.waitForTimeout(250);
		}
	}
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

/** A peer changes the Entry template's Draft tree (ids kept, as another editor's change would). */
async function peerChanges(change: (nodes: TreeNode[]) => TreeNode[]): Promise<void> {
	const { api } = await install.install.superadmin();
	const { template } = await api.templates.getEntryTemplate({ siteId, postTypeId });
	const tree = template?.draft as ElementTree;
	await api.templates.saveEntryTemplate({ siteId, postTypeId, tree: { ...tree, nodes: change(tree.nodes) } });
}

/** The article's children in a tree, changed by `change`. */
function inArticle(change: (children: TreeNode[]) => TreeNode[]) {
	return (nodes: TreeNode[]): TreeNode[] =>
		nodes.map((node) =>
			node.type === "element" && node.tag === "article" ? { ...node, children: change(node.children) } : node,
		);
}

/** Opens the question for the selected element's first piece of fixed text. */
async function ask(page: Page, button: string): Promise<Locator> {
	await inspector(page).getByRole("button", { name: button }).first().click();
	await dialog(page).waitFor();
	return dialog(page);
}

describe("fixed text becomes a value clients edit", () => {
	test("the shell with the question open passes the accessibility checks, light and dark", async () => {
		const page = await shared();
		await clickIn(page, "aside.notice p");
		await says(inspector(page).locator("[data-wc-fixed-texts]"), "“Closed on Sundays”");
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await page.mouse.move(24, 460);
			await page.waitForTimeout(1800);
			await settled(page);
			await expectAccessibleScreen(page, `fixed text in the Inspector (${theme})`);
			const question = await ask(page, "Bind to Prop");
			await expectNoAxeViolations(page, `the fixed text question (${theme})`);
			await page.keyboard.press("Escape");
			await question.waitFor({ state: "detached" });
		}
	});

	test("Layers flags it, and in an Entry template it becomes a Field of the Post Type, one Undo step", async () => {
		const page = await shared();
		await openRows(page);
		const lead = tree(page).getByRole("treeitem", { name: "p .lead Fixed text" });
		await lead.waitFor();
		expect(await lead.locator("[data-wc-fixed-text]").count()).toBe(1);
		// A heading reading the Entry's title holds no fixed text.
		expect(await tree(page).getByRole("treeitem", { name: "h1", exact: true }).count()).toBe(1);

		await clickIn(page, "p.lead");
		await says(inspector(page).locator("[data-wc-fixed-texts]"), "“Fresh from the oven”");
		const question = await ask(page, "Make it a Field");
		await says(question, "Each Entry then shows its own value for it.");
		await question.getByLabel("Label").fill("Lead");
		expect(await question.getByLabel("Key").inputValue()).toBe("lead");
		await question.getByRole("button", { name: "Make it a Field" }).click();
		await question.waitFor({ state: "detached" });
		await announces(page, "The text now reads {{ lead }}.");

		expect(await eventually(entryMarkup, (text) => text.includes('<p class="lead">{{ lead }}</p>'))).toContain(
			'<p class="lead">{{ lead }}</p>',
		);
		const { api } = await install.install.superadmin();
		const { postType } = await api.postTypes.get({ siteId, postTypeId });
		expect(postType.fields.find((field) => field.key === "lead")).toMatchObject({
			label: "Lead",
			type: "text",
			default: "Fresh from the oven",
		});
		// The row isn't flagged any more.
		await tree(page).getByRole("treeitem", { name: "p .lead", exact: true }).waitFor();

		// One Undo takes the binding back (the Field stays: a Post Type has no Draft).
		await page.getByRole("button", { name: "Undo" }).first().click();
		expect(await eventually(entryMarkup, (text) => text.includes('<p class="lead">Fresh from the oven</p>'))).toContain(
			'<p class="lead">Fresh from the oven</p>',
		);
	});

	test("in the Site template it becomes a Global in one step; text longer than a Global holds adds nothing", async () => {
		const page = await shared();
		const { api } = await install.install.superadmin();
		const before = (await api.globals.get({ siteId })).globals.fields.map((field) => field.key);

		await clickIn(page, "p.terms");
		let question = await ask(page, "Make it a Global");
		await question.getByLabel("Label").fill("Terms");
		await question.getByRole("button", { name: "Make it a Global" }).click();
		await says(question.getByRole("alert"), "2000");
		expect((await api.globals.get({ siteId })).globals.fields.map((field) => field.key)).toEqual(before);
		await page.keyboard.press("Escape");
		await question.waitFor({ state: "detached" });

		for (let attempt = 0; attempt < 3; attempt++) {
			await clickIn(page, "p.hours");
			const shown = await inspector(page).locator("[data-wc-fixed-texts]").textContent();
			if (shown?.includes("Open daily")) break;
			await page.waitForTimeout(500);
		}
		await says(inspector(page).locator("[data-wc-fixed-texts]"), "“Open daily”");
		question = await ask(page, "Make it a Global");
		await question.getByLabel("Label").fill("Hours");
		await question.getByRole("button", { name: "Make it a Global" }).click();
		const closed = await question
			.waitFor({ state: "detached", timeout: 10000 })
			.then(() => "")
			.catch(
				async () =>
					(await question
						.getByRole("alert")
						.textContent()
						.catch(() => "")) ?? "still open",
			);
		expect(closed).toBe("");
		await announces(page, "The text now reads {{ site.hours }}.");
		const { globals } = await api.globals.get({ siteId });
		expect(globals.fields.find((field) => field.key === "hours")).toMatchObject({ label: "Hours", type: "text" });
		expect(globals.draft).toMatchObject({ hours: "Open daily" });
		expect(await eventually(siteMarkup, (text) => text.includes("{{ site.hours }}"))).toContain(
			'<p class="hours">{{ site.hours }}</p>',
		);

		// One step: one Undo takes the binding back (the Global stays: Globals' fields have no Draft).
		await page.locator('[data-wc-bar="undo"]').click();
		expect(await eventually(siteMarkup, (text) => text.includes('<p class="hours">Open daily</p>'))).toContain(
			'<p class="hours">Open daily</p>',
		);
	});

	test("in a Component it becomes a Prop, the text its default; Undo takes back both in one step", async () => {
		const page = await shared();
		await clickIn(page, "aside.notice p");
		await says(inspector(page).locator("[data-wc-fixed-texts]"), "“Closed on Sundays”");
		const shownBefore = await (await frameOf(page)).locator("aside.notice p").elementHandle();
		if (!shownBefore) throw new Error("The notice isn't on the page.");
		const question = await ask(page, "Bind to Prop");
		await question.getByLabel("Label").fill("Message");
		await question.getByRole("button", { name: "Bind to Prop" }).click();
		await question.waitFor({ state: "detached" });
		await announces(page, "The text now reads {{ props.message }}.");
		// The Prop's default is the text: the page, drawn again from the changed Component, shows the same
		// words (the paragraph is a new one, so it isn't the old page still showing).
		await eventually(
			() => shownBefore.evaluate((element) => element.isConnected).catch(() => false),
			(connected) => !connected,
			{ what: "The notice drawn again" },
		);
		expect(await (await frameOf(page)).locator("aside.notice p").textContent()).toBe("Closed on Sundays");

		const { api } = await install.install.superadmin();
		const read = async () => {
			const got = await api.components.getMarkup({ siteId, componentId: noticeId });
			return { ...got, markup: { ...got.markup, draft: got.markup.draft.replace(/ data-wc-id="[^"]*"/g, "") } };
		};
		const saved = await eventually(read, (got) => got.markup.draft.includes("{{ props.message }}"));
		expect(saved.markup.draft).toContain('<aside class="notice"><p>{{ props.message }}</p></aside>');
		expect(saved.component.draft.props).toEqual([
			expect.objectContaining({ key: "message", label: "Message", type: "text", default: "Closed on Sundays" }),
		]);

		await page.locator('[data-wc-bar="undo"]').click();
		const undone = await eventually(read, (got) => got.component.draft.props.length === 0);
		expect(undone.component.draft.props).toEqual([]);
		expect(undone.markup.draft).toContain("<p>Closed on Sundays</p>");
	});

	test("the question follows its element: a peer's change elsewhere is kept; text a peer changed is never replaced", async () => {
		const page = await shared();
		await clickIn(page, "p.by");
		await says(inspector(page).locator("[data-wc-fixed-texts]"), "“Baked by hand.”");
		let question = await ask(page, "Make it a Field");
		// A peer adds an element before it meanwhile: the text is found where it is now.
		await peerChanges(
			inArticle((children) => [
				{
					type: "element",
					id: "peer1",
					tag: "p",
					attributes: [],
					classes: [],
					children: [{ type: "text", text: "Peer" }],
				},
				...children,
			]),
		);
		await eventually(entryMarkup, (text) => text.includes("<p>Peer</p>"));
		await question.getByLabel("Label").fill("Byline");
		await question.getByRole("button", { name: "Make it a Field" }).click();
		await question.waitFor({ state: "detached" });
		const markup = await eventually(entryMarkup, (text) => text.includes("{{ byline }}"));
		expect(markup).toContain("<p>Peer</p>");
		expect(markup).toMatch(/<p class="by"[^>]*>\{\{ byline \}\}<\/p>/);

		// A peer changes the text itself meanwhile: nothing is replaced and nothing is added.
		await clickIn(page, "article > p:last-of-type");
		await says(inspector(page).locator("[data-wc-fixed-texts]"), "“Ask at the counter.”");
		question = await ask(page, "Make it a Field");
		await peerChanges(
			inArticle((children) =>
				children.map((child) =>
					child.type === "element" &&
					child.children.some((each) => each.type === "text" && each.text === "Ask at the counter.")
						? { ...child, children: [{ type: "text", text: "Ask us at the counter." }] }
						: child,
				),
			),
		);
		await eventually(entryMarkup, (text) => text.includes("Ask us at the counter."));
		await question.getByLabel("Label").fill("Counter");
		await question.getByRole("button", { name: "Make it a Field" }).click();
		await says(question.getByRole("alert"), "The selected text changed.");
		await page.keyboard.press("Escape");
		await question.waitFor({ state: "detached" });
		expect(await entryMarkup()).toContain("<p>Ask us at the counter.</p>");
		const { api } = await install.install.superadmin();
		const { postType } = await api.postTypes.get({ siteId, postTypeId });
		expect(postType.fields.some((field) => field.key === "counter")).toBe(false);
	});

	test("an attribute keeps a literal {{ as text when it is edited", async () => {
		const page = await shared();
		await clickIn(page, "p.by");
		const value = inspector(page).getByLabel("Value of title");
		expect(await value.inputValue()).toBe("Use \\{{ name }} & more");
		await value.fill("Use \\{{ name }} & more!");
		await value.press("Enter");
		expect(await eventually(entryMarkup, (text) => text.includes('title="Use \\{{ name }} &amp; more!"'))).toContain(
			'title="Use \\{{ name }} &amp; more!"',
		);
	});

	test("Make Component turns the fixed text chosen into Props", async () => {
		const page = await shared();
		await clickIn(page, "article > p:last-of-type");
		await tree(page).getByRole("treeitem", { selected: true }).click({ button: "right" });
		await page
			.locator("[data-wc-row-menu]")
			.getByRole("menuitem", { name: /Make Component/ })
			.click();
		const make = page.locator("dialog[data-wc-component-dialog]");
		await make.waitFor();
		await make.getByRole("checkbox", { name: /Turn the fixed text into a Prop/ }).check();
		expect(await make.getByLabel("Prop name").inputValue()).toBe("askUsAt");
		await make.getByLabel("Name", { exact: true }).fill("CounterNote");
		await make.getByRole("button", { name: "Make" }).click();
		await make.waitFor({ state: "detached" });
		const { api } = await install.install.superadmin();
		const { components } = await eventually(
			() => api.components.list({ siteId }),
			(got) => got.components.some((each) => each.name === "CounterNote"),
		);
		const made = components.find((each) => each.name === "CounterNote");
		if (!made) throw new Error("CounterNote wasn't made.");
		const read = await api.components.getMarkup({ siteId, componentId: made.id });
		expect(read.markup.draft).toContain("{{ props.askUsAt }}");
		expect(read.component.draft.props).toEqual([
			expect.objectContaining({ key: "askUsAt", default: "Ask us at the counter." }),
		]);
	});
});
