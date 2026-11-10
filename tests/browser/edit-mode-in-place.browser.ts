// Edit mode in a real browser, beyond text: the image popover (the Media library, alt text, the Focal
// point from the keyboard), a Loop's items (their tools from the keyboard, the item form, Undo after
// removing one), the Page details drawer, and the phone layout (a compact bar, bottom sheets for
// Preview, the language, Page details and Publish, the text toolbar above the on-screen keyboard, touch
// targets of at least 44 px). Each passes axe and the keyboard checks, in light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Cookie, Page } from "playwright";

import { photo, upload } from "../harness/images.ts";
import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
let editor: TestAccount;
/** Two more people editing, for presence: each person may have at most 20 shared Drafts open at once. */
let pat: TestAccount;
let theo: TestAccount;
let siteId: string;
let entryId: string;
let loopId: string;
let loaf: string;
let rolls: string;
const slug = "bakery";
const path = "/recipes/sourdough";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Erin Editor" })).account;
	pat = (await local.createMember({ workspaceId, role: "editor", name: "Pat Baker" })).account;
	theo = (await local.createMember({ workspaceId, role: "editor", name: "Theo Writer" })).account;
	await api.languages.add({ siteId, code: "it" });
	const image = async (name: string, colourful: number) => {
		const { media } = await api.media.upload({
			siteId,
			file: upload(await photo({ width: 640 + colourful, height: 480 }), name),
		});
		return media.id;
	};
	loaf = await image("loaf.jpg", 0);
	rolls = await image("rolls.jpg", 20);
	await api.media.update({ siteId, mediaId: loaf, alt: "A round sourdough loaf" });
	await local.drainJobs();

	const { loop } = await api.loops.create({
		siteId,
		name: "our-bakes",
		source: "items",
		fields: [
			{ key: "name", label: "Name", type: "text" },
			{ key: "price", label: "Price", type: "text", translatable: false },
			{ key: "photo", label: "Photo", type: "media" },
			{ key: "soldOut", label: "Sold out today", type: "boolean" },
		],
	});
	loopId = loop.id;
	await api.loops.saveItems({
		siteId,
		loopId,
		items: [
			{ name: "Country sourdough", price: "€6.50", photo: loaf },
			{ name: "Cardamom bun", price: "€3.20", photo: rolls },
			{ name: "Seeded rye", price: "€5.90" },
		],
	});
	await api.loops.publish({ siteId, loopId });

	const { postType } = await api.postTypes.create({
		siteId,
		name: "Recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "intro", label: "Intro", type: "richText" },
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "photo", label: "Photo", type: "media" },
		],
		summaryField: "summary",
	});
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: '<header><p><a href="/">Acme Bakery</a></p></header><main>{{@outlet}}</main><footer><p>Cork</p></footer>',
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: [
			"<article><h1>{{ title }}</h1><div>{{ intro }}</div>",
			'<img src="{{ photo }}" width="320">',
			"<h2>Our bakes</h2>",
			'<ul>{{@loop our-bakes as bake}}<li><h3>{{ bake.name }}</h3><p>{{ bake.price }}</p><img src="{{ bake.photo }}" width="160"></li>{{/loop}}</ul>',
			"</article>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Sourdough",
		fields: { intro: "<p>Our country loaf.</p>", summary: "A loaf with a crackling crust.", photo: loaf },
	});
	entryId = entry.id;
	await api.entries.publish({ siteId, entryId });
});

afterAll(async () => {
	await install.close();
});

/** Each person's edit cookie from the first time Edit mode opened, handed to later pages (the link works once). */
const editCookies = new Map<string, Cookie[]>();

/**
 * A page in Edit mode, the first time through "Edit on site" in the admin: as the Editor unless
 * another person is given, at a phone's size with `phone`.
 */
async function editModePage(theme: Theme, options: { phone?: boolean; as?: TestAccount } = {}): Promise<Page> {
	const person = options.as ?? editor;
	const page = await install.newPage(theme);
	if (options.phone) await page.setViewportSize({ width: 390, height: 844 });
	const cookies = editCookies.get(person.email);
	if (cookies) {
		await page.context().addCookies(cookies);
	} else {
		await install.signIn(page, person);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname === new URL(install.siteUrl(slug, "/")).hostname);
		editCookies.set(
			person.email,
			(await page.context().cookies()).filter((cookie) => cookie.name === "webcraft.edit"),
		);
	}
	// The first-time hint is dismissed once, as people do: it stays out of later checks.
	await page.addInitScript(() => {
		try {
			window.localStorage.setItem("webcraft-edit-hint", "seen");
		} catch {
			// No storage: the hint shows.
		}
	});
	await page.goto(install.siteUrl(slug, path));
	await page.locator("webcraft-edit-bar").waitFor({ state: "attached" });
	await page.getByRole("button", { name: options.phone ? "Edit mode menu" : "Publish", exact: true }).waitFor();
	return page;
}

