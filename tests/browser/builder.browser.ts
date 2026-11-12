// The visual builder in a real browser (#66): full-screen, with its top bar, the Layers panel, the
// canvas and the style panel, in light and dark (axe and the keyboard; the canvas shows Staff's own
// Template, which Checks look at, so axe leaves it out). Every move the Layers panel makes from the
// keyboard is checked by what is saved: moving up, down, into the layer before and out, picking up
// and putting down, cut, copy, paste, duplicate, delete and rename, each announced. Dragging on the
// canvas, the Template markup view, the style panel and "Make it a Field" too.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
let entryTemplateId: string;

/** The canvas shows Staff's own Template (Checks look at it) and runs no script: axe leaves it out. */
const CANVAS = { exclude: ["iframe[title^='Canvas']"] };

const ENTRY_TEMPLATE =
	'<article class="intro" data-wc-label="Post" data-wc-id="post"><h1 data-wc-id="t">{{ title }}</h1>' +
	'<p data-wc-id="lead">Fresh from the oven</p>' +
	'<ul data-wc-id="list"><li data-wc-id="one">One</li><li data-wc-id="two">Two</li><li data-wc-id="three">Three</li></ul>' +
	'<section data-wc-id="box"></section></article>';

const openedPages: Page[] = [];
async function testPage(theme: "light" | "dark") {
	const page = await install.newPage(theme);
	page.setDefaultTimeout(10000);
	openedPages.push(page);
	return page;
}
afterEach(async () => {
	await Promise.all(openedPages.splice(0).map((page) => page.close()));
});

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId] })).account;
	await api.designSystem.createClass({ siteId, name: "intro", styles: "padding: var(--space-m);" });
	await api.designSystem.saveDraft({ siteId, darkMode: true });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "summary", label: "Summary", type: "text" }],
	});
	postTypeId = postType.id;
	await api.entries.create({ siteId, postTypeId, title: "Fresh bread", fields: { summary: "Out at seven" } });
	await resetTemplate();
});

beforeEach(resetTemplate);

afterAll(async () => {
	await install.close();
});

/** Puts the Entry template's Draft back as the fixture has it. */
async function resetTemplate(): Promise<void> {
	const { api } = await install.install.superadmin();
	const saved = await api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: ENTRY_TEMPLATE });
	entryTemplateId = saved.template.id;
}

/** The Entry template's Draft as Template markup, as the admin reads it. */
async function draftMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return (await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "";
}

