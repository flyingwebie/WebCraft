// What BA-33 and BA-27 left open in Staff's editing (UI-21), in Chromium:
// - a Class's colour saved from the CSS pane shows on the page once the pane leaves it, and after its
//   step is taken back (not what was typed), and after every
//   redraw: a change to the Structure (BA-08's `rerender`), a one-off style saved from the HTML pane,
//   and the Class renamed in the Styles place (UI-19's redraw on rename, BA-24's stylesheet swap);
// - the page with a saved Class colour passes the accessibility checks, light and dark;
// - Layers: typing a name moves to the next row it starts, and `*` opens every row beside the one at
//   focus (the old tree's typeahead and `*`);
// - Bind to Prop for a Component's link and image: a new Link Prop (its default the address the link
//   had) or a Media Prop the Component has; the Prop and the binding are one Undo step; the question
//   passes the accessibility checks, light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { announced, enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

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
	for (const name of ["lead", "note", "card"]) await api.designSystem.createClass({ siteId, name });
	const site = await api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main>{{@outlet}}</main>" });
	await api.templates.publish({ siteId, templateId: site.template.id });
	// A Component with a link and an image, and a Media Prop already there.
	const { component } = await api.components.create({
		siteId,
		name: "Card",
		props: [{ key: "photo", label: "Photo", type: "media" }],
	});
	cardId = component.id;
	await api.components.saveMarkup({
		siteId,
		componentId: cardId,
		markup: `<div class="card"><a href="/about">About us</a><img src="${PIXEL}" alt="A cake" width="48" height="48"></div>`,
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
			'<p class="lead">Out of the oven</p>',
			'<p class="note">A note</p>',
			"<p>Plain words</p>",
			"<ul><li>One</li></ul>",
			"<section><p>Inside</p></section>",
			"<Card />",
			"</article>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: made } = await api.entries.create({ siteId, postTypeId, title: "Fresh bread" });
	await api.entries.publish({ siteId, entryId: made.id });
});

/** A one-pixel image the page's policy allows (`data:`), so no request fails. */
const PIXEL = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";

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
const box = (page: Page, id: "html" | "css" | "js") => page.locator(`textarea[data-wc-code-box="${id}"]`);

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

async function draftClass(name: string) {
	const { api } = await install.install.superadmin();
	return (await api.designSystem.get({ siteId })).designSystem.draft.classes.find((each) => each.name === name);
}

async function entryMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return ((await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "").replace(
		/ data-wc-id="[^"]*"/g,
		"",
	);
}

/** The colour the page in the frame gives the first element `selector` names, once it is `wanted`. */
async function colourOf(page: Page, selector: string, wanted: string): Promise<string> {
	return eventually(
		async () =>
			(await frameOf(page))
				.locator(selector)
				.first()
				.evaluate((element) => getComputedStyle(element).color)
				.catch(() => ""),
		(colour) => colour === wanted,
	);
}

const RED = "rgb(200, 0, 0)";