/** What `read` gives once `done` accepts it, waiting up to 8 seconds. */
async function eventually<Value>(read: () => Promise<Value>, done: (value: Value) => boolean): Promise<Value> {
	const deadline = Date.now() + 8000;
	let value = await read();
	while (!done(value) && Date.now() < deadline) {
		await Bun.sleep(200);
		value = await read();
	}
	return value;
}

async function admin() {
	return (await install.install.superadmin()).api;
}

/** The text of the bar's live region (what screen readers were just told). */
async function announced(page: Page): Promise<string> {
	return page.evaluate(
		() => document.querySelector("webcraft-edit-bar")?.shadowRoot?.querySelector('p[role="status"]')?.textContent ?? "",
	);
}

for (const theme of THEMES) {
	describe(`Edit mode in place, ${theme}`, () => {
		test("the page with image regions and a Loop's items", async () => {
			const page = await editModePage(theme);

			await expectAccessibleScreen(page, `Edit mode with images and Loop items (${theme})`);
		});

		test("the image popover", async () => {
			const page = await editModePage(theme);

			await expectOverlayUsable(
				page,
				page.locator('img[data-wc-item^="entry:"][data-wc-field="photo"]'),
				"dialog",
				`Edit mode › image popover (${theme})`,
			);
		});

		test("the Media library, from the image popover", async () => {
			const page = await editModePage(theme);
			await page.locator('img[data-wc-item^="entry:"][data-wc-field="photo"]').click();
			const choose = page.getByRole("button", { name: "Choose from Media" });
			await choose.focus();

			await page.keyboard.press("Enter");
			const library = page.getByRole("dialog", { name: "Choose an image: Photo" });
			await library.getByRole("button", { name: /^rolls\.jpg/ }).waitFor();
			await expectNoAxeViolations(page, `Edit mode › Media library (${theme})`, ["region"]);
			expect(
				await page.getByRole("searchbox", { name: "Search images" }).evaluate((element) => {
					const active = (element.getRootNode() as ShadowRoot).activeElement;
					return active === element;
				}),
			).toBe(true);

			// Escape closes the library; the image popover it was opened from is back, focus on its button.
			await page.keyboard.press("Escape");
			await library.waitFor({ state: "hidden" });
			await page.waitForFunction(() => {
				const root = document.querySelector("webcraft-edit-bar")?.shadowRoot;
				return root?.activeElement?.textContent === "Choose from Media";
			});
		});

		test("a Loop item's form", async () => {
			const page = await editModePage(theme);
			await page.locator("li").first().focus();
			await page.keyboard.press("Alt+F10");
			const editItem = page.getByRole("toolbar").getByRole("button", { name: "Edit item" });

			await expectOverlayUsable(page, editItem, "dialog", `Edit mode › Loop item form (${theme})`);
		});

		test("the Page details drawer", async () => {
			const page = await editModePage(theme);

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Page details" }),
				"dialog",
				`Edit mode › Page details (${theme})`,
			);
		});

		test("the phone layout and its bottom sheets", async () => {
			const page = await editModePage(theme, { phone: true });

			await expectAccessibleScreen(page, `Edit mode on a phone (${theme})`);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Edit mode menu" }),
				"dialog",
				`Edit mode on a phone › menu sheet (${theme})`,
			);
		});
	});
}

