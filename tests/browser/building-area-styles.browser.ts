// The Styles place of the building area (ADR 0037, BA-24; SPEC 8; `places-assets/05`, `06`, `07`), in
// Chromium:
// - four tabs with icons, each an address; Classes listed with the elements each is on, filtered by
//   kind (All, Class, Generated, In use, Unused: Unused lists the Classes on no element);
// - a Class's rule saves to its pieces (its styles, its own CSS, each breakpoint's styles); the quick
//   actions write Design tokens (a second click removes them), their menu has a search and favourites;
//   Format tidies the rule;
// - Rename follows every element: once published, every page carries the new name and none the old;
// - a colour's dark value changes the page on the canvas in Dark preview;
// - Site CSS saves with Format;
// - Breakpoints: the table, the ruler tied to the frame's width, and "Show on canvas" drawing the
//   Breakpoint's line over the canvas;
// - a Member is refused;
// - the place passes the accessibility checks, light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Page } from "playwright";

import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { announced, enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let editor: TestAccount;
let superadmin: TestBrowser;
let siteId: string;
const slug = "bakery";

/** The Classes the Site has, by name, with their ids. */
const ids = new Map<string, string>();

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	superadmin = await local.superadmin();
	const { api } = superadmin;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).account;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Giulia Romano" })).account;

	// Dark mode on; four Classes, two on elements of the Site template and two on none.
	await api.designSystem.saveDraft({ siteId, darkMode: true });
	for (const [name, styles, breakpoints] of [
		["hero", "padding: var(--space-l);", { "breakpoint-md": "padding: var(--space-xl);" }],
		["hero__title", "font-size: var(--text-xl);", {}],
		["note", "color: var(--primary-60);", {}],
		["btn", "border-radius: var(--radius-m);", {}],
		["quote", "font-style: italic;", {}],
	] as const) {
		const made = await api.designSystem.createClass({ siteId, name, styles, breakpoints });
		ids.set(name, made.class.id);
	}
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header class="hero"><h1 class="hero__title">Acme Bakery</h1><p class="note">Open every day</p></header><main>{{@outlet}}</main>',
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	await api.designSystem.publish({ siteId });
	const pagesId = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id ?? "";
	for (const [title, pageSlug] of [
		["Home", "home"],
		["Menu", "menu"],
	] as const) {
		const { entry } = await api.entries.create({ siteId, postTypeId: pagesId, title, slug: pageSlug });
		await api.entries.publish({ siteId, entryId: entry.id });
		if (pageSlug === "home") await api.pages.setHomePage({ siteId, pageId: entry.id });
	}
});

afterAll(async () => {
	await install?.close();
});