/** The builder open on the Entry template, its canvas showing the Entry saved last. */
async function builderPage(theme: "light" | "dark" = "light"): Promise<Page> {
	const page = await testPage(theme);
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/builder/${siteId}/entry-template/${postTypeId}`));
	await page.getByRole("tree", { name: "Layers" }).waitFor();
	await page.frameLocator("iframe[title^='Canvas']").getByText("Fresh bread").waitFor();
	return page;
}

/** The layer with this name in the Layers panel. */
function layer(page: Page, name: string | RegExp) {
	return page.getByRole("tree", { name: "Layers" }).getByRole("treeitem", { name });
}

/** Waits until the live region says `text` (after a call to the server, it may take a moment). */
async function expectAnnounced(page: Page, text: string): Promise<void> {
	await page.locator("[data-editor-messages] > p").filter({ hasText: text }).first().waitFor({ timeout: 10_000 });
}

/** What the live region last said. */
async function announced(page: Page): Promise<string> {
	return (
		(await page.locator("[data-editor-messages] > p").filter({ hasText: /\S/ }).last().textContent()) ?? ""
	).trim();
}

for (const theme of THEMES) {
	describe(`the builder, ${theme}`, () => {
		test("its top bar, Layers panel and style panel", async () => {
			const page = await builderPage(theme);
			await layer(page, /^Post/).click();
			await page.getByRole("tab", { name: "Style" }).click();
			await page.getByRole("textbox", { name: "Declarations", exact: true }).waitFor();

			await expectAccessibleScreen(page, `Builder (${theme})`, CANVAS);
		});

		test("the insert menu", async () => {
			const page = await builderPage(theme);
			await layer(page, /^Post/).click();

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Insert" }),
				"dialog",
				`Builder › Insert (${theme})`,
				CANVAS,
			);
		});
	});
}

describe("the Layers panel from the keyboard alone", () => {
	test("moves a layer up, down, into the layer before and out, each announced, and saves the moves", async () => {
		await resetTemplate();
		const page = await builderPage();
		await layer(page, /^“Two”/).click();
		await layer(page, /^li/).nth(1).focus();
		expect(await layer(page, /^li/).nth(1).getAttribute("aria-selected")).toBe("true");

		await page.keyboard.press("Alt+ArrowUp");
		expect(await announced(page)).toBe("Moved li: 1 of 3 in ul.");
		await page.keyboard.press("Alt+ArrowUp");
		expect(await announced(page)).toBe("li is already first.");
		await page.keyboard.press("Alt+ArrowDown");
		await page.keyboard.press("Alt+ArrowDown");
		expect(await announced(page)).toBe("Moved li: 3 of 3 in ul.");
		// The tree's rules hold: a list item can't go inside another.
		await page.keyboard.press("Alt+ArrowRight");
		expect(await announced(page)).toBe("<li> can't go inside <li>: a browser would end the <li> before it.");
		await layer(page, /^ul/).click();
		await page.keyboard.press("Alt+ArrowDown");
		expect(await announced(page)).toBe("Moved ul: 4 of 4 in Post.");
		await page.keyboard.press("Alt+ArrowRight");
		expect(await announced(page)).toBe("Moved ul: 1 of 1 in section.");
		await page.keyboard.press("Alt+ArrowLeft");
		expect(await announced(page)).toBe("Moved ul: 4 of 4 in Post.");
		await page.keyboard.press("Alt+ArrowRight");
		await page.keyboard.press("ControlOrMeta+s");
		await page
			.locator("header")
			.getByRole("button", { name: "Save", exact: true })
			.and(page.locator("[disabled]"))
			.waitFor();

		expect(await draftMarkup()).toContain(
			'<section data-wc-id="box"><ul data-wc-id="list"><li data-wc-id="one">One</li><li data-wc-id="three">Three</li>' +
				'<li data-wc-id="two">Two</li></ul></section></article>',
		);
	});

	test("picks a layer up with Space, moves it with the arrows, and puts it back with Escape or down with Space", async () => {
		await resetTemplate();
		const page = await builderPage();
		await layer(page, /^section/).click();

		await page.keyboard.press(" ");
		expect(await announced(page)).toStartWith("Picked up section.");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press("Escape");
		expect(await announced(page)).toBe("Put section back where it was.");
		await page.keyboard.press(" ");
		await page.keyboard.press("ArrowUp");
		await page.keyboard.press(" ");
		expect(await announced(page)).toBe("Put down section: 3 of 4 in Post.");
		await page.keyboard.press("ControlOrMeta+s");
		await page
			.locator("header")
			.getByRole("button", { name: "Save", exact: true })
			.and(page.locator("[disabled]"))
			.waitFor();

		expect(await draftMarkup()).toContain('<section data-wc-id="box"></section><ul data-wc-id="list">');
	});

	test("cuts, copies, pastes, duplicates, deletes and renames, each announced", async () => {
		await resetTemplate();
		const page = await builderPage();
		await layer(page, /^p/).click();

		await page.keyboard.press("ControlOrMeta+c");
		expect(await announced(page)).toBe("Copied p.");
		await layer(page, /^section/).click();
		await page.keyboard.press("ControlOrMeta+v");
		expect(await announced(page)).toBe("Pasted p: 5 of 5 in Post.");
		await page.keyboard.press("ControlOrMeta+d");
		expect(await announced(page)).toBe("Duplicated p: 6 of 6 in Post.");
		await page.keyboard.press("Delete");
		expect(await announced(page)).toBe("Deleted p.");
		await layer(page, /^ul/).click();
		await page.keyboard.press("ControlOrMeta+x");
		expect(await announced(page)).toBe("Cut ul.");
		await layer(page, /^h1/).click();
		await page.keyboard.press("ControlOrMeta+v");
		expect(await announced(page)).toBe("Pasted ul: 2 of 5 in Post.");
		await page.keyboard.press("F2");
		const rename = page.getByRole("textbox", { name: "Layer label of ul" });
		await rename.fill("Steps");
		await rename.press("Enter");
		expect(await announced(page)).toBe("Renamed Steps.");
		await expect(layer(page, /^Steps/).getAttribute("aria-selected")).resolves.toBe("true");
		await page.keyboard.press("ControlOrMeta+s");
		await page
			.locator("header")
			.getByRole("button", { name: "Save", exact: true })
			.and(page.locator("[disabled]"))
			.waitFor();

		const markup = await draftMarkup();
		expect(markup).toMatch(
			/^<article class="intro" data-wc-label="Post" data-wc-id="post"><h1 data-wc-id="t">\{\{ title \}\}<\/h1><ul data-wc-label="Steps" data-wc-id="[A-Za-z0-9]{12}"><li data-wc-id="[A-Za-z0-9]{12}">One<\/li>/,
		);
		expect(markup).toMatch(
			/<section data-wc-id="box"><\/section><p data-wc-id="[A-Za-z0-9]{12}">Fresh from the oven<\/p><\/article>$/,
		);
	});

	test("undoes and redoes", async () => {
		await resetTemplate();
		const page = await builderPage();
		await layer(page, /^section/).click();
		await page.keyboard.press("Delete");
		await expect(layer(page, /^section/).count()).resolves.toBe(0);

		await page.keyboard.press("ControlOrMeta+z");
		await layer(page, /^section/).waitFor();
		await expectAnnounced(page, "Undid Delete section");
		await page.keyboard.press("ControlOrMeta+Shift+z");
		await expectAnnounced(page, "Redid Delete section");
		await expect(layer(page, /^section/).count()).resolves.toBe(0);
	});
});

describe("inserting", () => {
	test("from the insert menu, by typing and Enter, inside the selected layer", async () => {
		await resetTemplate();
		const page = await builderPage();
		await layer(page, /^section/).click();

		await page.getByRole("button", { name: "Insert" }).click();
		await page.getByRole("combobox", { name: "Find an element" }).fill("Heading 2");
		await page.keyboard.press("Enter");

		expect(await announced(page)).toBe("Inserted h2: 1 of 1 in section.");
		await page.frameLocator("iframe[title^='Canvas']").getByRole("heading", { name: "Heading", level: 2 }).waitFor();
		await page.keyboard.press("ControlOrMeta+s");
		await page
			.locator("header")
			.getByRole("button", { name: "Save", exact: true })
			.and(page.locator("[disabled]"))
			.waitFor();
		expect(await draftMarkup()).toMatch(
			/<section data-wc-id="box"><h2 data-wc-id="[A-Za-z0-9]{12}">Heading<\/h2><\/section>/,
		);
	});

	test("any element by its tag, refusing what Templates never hold", async () => {
		await resetTemplate();
		const page = await builderPage();
		await layer(page, /^section/).click();
		await page.getByRole("button", { name: "Insert" }).click();
		await page.getByRole("combobox", { name: "Find an element" }).fill("Any element");
		await page.keyboard.press("Enter");
		const tag = page.getByRole("textbox", { name: "Tag name" });

		await tag.fill("script");
		await page.getByRole("button", { name: "Insert", exact: true }).last().click();
		await page.getByText("Scripts aren't allowed in a Template.").waitFor();
		await tag.fill("dl");
		await page.getByRole("button", { name: "Insert", exact: true }).last().click();

		expect(await announced(page)).toBe("Inserted dl: 1 of 1 in section.");
	});
});

test("a Media image, chosen from the Media library inside the insert menu", async () => {
	await resetTemplate();
	const { api } = await install.install.superadmin();
	const { photo, upload } = await import("../harness/images.ts");
	await api.media.upload({ siteId, file: upload(await photo({ width: 400, height: 300 }), "loaf.jpg") });
	await install.install.drainJobs();
	const page = await builderPage();
	await layer(page, /^section/).click();
	await page.getByRole("button", { name: "Insert" }).click();
	await page.getByRole("combobox", { name: "Find an element" }).fill("Image");
	await page.keyboard.press("Enter");

	await page.getByRole("button", { name: /^Choose file/ }).click();
	await page.getByRole("button", { name: /loaf\.jpg/ }).click();
	await page.getByRole("button", { name: "Insert", exact: true }).last().click();

	await expectAnnounced(page, "Inserted img: 1 of 1 in section.");
	const src = await page.frameLocator("iframe[title^='Canvas']").locator("section img").getAttribute("src");
	expect(src).toStartWith(`/api/media/${siteId}/`);
	await page.keyboard.press("ControlOrMeta+s");
	await page
		.locator("header")
		.getByRole("button", { name: "Save", exact: true })
		.and(page.locator("[disabled]"))
		.waitFor();
	expect(await draftMarkup()).toMatch(
		/<section data-wc-id="box"><img src="media:[0-9a-f-]{36}" data-wc-id="[A-Za-z0-9]{12}"><\/section>/,
	);
});

describe("the canvas", () => {
	test("selects what is clicked, and moves the selected element where it is dragged", async () => {
		await resetTemplate();
		const page = await builderPage();
		const canvas = page.frameLocator("iframe[title^='Canvas']");

		await canvas.getByText("One", { exact: true }).click();
		await expect(layer(page, /^li/).first().getAttribute("aria-selected")).resolves.toBe("true");
		// Playwright's mouse runs a script in every frame to watch for native drags, and the canvas runs
		// none, so the drag is the pointer events a person's drag makes, sent to the canvas page.
		await page.evaluate(() => {
			const frame = document.querySelector<HTMLIFrameElement>("iframe[title^='Canvas']");
			const canvasDocument = frame?.contentDocument;
			const items = [...(canvasDocument?.querySelectorAll("li") ?? [])];
			const one = items.find((item) => item.textContent === "One")?.getBoundingClientRect();
			const three = items.find((item) => item.textContent === "Three")?.getBoundingClientRect();
			if (!canvasDocument || !one || !three) throw new Error("The canvas shows no list.");
			const send = (type: string, x: number, y: number) =>
				canvasDocument
					.elementFromPoint(x, y)
					?.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true }));
			send("pointerdown", one.x + 10, one.y + one.height / 2);
			for (let step = 1; step <= 8; step++) {
				send(
					"pointermove",
					one.x + 10,
					one.y + one.height / 2 + ((three.bottom - 2 - one.y - one.height / 2) * step) / 8,
				);
			}
			send("pointerup", three.x + 10, three.bottom - 2);
		});

		expect(await announced(page)).toBe("Moved li: 3 of 3 in ul.");
		await page.keyboard.press("ControlOrMeta+s");
		await page
			.locator("header")
			.getByRole("button", { name: "Save", exact: true })
			.and(page.locator("[disabled]"))
			.waitFor();
		expect(await draftMarkup()).toContain(
			'<ul data-wc-id="list"><li data-wc-id="two">Two</li><li data-wc-id="three">Three</li><li data-wc-id="one">One</li></ul>',
		);
	});

	test("shows the Site's dark values when the dark preview is on", async () => {
		const page = await builderPage();
		const preview = page.getByRole("button", { name: "Dark preview" });

		await preview.click();

		expect(await preview.getAttribute("aria-pressed")).toBe("true");
		const theme = await page.frameLocator("iframe[title^='Canvas']").locator("html").getAttribute("data-wc-theme");
		expect(theme).toBe("dark");
	});
});

describe("the Template markup view", () => {
	test("shows the same Draft as text; what is typed there comes back as layers and saves the same Draft", async () => {
		await resetTemplate();
		const page = await builderPage();
		const markup = page.getByRole("textbox", { name: "Template markup" });
		expect(await markup.inputValue()).toBe(ENTRY_TEMPLATE);

		await markup.fill(ENTRY_TEMPLATE.replace("Fresh from the oven", "Baked daily").replace("<li", "\n  <li"));
		await page.keyboard.press("ControlOrMeta+s");
		await layer(page, /^“Baked daily”/).waitFor();
		expect(await markup.inputValue()).toContain('<ul data-wc-id="list">\n  <li data-wc-id="one">');
		await page.keyboard.press("ControlOrMeta+s");
		await page
			.locator("header")
			.getByRole("button", { name: "Save", exact: true })
			.and(page.locator("[disabled]"))
			.waitFor();

		expect(await draftMarkup()).toBe(await markup.inputValue());
	});

	test("refuses markup it can't read, saying where, and stays", async () => {
		await resetTemplate();
		const page = await builderPage();
		const markup = page.getByRole("textbox", { name: "Template markup" });
		await markup.fill('<p data-wc-id="x">\n  <script>alert(1)</script>\n</p>');

		await page.keyboard.press("ControlOrMeta+s");

		await page.getByRole("button", { name: "Line 2, column 3:" }).waitFor();
		expect(await markup.isVisible()).toBe(true);
	});
});

describe("the style panel", () => {
	test("adds a Class, makes a new one, and saves a one-off style as a generated Class", async () => {
		await resetTemplate();
		const page = await builderPage();
		await layer(page, /^p/).click();
		await page.getByRole("tab", { name: "Style" }).click();
		const css = page.getByRole("region", { name: "CSS", exact: true });
		await css.getByRole("button", { name: "Give this element a Class", exact: true }).click();
		const add = css.getByRole("combobox", { name: "Class name" });

		await add.fill("intro");
		await add.press("Enter");
		await expectAnnounced(page, "Added intro to this element.");
		await css.getByRole("button", { name: "Give this element a Class", exact: true }).click();
		await add.fill("lead-text");
		await add.press("Enter");
		await css.getByRole("tab", { name: ".lead-text", exact: true }).waitFor();
		await page.getByRole("textbox", { name: "Declarations" }).fill("color: red");
		await page.getByRole("button", { name: "Apply" }).click();
		await expectAnnounced(page, "One-off style applied.");
		expect(await announced(page)).toBe("One-off style applied.");
		await page.keyboard.press("ControlOrMeta+s");
		await page
			.locator("header")
			.getByRole("button", { name: "Save", exact: true })
			.and(page.locator("[disabled]"))
			.waitFor();

		expect(await draftMarkup()).toMatch(/<p class="intro lead-text style-[0-9a-f]{8}" data-wc-id="lead">/);
	});
});

describe("fixed text", () => {
	test("is flagged, and becomes a Field of the Post Type that clients edit", async () => {
		await resetTemplate();
		const page = await builderPage();
		await expect(
			layer(page, /^“Fresh from the oven”/)
				.getByText("Fixed text")
				.count(),
		).resolves.toBe(1);
		await layer(page, /^“Fresh from the oven”/).click();

		await page.getByRole("button", { name: "Make it a Field" }).click();
		const dialog = page.getByRole("dialog", { name: "Make it a Field" });
		await dialog.getByRole("textbox", { name: "Label" }).fill("Lead");
		await dialog.getByRole("button", { name: "Make it a Field" }).click();
		await expectAnnounced(page, "The text now reads {{ lead }}.");
		await page.keyboard.press("ControlOrMeta+s");
		await page
			.locator("header")
			.getByRole("button", { name: "Save", exact: true })
			.and(page.locator("[disabled]"))
			.waitFor();

		expect(await draftMarkup()).toContain('<p data-wc-id="lead">{{ lead }}</p>');
		const { api } = await install.install.superadmin();
		const { postType } = await api.postTypes.get({ siteId, postTypeId });
		expect(postType.fields.find((field) => field.key === "lead")).toMatchObject({
			label: "Lead",
			type: "text",
			default: "Fresh from the oven",
		});
	});
});

test("in the Site template, fixed text becomes a Global in one step; text longer than one holds is refused, adding nothing", async () => {
	const { api } = await install.install.superadmin();
	const terms = "Terms apply. ".repeat(200).trim();
	await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: `<main data-wc-id="m">{{@outlet}}</main><footer data-wc-id="f"><p data-wc-id="hours">Open daily</p><p data-wc-id="terms">${terms}</p></footer>`,
	});
	const page = await testPage("light");
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/builder/${siteId}/site-template`));
	await page.frameLocator("iframe[title^='Canvas']").getByText("Open daily").waitFor();
	const before = (await api.globals.get({ siteId })).globals.fields.map((field) => field.key);

	await layer(page, /^“Terms apply/).click();
	await page.getByRole("button", { name: "Make it a Global" }).click();
	let dialog = page.getByRole("dialog", { name: "Make it a Global" });
	await dialog.getByRole("textbox", { name: "Label" }).fill("Terms");
	await dialog.getByRole("button", { name: "Make it a Global" }).click();
	await dialog.getByText(/at most 2000 characters/).waitFor();
	expect((await api.globals.get({ siteId })).globals.fields.map((field) => field.key)).toEqual(before);
	await page.keyboard.press("Escape");

	await layer(page, /^“Open daily”/).click();
	await page.getByRole("button", { name: "Make it a Global" }).click();
	dialog = page.getByRole("dialog", { name: "Make it a Global" });
	await dialog.getByRole("textbox", { name: "Label" }).fill("Hours");
	await dialog.getByRole("button", { name: "Make it a Global" }).click();
	await expectAnnounced(page, "The text now reads {{ site.hours }}.");

	const { globals } = await api.globals.get({ siteId });
	expect(globals.fields.find((field) => field.key === "hours")).toMatchObject({ label: "Hours", type: "text" });
	expect(globals.draft).toMatchObject({ hours: "Open daily" });
});