describe("images in place", () => {
	test("choosing an image in the Media library puts it in the Draft and shows it", async () => {
		const page = await editModePage("light");
		await page.locator('img[data-wc-item^="entry:"][data-wc-field="photo"]').click();
		await page.getByRole("button", { name: "Choose from Media" }).click();

		await page.getByRole("button", { name: /^rolls\.jpg/ }).click();

		const photoOf = async () => (await (await admin()).entries.get({ siteId, entryId })).entry.draft.fields.photo;
		expect(await eventually(photoOf, (value) => value === rolls)).toBe(rolls);
		await page.locator(`img[data-wc-item^="entry:"][data-wc-media="${rolls}"]`).waitFor();
		expect(await announced(page)).toBe("Image changed");
		// The popover stays open on the new image, for its alt text and Focal point.
		await page.getByRole("dialog").getByText("Alt text · English").waitFor();
		await (await admin()).entries.saveDraft({ siteId, entryId, fields: { photo: loaf } });
	});

	test("the Focal point moves with the arrow keys, its value shown, and is saved on the image", async () => {
		const page = await editModePage("light");
		await page.locator('img[data-wc-item^="entry:"][data-wc-field="photo"]').click();
		const dot = page.getByRole("slider", { name: "Focal point" });

		await dot.focus();
		await page.keyboard.press("Shift+ArrowLeft");
		await page.keyboard.press("Shift+ArrowLeft");
		await page.keyboard.press("ArrowDown");

		expect(await dot.getAttribute("aria-valuetext")).toBe("30% across, 51% down");
		await page.getByText("30% across, 51% down").first().waitFor();
		const focal = async () => (await (await admin()).media.get({ siteId, mediaId: loaf })).media.focalPoint;
		expect(await eventually(focal, (point) => point?.x === 30)).toEqual({ x: 30, y: 51 });
		// The page's image follows at once, through WebCraft's own classes (no inline style).
		expect(await page.locator('img[data-wc-item^="entry:"][data-wc-field="photo"]').getAttribute("class")).toContain(
			"wc-focus wc-fx-30 wc-fy-50",
		);
		await (await admin()).media.update({ siteId, mediaId: loaf, focalPoint: null });
	});

	test("alt text is typed in the page's language and saved on the Media item", async () => {
		const page = await editModePage("light");
		await page.locator('img[data-wc-item^="entry:"][data-wc-field="photo"]').click();
		const alt = page.getByRole("textbox", { name: "Alt text · English" });

		await alt.fill("A round loaf with a dark crust");

		const altOf = async () => (await (await admin()).media.get({ siteId, mediaId: loaf })).media.alt;
		expect(await eventually(altOf, (value) => value !== "A round sourdough loaf")).toBe(
			"A round loaf with a dark crust",
		);
		await (await admin()).media.update({ siteId, mediaId: loaf, alt: "A round sourdough loaf" });
	});
});

describe("a Loop's items in place", () => {
	const names = async () =>
		(await (await admin()).loops.get({ siteId, loopId })).loop.draft.items.map((item) => item.name);

	test("Alt+F10 reaches an item's tools; moving it later is announced and saved", async () => {
		const page = await editModePage("light");
		await page.locator("li").first().focus();
		await page.waitForFunction(
			() =>
				document.querySelector("webcraft-edit-bar")?.shadowRoot?.querySelector('p[role="status"]')?.textContent ===
				"our-bakes · item 1 of 3. Alt+F10 for its tools.",
		);

		await page.keyboard.press("Alt+F10");
		const toolbar = page.getByRole("toolbar", { name: "Tools for our-bakes · item 1 of 3" });
		await toolbar.waitFor();
		// Move earlier is off for the first item; the arrow keys go through the tools.
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("Enter");

		expect(await eventually(names, (list) => list[0] !== "Country sourdough")).toEqual([
			"Cardamom bun",
			"Country sourdough",
			"Seeded rye",
		]);
		await page.waitForFunction(
			() =>
				document.querySelector("webcraft-edit-bar")?.shadowRoot?.querySelector('p[role="status"]')?.textContent ===
				"Moved to place 2 of 3",
		);
		expect(await page.locator("li h3").allTextContents()).toEqual(["Cardamom bun", "Country sourdough", "Seeded rye"]);
		await page.getByRole("button", { name: "Publish", exact: true }).click();
		await page.getByRole("button", { name: "Discard changes" }).click();
		await page.getByRole("button", { name: "Discard", exact: true }).click();
		expect(await eventually(names, (list) => list[0] === "Country sourdough")).toEqual([
			"Country sourdough",
			"Cardamom bun",
			"Seeded rye",
		]);
	});

	test("a removed item comes back with Undo", async () => {
		const page = await editModePage("light");
		await page.locator("li").nth(2).focus();
		await page.keyboard.press("Alt+F10");

		await page.getByRole("toolbar").getByRole("button", { name: "Remove" }).click();

		expect(await eventually(names, (list) => list.length === 2)).toEqual(["Country sourdough", "Cardamom bun"]);
		await page.getByRole("status").getByRole("button", { name: "Undo" }).click();
		expect(await eventually(names, (list) => list.length === 3)).toEqual([
			"Country sourdough",
			"Cardamom bun",
			"Seeded rye",
		]);
		await page.locator("li h3", { hasText: "Seeded rye" }).waitFor();
	});

	test("the item form saves a Field the page doesn't show", async () => {
		const page = await editModePage("light");
		await page.locator("li").nth(1).focus();
		await page.keyboard.press("Alt+F10");
		await page.keyboard.press("Enter");

		await page.getByRole("switch", { name: "Sold out today" }).click();

		const soldOut = async () =>
			(await (await admin()).loops.get({ siteId, loopId })).loop.draft.items[1]?.soldOut === true;
		expect(await eventually(soldOut, Boolean)).toBe(true);
		await (await admin()).loops.saveItems({
			siteId,
			loopId,
			items: (await (await admin()).loops.get({ siteId, loopId })).loop.draft.items.map((item) => ({
				id: item.id,
				soldOut: false,
			})),
		});
	});
});