/** Opens a shell address in the page (as a bookmark or a typed address does). */
async function go(page: Page, address: string): Promise<void> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build${address}`));
}

/** The shell's address with a place open over the menu page. */
const placed = (place: string, view?: string) =>
	`/page/menu?wc-place=${encodeURIComponent(place)}${view ? `&wc-view=${encodeURIComponent(view)}` : ""}`;

/** The Design system's Draft as the API reads it now. */
async function draft() {
	return (await superadmin.api.designSystem.get({ siteId })).designSystem.draft;
}

/** Waits until `read` answers what is expected. */
async function eventually<T>(read: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
	let last = await read();
	for (let attempt = 0; attempt < 60 && !check(last); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		last = await read();
	}
	expect(check(last)).toBe(true);
	return last;
}

/** The Class rows the list shows, by name, in order. */
const rows = (page: Page) =>
	page.locator("[data-wc-class-row]").evaluateAll((all) => all.map((row) => row.getAttribute("data-wc-class-row")));

/** The text of a Class's rule as its code box holds it. */
const rule = (page: Page) => page.locator("[data-wc-class-rule]").inputValue();

describe("the Styles place, for Staff", () => {
	let page: Page;
	let frame: Frame;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		frame = await enterBuildingArea(install, page, { as: staff, siteId, slug, open: "/page/menu" });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("the rail opens Styles on Classes; the tabs are addresses with icons; the place has the frame's sizes", async () => {
		await page.locator('[data-wc-place="styles"]').click();
		await page.locator("[data-wc-styles-classes]").waitFor();
		expect(new URL(page.url()).searchParams.get("wc-place")).toBe("styles/classes");
		expect(await page.locator('[data-wc-place="styles"]').getAttribute("aria-pressed")).toBe("true");
		const tabs = page.locator("[data-wc-styles-tab]");
		expect(await tabs.allTextContents()).toEqual(["Classes", "Design tokens", "Site CSS", "Breakpoints"]);
		expect(await tabs.locator("svg").count()).toBe(4);
		expect(await page.locator('[data-wc-styles-tab="classes"]').getAttribute("aria-current")).toBe("page");
		// Sizes of `places-assets/05`: tabs 33 high, the list's column 405 wide, rows 27, kinds 27.
		expect((await tabs.first().boundingBox())?.height).toBe(33);
		expect((await page.locator("[data-wc-styles-classes] > div").first().boundingBox())?.width).toBe(405);
		expect((await page.locator("[data-wc-class-row]").first().boundingBox())?.height).toBe(27);
		expect((await page.locator("[data-wc-class-kind]").first().boundingBox())?.height).toBe(27);
		// The Design system's Draft state on the right of the header.
		expect(await page.locator("[data-wc-styles-draft]").textContent()).toBe("Draft · all saved");

		// Each Class with the elements it is on, by name.
		expect(await rows(page)).toEqual(["btn", "hero", "hero__title", "note", "quote"]);
		const count = (name: string) => page.locator(`[data-wc-class-row="${name}"] [data-wc-class-count]`).textContent();
		expect(await count("hero")).toContain("1");
		expect(await count("btn")).toContain("0");

		// A tab is an address: Back returns to the one before.
		await page.locator('[data-wc-styles-tab="tokens"]').click();
		await page.locator("[data-wc-tokens]").waitFor();
		expect(new URL(page.url()).searchParams.get("wc-place")).toBe("styles/tokens");
		await page.goBack();
		await page.locator("[data-wc-styles-classes]").waitFor();
	});

	test("the kind filter: Unused lists the Classes on no element, In use the others; Back restores it", async () => {
		await go(page, placed("styles/classes"));
		await page.locator("[data-wc-styles-classes]").waitFor();
		await page.locator('[data-wc-class-kind="unused"]').click();
		await page.waitForURL((url) => url.searchParams.get("wc-view") === "kind=unused");
		expect(await rows(page)).toEqual(["btn", "quote"]);
		expect(await page.locator('[data-wc-class-kind="unused"]').getAttribute("aria-pressed")).toBe("true");
		await page.locator('[data-wc-class-kind="used"]').click();
		await page.waitForURL((url) => url.searchParams.get("wc-view") === "kind=used");
		expect(await rows(page)).toEqual(["hero", "hero__title", "note"]);
		await page.locator('[data-wc-class-kind="generated"]').click();
		expect(await rows(page)).toEqual([]);
		await page.goBack();
		await page.waitForURL((url) => url.searchParams.get("wc-view") === "kind=used");
		expect(await rows(page)).toEqual(["hero", "hero__title", "note"]);
		// The search replaces the address's view as it is typed.
		await page.locator('[data-wc-class-kind="all"]').click();
		await page.locator("[data-wc-class-search]").fill(".he");
		expect(await rows(page)).toEqual(["hero", "hero__title"]);
	});

	test("a Class's rule shows its pieces as one rule, and what is typed saves to them", async () => {
		await go(page, placed("styles/classes", `class=${ids.get("hero")}`));
		await page.locator('[data-wc-class-rule="hero"]').waitFor();
		expect(await rule(page)).toBe(
			".hero {\n  padding: var(--space-l);\n\n  @media (width >= 768px) {\n    padding: var(--space-xl);\n  }\n}",
		);
		expect(await page.locator('[data-wc-class-row="hero"]').getAttribute("aria-current")).toBe("true");
		expect(await page.locator("[data-wc-class-usage]").textContent()).toBe("on 1 element · 2 pages");
		// Name field 420 wide, as the frame draws it.
		expect((await page.locator("[data-wc-class-name]").boundingBox())?.width).toBe(420);

		await page
			.locator("[data-wc-class-rule]")
			.fill(
				".hero {\n  padding: var(--space-m);\n  &:hover {\n    color: red;\n  }\n  @media (width >= 1024px) {\n    gap: 1rem;\n  }\n}",
			);
		const saved = await eventually(draft, (now) =>
			(now.classes.find((each) => each.name === "hero")?.styles ?? "").includes("--space-m"),
		);
		const hero = saved.classes.find((each) => each.name === "hero");
		expect(hero?.css).toContain("&:hover");
		expect(hero?.breakpoints["breakpoint-lg"]).toContain("gap: 1rem");
		expect(hero?.breakpoints["breakpoint-md"]).toBeUndefined();
		await page.locator('[data-wc-styles-draft="saved"]').waitFor();

		// A rule that isn't one block says so and marks its line; nothing is saved.
		await page.locator("[data-wc-class-rule]").fill(".hero {\n  padding: 0;\n");
		await page.locator("[data-wc-problem-line]").waitFor();
		expect(await page.locator("[data-format-note]").textContent()).toContain("isn't closed");
		expect(await page.locator('[data-wc-quick="fontSize"]').getAttribute("aria-disabled")).toBe("true");
	});

	test("the quick actions write Design tokens: a click fills the default, its menu lists the scale with favourites, a second click removes it", async () => {
		await go(page, placed("styles/classes", `class=${ids.get("quote")}`));
		await page.locator('[data-wc-class-rule="quote"]').waitFor();
		const fontSize = page.locator('[data-wc-quick="fontSize"]');
		expect(await fontSize.getAttribute("aria-pressed")).toBe("false");
		await fontSize.click();
		// The scale's middle step, and its menu open with the search focused.
		expect(await rule(page)).toContain("font-size: var(--text-m);");
		expect(await fontSize.getAttribute("aria-pressed")).toBe("true");
		await page.locator("[data-wc-token-menu]").waitFor();
		await page.waitForFunction(() => document.activeElement?.matches("[data-wc-token-menu] input"));
		expect(await page.locator("[data-wc-token-menu]").textContent()).toContain("Type scale");
		// The search narrows the list; a star makes a favourite, listed first.
		await page.keyboard.type("xl");
		const choices = () =>
			page
				.locator("[data-wc-token-choice]")
				.evaluateAll((all) => all.map((each) => each.getAttribute("data-wc-token-choice")));
		expect(await choices()).toEqual(["text-4xl", "text-3xl", "text-2xl", "text-xl"]);
		await page.locator('[data-wc-token-star="text-xl"]').click();
		expect(await page.locator('[data-wc-token-star="text-xl"]').getAttribute("aria-pressed")).toBe("true");
		expect((await choices())[0]).toBe("text-xl");
		await page.locator('[data-wc-token-choice="text-2xl"]').click();
		expect(await rule(page)).toContain("font-size: var(--text-2xl);");
		await page.waitForFunction(() => document.activeElement?.matches('[data-wc-quick="fontSize"]'));
		expect(await page.locator("[data-wc-token-menu]").count()).toBe(0);
		// A second click removes it; the next first click writes the favourite.
		await fontSize.click();
		expect(await rule(page)).not.toContain("font-size");
		await fontSize.click();
		expect(await rule(page)).toContain("font-size: var(--text-xl);");
		await page.keyboard.press("Escape");
		expect(await page.locator("[data-wc-token-menu]").count()).toBe(0);
		// Escape closed the menu, not the place.
		expect(await page.locator("[data-wc-place-frame]").count()).toBe(1);
		// A plain value: Bold sets font-weight, and again removes it.
		await page.locator('[data-wc-quick="bold"]').click();
		expect(await rule(page)).toContain("font-weight: 700;");
		expect(await announced(page)).toContain("Bold added");

		// The media query action lists the Breakpoints and adds a block for the chosen one.
		await page.locator('[data-wc-quick="media"]').click();
		await page.locator('[data-wc-token-choice="md"]').click();
		expect(await rule(page)).toContain("@media (width >= 768px) {");
		await page.keyboard.press("Tab");
		const saved = await eventually(draft, (now) =>
			(now.classes.find((each) => each.name === "quote")?.styles ?? "").includes("--text-xl"),
		);
		expect(saved.classes.find((each) => each.name === "quote")?.styles).toContain("font-weight: 700");
	});

	test("Format tidies the rule in one step and says how many lines changed", async () => {
		await go(page, placed("styles/classes", `class=${ids.get("btn")}`));
		await page.locator('[data-wc-class-rule="btn"]').waitFor();
		await page.locator("[data-wc-class-rule]").fill(".btn {\nborder-radius:var(--radius-m);color:red}");
		await page.locator("[data-format-button]").click();
		await page.locator('[data-format-note="changed"]').waitFor();
		expect(await page.locator("[data-format-note]").textContent()).toMatch(/^Formatted · \d+ lines? changed$/);
		expect(await rule(page)).toBe(".btn {\n  border-radius: var(--radius-m);\n  color: red;\n}");
		await eventually(draft, (now) => (now.classes.find((each) => each.name === "btn")?.styles ?? "").includes("red"));
	});

	test("Rename follows every element: once published, every page carries the new name and none the old", async () => {
		await go(page, placed("styles/classes", `class=${ids.get("hero__title")}`));
		await page.locator('[data-wc-class-rule="hero__title"]').waitFor();
		// The page under the place is announced once Edit mode has described it: the rename's message comes after.
		await page.waitForFunction(() =>
			document.querySelector("[data-wc-messages]")?.textContent?.includes("Opened Menu"),
		);
		expect(await page.locator("[data-wc-class-rename]").isDisabled()).toBe(true);
		await page.locator("[data-wc-class-name]").fill("masthead__title");
		await page.locator("[data-wc-class-rename]").click();
		await page.locator('[data-wc-class-rule="masthead__title"]').waitFor();
		expect((await rule(page)).startsWith(".masthead__title {")).toBe(true);
		await page.waitForFunction(() =>
			document.querySelector("[data-wc-messages]")?.textContent?.includes("Renamed to .masthead__title"),
		);
		const renamed = await draft();
		// The same Class, by its id: the elements keep it.
		expect(renamed.classes.find((each) => each.id === ids.get("hero__title"))?.name).toBe("masthead__title");

		// Published, every page the canvas shows (the published Structure) carries the new name, none the old.
		await superadmin.api.designSystem.publish({ siteId });
		for (const path of ["/page/", "/page/menu"]) {
			await go(page, path);
			const shown = await frameOf(page);
			const html = await shown.evaluate(() => document.body.innerHTML);
			expect(html).toContain('class="masthead__title"');
			expect(html).not.toContain("hero__title");
		}
	});

	test("Design tokens: the groups, a typed editor and its CSS; a colour's dark value changes the page in Dark preview", async () => {
		await go(page, placed("styles/tokens"));
		await page.locator('[data-wc-tokens="colours"]').waitFor();
		const groups = await page.locator("[data-wc-token-group]").allTextContents();
		expect(groups.map((each) => each.replace(/\d+$/, ""))).toEqual([
			"Colours",
			"Spacing",
			"Type scale",
			"Fonts",
			"Radius",
			"Shadows",
			"Content widths",
		]);
		expect((await page.locator("[data-wc-tokens] > nav").boundingBox())?.width).toBe(300);
		expect(await page.locator("[data-wc-colour]").count()).toBe(4);
		expect((await page.locator('[data-wc-colour="primary"]').boundingBox())?.height).toBe(44);

		// The dark value of primary, typed: saved, and the page on the canvas shows it in Dark preview.
		await page.locator('[data-wc-colour-dark="primary"]').fill("#ff0000");
		await eventually(
			draft,
			(now) => now.tokens.colours.find((each) => each.name === "primary")?.dark.base === "#ff0000",
		);
		const { preview } = await superadmin.api.designSystem.preview({ siteId });
		const darkPrimary = preview.ramps["colour-primary"]?.dark.shown["60"] ?? "";
		// Editor · CSS: the group's custom properties.
		await page.locator('[data-wc-tokens-as="css"]').click();
		expect(await page.locator('[data-wc-tokens-css="colours"]').inputValue()).toContain("--primary-60:");
		expect(new URL(page.url()).searchParams.get("wc-view")).toBe("as=css");
		await page.locator('[data-wc-tokens-as="editor"]').click();
		// Spacing: its steps and the property each gives.
		await page.locator('[data-wc-token-group="space"]').click();
		await page.locator('[data-wc-tokens="space"]').waitFor();
		expect(await page.locator('[data-wc-tokens="space"] table').textContent()).toContain("--space-m");

		await page.locator("[data-wc-place-back]").click();
		await page.locator("[data-wc-place-frame]").waitFor({ state: "detached" });
		await page.locator('[data-wc-rail="dark-preview"]').click();
		frame = await frameOf(page);
		const colour = async () =>
			frame.evaluate(() => {
				const note = document.querySelector(".note");
				return note ? getComputedStyle(note).color : "";
			});
		const expected = await page.evaluate((hex) => {
			const probe = document.createElement("span");
			probe.style.color = hex;
			document.body.append(probe);
			const read = getComputedStyle(probe).color;
			probe.remove();
			return read;
		}, darkPrimary);
		for (let attempt = 0; attempt < 50 && (await colour()) !== expected; attempt++) await page.waitForTimeout(100);
		expect(await colour()).toBe(expected);
		await page.locator('[data-wc-rail="dark-preview"]').click();
	});

	test("Site CSS: one code file, saved as typed, with Format", async () => {
		await go(page, placed("styles/site-css"));
		await page.locator("[data-wc-site-css-box]").waitFor();
		await page.locator("[data-wc-site-css-box]").fill("body{margin:0}");
		await page.locator("[data-format-button]").click();
		await page.locator('[data-format-note="changed"]').waitFor();
		expect(await page.locator("[data-wc-site-css-box]").inputValue()).toBe("body {\n  margin: 0;\n}");
		await eventually(draft, (now) => now.customCss.includes("margin: 0"));
	});

	test("Breakpoints: the table, the ruler tied to the frame, and Show on canvas drawing the line", async () => {
		await go(page, placed("styles/breakpoints"));
		await page.locator("[data-wc-breakpoints]").waitFor();
		const names = await page
			.locator("[data-wc-breakpoint-row]")
			.evaluateAll((all) => all.map((row) => row.getAttribute("data-wc-breakpoint-row")));
		expect(names).toEqual(["md", "lg", "xl", "2xl"]);
		const cells = (name: string) => page.locator(`[data-wc-breakpoint-row="${name}"] td`).allTextContents();
		// hero has styles from lg up (typed earlier), quote from md up.
		expect((await cells("lg"))[2]).toBe("on 1 rule");
		expect((await cells("xl"))[2]).toBe("on 0 rules");
		expect(await page.locator('[data-wc-breakpoint-row="md"] [data-wc-breakpoint-width]').inputValue()).toBe("768");
		expect((await page.locator('[data-wc-breakpoint-row="md"]').boundingBox())?.height).toBe(44);
		// The ruler marks each breakpoint and the page's width on the canvas now.
		expect(await page.locator("[data-wc-ruler-breakpoint]").count()).toBe(4);
		const width = await page.evaluate(
			() => document.querySelector<HTMLIFrameElement>("iframe[data-wc-frame]")?.contentWindow?.innerWidth ?? 0,
		);
		expect(Number(await page.locator("[data-wc-ruler-canvas]").getAttribute("data-wc-ruler-canvas"))).toBe(width);

		// Show on canvas: its line is drawn over the canvas once the place is left, where the frame's
		// edges would be at 768 px.
		await page.locator('[data-wc-breakpoint-show="md"]').click();
		expect(await page.locator('[data-wc-breakpoint-show="md"]').getAttribute("aria-checked")).toBe("true");
		await page.locator("[data-wc-place-back]").click();
		await page.locator('[data-wc-breakpoint-line="md"]').waitFor({ state: "attached" });
		await settled(page);
		const box = await page.locator("[data-wc-frame-box]").boundingBox();
		const lines = await page
			.locator('[data-wc-breakpoint-line="md"] > span')
			.evaluateAll((spans) => spans.slice(0, 2).map((span) => span.getBoundingClientRect().left));
		const centre = (box?.x ?? 0) + (box?.width ?? 0) / 2;
		const half = (768 * (box?.width ?? 0)) / width / 2;
		expect(Math.abs((lines[0] ?? 0) - (centre - half))).toBeLessThanOrEqual(1);
		expect(Math.abs((lines[1] ?? 0) - (centre + half))).toBeLessThanOrEqual(1);
		// Switched off, the line goes.
		await go(page, placed("styles/breakpoints"));
		await page.locator('[data-wc-breakpoint-show="md"]').click();
		await page.locator("[data-wc-place-back]").click();
		await page.locator("[data-wc-place-frame]").waitFor({ state: "detached" });
		expect(await page.locator("[data-wc-breakpoint-line]").count()).toBe(0);
	});

	for (const theme of THEMES) {
		test(`the place passes the accessibility checks (${theme})`, async () => {
			await page.emulateMedia({ colorScheme: theme });
			await go(page, placed("styles/classes", `class=${ids.get("note")}`));
			await page.locator('[data-wc-class-rule="note"]').waitFor();
			await expectAccessibleScreen(page, `building area, Styles › Classes (${theme})`);
			// A token action the rule doesn't have yet opens its menu (one it has would be removed).
			const background = page.locator('[data-wc-quick="background"]');
			if ((await background.getAttribute("aria-pressed")) === "true") await background.click();
			await background.click();
			await page.locator("[data-wc-token-menu]").waitFor();
			await expectNoAxeViolations(page, `building area, a quick action's token menu (${theme})`);
			await page.keyboard.press("Escape");
			await go(page, placed("styles/tokens"));
			await page.locator('[data-wc-tokens="colours"]').waitFor();
			await expectAccessibleScreen(page, `building area, Styles › Design tokens (${theme})`);
			await go(page, placed("styles/breakpoints"));
			await page.locator("[data-wc-breakpoints]").waitFor();
			await expectNoAxeViolations(page, `building area, Styles › Breakpoints (${theme})`);
		});
	}
});

describe("the Styles place, for a Member", () => {
	test("isn't theirs: no rail button, and its address opens the page (client editing, BA-14)", async () => {
		const page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await enterBuildingArea(install, page, { as: editor, siteId, slug, open: "/page/menu" });
		await page.locator("[data-wc-client-rail]").waitFor();
		expect(await page.locator('[data-wc-place="styles"]').count()).toBe(0);
		await go(page, placed("styles/classes"));
		await page.locator("iframe[data-wc-frame]").waitFor();
		await page.locator("[data-wc-client-rail]").waitFor();
		expect(await page.locator("[data-wc-place-frame]").count()).toBe(0);
		expect(await page.locator("[data-wc-styles-loading]").count()).toBe(0);
		await page.context().close();
	});
});
