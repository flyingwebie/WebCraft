// Answers that come late, and the history's 200-step limit, in Staff's editing (UI-21; what BA-33 left
// unchecked), in Chromium:
// - the tab's history keeps the last 200 steps: after 201 saves, 200 Undos and no more; Redo, then a
//   new step, ends Redo (`editor-history` 475, 521);
// - the CSS pane: what is typed while the Design system is read stays, and a read answered after a
//   newer save never replaces the saved rule (`editor-concurrency` 100, 232); a save answered after a
//   peer changed another Class keeps the peer's CSS (282); unfinished CSS survives a peer's change to
//   the element's Template (640); Undo waits for a CSS save under way;
// - the HTML pane: a source whose markup is printed late shows a peer's change made meanwhile (943);
// - a one-off style whose generated Class a peer changed is skipped by Undo, the peer's CSS kept
//   (`component-history` 330).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ElementTree, TreeNode } from "@webcraft/renderer/builder";
import type { Page, Route } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { announced, enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
let entryId: string;
let noticeId: string;
const classIds = new Map<string, string>();
const slug = "bakery";
const path = "/blog/fresh-bread";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).account;
	for (const [name, styles] of [
		["alpha", "color: rgb(200, 0, 0);"],
		["beta", "color: rgb(0, 0, 200);"],
		["peer", "font-weight: 600;"],
		["notice", ""],
	] as const)
		classIds.set(name, (await api.designSystem.createClass({ siteId, name, styles })).class.id);
	const site = await api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main>{{@outlet}}</main>" });
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { component } = await api.components.create({ siteId, name: "Notice" });
	noticeId = component.id;
	await api.components.saveMarkup({
		siteId,
		componentId: noticeId,
		markup: '<aside class="notice"><p>Original text</p></aside>',
	});
	await api.components.publish({ siteId, componentId: noticeId });
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	postTypeId = postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: [
			"<article>",
			"<h1>{{ title }}</h1>",
			'<p class="alpha">Alpha words</p>',
			'<p class="beta peer">Beta words</p>',
			"<p>Gamma words</p>",
			"<Notice />",
			"</article>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: made } = await api.entries.create({ siteId, postTypeId, title: "Fresh bread" });
	entryId = made.id;
	await api.entries.publish({ siteId, entryId });
	await api.scripts.saveDraft({ siteId, entryId, code: "// step 0" });
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

const box = (page: Page, id: "html" | "css" | "js") => page.locator(`textarea[data-wc-code-box="${id}"]`);
const undo = (page: Page) => page.locator('[data-wc-bar="undo"]');
const redo = (page: Page) => page.locator('[data-wc-bar="redo"]');
const chip = (page: Page, name: string) =>
	page.locator(`[data-wc-panel="css"] [data-wc-css-class="${name}"] button[aria-pressed]`);

async function eventually<Value>(read: () => Promise<Value>, done: (value: Value) => boolean): Promise<Value> {
	const deadline = Date.now() + 15000;
	let value = await read();
	while (!done(value) && Date.now() < deadline) {
		await Bun.sleep(100);
		value = await read();
	}
	return value;
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

/** Selects an element of the page and waits for its panes, the HTML box holding its source's markup. */
async function select(page: Page, selector: string): Promise<void> {
	await clickIn(page, selector);
	await box(page, "html").waitFor();
	await eventually(
		() => box(page, "html").inputValue(),
		(text) => text.includes("<"),
	);
}

/** Waits until a box holds what `done` wants, and answers what it holds. */
function boxHolds(page: Page, id: "html" | "css" | "js", done: (text: string) => boolean): Promise<string> {
	return eventually(() => box(page, id).inputValue(), done);
}

async function draftClass(name: string) {
	const { api } = await install.install.superadmin();
	return (await api.designSystem.get({ siteId })).designSystem.draft.classes.find(
		(each) => each.id === classIds.get(name) || each.name === name,
	);
}

async function entryMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return ((await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "").replace(
		/ data-wc-id="[^"]*"/g,
		"",
	);
}

async function pageScript(): Promise<string> {
	const { api } = await install.install.superadmin();
	return (await api.scripts.get({ siteId, entryId })).script?.draft ?? "";
}

/** Holds the answer to the next request a route matches (the request reaches the server), until released. */
async function holdAnswer(page: Page, url: string, wanted: (route: Route) => boolean = () => true) {
	const held = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const delivered = Promise.withResolvers<void>();
	let holding = true;
	await page.route(url, async (route) => {
		if (!holding || !wanted(route)) return route.continue();
		holding = false;
		const response = await route.fetch();
		held.resolve();
		await release.promise;
		await route.fulfill({ response }).catch(() => {});
		delivered.resolve();
	});
	// A request that never comes fails the check in words, not by its timeout.
	const within = (promise: Promise<void>, what: string) => {
		const raced = Promise.race([
			promise,
			Bun.sleep(15000).then(() => {
				throw new Error(`No ${what} for ${url} within 15 s.`);
			}),
		]);
		// Not every check waits for both: one never awaited isn't reported as unhandled.
		raced.catch(() => {});
		return raced;
	};
	return {
		held: within(held.promise, "request"),
		release: () => release.resolve(),
		delivered: within(delivered.promise, "answer"),
	};
}

describe("the tab's history keeps the last 200 steps", () => {
	test("after 201 saves, 200 Undos and no more; Redo, then a new step, ends Redo", async () => {
		const page = await shared();
		await select(page, "h1");
		const js = box(page, "js");
		await page.locator('[data-wc-panel="js"] [data-wc-script-tab="page"]').click();
		await boxHolds(page, "js", (text) => text === "// step 0");
		for (let step = 1; step <= 201; step++) {
			await js.fill(`// step ${step}`);
			await js.press("ControlOrMeta+s");
			await eventually(pageScript, (code) => code === `// step ${step}`);
		}
		// Each Undo takes back one save: the 200 newest, down to the first save's code.
		for (let step = 200; step >= 1; step--) {
			await undo(page).click();
			expect(await boxHolds(page, "js", (text) => text === `// step ${step}`)).toBe(`// step ${step}`);
		}
		expect(
			await eventually(
				() => undo(page).isDisabled(),
				(disabled) => disabled,
			),
		).toBe(true);
		expect(await pageScript()).toBe("// step 1");
		await redo(page).click();
		expect(await boxHolds(page, "js", (text) => text === "// step 2")).toBe("// step 2");
		// A new step ends what Redo had.
		await js.fill("// a new branch");
		await js.press("ControlOrMeta+s");
		await eventually(pageScript, (code) => code === "// a new branch");
		expect(
			await eventually(
				() => redo(page).isDisabled(),
				(disabled) => disabled,
			),
		).toBe(true);
		await undo(page).click();
		expect(await boxHolds(page, "js", (text) => text === "// step 2")).toBe("// step 2");
	}, 300_000);
});

describe("the CSS pane, with answers that come late", () => {
	test("what is typed while the Design system is read stays; a read answered after a newer save never replaces it", async () => {
		const page = await shared();
		await select(page, "p.alpha");
		await boxHolds(page, "css", (text) => text.startsWith(".alpha"));
		// No read under way (the pane would share it): the next one is held.
		await page.waitForLoadState("networkidle");
		const read = await holdAnswer(page, "**/_webcraft/build/api/rpc/designSystem/get");
		try {
			await select(page, "p.beta");
			await read.held;
			await boxHolds(page, "css", (text) => text.startsWith(".beta"));
			await box(page, "css").fill(".beta {\n  color: rgb(0, 0, 120);\n}");
			// Saved meanwhile (0.8 s after typing stops), while the older read is still on its way.
			expect(
				await eventually(
					async () => (await draftClass("beta"))?.styles ?? "",
					(styles) => styles.includes("rgb(0, 0, 120)"),
				),
			).toContain("rgb(0, 0, 120)");
			read.release();
			await read.delivered;
			await page.waitForTimeout(500);
			expect(await box(page, "css").inputValue()).toContain("rgb(0, 0, 120)");
			// Shown again from what the pane holds: the saved rule, not the older read's.
			await chip(page, "peer").click();
			await chip(page, "beta").click();
			expect(await box(page, "css").inputValue()).toContain("rgb(0, 0, 120)");
		} finally {
			read.release();
			await page.unrouteAll({ behavior: "wait" });
		}
	});

	test("a save answered after a peer changed another Class keeps the peer's CSS", async () => {
		const page = await shared();
		await select(page, "p.beta");
		await chip(page, "beta").click();
		await boxHolds(page, "css", (text) => text.startsWith(".beta"));
		const saving = await holdAnswer(page, "**/_webcraft/build/api/rpc/designSystem/updateClass");
		try {
			await box(page, "css").fill(".beta {\n  color: rgb(0, 120, 0);\n}");
			await saving.held;
			// The save is stored; before its answer comes back, a peer changes the element's other Class.
			const { api } = await install.install.superadmin();
			await api.designSystem.updateClass({
				siteId,
				classId: classIds.get("peer") ?? "",
				styles: "font-weight: 600;\ncolor: rgb(120, 0, 120);",
			});
			saving.release();
			await saving.delivered;
		} finally {
			saving.release();
			await page.unrouteAll({ behavior: "wait" });
		}
		// The other Class shows the peer's CSS, and its own save is kept.
		expect((await draftClass("beta"))?.styles).toContain("rgb(0, 120, 0)");
		expect((await draftClass("peer"))?.styles).toContain("rgb(120, 0, 120)");
		await chip(page, "peer").click();
		const shown = await boxHolds(page, "css", (text) => text.includes("rgb(120, 0, 120)"));
		expect(shown).toContain("rgb(120, 0, 120)");
		// Shown again from what the pane holds, while its next read is slow: each Class's newest CSS.
		const slow = await holdAnswer(page, "**/_webcraft/build/api/rpc/designSystem/get");
		try {
			await chip(page, "beta").click();
			expect(await box(page, "css").inputValue()).toContain("rgb(0, 120, 0)");
			await chip(page, "peer").click();
			expect(await box(page, "css").inputValue()).toContain("rgb(120, 0, 120)");
		} finally {
			slow.release();
			await page.unrouteAll({ behavior: "wait" });
		}
	});

	test("unfinished CSS survives a peer's change to the element's Template", async () => {
		const page = await shared();
		await select(page, "p.alpha");
		await boxHolds(page, "css", (text) => text.startsWith(".alpha"));
		const unfinished = ".alpha {\n  color: rgb(9, 9";
		await box(page, "css").fill(unfinished);
		// A peer gives the heading a Layer label meanwhile (the element's Template changes, ids kept).
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
		await page
			.getByRole("tree", { name: "Elements of the page" })
			.getByRole("treeitem", { name: /^Peer title/ })
			.waitFor();
		await page.waitForTimeout(500);
		expect(await box(page, "css").inputValue()).toBe(unfinished);
		await box(page, "css").fill(".alpha {\n  color: rgb(9, 9, 9);\n}");
		expect(
			await eventually(
				async () => (await draftClass("alpha"))?.styles ?? "",
				(styles) => styles.includes("rgb(9, 9, 9)"),
			),
		).toContain("rgb(9, 9, 9)");
		expect(JSON.stringify((await api.templates.getEntryTemplate({ siteId, postTypeId })).template?.draft)).toContain(
			"Peer title",
		);
	});

	test("Undo waits for a CSS save under way, and takes back that save", async () => {
		const page = await shared();
		await select(page, "p.alpha");
		await boxHolds(page, "css", (text) => text.includes("rgb(9, 9, 9)"));
		const saving = await holdAnswer(page, "**/_webcraft/build/api/rpc/designSystem/updateClass");
		try {
			await box(page, "css").fill(".alpha {\n  color: rgb(10, 10, 10);\n}");
			await saving.held;
			await undo(page).click();
			await page.waitForTimeout(300);
			// Nothing taken back yet: Undo waits for the save's answer.
			expect((await draftClass("alpha"))?.styles).toContain("rgb(10, 10, 10)");
			expect(await announced(page)).not.toContain("Undid Changed the CSS of .alpha");
			saving.release();
			// The step taken back is the save that was under way, not the one before it.
			expect(
				await eventually(
					async () => (await draftClass("alpha"))?.styles ?? "",
					(styles) => styles.includes("rgb(9, 9, 9)"),
				),
			).toContain("rgb(9, 9, 9)");
		} finally {
			saving.release();
			await page.unrouteAll({ behavior: "wait" });
		}
	});
});

describe("the HTML pane, with answers that come late", () => {
	test("a source whose markup is printed late shows a peer's change made meanwhile", async () => {
		const page = await shared();
		await select(page, "h1");
		const printing = await holdAnswer(page, "**/_webcraft/edit/api/code/editorMarkup");
		try {
			await clickIn(page, "aside.notice p");
			await printing.held;
			// A peer changes the Component while its markup is being printed (its ids kept).
			const { api } = await install.install.superadmin();
			const { markup } = await api.components.getMarkup({ siteId, componentId: noticeId });
			await api.components.saveMarkup({
				siteId,
				componentId: noticeId,
				markup: markup.draft.replace("Original text", "Remote text"),
			});
			await (await frameOf(page)).getByText("Remote text").waitFor();
			printing.release();
			await printing.delivered;
		} finally {
			printing.release();
			await page.unrouteAll({ behavior: "wait" });
		}
		expect(await boxHolds(page, "html", (text) => text.includes("Remote text"))).toContain("Remote text");
		await page.waitForTimeout(500);
		expect(await box(page, "html").inputValue()).not.toContain("Original text");
	});
});

describe("a one-off style's generated Class a peer changed", () => {
	test("Undo skips the one-off style, and the peer's CSS stays", async () => {
		const page = await shared();
		await select(page, "p.alpha");
		const html = box(page, "html");
		const before = await html.inputValue();
		const styled = before.replace(
			/<p((?: data-wc-id="[^"]*")?)>Gamma words/,
			'<p$1 style="color: rgb(5, 5, 5)">Gamma words',
		);
		expect(styled).not.toBe(before);
		await html.fill(styled);
		await page.locator('[data-wc-rail="panels"]').focus();
		const saved = await eventually(entryMarkup, (text) => /<p class="style-[0-9a-f]{8}">Gamma words/.test(text));
		expect(saved).toMatch(/<p class="style-[0-9a-f]{8}">Gamma words/);
		const name = /<p class="(style-[0-9a-f]{8})">Gamma words/.exec(saved)?.[1] ?? "";
		const generated = await draftClass(name);
		if (!generated) throw new Error("No generated Class.");
		const { api } = await install.install.superadmin();
		await api.designSystem.updateClass({ siteId, classId: generated.id, styles: "color: rgb(6, 6, 6);" });
		await undo(page).click();
		expect(
			await eventually(
				() => announced(page),
				(seen) => seen.includes("Skipped"),
			),
		).toContain("Skipped");
		expect((await draftClass(name))?.styles).toContain("rgb(6, 6, 6)");
		expect(await entryMarkup()).toContain(`<p class="${name}">Gamma words</p>`);
	});
});