describe("a saved Class colour on the page", () => {
	test("shows once the CSS pane leaves it, with no preview", async () => {
		const page = await shared();
		await select(page, "p.lead");
		await page.locator("[data-wc-css-pane]").first().waitFor();
		await box(page, "css").fill(`.lead {\n  color: ${RED};\n}`);
		expect(
			await eventually(
				async () => (await draftClass("lead"))?.styles ?? "",
				(styles) => styles.includes(RED),
			),
		).toContain(RED);
		// Another element shown: the pane's preview leaves, and the page shows the saved rule.
		await select(page, "p.note");
		expect(await colourOf(page, "p.lead", RED)).toBe(RED);
	});

	test("Undo of a saved rule shows the Draft's rule again, not what was typed", async () => {
		const page = await shared();
		await select(page, "p.lead");
		await box(page, "css").fill(".lead {\n  color: rgb(0, 100, 0);\n}");
		expect(
			await eventually(
				async () => (await draftClass("lead"))?.styles ?? "",
				(styles) => styles.includes("rgb(0, 100, 0)"),
			),
		).toContain("rgb(0, 100, 0)");
		expect(await colourOf(page, "p.lead", "rgb(0, 100, 0)")).toBe("rgb(0, 100, 0)");
		// Still selected: the step is taken back, and the page shows the Draft's rule, not the typed one.
		await page.locator('[data-wc-bar="undo"]').click();
		expect(
			await eventually(
				async () => (await draftClass("lead"))?.styles ?? "",
				(styles) => styles.includes(RED),
			),
		).toContain(RED);
		expect(await colourOf(page, "p.lead", RED)).toBe(RED);
	});

	test("shows after the page is drawn again for a change to its Structure", async () => {
		const page = await shared();
		await select(page, "p.note");
		const html = box(page, "html");
		const before = await html.inputValue();
		expect(before).toContain("A note</p>");
		await html.fill(before.replace("A note</p>", "A longer note</p>"));
		await page.locator('[data-wc-rail="panels"]').focus();
		await (await frameOf(page)).locator("p.note", { hasText: "A longer note" }).waitFor();
		expect(await colourOf(page, "p.lead", RED)).toBe(RED);
	});

	test("shows after a one-off style is saved from the HTML pane", async () => {
		const page = await shared();
		await select(page, "p.note");
		const html = box(page, "html");
		const before = await html.inputValue();
		// The box prints each element with its id (`<p data-wc-id="…">`): a style is added after the tag.
		const styled = before.replace(
			/<p((?: data-wc-id="[^"]*")?)>Plain words/,
			'<p$1 style="color: rgb(0, 0, 200)">Plain words',
		);
		expect(styled).not.toBe(before);
		await html.fill(styled);
		await page.locator('[data-wc-rail="panels"]').focus();
		expect(await eventually(entryMarkup, (text) => /<p class="style-[0-9a-f]{8}">Plain words/.test(text))).toMatch(
			/<p class="style-[0-9a-f]{8}">Plain words/,
		);
		expect(await colourOf(page, "p:text-is('Plain words')", "rgb(0, 0, 200)")).toBe("rgb(0, 0, 200)");
		expect(await colourOf(page, "p.lead", RED)).toBe(RED);
	});

	test("shows after the Class is renamed in the Styles place", async () => {
		const page = await shared();
		const lead = await draftClass("lead");
		if (!lead) throw new Error("No lead Class.");
		await page.goto(
			install.siteUrl(
				slug,
				`/_webcraft/build/page${path}?wc-place=${encodeURIComponent("styles/classes")}&wc-view=${encodeURIComponent(`class=${lead.id}`)}`,
			),
		);
		await page.locator('[data-wc-class-rule="lead"]').waitFor();
		await page.locator("[data-wc-class-name]").fill("intro");
		await page.locator("[data-wc-class-rename]").click();
		await page.locator('[data-wc-class-rule="intro"]').waitFor();
		const frame = await frameOf(page);
		await frame.waitForFunction(() => document.querySelector("p.intro") !== null);
		expect(await colourOf(page, "p.intro", RED)).toBe(RED);
		// Drawn again once more after the rename (a change to the Structure): still the Draft's rule.
		await page.locator('[data-wc-class-rule="intro"]').fill(`.intro {\n  color: ${RED};\n  font-weight: 700;\n}`);
		expect(
			await eventually(
				async () => (await frameOf(page)).locator("p.intro").evaluate((p) => getComputedStyle(p).fontWeight),
				(weight) => weight === "700",
			),
		).toBe("700");
		expect(await colourOf(page, "p.intro", RED)).toBe(RED);
	});

	test("the page with a saved Class colour passes the accessibility checks, light and dark", async () => {
		const page = await shared();
		await page.goto(install.siteUrl(slug, `/_webcraft/build/page${path}`));
		await settled(page);
		await tree(page).getByRole("treeitem").first().waitFor();
		expect(await colourOf(page, "p.intro", RED)).toBe(RED);
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await page.waitForTimeout(1200);
			await expectAccessibleScreen(page, `a saved Class colour on the page (${theme})`);
		}
		await page.emulateMedia({ colorScheme: "light" });
	});
});

const row = (page: Page, name: string | RegExp) => tree(page).getByRole("treeitem", { name }).first();
/** The name of the row with focus in Layers. */
const focused = (page: Page) =>
	page.evaluate(() =>
		document.activeElement?.getAttribute("role") === "treeitem"
			? document.activeElement.getAttribute("aria-label")
			: null,
	);

/** Waits until focus is on the row whose name matches (focus moves on the next frame), and answers its name. */
async function focusOn(page: Page, name: RegExp): Promise<string | null> {
	return eventually(
		() => focused(page),
		(now) => now !== null && name.test(now),
	);
}

async function announces(page: Page, words: string): Promise<void> {
	expect(
		await eventually(
			() => announced(page),
			(seen) => seen.includes(words),
		),
	).toContain(words);
}

/** Selects an element on the page, and puts focus on its row in Layers. */
async function focusSelected(page: Page, selector: string): Promise<void> {
	await select(page, selector);
	const selected = tree(page).getByRole("treeitem", { selected: true });
	await selected.waitFor();
	await selected.focus();
}

describe("Layers: typeahead and *", () => {
	test("typing a name moves to the next row it starts, and selects it", async () => {
		const page = await shared();
		await focusSelected(page, "h1");
		await page.keyboard.press("p");
		expect(await focusOn(page, /^p \.(intro|lead)\b/)).toMatch(/^p \.(intro|lead)\b/);
		expect(await row(page, /^p \.(intro|lead)\b/).getAttribute("aria-selected")).toBe("true");
		// (The rename in the Styles place above made `.lead` `.intro`.) The same letter again goes on to the next row it starts.
		await page.keyboard.press("p");
		expect(await focusOn(page, /^p \.note/)).toMatch(/^p \.note/);
		// Letters typed one after the other add up; from the last row, the search goes round.
		await page.waitForTimeout(800);
		await page.keyboard.press("s");
		expect(await focusOn(page, /^section/)).toMatch(/^section/);
		await page.waitForTimeout(800);
		await page.keyboard.press("a");
		await page.keyboard.press("r");
		expect(await focusOn(page, /^article/)).toMatch(/^article/);
		await page.waitForTimeout(800);
		await page.keyboard.press("m");
		expect(await focusOn(page, /^main/)).toMatch(/^main/);
	});

	test("* opens every row beside the one at focus", async () => {
		const page = await shared();
		await focusSelected(page, "h1");
		for (const name of [/^ul\b/, /^section\b/])
			expect(await row(page, name).getAttribute("aria-expanded")).toBe("false");
		await page.keyboard.press("*");
		for (const name of [/^ul\b/, /^section\b/])
			expect(
				await eventually(
					() => row(page, name).getAttribute("aria-expanded"),
					(open) => open === "true",
				),
			).toBe("true");
		await row(page, /^li\b/).waitFor();
		// Focus stays on its row.
		expect(await focusOn(page, /^h1\b/)).toMatch(/^h1\b/);
	});
});

