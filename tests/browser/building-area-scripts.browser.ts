// The Site's own scripts in the building area's frame (ADR 0022, ADR 0037; BA-32), in Chromium:
// - a Site script that fails: a notice over the canvas names it and says what it threw; Open in Safe
//   mode shows the page again with none of the Site's own scripts, and the bar says Safe mode with Turn
//   off, which brings them back (and the notice). For Staff, and for a Member in client editing's words;
// - Component scripts run in the frame, once per Placement, also for a Placement added later (one
//   duplicated in Layers, BA-09; a Component placed from the insert row's menu, BA-10, and a section a
//   Member adds, BA-17, each of a Component the page never loaded);
//   a call that fails shows its notice, naming the Component;
// - the JS pane's Component tab (BA-11): chosen for a Placement selected, its "on N pages" warning, ⌘S
//   saving it, Run running the new code on each Placement once, a failing call in the console against
//   its Component with its Placement a click away;
// - ⌘S in the HTML, CSS and JS panes saves, and what it saved is what the Draft holds; Tab leaves a box;
// - Undo waits for a Component script's save before it takes a step back;
// - the Component tab's Consent category and Libraries (BA-36): each saved with the script, one Undo
//   step with what was typed, read back after the shell loads again; ⌘] and ⌘[ in the code boxes;
// - the shell passes the accessibility checks with the notice and with Safe mode on, light and dark.
// The building area's counterpart of `site-scripts.browser.ts` 192 (a failing Site script, Safe mode),
// `component-scripts.browser.ts` 173, 219, 243 and 289 (Edit mode and Code mode's JS panel; 219's
// Consent category and Libraries and 243's "and its category" in BA-36's check),
// `editor-keyboard.browser.ts` 444 (Component JS keys and saved text; its ⌘] and ⌘[ in BA-36's) and
// `editor-history.browser.ts` 293 (Undo waits for a Component script).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiClient } from "@webcraft/api";
import type { Frame, Page } from "playwright";

import { fakeNpmPackage } from "../harness/fake-npm.ts";
import type { TestAccount } from "../harness/index.ts";
import { announced, enterBuildingArea, eventually, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, forgetPageErrors, startBrowserInstall } from "./harness.ts";

/**
 * The accessibility checks, once the size readout a previous keyboard walk opened (focus on a gutter)
 * has left: its controls would count as stops while they are going.
 */
async function accessible(page: Page, where: string): Promise<void> {
	await page.waitForTimeout(1800);
	await expectAccessibleScreen(page, where);
}

let install: BrowserInstall;
let api: ApiClient;
let staff: TestAccount;
let member: TestAccount;
let siteId: string;
let counterId: string;
let quoteId: string;
let heroId: string;
let pagesId: string;
let postTypeId: string;
const slug = "bakery";

/** The Counter's script: counts its calls on each Placement root; the one labelled Broken throws. */
const COUNTER = `export default function (root) {
	root.dataset.calls = String(Number(root.dataset.calls || 0) + 1);
	if (root.dataset.label === "Broken") throw new Error("Counter broke");
}
`;

/** The Site script: it runs everywhere, and fails on Fresh bread's page (a function no Library gave). */
const SITE_SCRIPT =
	'document.documentElement.dataset.siteScript = "ran";\nif (location.pathname === "/blog/fresh-bread") startSlider();';

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	({ api } = await local.superadmin());
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Ciara Byrne" })).account;
	member = (await local.createMember({ workspaceId, role: "editor", name: "Giulia Romano" })).account;

	await api.designSystem.createClass({ siteId, name: "post-title", styles: "font-size: 2rem;" });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>Acme Bakery</p></header><main>{{@outlet}}</main><footer><p>Open daily.</p></footer>",
	});
	await api.templates.publish({ siteId, templateId: site.template.id });

	const made = async (name: string, markup: string, code: string | null, props?: unknown) => {
		const { component } = await api.components.create({ siteId, name, ...(props ? { props: props as never } : {}) });
		await api.components.saveMarkup({ siteId, componentId: component.id, markup });
		if (code) await api.components.saveScriptDraft({ siteId, componentId: component.id, code });
		await api.components.publish({ siteId, componentId: component.id });
		return component;
	};
	counterId = (
		await made("Counter", "{{@props}}\nlabel: text exposed\n{{/props}}\n<div><p>{{ props.label }}</p></div>", COUNTER)
	).id;
	const hero = await made("Hero", "<section><h2>{{ props.heading }}</h2></section>", null, [
		{ key: "heading", label: "Heading", type: "text", translatable: true },
	]);
	heroId = hero.id;
	quoteId = (
		await made(
			"Quote",
			"<section><blockquote>{{ props.quote }}</blockquote></section>",
			"export default (root) => { root.dataset.quoted = String(Number(root.dataset.quoted || 0) + 1); };",
			[{ key: "quote", label: "Quote", type: "text", default: "Best bread in Cork." }],
		)
	).id;

	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	postTypeId = postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup:
			'<article><h1 class="post-title">{{ title }}</h1><Counter label="One" /><Counter label="Broken" /><Counter label="Three" /></article>',
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	for (const [title, entrySlug] of [
		["Fresh bread", "fresh-bread"],
		["Rye", "rye"],
	] as const) {
		const { entry: post } = await api.entries.create({ siteId, postTypeId, title, slug: entrySlug });
		await api.entries.publish({ siteId, entryId: post.id });
	}
	const { script } = await api.scripts.saveDraft({ siteId, entryId: null, code: SITE_SCRIPT });
	await api.scripts.publish({ siteId, scriptId: script.id });

	// A Page with two Hero sections (no script), where Members may add the Quote (which has one).
	pagesId = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id ?? "";
	await api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [heroId, quoteId] });
	const { entry: sections } = await api.entries.create({
		siteId,
		postTypeId: pagesId,
		title: "Our story",
		slug: "story",
	});
	const state = await api.pageLayouts.get({ siteId, entryId: sections.id });
	await api.pageLayouts.save({
		siteId,
		entryId: sections.id,
		basedOn: state.version,
		layout: {
			placements: ["north", "south"].map((id) => ({
				id,
				component: heroId,
				props: hero.draft.props,
				values: { heading: { en: id === "north" ? "North" : "South" } } as never,
			})),
		},
	});
	await api.entries.publish({ siteId, entryId: sections.id });
	// An empty Page, where Staff place a Component from the insert row's menu (BA-10).
	const { entry: visit } = await api.entries.create({ siteId, postTypeId: pagesId, title: "Visit us", slug: "visit" });
	await api.entries.publish({ siteId, entryId: visit.id });
});

