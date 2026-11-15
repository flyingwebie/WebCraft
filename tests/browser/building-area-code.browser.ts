// The code panes in the building area (ADR 0037 › 1.7, BA-11; SPEC 5 and 5.1), in Chromium:
// - selecting an `h1` of a Component opens HTML, CSS and JS in the bottom dock: its source's Template
//   markup with its own lines marked, its chosen Class as one rule (the Inspector's chosen chip and the
//   pane's are one choice), the page script; Escape clears the selection and the panes leave;
// - typing markup previews in the frame without saving; leaving the box saves it, one Undo step; markup
//   that can't be read lists each problem with its line and column, and saves nothing;
// - saving over a version someone saved meanwhile asks: Reload theirs, or Overwrite with mine;
// - the CSS pane's media query at a 768 px frame writes `@media (width < 768px)` into the Class;
// - Format: one Undo step in the box, "Formatted · N lines changed", "Already tidy", "Can't format: …";
// - "Format when I leave the box" is kept in the person's editor preferences;
// - Run runs the scripts on a page drawn afresh; what they write and an error show in the console,
//   the error against its script and line, which opens it there;
// - with the panes open the shell passes the accessibility checks, light and dark.
// The building area's own test of `code-mode` (HTML preview, save, conflicts, problems, Run, console),
// `css-panel` (a Class's CSS, choosing a Class, the media query), the Code mode JS of
// `component-scripts`, the code keys of `editor-keyboard` and the code steps of `editor-history`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Page } from "playwright";

import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let staffBrowser: TestBrowser;
let siteId: string;
let componentId: string;
let breadId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";
const HERO = '<section class="hero"><h1 class="hero__title is-large">{{ props.headline }}</h1></section>';

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const person = await local.createStaff({ workspaces: [workspaceId], name: "Sam Staff" });
	staff = person.account;
	staffBrowser = person.browser;

	for (const name of ["site-header", "page", "hero", "lead"]) await api.designSystem.createClass({ siteId, name });
	await api.designSystem.createClass({
		siteId,
		name: "hero__title",
		styles: "font-family: serif;\nline-height: 1.05;",
	});
	await api.designSystem.createClass({ siteId, name: "is-large", styles: "font-size: 3rem;" });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: [
			'<header class="site-header"><p>Acme Bakery</p></header>',
			'<main class="page">{{@outlet}}</main>',
			"<footer><p>Harbour Street</p></footer>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { component } = await api.components.create({
		siteId,
		name: "HeroSplit",
		props: [{ key: "headline", label: "Headline", type: "text" }],
	});
	componentId = component.id;
	await api.components.saveMarkup({ siteId, componentId, markup: HERO });
	await api.components.publish({ siteId, componentId });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "subtitle", label: "Subtitle", type: "text" }],
	});
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: [
			"<article>",
			'<HeroSplit headline="Fresh from our ovens" />',
			"<h2>{{ title }}</h2>",
			'<p class="lead">{{ subtitle }}</p>',
			"</article>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: made } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven at seven" },
	});
	await api.entries.publish({ siteId, entryId: made.id });
	breadId = made.id;
	await api.scripts.saveDraft({ siteId, entryId: breadId, code: 'console.log("page script loaded");' });
	await api.scripts.saveDraft({
		siteId,
		entryId: null,
		code: "window.siteScriptRuns = (window.siteScriptRuns ?? 0) + 1;",
	});
});

let sharedPage: Promise<{ page: Page }> | undefined;

/** The one page in the building area the checks share (entering is rate-limited), at 1440 × 900. */
function shared() {
	sharedPage ??= (async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: staff, siteId, slug, open: `/page${path}` });
		await settled(page);
		await page.getByRole("tree", { name: "Elements of the page" }).getByRole("treeitem").first().waitFor();
		return { page };
	})();
	return sharedPage;
}

afterAll(async () => {
	await (await sharedPage)?.page
		.context()
		.close()
		.catch(() => {});
	await install?.close();
});