describe("Bind to Prop for a Component's link and image", () => {
	const inspector = (page: Page) => page.locator('[data-wc-panel-body="inspector"]');
	const read = async () => {
		const { api } = await install.install.superadmin();
		const got = await api.components.getMarkup({ siteId, componentId: cardId });
		return { ...got, markup: { ...got.markup, draft: got.markup.draft.replace(/ data-wc-id="[^"]*"/g, "") } };
	};

	test("a link's address becomes a new Link Prop, its default the address; Undo takes back both in one step", async () => {
		const page = await shared();
		await clickIn(page, ".card a");
		const bind = inspector(page).locator('[data-wc-bind-prop="link"]');
		await bind.waitFor();
		expect(await bind.textContent()).toBe("Bind to Prop: Link");
		await bind.click();
		const question = page.locator('[data-wc-bind-prop-dialog="link"]');
		await question.waitFor();
		expect(await question.getByLabel("Label").inputValue()).toBe("Link");
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			await page.waitForTimeout(300);
			await expectNoAxeViolations(page, `Bind to Prop's question (${theme})`);
		}
		await page.emulateMedia({ colorScheme: "light" });
		await question.getByRole("button", { name: "Bind to Prop" }).click();
		await question.waitFor({ state: "detached" });
		await announces(page, "Bound to {{ props.link.url }}.");
		// Focus goes back to the button, which now says what the address reads.
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-bind-prop"))).toBe("link");
		await inspector(page).locator("[data-wc-bound-prop]").filter({ hasText: "{{ props.link.url }}" }).waitFor();
		const saved = await eventually(read, (got) => got.markup.draft.includes("{{ props.link.url }}"));
		expect(saved.markup.draft).toContain('<a href="{{ props.link.url }}">About us</a>');
		expect(saved.component.draft.props).toEqual([
			expect.objectContaining({ key: "photo", type: "media" }),
			expect.objectContaining({
				key: "link",
				label: "Link",
				type: "link",
				default: expect.objectContaining({ url: "/about" }),
			}),
		]);
		// The default is the address it had: the page links to the same place.
		expect(
			await eventually(
				async () =>
					(await frameOf(page))
						.locator(".card a")
						.getAttribute("href")
						.catch(() => null),
				(href) => href === "/about",
			),
		).toBe("/about");

		await page.locator('[data-wc-bar="undo"]').click();
		const undone = await eventually(read, (got) => got.component.draft.props.length === 1);
		expect(undone.component.draft.props.map((prop) => prop.key)).toEqual(["photo"]);
		expect(undone.markup.draft).toContain('<a href="/about">About us</a>');
	});

	test("an image's file reads a Media Prop the Component has", async () => {
		const page = await shared();
		await clickIn(page, ".card img");
		const bind = inspector(page).locator('[data-wc-bind-prop="media"]');
		await bind.waitFor();
		await bind.click();
		const question = page.locator('[data-wc-bind-prop-dialog="media"]');
		await question.waitFor();
		await question.getByRole("radio", { name: "A Prop it has" }).check();
		await question.getByRole("combobox").selectOption("photo");
		await question.getByRole("button", { name: "Bind to Prop" }).click();
		await question.waitFor({ state: "detached" });
		await announces(page, "Bound to {{ props.photo }}.");
		const saved = await eventually(read, (got) => got.markup.draft.includes("{{ props.photo }}"));
		expect(saved.markup.draft).toContain('src="{{ props.photo }}"');
		expect(saved.component.draft.props.map((prop) => prop.key)).toEqual(["photo"]);
	});

	test("a Prop key taken is refused in words, and the question stays open", async () => {
		const page = await shared();
		await clickIn(page, ".card a");
		await inspector(page).locator('[data-wc-bind-prop="link"]').click();
		const question = page.locator('[data-wc-bind-prop-dialog="link"]');
		await question.waitFor();
		await question.getByLabel("Key").fill("photo");
		await question.getByRole("button", { name: "Bind to Prop" }).click();
		await question.getByRole("alert").filter({ hasText: "That key is taken." }).waitFor();
		await page.keyboard.press("Escape");
		await question.waitFor({ state: "detached" });
		expect((await read()).markup.draft).toContain('<a href="/about">About us</a>');
	});
});