describe("Page details", () => {
	test("the SEO title shows its fallback, counts its characters, and goes to the Draft", async () => {
		const page = await editModePage("light");
		await page.getByRole("button", { name: "Page details" }).click();
		const seoTitle = page.getByRole("textbox", { name: "SEO title · English" });

		expect(await seoTitle.getAttribute("placeholder")).toBe("Sourdough · Acme Bakery");
		await seoTitle.fill("Sourdough in Cork");

		await page.getByText("17 of 60 characters").waitFor();
		const seoOf = async () => (await (await admin()).entries.get({ siteId, entryId })).entry.draft.seo.title;
		expect(await eventually(seoOf, (value) => value !== null)).toBe("Sourdough in Cork");
		await (await admin()).entries.saveDraft({ siteId, entryId, seo: { title: null } });
	});
});

describe("on a phone", () => {
	test("the bar is compact; its menu sheet holds Preview, the language, Page details and Publish", async () => {
		const page = await editModePage("light", { phone: true });

		await page.getByRole("button", { name: "Edit mode menu" }).click();
		const sheet = page.getByRole("dialog", { name: "Sourdough" });
		for (const name of ["Preview", "Language", "Page details", "Publish page"]) {
			await sheet.getByRole("button", { name: new RegExp(`^${name}`) }).waitFor();
		}
		await sheet.getByRole("button", { name: /^Publish page/ }).click();
		await page.getByRole("dialog", { name: "Publish Sourdough" }).waitFor();
		await expectNoAxeViolations(page, "Edit mode on a phone › Publish sheet", ["region"]);
	});

	test("every control people tap is at least 44 pixels tall", async () => {
		const page = await editModePage("light", { phone: true });
		await page.getByRole("button", { name: "Edit mode menu" }).click();
		await page.getByRole("dialog").waitFor();

		const small = await page.evaluate(() => {
			const root = document.querySelector("webcraft-edit-bar")?.shadowRoot;
			const controls = [...(root?.querySelectorAll<HTMLElement>("button, a[href], input, select") ?? [])];
			return controls
				.filter((control) => {
					const rect = control.getBoundingClientRect();
					return rect.width > 0 && rect.height > 0 && (rect.height < 44 || rect.width < 44);
				})
				.map((control) => control.getAttribute("aria-label") ?? control.textContent);
		});
		expect(small).toEqual([]);
	});

	test("the text toolbar sits above the on-screen keyboard", async () => {
		const page = await editModePage("light", { phone: true });
		const intro = page.locator('div[data-wc-field="intro"]');

		await intro.focus();
		// The on-screen keyboard leaves the top of the screen to the page: the visual viewport shrinks.
		await page.setViewportSize({ width: 390, height: 460 });
		await page.keyboard.type(" ");

		const gap = await page.evaluate(() => {
			const toolbar = document.querySelector("webcraft-edit-bar")?.shadowRoot?.querySelector(".toolbar-wrap");
			const bottom = toolbar?.getBoundingClientRect().bottom ?? 0;
			return (window.visualViewport?.height ?? window.innerHeight) - bottom;
		});
		expect(gap).toBeGreaterThanOrEqual(0);
		expect(gap).toBeLessThan(16);
	});
});

describe("Co-editing presence", () => {
	test("others see who is on an image or a Loop item, outlined with their name", async () => {
		const mine = await editModePage("light", { as: pat });
		const theirs = await editModePage("light", { as: theo });
		const presence = () =>
			theirs.evaluate(() =>
				[...(document.querySelector("webcraft-edit-bar")?.shadowRoot?.querySelectorAll(".presence-tag") ?? [])].map(
					(tag) => tag.textContent,
				),
			);

		await mine.locator("li").nth(1).focus();
		// Pages earlier tests left open are people here too: what matters is the one this page is on.
		const pats = (tags: (string | null)[]) => tags.filter((tag) => tag?.includes("Pat Baker"));
		expect(pats(await eventually(presence, (tags) => pats(tags).length > 0))).toEqual([
			expect.stringMatching(/^(Erin Editor, )?Pat Baker is here$/) as unknown as string,
		]);
		const boxed = await theirs.evaluate(
			() => document.querySelector("webcraft-edit-bar")?.shadowRoot?.querySelectorAll(".presence-box").length ?? 0,
		);
		expect(boxed).toBeGreaterThanOrEqual(1);

		await mine.locator('img[data-wc-item^="entry:"][data-wc-field="photo"]').click();
		const outlined = () =>
			theirs.locator('img[data-wc-item^="entry:"][data-wc-field="photo"]').evaluate((image) => image.style.outline);
		expect(await eventually(outlined, (outline) => outline.includes("solid"))).toContain("solid");
	});
});