afterAll(async () => {
	for (const shared of [staffPage, memberPage]) {
		await (await shared)
			?.context()
			.close()
			.catch(() => {});
	}
	await install?.close();
});

let staffPage: Promise<Page> | undefined;
let memberPage: Promise<Page> | undefined;

/** The one page each person has in the building area (entering is rate-limited), at 1440 × 900. */
function shared(as: "staff" | "member"): Promise<Page> {
	const make = async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await recordMessages(page);
		try {
			await enterBuildingArea(install, page, {
				as: as === "staff" ? staff : member,
				siteId,
				slug,
				open: "/page/blog/fresh-bread",
			});
		} catch (failure) {
			const text = await page
				.locator("body")
				.textContent()
				.catch(() => "");
			throw new Error(`Entering as ${as} failed at ${page.url()}: ${(text ?? "").slice(0, 400)}`, { cause: failure });
		}
		await settled(page);
		return page;
	};
	if (as === "staff") {
		staffPage ??= make();
		return staffPage;
	}
	memberPage ??= make();
	return memberPage;
}

/** Shows another page of the Site in the shell (the session's cookies are there already). */
async function open(page: Page, path: string): Promise<Frame> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build/page${path}`));
	for (let attempt = 0; attempt < 100; attempt++) {
		const frame = await frameOf(page);
		if (new URL(frame.url()).pathname === path) return frame;
		await page.waitForTimeout(50);
	}
	throw new Error(`The frame never showed ${path}.`);
}

/** The frame once it shows a page again (Safe mode switched loads it afresh). */
async function reloaded(page: Page, safe: boolean): Promise<Frame> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const frame = await frameOf(page);
		const on = await frame
			.evaluate(
				() =>
					document.readyState !== "loading" &&
					document.querySelector('meta[name="webcraft-safe-mode"]')?.getAttribute("content") === "on",
			)
			.catch(() => null);
		if (on === safe) return frame;
		await page.waitForTimeout(50);
	}
	throw new Error(`The page never showed with Safe mode ${safe ? "on" : "off"}.`);
}

/** Puts the caret at the end of the JS box (the End keys differ between systems). */
async function toEnd(page: Page): Promise<void> {
	await box(page, "js").evaluate((area: HTMLTextAreaElement) =>
		area.setSelectionRange(area.value.length, area.value.length),
	);
}

/** Turns Safe mode off when a check left it on, so the next checks see the Site's scripts run. */
async function leaveSafeMode(page: Page): Promise<void> {
	const control = page.locator("[data-wc-safe-mode]");
	if ((await control.count()) === 0) return;
	await control.getByRole("button", { name: "Turn off Safe mode" }).click();
	await reloaded(page, false);
}

/** What each Counter's root says about its calls, in the page's order. */
async function counters(frame: Frame): Promise<string[]> {
	return frame.$$eval("main [data-wc-component][data-label]", (roots) =>
		roots.map((root) => `${(root as HTMLElement).dataset.label}: ${(root as HTMLElement).dataset.calls ?? 0}`),
	);
}

/** The failing scripts' own errors are what this file sets up: the accessibility checks leave them out. */
function forgetScriptErrors(page: Page): void {
	forgetPageErrors(page, 0, (error) => /startSlider|Counter broke/.test(error));
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

const pane = (page: Page, id: "html" | "css" | "js") => page.locator(`[data-wc-panel="${id}"]`);
const box = (page: Page, id: "html" | "css" | "js") => page.locator(`textarea[data-wc-code-box="${id}"]`);
const notice = (page: Page) => page.getByRole("alert", { name: "A script failed" });

/** The Counter's script as its Draft holds it now. */
async function counterDraft(): Promise<string> {
	return (await api.components.getScript({ siteId, componentId: counterId })).script?.draft.code ?? "";
}

/** The Counter script's Draft: its code, Consent category and Libraries (by name, in the Site's order). */
async function counterScript(): Promise<{ code: string; consent: string; libraries: string[] }> {
	const { script } = await api.components.getScript({ siteId, componentId: counterId });
	const { libraries } = await api.libraries.list({ siteId });
	const ids = script?.draft.libraryIds ?? [];
	return {
		code: script?.draft.code ?? "",
		consent: script?.draft.consentCategory ?? "",
		libraries: libraries.filter((library) => ids.includes(library.id)).map((library) => library.name),
	};
}

/** The Counter's script as the fixture has it: its code, Necessary, no Libraries. */
async function resetCounter(): Promise<void> {
	await api.components.saveScriptDraft({
		siteId,
		componentId: counterId,
		code: COUNTER,
		consentCategory: "necessary",
		libraryIds: [],
	});
}

/**
 * Keeps every message the shell's live region says, in each document the page loads: a later message
 * (the page announced as it loads again) can replace one before a check reads it.
 */
async function recordMessages(page: Page): Promise<void> {
	await page.addInitScript(() => {
		const kept: string[] = [];
		(window as unknown as { wcSaid: string[] }).wcSaid = kept;
		new MutationObserver(() => {
			const text = document.querySelector("[data-wc-messages]")?.textContent ?? "";
			if (text && kept.at(-1) !== text) kept.push(text);
		}).observe(document, { subtree: true, childList: true, characterData: true });
	});
}

/** Waits until the shell's live region has said `text` (in the document shown now). */
async function said(page: Page, text: string): Promise<void> {
	await page.waitForFunction(
		(wanted) =>
			((window as unknown as { wcSaid?: string[] }).wcSaid ?? []).some((each) => each.includes(wanted)) ||
			(document.querySelector("[data-wc-messages]")?.textContent ?? "").includes(wanted),
		text,
	);
}

/** Selects the Placement labelled `label` and shows its Component tab in the JS pane. */
async function componentTab(page: Page, label: string): Promise<void> {
	await clickIn(page, await frameOf(page), `main [data-label='${label}'] > p`);
	const tab = pane(page, "js").locator('[data-wc-script-tab="component"]');
	await tab.waitFor();
	await tab.click();
	await pane(page, "js").locator('[data-wc-script="component"]').waitFor();
	await box(page, "js").and(page.locator(":not([readonly])")).waitFor();
}

describe("Staff", () => {
	test("a failing Site script: the notice names it; Safe mode opens from it, and the bar turns it off", async () => {
		const page = await shared("staff");
		try {
			await failingSiteScript(page);
		} finally {
			await leaveSafeMode(page);
		}
	});

	async function failingSiteScript(page: Page): Promise<void> {
		let frame = await frameOf(page);
		await frame.waitForFunction(() => document.documentElement.dataset.siteScript === "ran");
		const shown = notice(page);
		await shown.waitFor();
		expect(await shown.locator("strong").textContent()).toBe("The Site script failed.");
		expect(await shown.textContent()).toContain("startSlider is not defined (line 2)");
		// The Counter that throws failed too: the notice counts it.
		await shown.getByText("Other scripts failed too: 1.").waitFor();
		forgetScriptErrors(page);
		await accessible(page, "a failing Site script's notice, light");
		await page.emulateMedia({ colorScheme: "dark" });
		await expectNoAxeViolations(page, "a failing Site script's notice, dark");
		await page.emulateMedia({ colorScheme: "light" });

		await shown.getByRole("button", { name: "Open in Safe mode" }).click();
		const control = page.locator("[data-wc-safe-mode]");
		await control.waitFor();
		frame = await reloaded(page, true);
		await said(page, "Safe mode is on: the page runs none of the Site's own scripts.");
		// None of the Site's own scripts ran: no Site script, no Component script.
		await frame.locator("main h1").waitFor();
		expect(await frame.evaluate(() => document.documentElement.dataset.siteScript ?? null)).toBeNull();
		expect(await frame.locator("script[data-wc-script], script[data-wc-component-script]").count()).toBe(0);
		expect(await frame.locator("[data-calls]").count()).toBe(0);
		expect(await notice(page).count()).toBe(0);
		// The agent still makes the page editable.
		await frame.locator("h1[contenteditable]").waitFor();
		expect(await control.textContent()).toContain("Safe mode");
		forgetScriptErrors(page);
		await accessible(page, "Safe mode on the bar, light");
		await page.emulateMedia({ colorScheme: "dark" });
		await accessible(page, "Safe mode on the bar, dark");
		await page.emulateMedia({ colorScheme: "light" });

		// Turn off, on the bar: the Site's scripts run again, and the notice is back.
		await control.getByRole("button", { name: "Turn off Safe mode" }).click();
		frame = await reloaded(page, false);
		await frame.waitForFunction(() => document.documentElement.dataset.siteScript === "ran");
		await notice(page).locator("strong").filter({ hasText: "The Site script failed." }).waitFor();
		expect(await control.count()).toBe(0);
		// Dismiss puts it away until the page loads again; focus goes into the page.
		await notice(page).getByRole("button", { name: "Dismiss" }).click();
		expect(await notice(page).count()).toBe(0);
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-frame") ?? false)).toBe(true);
		forgetScriptErrors(page);
	}

	test("Component scripts run once per Placement, also for one added later; a failing call shows its notice", async () => {
		const page = await shared("staff");
		// Rye's page: the Site script runs there without failing, so the Counter's call is the first failure.
		const frame = await open(page, "/blog/rye");
		await frame.waitForFunction(() => document.querySelectorAll("main [data-calls]").length === 3);
		expect(await counters(frame)).toEqual(["One: 1", "Broken: 1", "Three: 1"]);
		const shown = notice(page);
		await shown.locator("strong").filter({ hasText: "The Component script of Counter failed." }).waitFor();
		expect(await shown.textContent()).toContain("Counter broke");
		expect(await shown.getByText(/Other scripts failed/).count()).toBe(0);
		forgetScriptErrors(page);
		await expectNoAxeViolations(page, "a failing Component script's notice, light");
		await page.emulateMedia({ colorScheme: "dark" });
		await expectNoAxeViolations(page, "a failing Component script's notice, dark");
		await page.emulateMedia({ colorScheme: "light" });

		// A Placement duplicated in Layers (BA-09): the page is drawn again with it, and it gets its call.
		// Selecting inside it opens the tree towards it: the Placements' rows show.
		await clickIn(page, frame, "main [data-label='Three'] > p");
		const tree = page.getByRole("tree", { name: "Elements of the page" });
		const three = tree.getByRole("treeitem", { name: /^Counter/ }).nth(2);
		await three.click();
		await page.keyboard.press("ControlOrMeta+d");
		await frame.waitForFunction(() => document.querySelectorAll("main [data-wc-component][data-label]").length === 4);
		await frame.waitForFunction(() => document.querySelectorAll("main [data-calls]").length === 4);
		expect(await counters(frame)).toEqual(["One: 1", "Broken: 1", "Three: 1", "Three: 1"]);
		const markup = (await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "";
		expect(markup.match(/<Counter /g)?.length).toBe(4);
		// Taken back: three again, each called once on the page drawn again.
		await page.locator('[data-wc-bar="undo"]').click();
		await frame.waitForFunction(() => document.querySelectorAll("main [data-wc-component][data-label]").length === 3);
		await frame.waitForFunction(() => document.querySelectorAll("main [data-calls]").length === 3);
		expect(await counters(frame)).toEqual(["One: 1", "Broken: 1", "Three: 1"]);
		forgetScriptErrors(page);
	});

	test("a Component placed from the insert row's menu runs its script, which the page hadn't loaded", async () => {
		const page = await shared("staff");
		const frame = await open(page, "/visit");
		const empty = page.locator("[data-wc-empty-page]");
		await empty.getByRole("button", { name: "Add a Component" }).waitFor();
		expect(await frame.locator("script[data-wc-component-script]").count()).toBe(0);
		await empty.getByRole("button", { name: "Add a Component" }).click();
		const menu = page.locator("dialog[data-wc-command-menu]");
		await menu.getByRole("option", { name: /^Quote/ }).click();
		await frame.locator("blockquote").filter({ hasText: "Best bread in Cork." }).waitFor();
		// Its script arrives and is called once on the new Placement.
		await frame.waitForFunction(() => document.querySelector<HTMLElement>("[data-quoted]")?.dataset.quoted === "1");
		expect(await frame.locator("script[data-wc-component-script]").count()).toBe(1);
		expect(await notice(page).count()).toBe(0);
	});

	test("the JS pane's Component tab: chosen for a Placement, its warning, ⌘S saving it, Run, a failing call", async () => {
		await api.components.saveScriptDraft({ siteId, componentId: counterId, code: COUNTER });
		const page = await shared("staff");
		await open(page, "/blog/rye");
		// Before anything inside a Placement is selected, there is no Component tab.
		await clickIn(page, await frameOf(page), "main h1");
		await pane(page, "js").locator("[data-wc-script-tab]").first().waitFor();
		expect(await pane(page, "js").locator('[data-wc-script-tab="component"]').count()).toBe(0);

		await componentTab(page, "One");
		expect(await box(page, "js").inputValue()).toBe(COUNTER);
		expect(
			await pane(page, "js").getByText("Counter is on 2 pages: changing its script changes all of them.").count(),
		).toBe(1);
		expect(await box(page, "js").getAttribute("aria-label")).toBe("Component script");
		forgetScriptErrors(page);
		await expectNoAxeViolations(page, "the JS pane's Component tab, light");
		await page.emulateMedia({ colorScheme: "dark" });
		await expectNoAxeViolations(page, "the JS pane's Component tab, dark");
		await page.emulateMedia({ colorScheme: "light" });

		// ⌘S saves at once: the Draft holds exactly what the box shows, and it is said.
		const typed = `${COUNTER}// saved from the keyboard\n`;
		await box(page, "js").click();
		await toEnd(page);
		await page.keyboard.insertText("// saved from the keyboard\n");
		await page.keyboard.press("ControlOrMeta+s");
		await said(page, "Saved the Component script to the Draft.");
		expect(await counterDraft()).toBe(typed);
		expect(await box(page, "js").inputValue()).toBe(typed);
		// Tab leaves the box (no trap); Shift+Tab too.
		await page.keyboard.press("Tab");
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-code-box") ?? null)).toBeNull();
		await box(page, "js").focus();
		await page.keyboard.press("Shift+Tab");
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-code-box") ?? null)).toBeNull();

		// Run: the page drawn afresh, the new code called once on each Placement; the failing call is in
		// the console against its Component.
		await pane(page, "js").locator("[data-wc-console-clear]").click();
		await pane(page, "js").locator("[data-wc-run]").click();
		const frame = await frameOf(page);
		const line = pane(page, "js").locator("[data-wc-console-component]");
		await line.first().waitFor();
		expect(await line.first().textContent()).toContain("Counter failed on a Placement: Counter broke");
		await frame.waitForFunction(() => {
			const roots = [...document.querySelectorAll<HTMLElement>("main [data-wc-component][data-label]")];
			return roots.length === 3 && roots.every((root) => root.dataset.calls === "1");
		});
		// The new code ran: its file is the Draft's.
		expect(
			await frame.evaluate(() => document.querySelectorAll("script[data-wc-component-script][data-wc-run]").length),
		).toBe(1);
		forgetScriptErrors(page);
		await expectNoAxeViolations(page, "the console with a failing Component script");
		// Its Placement a click away: Broken's is selected on the page.
		await line.first().getByRole("button", { name: "Show the Placement" }).click();
		await page.locator('[data-wc-outline="selected"]').waitFor();
		const selected = await frame.evaluate(() => {
			const ref = new URL(window.parent.location.href).searchParams.get("wc-select");
			return ref
				? document
						.querySelector(`[data-wc-code="${CSS.escape(ref)}"]`)
						?.closest("[data-label]")
						?.getAttribute("data-label")
				: null;
		});
		expect(selected).toBe("Broken");
		await api.components.saveScriptDraft({ siteId, componentId: counterId, code: COUNTER });
	});

	test("⌘S in the HTML and CSS panes saves, and the Draft holds what it saved", async () => {
		const page = await shared("staff");
		await open(page, "/blog/rye");
		await clickIn(page, await frameOf(page), "main h1");
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="html"]')?.value.includes("<h1") ===
				true,
		);
		// HTML: saved only on leaving the box or ⌘S.
		const markup = (await box(page, "html").inputValue()).replace("{{ title }}</h1>", "{{ title }}, baked today</h1>");
		await box(page, "html").click();
		await page.keyboard.press("ControlOrMeta+A");
		await page.keyboard.insertText(markup);
		await page.keyboard.press("ControlOrMeta+s");
		const saved = await eventually(
			async () => (await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "",
			(text) => text.includes("baked today"),
		);
		expect(saved).toContain("{{ title }}, baked today</h1>");
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-code-box"))).toBe("html");
		await (await frameOf(page)).locator("main h1").filter({ hasText: "Rye, baked today" }).waitFor();

		// CSS: the chosen Class's rule.
		await box(page, "css").waitFor();
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="css"]')?.value.includes("2rem") ===
				true,
		);
		const rule = (await box(page, "css").inputValue()).replace("2rem", "2.5rem");
		await box(page, "css").click();
		await page.keyboard.press("ControlOrMeta+A");
		await page.keyboard.insertText(rule);
		await page.keyboard.press("ControlOrMeta+s");
		const styles = await eventually(
			async () =>
				(await api.designSystem.get({ siteId })).designSystem.draft.classes.find((each) => each.name === "post-title")
					?.styles ?? "",
			(text) => text.includes("2.5rem"),
		);
		expect(styles).toContain("font-size: 2.5rem;");
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-code-box"))).toBe("css");
	});

	test("Undo waits for a Component script's save before it takes a step back", async () => {
		await api.components.saveScriptDraft({ siteId, componentId: counterId, code: COUNTER });
		const page = await shared("staff");
		await open(page, "/blog/rye");
		await componentTab(page, "Three");
		// One saved step first.
		const first = `${COUNTER}// first\n`;
		await box(page, "js").click();
		await toEnd(page);
		await page.keyboard.insertText("// first\n");
		await page.keyboard.press("ControlOrMeta+s");
		await said(page, "Saved the Component script to the Draft.");
		expect(await counterDraft()).toBe(first);

		// The next save is held on its way; Undo is pressed while it is.
		const held = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		await page.route("**/_webcraft/edit/api/code/saveScript", async (route) => {
			held.resolve();
			await release.promise;
			await route.continue();
		});
		try {
			await box(page, "js").click();
			await toEnd(page);
			await page.keyboard.insertText("// second\n");
			await page.locator('[data-wc-bar="undo"]').click();
			await held.promise;
			await page.waitForTimeout(300);
			// Nothing was taken back yet: Undo waits for the save.
			expect(await counterDraft()).toBe(first);
			expect(await announced(page)).not.toContain("Undid");
			release.resolve();
			await said(page, "Undid Changed the Component script of Counter");
			// The step taken back is the save that was under way, not the one before it.
			expect(await eventually(counterDraft, (code) => code === first)).toBe(first);
			await page.waitForFunction(
				(wanted) => document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="js"]')?.value === wanted,
				first,
			);
		} finally {
			release.resolve();
			await page.unrouteAll({ behavior: "wait" });
		}
		await api.components.saveScriptDraft({ siteId, componentId: counterId, code: COUNTER });
	});

	test("saving the Component script over a version someone saved meanwhile asks: Reload theirs, or Overwrite with mine", async () => {
		await resetCounter();
		const page = await shared("staff");
		await open(page, "/blog/rye");
		await componentTab(page, "Three");
		expect(await box(page, "js").inputValue()).toBe(COUNTER);
		// Someone else saves the Component's script after the box was read.
		await api.components.saveScriptDraft({ siteId, componentId: counterId, code: `${COUNTER}// theirs\n` });
		await box(page, "js").click();
		await toEnd(page);
		await page.keyboard.insertText("// mine\n");
		await page.keyboard.press("ControlOrMeta+s");
		const dialog = page.getByRole("alertdialog", { name: "Someone saved a newer version" });
		await dialog.waitFor();
		expect(await dialog.textContent()).toContain("Component script");
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-conflict-reload"))).toBe(true);
		// Their version is still the Draft while the question is asked.
		expect(await counterDraft()).toBe(`${COUNTER}// theirs\n`);
		forgetScriptErrors(page);
		// Under the modal question the inert panels read as unreachable scrolling regions (as BA-34 found).
		await expectNoAxeViolations(page, "the JS pane's conflict question", ["scrollable-region-focusable"]);
		await dialog.getByRole("button", { name: "Overwrite with mine" }).click();
		expect(await eventually(counterDraft, (code) => code === `${COUNTER}// mine\n`)).toBe(`${COUNTER}// mine\n`);

		// Again, and Reload theirs drops what was typed and shows theirs.
		await api.components.saveScriptDraft({ siteId, componentId: counterId, code: `${COUNTER}// theirs again\n` });
		await box(page, "js").click();
		await toEnd(page);
		await page.keyboard.insertText("// mine again\n");
		await page.keyboard.press("ControlOrMeta+s");
		await dialog.waitFor();
		await dialog.getByRole("button", { name: "Reload theirs" }).click();
		await page.waitForFunction(
			(wanted) => document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="js"]')?.value === wanted,
			`${COUNTER}// theirs again\n`,
		);
		expect(await counterDraft()).toBe(`${COUNTER}// theirs again\n`);
		await resetCounter();
	});

	test("a Component script's Consent category and Libraries: saved with it, one Undo step, read back (BA-36)", async () => {
		await resetCounter();
		const page = await shared("staff");
		await open(page, "/blog/rye");
		await componentTab(page, "One");
		const row = pane(page, "js").getByRole("group", { name: "The Component script's settings" });
		const consent = row.getByRole("combobox", { name: "Consent category" });
		const libraries = row.getByRole("button", { name: /^Libraries it needs/ });
		expect(await consent.inputValue()).toBe("necessary");
		expect(await consent.locator("option").allTextContents()).toEqual(["Necessary", "Analytics", "Marketing", "Media"]);
		// Its help is the select's description, and shows on focus.
		const help =
			"Outside Necessary, visitors' pages hold it back until they accept this category in the Consent banner.";
		expect(
			await consent.evaluate((select) =>
				(select.getAttribute("aria-describedby") ?? "")
					.split(" ")
					.map((id) => document.getElementById(id)?.textContent)
					.join(" "),
			),
		).toBe(help);
		await consent.focus();
		await row.locator("[data-wc-tip]").filter({ hasText: help }).waitFor();
		// A Site without Libraries says where to add them.
		expect(await libraries.textContent()).toBe("None");
		await libraries.focus();
		await page.keyboard.press("Enter");
		const menu = page.getByRole("menu", { name: "Libraries it needs" });
		await menu
			.getByRole("menuitem", { name: "The Site has no Libraries: add them in Site › Libraries.", disabled: true })
			.waitFor();
		await page.keyboard.press("Escape");
		await menu.waitFor({ state: "detached" });
		expect(await libraries.evaluate((button) => button === document.activeElement)).toBe(true);

		// Two Libraries on the Site: the shell loads again and the menu lists them.
		for (const name of ["motion-kit", "swipe-kit"]) {
			fakeNpmPackage(install.install, name, {
				"1.0.0": {
					files: { "dist/kit.min.js": `window["${name}"] = {};` },
					license: "MIT",
					jsdelivr: "dist/kit.min.js",
				},
			});
			await api.libraries.add({ siteId, library: { source: "npm", packageName: name, version: "1.0.0" } });
		}
		await open(page, "/blog/rye");
		await componentTab(page, "One");

		// The Consent category saves at once, as one Undo step.
		await consent.selectOption("analytics");
		expect((await eventually(counterScript, (now) => now.consent === "analytics")).consent).toBe("analytics");
		await page.locator('[data-wc-bar="undo"]').click();
		await said(page, "Undid Changed the Component script of Counter");
		expect((await eventually(counterScript, (now) => now.consent === "necessary")).consent).toBe("necessary");
		await page.waitForFunction(
			() => document.querySelector<HTMLSelectElement>("[data-wc-script-consent]")?.value === "necessary",
		);

		// The Libraries, ticked from the keyboard: the menu stays open; each saves at once.
		await libraries.focus();
		await page.keyboard.press("ArrowDown");
		await menu.waitFor();
		const motion = menu.getByRole("menuitemcheckbox", { name: "motion-kit" });
		expect(await motion.evaluate((item) => item === document.activeElement)).toBe(true);
		await page.keyboard.press("Enter");
		await menu.getByRole("menuitemcheckbox", { name: "motion-kit", checked: true }).waitFor();
		expect((await eventually(counterScript, (now) => now.libraries.length === 1)).libraries).toEqual(["motion-kit"]);
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press(" ");
		await menu.getByRole("menuitemcheckbox", { name: "swipe-kit", checked: true }).waitFor();
		expect((await eventually(counterScript, (now) => now.libraries.length === 2)).libraries).toEqual([
			"motion-kit",
			"swipe-kit",
		]);
		forgetScriptErrors(page);
		await expectNoAxeViolations(page, "the Component tab's Libraries menu, light");
		await page.emulateMedia({ colorScheme: "dark" });
		await expectNoAxeViolations(page, "the Component tab's Libraries menu, dark");
		await page.emulateMedia({ colorScheme: "light" });
		// Unticking one.
		await page.keyboard.press("Enter");
		await menu.getByRole("menuitemcheckbox", { name: "swipe-kit", checked: false }).waitFor();
		expect((await eventually(counterScript, (now) => now.libraries.length === 1)).libraries).toEqual(["motion-kit"]);
		await page.keyboard.press("Escape");
		expect(await libraries.textContent()).toBe("motion-kit");

		// What is typed and a category chosen before it saved go together: one save, one Undo step.
		const typed = `${COUNTER}// with its category\n`;
		await box(page, "js").click();
		await toEnd(page);
		await page.keyboard.insertText("// with its category\n");
		await consent.selectOption("marketing");
		const both = await eventually(counterScript, (now) => now.consent === "marketing" && now.code === typed);
		expect(both).toEqual({ code: typed, consent: "marketing", libraries: ["motion-kit"] });
		await page.locator('[data-wc-bar="undo"]').click();
		const undone = await eventually(counterScript, (now) => now.consent === "necessary");
		expect(undone).toEqual({ code: COUNTER, consent: "necessary", libraries: ["motion-kit"] });
		await page.waitForFunction(
			(wanted) => document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="js"]')?.value === wanted,
			COUNTER,
		);
		expect(await consent.inputValue()).toBe("necessary");
		await page.locator('[data-wc-bar="redo"]').click();
		expect(await eventually(counterScript, (now) => now.consent === "marketing")).toEqual(both);

		// Read back once the shell loads again.
		await open(page, "/blog/rye");
		await componentTab(page, "One");
		expect(await consent.inputValue()).toBe("marketing");
		expect(await libraries.textContent()).toBe("motion-kit");
		expect(await box(page, "js").inputValue()).toBe(typed);
		forgetScriptErrors(page);
		await expectNoAxeViolations(page, "the Component tab's settings, light");
		await page.emulateMedia({ colorScheme: "dark" });
		await expectNoAxeViolations(page, "the Component tab's settings, dark");
		await page.emulateMedia({ colorScheme: "light" });
		await resetCounter();
	});

	test("⌘] and ⌘[ indent and outdent the lines in a code box; the box's Undo takes each back (BA-36)", async () => {
		await resetCounter();
		const page = await shared("staff");
		await open(page, "/blog/rye");
		await componentTab(page, "Three");
		const js = box(page, "js");
		await js.click();
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.insertText("// First\n// Second");
		// Every line of the selection, and the same lines stay selected.
		await page.keyboard.press("ControlOrMeta+a");
		await page.keyboard.press("ControlOrMeta+]");
		expect(await js.inputValue()).toBe("  // First\n  // Second");
		await page.keyboard.press("ControlOrMeta+]");
		expect(await js.inputValue()).toBe("    // First\n    // Second");
		await page.keyboard.press("ControlOrMeta+[");
		await page.keyboard.press("ControlOrMeta+[");
		expect(await js.inputValue()).toBe("// First\n// Second");
		// The caret's line alone, the caret moving with it.
		await js.evaluate((area: HTMLTextAreaElement) => area.setSelectionRange(12, 12));
		await page.keyboard.press("ControlOrMeta+]");
		expect(await js.inputValue()).toBe("// First\n  // Second");
		expect(await js.evaluate((area: HTMLTextAreaElement) => area.selectionStart)).toBe(14);
		// The box's Undo takes the indent back in one step.
		await page.keyboard.press("ControlOrMeta+z");
		expect(await js.inputValue()).toBe("// First\n// Second");
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-code-box"))).toBe("js");
		// The page stayed where it was (⌘[ is the browser's Back).
		expect(new URL(page.url()).pathname).toBe("/_webcraft/build/page/blog/rye");
		await page.keyboard.press("ControlOrMeta+s");
		expect(await eventually(counterDraft, (code) => code === "// First\n// Second")).toBe("// First\n// Second");

		// The HTML pane's box has the same keys.
		await clickIn(page, await frameOf(page), "main h1");
		await page.waitForFunction(
			() =>
				document.querySelector<HTMLTextAreaElement>('textarea[data-wc-code-box="html"]')?.value.includes("<h1") ===
				true,
		);
		const html = box(page, "html");
		const markup = await html.inputValue();
		const at = markup.indexOf("<h1");
		await html.focus();
		await html.evaluate((area: HTMLTextAreaElement, offset: number) => area.setSelectionRange(offset, offset), at);
		await page.keyboard.press("ControlOrMeta+]");
		const lineStart = markup.lastIndexOf("\n", at - 1) + 1;
		expect(await html.inputValue()).toBe(`${markup.slice(0, lineStart)}  ${markup.slice(lineStart)}`);
		await page.keyboard.press("ControlOrMeta+[");
		expect(await html.inputValue()).toBe(markup);
		await resetCounter();
	});
});