test("an attribute keeps literal {{ as text when it is edited, written as in Template markup", async () => {
	const { api } = await install.install.superadmin();
	await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: ENTRY_TEMPLATE.replace(
			'<p data-wc-id="lead">',
			'<p title="Use \\{{ name }} &amp; more" data-wc-id="lead">',
		),
	});
	const page = await builderPage();
	await layer(page, /^p/).click();
	const value = page.getByRole("textbox", { name: "Value of attribute 1" });
	expect(await value.inputValue()).toBe("Use \\{{ name }} &amp; more");

	await value.fill("Use \\{{ name }} &amp; more!");
	await value.blur();
	await page.keyboard.press("ControlOrMeta+s");
	await page
		.locator("header")
		.getByRole("button", { name: "Save", exact: true })
		.and(page.locator("[disabled]"))
		.waitFor();

	expect(await draftMarkup()).toContain('<p title="Use \\{{ name }} &amp; more!" data-wc-id="lead">');
});

test("a Component: its fixed text becomes a Prop, saved with it, the text as its default", async () => {
	const { api } = await install.install.superadmin();
	const { component } = await api.components.create({ siteId, name: "Notice" });
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<aside data-wc-id="n"><p data-wc-id="m">Closed on Sundays</p></aside>',
	});
	const page = await testPage("light");
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/builder/${siteId}/component/${component.id}`));
	await page.frameLocator("iframe[title^='Canvas']").getByText("Closed on Sundays").waitFor();
	await layer(page, /^“Closed on Sundays”/).click();

	await page.getByRole("button", { name: "Make it a Prop" }).click();
	const dialog = page.getByRole("dialog", { name: "Make it a Prop" });
	await dialog.getByRole("textbox", { name: "Label" }).fill("Message");
	await dialog.getByRole("button", { name: "Make it a Prop" }).click();
	await expectAnnounced(page, "The text now reads {{ props.message }}.");
	// The Prop's default is the text, so the canvas shows the same words.
	await page.frameLocator("iframe[title^='Canvas']").getByText("Closed on Sundays").waitFor();
	await page.keyboard.press("ControlOrMeta+s");
	await page
		.locator("header")
		.getByRole("button", { name: "Save", exact: true })
		.and(page.locator("[disabled]"))
		.waitFor();

	const saved = await api.components.getMarkup({ siteId, componentId: component.id });
	expect(saved.markup.draft.split("{{/props}}\n")[1]).toBe(
		'<aside data-wc-id="n"><p data-wc-id="m">{{ props.message }}</p></aside>',
	);
	expect(saved.component.draft.props).toEqual([
		expect.objectContaining({ key: "message", label: "Message", type: "text", default: "Closed on Sundays" }),
	]);
});

test("Publish saves, then publishes what visitors see", async () => {
	await resetTemplate();
	const page = await builderPage();
	await layer(page, /^section/).click();
	await page.keyboard.press("Delete");

	await page.getByRole("button", { name: "Publish" }).click();
	await page.getByText("Blog posts · Entry template is published.").first().waitFor();

	const { api } = await install.install.superadmin();
	const { template } = await api.templates.getEntryTemplate({ siteId, postTypeId });
	expect(template?.id).toBe(entryTemplateId);
	expect(template?.status).toBe("published");
	expect(JSON.stringify(template?.published)).not.toContain('"box"');
});

for (const theme of THEMES) {
	test(`the Template markup view, ${theme}`, async () => {
		const page = await builderPage(theme);
		await page.getByRole("textbox", { name: "Template markup" }).waitFor();

		await page.waitForLoadState("networkidle");
		await expectAccessibleScreen(page, `Builder › Template markup (${theme})`, CANVAS);
	});
}

for (const theme of THEMES)
	test(`Component declarations preview and apply from the keyboard in ${theme}`, async () => {
		const { api } = await install.install.superadmin();
		const workspaceId = (await install.install.createWorkspace()).id;
		const siteId = (await install.install.createSite(workspaceId)).id;
		const staff = (await install.install.createStaff({ workspaces: [workspaceId] })).account;
		const { component } = await api.components.create({ siteId, name: theme === "light" ? "LightProps" : "DarkProps" });
		const page = await install.newPage(theme);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/builder/${siteId}/component/${component.id}`));
		await page.getByRole("textbox", { name: "Template markup" }).focus();
		const markup = page.getByRole("textbox", { name: "Template markup" });
		await markup.fill(
			'{{@props}}\nheading: text exposed default="Preview words"\n{{/props}}\n<h2>{{ props.heading }}</h2>',
		);
		await page.frameLocator("iframe[title^='Canvas']").getByText("Preview words").waitFor();
		await page.waitForLoadState("networkidle");
		await expectAccessibleScreen(page, `Component Props ${theme}`, CANVAS);
		await page.getByRole("tree", { name: "Layers" }).getByRole("treeitem").first().focus();
		await page.getByRole("tree", { name: "Layers" }).waitFor();
		await page.keyboard.press("ControlOrMeta+s");
		await page
			.locator("header")
			.getByRole("button", { name: "Save", exact: true })
			.and(page.locator("[disabled]"))
			.waitFor();
		const saved = await api.components.getMarkup({ siteId, componentId: component.id });
		expect(saved.component.draft.props[0]).toMatchObject({ key: "heading", exposed: true, default: "Preview words" });
	});