const pane = (page: Page, id: "html" | "css" | "js") => page.locator(`[data-wc-panel="${id}"]`);
const box = (page: Page, id: "html" | "css" | "js") => page.locator(`textarea[data-wc-code-box="${id}"]`);
const inspector = (page: Page) => page.locator('[data-wc-panel-body="inspector"]');

/** What `read` gives once `done` accepts it, waiting up to 10 seconds. */
async function eventually<Value>(read: () => Promise<Value>, done: (value: Value) => boolean): Promise<Value> {
	const deadline = Date.now() + 10_000;
	let value = await read();
	while (!done(value) && Date.now() < deadline) {
		await Bun.sleep(100);
		value = await read();
	}
	return value;
}

/** The Component's Draft markup now, as the admin reads it. */
async function heroMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return (await api.components.getMarkup({ siteId, componentId })).markup?.draft ?? "";
}

/** Clicks an element of the page in the frame, at its middle, as a person does. */
async function clickIn(page: Page, frame: Frame, selector: string): Promise<void> {
	for (let attempt = 0; ; attempt++) {
		try {
			const element = frame.locator(selector).first();
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

/** Selects the hero's heading and waits for the three panes to show what it is. */
async function selectHeading(page: Page): Promise<void> {
	await clickIn(page, await frameOf(page), "h1.hero__title");
	await box(page, "html").waitFor();
	await page.waitForFunction(
		() =>
			document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="html"]')?.value.includes("<h1") === true,
	);
	await box(page, "css").waitFor();
	await box(page, "js").waitFor();
}

/** Puts `text` in a pane's box as typed, all of it. */
async function typeInto(page: Page, id: "html" | "css" | "js", text: string): Promise<void> {
	const area = box(page, id);
	await area.click();
	await page.keyboard.press("ControlOrMeta+A");
	await page.keyboard.insertText(text);
}

/** Leaves a pane's box (focus to the rail's Panels button), which saves what was typed. */
async function leaveBox(page: Page): Promise<void> {
	await page.locator('[data-wc-rail="panels"]').focus();
}

describe("the code panes", () => {
	test("selecting a heading opens its markup with its lines marked, its Class's rule and the page script", async () => {
		const { page } = await shared();
		await selectHeading(page);
		// HTML: the Component's markup, the heading's own lines marked; the header names the selection.
		expect(await pane(page, "html").locator("h2").textContent()).toBe("HTML");
		expect(await pane(page, "html").locator("[data-wc-panel-header]").textContent()).toContain("h1 · Heading");
		const markup = await box(page, "html").inputValue();
		expect(markup).toMatch(/<h1 class="hero__title is-large"[^>]*>\{\{ props\.headline \}\}<\/h1>/);
		const marked = await eventually(
			() => pane(page, "html").locator("[data-wc-marked-line]").allTextContents(),
			(lines) => lines.length > 0,
		);
		expect(marked.join("\n")).toContain('<h1 class="hero__title is-large"');
		// CSS: the element's Classes as chips, the chosen one (the first) as one rule.
		expect(await pane(page, "css").locator("[data-wc-css-class]").allTextContents()).toEqual([
			".hero__title",
			".is-large",
		]);
		expect(
			await pane(page, "css")
				.locator('[data-wc-css-class="hero__title"] button[aria-pressed]')
				.getAttribute("aria-pressed"),
		).toBe("true");
		expect(await box(page, "css").inputValue()).toBe(".hero__title {\n  font-family: serif;\n  line-height: 1.05;\n}");
		// JS: the page script.
		expect(await pane(page, "js").locator('[data-wc-script-tab="page"]').getAttribute("aria-pressed")).toBe("true");
		expect(await pane(page, "js").locator("[data-wc-panel-header]").textContent()).toContain("Page script");
		expect(await box(page, "js").inputValue()).toBe('console.log("page script loaded");');
		// The three panes share the bottom dock equally.
		const widths = await Promise.all(
			(["html", "css", "js"] as const).map(async (id) => Math.round((await pane(page, id).boundingBox())?.width ?? 0)),
		);
		expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(2);
	});

	test("the Inspector's chosen Class and the CSS pane's are one choice", async () => {
		const { page } = await shared();
		await selectHeading(page);
		await pane(page, "css").locator('[data-wc-css-class="is-large"] button[aria-pressed]').click();
		await page.waitForFunction(() =>
			document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="css"]')?.value.startsWith(".is-large {"),
		);
		expect(
			await inspector(page).locator('[data-wc-class="is-large"] button[aria-pressed]').getAttribute("aria-pressed"),
		).toBe("true");
		await inspector(page).locator('[data-wc-class="hero__title"] button[aria-pressed]').click();
		await page.waitForFunction(() =>
			document
				.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="css"]')
				?.value.startsWith(".hero__title {"),
		);
	});

	test("Escape clears the selection and the panes leave", async () => {
		const { page } = await shared();
		await selectHeading(page);
		await clickIn(page, await frameOf(page), "h1.hero__title");
		await page.keyboard.press("Escape");
		await page.locator('[data-wc-outline="selected"]').waitFor({ state: "hidden" });
		for (const id of ["html", "css", "js"] as const) await pane(page, id).waitFor({ state: "detached" });
	});

	test("typing markup previews in the frame without saving; leaving the box saves it, one Undo step", async () => {
		const { page } = await shared();
		await selectHeading(page);
		const typed = (await box(page, "html").inputValue()).replace("{{ props.headline }}", "{{ props.headline }} today");
		await typeInto(page, "html", typed);
		const frame = await frameOf(page);
		// Shown on the page 350 ms after typing stops: the Draft is unchanged.
		await frame.waitForFunction(
			() => document.querySelector("h1.hero__title")?.textContent?.includes("today") === true,
		);
		expect(await heroMarkup()).not.toContain("today");
		expect(await pane(page, "html").locator("[data-format-note]").textContent()).toContain("not saved yet");

		await leaveBox(page);
		expect(await eventually(heroMarkup, (markup) => markup.includes("today"))).toContain("today");
		await (await frameOf(page)).waitForFunction(
			() => document.querySelector("h1.hero__title")?.textContent?.includes("today") === true,
		);

		// One Undo step takes it all back.
		const undo = page.locator('[data-wc-bar="undo"]');
		expect(await undo.getAttribute("aria-label")).toContain("Changed the HTML of HeroSplit");
		await undo.click();
		expect(await eventually(heroMarkup, (markup) => !markup.includes("today"))).not.toContain("today");
		await (await frameOf(page)).waitForFunction(
			() => document.querySelector("h1.hero__title")?.textContent?.includes("today") === false,
		);
		await page.waitForFunction(
			() => !document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="html"]')?.value.includes("today"),
		);
	});

	test("markup that can't be read lists each problem with its line and column, and saves nothing", async () => {
		const { page } = await shared();
		await selectHeading(page);
		const before = await box(page, "html").inputValue();
		await typeInto(page, "html", before.replace("</h1>", "</h2>"));
		const problems = pane(page, "html").locator("[data-wc-html-problems] li");
		await problems.first().waitFor();
		expect(await problems.first().textContent()).toMatch(/^Line \d+, column \d+: .+/);
		expect(await pane(page, "html").locator("[data-wc-problem-line]").count()).toBeGreaterThan(0);
		const saved = await heroMarkup();
		await leaveBox(page);
		await page.waitForTimeout(600);
		expect(await heroMarkup()).toBe(saved);
		// Choosing a problem puts the caret on its line.
		await problems.first().getByRole("button").click();
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-code-box"))).toBe("html");
		await typeInto(page, "html", before);
		await leaveBox(page);
		await pane(page, "html").locator("[data-wc-html-problems]").waitFor({ state: "detached" });
	});

	test("saving over a version someone saved meanwhile asks: Reload theirs, or Overwrite with mine", async () => {
		const { page } = await shared();
		const { api } = await install.install.superadmin();
		await selectHeading(page);
		const mine = (await box(page, "html").inputValue()).replace("{{ props.headline }}", "Mine: {{ props.headline }}");
		await typeInto(page, "html", mine);
		await api.components.saveMarkup({
			siteId,
			componentId,
			markup: HERO.replace("{{ props.headline }}", "Theirs: {{ props.headline }}"),
		});
		// Their change reaches the page (the shell's open Draft); what was typed stays in the box.
		await (await frameOf(page)).waitForFunction(
			() => document.querySelector("h1.hero__title")?.textContent?.includes("Theirs") === true,
			undefined,
			{ timeout: 10_000 },
		);
		expect(await box(page, "html").inputValue()).toContain("Mine:");
		await leaveBox(page);
		const dialog = page.getByRole("alertdialog", { name: "Someone saved a newer version" });
		await dialog.waitFor();
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-conflict-reload"))).toBe(true);
		await dialog.getByRole("button", { name: "Overwrite with mine" }).click();
		expect(await eventually(heroMarkup, (markup) => markup.includes("Mine:"))).toContain("Mine:");

		// Again, and Reload theirs drops what was typed.
		await typeInto(page, "html", (await box(page, "html").inputValue()).replace("Mine:", "Mine again:"));
		await api.components.saveMarkup({
			siteId,
			componentId,
			markup: HERO.replace("{{ props.headline }}", "Theirs again"),
		});
		await (await frameOf(page)).waitForFunction(
			() => document.querySelector("h1.hero__title")?.textContent?.includes("Theirs again") === true,
			undefined,
			{ timeout: 10_000 },
		);
		await leaveBox(page);
		await dialog.waitFor();
		await dialog.getByRole("button", { name: "Reload theirs" }).click();
		await page.waitForFunction(() =>
			document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="html"]')?.value.includes("Theirs again"),
		);
		expect(await heroMarkup()).toContain("Theirs again");
		await api.components.saveMarkup({ siteId, componentId, markup: HERO });
		await (await frameOf(page)).waitForFunction(
			() => document.querySelector("h1.hero__title")?.textContent?.includes("Theirs") === false,
			undefined,
			{ timeout: 10_000 },
		);
	});

	test("Format is one Undo step and says what it did: lines changed, already tidy, or why it can't", async () => {
		const { page } = await shared();
		await selectHeading(page);
		const js = pane(page, "js");
		await typeInto(page, "js", "const a=1;if(a){console.log(a)}");
		await js.locator("[data-format-button]").click();
		await js.locator('[data-format-note="changed"]').waitFor();
		expect(await js.locator("[data-format-note]").textContent()).toMatch(/^Formatted · \d+ lines? changed$/);
		expect(await box(page, "js").inputValue()).toBe("const a = 1;\nif (a) {\n  console.log(a);\n}");
		// The box's Undo takes Format back in one step.
		await box(page, "js").focus();
		await page.keyboard.press("ControlOrMeta+Z");
		expect(await box(page, "js").inputValue()).toBe("const a=1;if(a){console.log(a)}");
		await page.keyboard.press("ControlOrMeta+Shift+Z");
		expect(await box(page, "js").inputValue()).toBe("const a = 1;\nif (a) {\n  console.log(a);\n}");
		// ⇧⌥F with the caret in the box, on tidy code.
		await page.keyboard.press("Shift+Alt+F");
		await js.locator('[data-format-note="tidy"]').waitFor();
		expect(await js.locator("[data-format-note]").textContent()).toBe("Already tidy");
		// Broken code: nothing changes, the line is marked.
		await typeInto(page, "js", "if (a {\n}");
		await js.locator("[data-format-button]").click();
		await js.locator('[data-format-note="problem"]').waitFor();
		expect(await js.locator("[data-format-note]").textContent()).toMatch(/^Can't format: .+ on line \d+$/);
		expect(await box(page, "js").inputValue()).toBe("if (a {\n}");
		expect(await js.locator("[data-wc-problem-line]").count()).toBe(1);
		await typeInto(page, "js", 'console.log("page script loaded");');
		await leaveBox(page);
	});

	test("Format when I leave the box is kept in the person's editor preferences", async () => {
		const { page } = await shared();
		await selectHeading(page);
		await page.locator('[data-wc-panel-menu="js"]').click();
		const toggle = page.getByRole("menuitemcheckbox", { name: "Format when I leave the box" });
		await toggle.click();
		await page.keyboard.press("Escape");
		const { api } = staffBrowser;
		expect(
			await eventually(
				async () => (await api.me.editorPreferences({ siteId })).preferences.formatOnLeave,
				(on) => on,
			),
		).toBe(true);
		// Leaving the box now formats it, then saves it.
		await typeInto(page, "js", 'console.log("page script loaded")');
		await leaveBox(page);
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="js"]')?.value ===
				'console.log("page script loaded");',
		);
		await page.locator('[data-wc-panel-menu="js"]').click();
		await page.getByRole("menuitemcheckbox", { name: "Format when I leave the box" }).click();
		await page.keyboard.press("Escape");
	});

	test("the CSS pane's media query at a 768 px frame writes @media (width < 768px) into the Class", async () => {
		const { page } = await shared();
		await selectHeading(page);
		// The frame at the tablet width, from the size readout.
		const gutter = page.locator('[data-wc-gutter="end"]');
		await gutter.hover();
		await page.locator('[data-wc-preset="tablet"]').click();
		await page.waitForTimeout(400);
		expect(await (await frameOf(page)).evaluate(() => window.innerWidth)).toBe(768);

		await pane(page, "css")
			.getByRole("button", { name: /^Media query/ })
			.click();
		await page.locator('[data-wc-token-choice="At this width (768px)"]').click();
		expect(await box(page, "css").inputValue()).toContain("@media (width < 768px) {");
		// The caret is inside the new block.
		await page.waitForFunction(() => document.activeElement?.getAttribute("data-wc-code-box") === "css");
		await page.keyboard.insertText("font-size: 2rem;");
		const { api } = await install.install.superadmin();
		const css = await eventually(
			async () =>
				(await api.designSystem.get({ siteId })).designSystem.draft.classes.find((each) => each.name === "hero__title")
					?.css ?? "",
			(text) => text.includes("2rem"),
		);
		expect(css).toContain("@media (width < 768px)");
		expect(css).toContain("font-size: 2rem;");
		// The page in the frame is drawn again with it: at 768 the rule doesn't apply, under it it does.
		await page.locator('[data-wc-gutter="end"]').dblclick();
		await page.waitForTimeout(400);
	});

	test("with the panes open, the shell passes the accessibility checks in light and dark", async () => {
		const { page } = await shared();
		await selectHeading(page);
		await page.mouse.move(24, 460);
		await page.waitForTimeout(1800);
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await page.waitForTimeout(1800);
			await settled(page);
			await expectAccessibleScreen(page, `building area code panes (${theme})`);
		}
	});

	test("Run runs the scripts on a page drawn afresh; the console shows what they wrote and an error against its line", async () => {
		const { page } = await shared();
		await selectHeading(page);
		await typeInto(
			page,
			"js",
			'document.documentElement.dataset.ran = "yes";\nconsole.log("ran on a fresh page");\nnull.boom();',
		);
		await pane(page, "js").locator("[data-wc-run]").click();
		const frame = await frameOf(page);
		await frame.waitForFunction(() => document.documentElement.dataset.ran === "yes");
		expect(
			await frame.evaluate(() => (window as unknown as { siteScriptRuns?: number }).siteScriptRuns ?? 0),
		).toBeGreaterThan(0);
		const console = pane(page, "js").locator("[data-wc-console-lines]");
		await console.getByText("ran on a fresh page").waitFor();
		const error = console.locator('[data-wc-console-line="error"][data-wc-console-script="page"]');
		await error.waitFor();
		expect(await error.locator("[data-wc-console-where]").textContent()).toBe("Page script · line 3");
		// Choosing it opens the page script with the caret on line 3.
		await error.locator("[data-wc-console-where]").click();
		const caretLine = await box(page, "js").evaluate(
			(area: HTMLTextAreaElement) => area.value.slice(0, area.selectionStart).split("\n").length,
		);
		expect(caretLine).toBe(3);
		await pane(page, "js").locator("[data-wc-console-clear]").click();
		expect(await console.textContent()).toBe("Nothing written yet.");
	});
});