describe("a Member", () => {
	test("a failing Site script, in client editing's words; Safe mode from the notice, turned off on the bar", async () => {
		const page = await shared("member");
		try {
			await memberFailingSiteScript(page);
		} finally {
			await leaveSafeMode(page);
		}
	});

	async function memberFailingSiteScript(page: Page): Promise<void> {
		let frame = await frameOf(page);
		await frame.waitForFunction(() => document.documentElement.dataset.siteScript === "ran");
		const shown = notice(page);
		await shown
			.locator("strong")
			.filter({ hasText: "Something on this page didn't work: the Site script failed." })
			.waitFor();
		// No code for a Member: what to do instead.
		expect(await shown.textContent()).not.toContain("startSlider");
		await shown.getByText("You can keep editing.", { exact: false }).waitFor();
		forgetScriptErrors(page);
		await accessible(page, "a Member's notice, light");
		await page.emulateMedia({ colorScheme: "dark" });
		await expectNoAxeViolations(page, "a Member's notice, dark");
		await page.emulateMedia({ colorScheme: "light" });

		await shown.getByRole("button", { name: "Open in Safe mode" }).click();
		const control = page.locator("[data-wc-client-bar] [data-wc-safe-mode]");
		await control.waitFor();
		frame = await reloaded(page, true);
		await frame.locator("main h1").waitFor();
		expect(await frame.evaluate(() => document.documentElement.dataset.siteScript ?? null)).toBeNull();
		expect(await notice(page).count()).toBe(0);
		forgetScriptErrors(page);
		await accessible(page, "a Member's bar in Safe mode, light");
		await page.emulateMedia({ colorScheme: "dark" });
		await expectNoAxeViolations(page, "a Member's bar in Safe mode, dark");
		await page.emulateMedia({ colorScheme: "light" });

		await control.getByRole("button", { name: "Turn off Safe mode" }).click();
		frame = await reloaded(page, false);
		await frame.waitForFunction(() => document.documentElement.dataset.siteScript === "ran");
		await notice(page).waitFor();
		expect(await control.count()).toBe(0);
		forgetScriptErrors(page);
	}

	test("a section a Member adds runs its Component's script, which the page hadn't loaded", async () => {
		const page = await shared("member");
		const frame = await open(page, "/story");
		await frame.locator("main [data-wc-page-placement]").first().waitFor();
		await page.locator('[data-wc-bar="sections"]').waitFor();
		await frame.locator("html.wc-arrange-on").waitFor({ state: "attached" });
		// The page shows no Component with a script: it loaded none.
		expect(await frame.locator("script[data-wc-component-script]").count()).toBe(0);
		const south = await frame.locator('[data-wc-page-placement="south"]').first().boundingBox();
		if (!south) throw new Error("No South.");
		await page.mouse.move(south.x + 40, south.y + 4);
		const line = page.locator("[data-wc-add-section-line]");
		await line.waitFor();
		await line.getByRole("button", { name: /^Add section/ }).click();
		const panel = page.locator('[data-wc-side-panel="sections"]');
		await panel.locator("[data-wc-section-picker]").waitFor();
		await panel.locator("[data-wc-section-card]").filter({ hasText: "Quote" }).click();
		await frame.locator("blockquote").filter({ hasText: "Best bread in Cork." }).waitFor();
		// Its script arrives and is called once on the new section.
		await frame.waitForFunction(() => document.querySelector<HTMLElement>("[data-quoted]")?.dataset.quoted === "1");
		expect(await frame.locator("script[data-wc-component-script]").count()).toBe(1);
		expect(await notice(page).count()).toBe(0);
	});

	test("on a phone: the notice opens Safe mode, and More turns it off", async () => {
		const page = await shared("member");
		await page.setViewportSize({ width: 390, height: 844 });
		try {
			await open(page, "/blog/fresh-bread");
			await page.locator('[data-wc-phone-bar="more"]').waitFor();
			const shown = notice(page);
			await shown.locator("strong").filter({ hasText: "the Site script failed." }).waitFor();
			await shown.getByRole("button", { name: "Open in Safe mode" }).click();
			let frame = await reloaded(page, true);
			expect(await frame.evaluate(() => document.documentElement.dataset.siteScript ?? null)).toBeNull();
			await page.locator('[data-wc-phone-bar="more"]').click();
			const row = page.locator('[data-wc-phone-row="safe-mode"]');
			await row.waitFor();
			expect(await row.textContent()).toContain("Turn off Safe mode");
			forgetScriptErrors(page);
			await expectNoAxeViolations(page, "a phone's More with Safe mode on");
			await row.click();
			frame = await reloaded(page, false);
			await frame.waitForFunction(() => document.documentElement.dataset.siteScript === "ran");
			forgetScriptErrors(page);
		} finally {
			await page.setViewportSize({ width: 1440, height: 900 });
		}
	});
});
