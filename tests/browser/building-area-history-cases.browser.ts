// The Undo history's harder cases in client editing (BA-35; ADR 0036, ADR 0037 › 1.5), in Chromium, for
// a Member whose page's shared Drafts go through the test (held back, or cut off, as a network would):
// - a step the server refuses (a section put back that Members may no longer add) is skipped, with
//   its reason;
// - Undo with a section's Prop still being typed, or its save not answered yet, takes back that Prop
//   and nothing earlier;
// - a Prop the server refuses is no step: Undo takes back the last one that was accepted;
// - on an Entry's own page the history takes back its title and Fields, and Undo after publishing
//   changes the Draft only; a photo chosen and a link changed are steps too, shown again as taken back;
// - steps keep the order they were made in when an earlier save is answered later;
// - Undo while the Draft can't be reached keeps every step, says so, and works once it is back;
// - what is typed before the page's Drafts have arrived is a step all the same.
// The building area's own test of the old editing bar's cases in `edit-mode-history.browser.ts` (373,
// 410, 472, 861, 904, 1072, 1138). Each part reloads the shell first: a reload starts a new history.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiClient } from "@webcraft/api";
import type { Frame, Page } from "playwright";

import { photo, upload } from "../harness/images.ts";
import type { TestAccount } from "../harness/index.ts";
import { enterBuildingArea, frameOf, settled } from "./building-area.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let api: ApiClient;
let editor: TestAccount;
let siteId: string;
let homeId: string;
let breadId: string;
let loaf: string;
let rolls: string;
let hero: Awaited<ReturnType<ApiClient["components"]["create"]>>["component"];
const slug = "bakery";
const home = "/home";
const bread = "/blog/fresh-bread";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	({ api } = await local.superadmin());
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Mia Member" })).account;
	const image = async (name: string, wider: number) =>
		(await api.media.upload({ siteId, file: upload(await photo({ width: 400 + wider, height: 300 }), name) })).media.id;
	loaf = await image("loaf.jpg", 0);
	rolls = await image("rolls.jpg", 20);
	await local.drainJobs();

	await api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			"<header><p>{{ site.tagline }}</p></header><main>{{@outlet}}</main><footer><p>Harbour Street, Cork.</p></footer>",
	});
	await api.templates.publish({ siteId, templateId: site.template.id });

	const { component } = await api.components.create({
		siteId,
		name: "Hero",
		props: [{ key: "heading", label: "Heading", type: "text", translatable: true }],
	});
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<section><h1>{{ props.heading }}</h1><p>Fresh every morning.</p></section>",
	});
	await api.components.publish({ siteId, componentId: component.id });
	hero = component;
	const pagesId = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id ?? "";
	homeId = (await api.entries.create({ siteId, postTypeId: pagesId, title: "Home", slug: "home" })).entry.id;

	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "subtitle", label: "Subtitle", type: "text" },
			{ key: "photo", label: "Hero photo", type: "media" },
			{ key: "cta", label: "Order button", type: "link" },
		],
	});
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: [
			"<article><h1>{{ title }}</h1><p>{{ subtitle }}</p>",
			'<img src="{{ photo }}" width="320" height="240">',
			'<p><a href="{{ cta.url }}">{{ cta.text }}</a></p></article>',
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	breadId = (await api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread", slug: "fresh-bread" }))
		.entry.id;
	await reset();
});

afterAll(async () => {
	await install?.close();
});

/** Everything as each part starts: published, Members may arrange and add Hero, the Home page North and South. */
async function reset(): Promise<void> {
	await api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [hero.id] });
	await api.globals.saveDraft({ siteId, fields: { tagline: "Baked daily" } });
	await api.globals.publish({ siteId });
	const state = await api.pageLayouts.get({ siteId, entryId: homeId });
	await api.pageLayouts.save({
		siteId,
		entryId: homeId,
		basedOn: state.version,
		layout: {
			placements: ["North", "South"].map((heading) => ({
				id: heading.toLowerCase(),
				component: hero.id,
				props: hero.draft.props,
				values: { heading: { en: heading } } as never,
			})),
		},
	});
	await api.entries.publish({ siteId, entryId: homeId });
	await api.entries.saveDraft({
		siteId,
		entryId: breadId,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven", photo: loaf, cta: { url: "/order", text: "Order a loaf" } },
	});
	await api.entries.publish({ siteId, entryId: breadId });
}

/** What the Drafts hold now: the Tagline, and the Home page's sections (their headings, hidden ones marked). */
async function read() {
	const [globals, layout] = await Promise.all([
		api.globals.get({ siteId }),
		api.pageLayouts.get({ siteId, entryId: homeId }),
	]);
	return {
		tagline: String(globals.globals.draft.tagline ?? ""),
		sections: layout.layout.placements.map(
			(placement) =>
				`${(placement.values as { heading?: string }).heading ?? ""}${placement.hidden ? " (hidden)" : ""}`,
		),
	};
}

/** Waits until the Drafts hold what `wanted` names (a step reaches the server a moment after the page shows it). */
async function drafts(wanted: Partial<Awaited<ReturnType<typeof read>>>): Promise<void> {
	const picked = (seen: Awaited<ReturnType<typeof read>>) =>
		Object.fromEntries(Object.keys(wanted).map((key) => [key, seen[key as keyof typeof seen]]));
	let seen = picked(await read());
	for (let attempt = 0; attempt < 150 && JSON.stringify(seen) !== JSON.stringify(wanted); attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 100));
		seen = picked(await read());
	}
	expect(seen).toEqual(wanted);
}

async function entry() {
	return (await api.entries.get({ siteId, entryId: breadId })).entry;
}

/** The page's shared Drafts go through here: their answers held back while `holding` (the Entry's), or cut off. */
const network = {
	holding: false,
	down: false,
	held: [] as (() => void)[],
	upstreams: [] as { close(): Promise<void> }[],
	release() {
		this.holding = false;
		for (const send of this.held.splice(0)) send();
	},
};

/** Opens a page in the shell, afresh: a new history. */
async function open(page: Page, path: string): Promise<Frame> {
	await page.goto(install.siteUrl(slug, `/_webcraft/build/page${path}`));
	for (let attempt = 0; attempt < 150; attempt++) {
		const frame = await frameOf(page);
		if (new URL(frame.url()).pathname === path) {
			await frame.locator("[data-wc-item][contenteditable]").first().waitFor();
			if (path === home) await frame.locator("html.wc-arrange-on").waitFor({ state: "attached" });
			return frame;
		}
		await page.waitForTimeout(50);
	}
	throw new Error(`The frame never showed ${path}.`);
}

const undoButton = (page: Page) => page.locator('[data-wc-bar="undo"]');
const redoButton = (page: Page) => page.locator('[data-wc-bar="redo"]');

/** Waits until Undo offers `label` (its name is "Undo <label>"), or nothing for null. */
async function nextUndo(page: Page, label: string | null, timeout = 15_000): Promise<void> {
	await page.waitForFunction(
		(label) => {
			const button = document.querySelector<HTMLButtonElement>('[data-wc-bar="undo"]');
			if (!button) return false;
			return label === null
				? button.disabled
				: !button.disabled && button.getAttribute("aria-label") === `Undo ${label}`;
		},
		label,
		{ timeout },
	);
}

/** What Undo offers now: its step's words, or null. */
async function undoNow(page: Page): Promise<string | null> {
	return page.evaluate(() => {
		const button = document.querySelector<HTMLButtonElement>('[data-wc-bar="undo"]');
		return !button || button.disabled ? null : (button.getAttribute("aria-label") ?? "").replace(/^Undo /, "");
	});
}

/** Waits until the shell has said `text`. */
async function said(page: Page, text: string, timeout = 15_000): Promise<void> {
	try {
		await page.waitForFunction(
			(text) => (document.querySelector("[data-wc-messages]")?.textContent ?? "").replaceAll(" ", "").includes(text),
			text,
			{ timeout },
		);
	} catch {
		expect(((await page.locator("[data-wc-messages]").textContent()) ?? "").replaceAll(" ", "")).toContain(text);
	}
}

/** Types over a region's text from the pointer and leaves it: one finished burst, one step. */
async function typeOver(page: Page, frame: Frame, selector: string, text: string): Promise<void> {
	const region = frame.locator(selector);
	await region.scrollIntoViewIfNeeded();
	await settled(page);
	const box = await region.boundingBox();
	if (!box) throw new Error(`${selector} isn't shown.`);
	await page.mouse.click(box.x + box.width - 3, box.y + box.height / 2);
	await page.keyboard.press("ControlOrMeta+a");
	await page.keyboard.type(text);
	await page.keyboard.press("Tab");
}

/** Opens the Sections panel and a section's settings; answers its Heading box. */
async function settingsOf(page: Page, name: RegExp) {
	if ((await page.locator("[data-wc-sections-list]").count()) === 0) {
		if ((await page.locator("[data-wc-section-settings]").count()) > 0)
			await page.locator("[data-wc-side-panel-back]").click();
		else await page.locator('[data-wc-bar="sections"]').click();
		await page.locator("[data-wc-sections-list]").waitFor();
	}
	await page.getByRole("treeitem", { name }).click();
	await page.keyboard.press("Enter");
	await page.locator("[data-wc-section-settings]").waitFor();
	return page.locator("[data-wc-section-settings]").getByLabel("Heading", { exact: true });
}

/** Hides a section from its row's own button in the Sections panel. */
async function hideFromList(page: Page, name: string) {
	if ((await page.locator("[data-wc-sections-list]").count()) === 0) {
		await page.locator('[data-wc-bar="sections"]').click();
		await page.locator("[data-wc-sections-list]").waitFor();
	}
	const row = page.getByRole("treeitem", { name: new RegExp(name) });
	await row.hover();
	await row.getByRole("button", { name: `Hide ${name}`, exact: true }).click();
}

describe("the Undo history's harder cases, for a Member", () => {
	let page: Page;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		await page.routeWebSocket(/\/_webcraft\/edit\/drafts\//, (socket) => {
			if (network.down) {
				socket.close({ code: 1006 }).catch(() => {});
				return;
			}
			const server = socket.connectToServer();
			network.upstreams.push({ close: () => server.close() });
			const holds = socket.url().includes("/drafts/entry/");
			socket.onMessage((message) => server.send(message));
			server.onMessage((message) => {
				if (network.holding && holds) network.held.push(() => socket.send(message));
				else socket.send(message);
			});
		});
		await enterBuildingArea(install, page, { as: editor, siteId, slug, open: `/page${home}` });
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("a step the server refuses is skipped, with its reason", async () => {
		await reset();
		await open(page, home);
		await page.locator('[data-wc-bar="sections"]').click();
		await page.getByRole("treeitem", { name: /Hero · South/ }).click();
		await page.keyboard.press("Delete");
		await nextUndo(page, "Remove Hero · South");
		await drafts({ sections: ["North"] });
		// Staff stop allowing Hero: putting the section back would add one Members may not add.
		await api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [] });
		await undoButton(page).click();
		await said(page, "Skipped Remove Hero · South. The server refused this step.");
		await nextUndo(page, null);
		expect(await redoButton(page).isDisabled()).toBe(true);
		await drafts({ sections: ["North"] });
	});

	test("Undo with a Prop still typed in, or its save not answered, takes back that Prop and nothing earlier", async () => {
		await reset();
		const frame = await open(page, home);
		// An earlier step, which must stay: South is hidden.
		await hideFromList(page, "Hero · South");
		await nextUndo(page, "Hide or show Hero · South");

		// Typed and still in the box: nothing is a step yet. Undo finishes it first, so it is this Prop
		// that is taken back, in its place after the earlier step.
		const north = await settingsOf(page, /Hero · North/);
		await north.fill("Still typing");
		await nextUndo(page, "Hide or show Hero · South");
		await undoButton(page).click();
		await said(page, "Undid Change Hero · North");
		await nextUndo(page, "Hide or show Hero · South");
		expect(await redoButton(page).getAttribute("aria-label")).toBe("Redo Change Hero · North");
		await drafts({ sections: ["North", "South (hidden)"] });
		await frame
			.locator("main h1")
			.first()
			.filter({ hasText: /^North$/ })
			.waitFor();

		// Left, its save not answered yet: Undo waits for the answer, then takes back that Prop.
		const south = await settingsOf(page, /Hero · South/);
		await south.fill("Slow to save");
		network.holding = true;
		await south.press("Tab");
		await undoButton(page).click();
		await page.waitForTimeout(400);
		// Nothing moved while the answer was out: not this step, and not the one before it.
		expect(await redoButton(page).getAttribute("aria-label")).toBe("Redo Change Hero · North");
		network.release();
		await said(page, "Undid Change Hero · South");
		await nextUndo(page, "Hide or show Hero · South");
		expect(await redoButton(page).getAttribute("aria-label")).toBe("Redo Change Hero · South");
		await drafts({ sections: ["North", "South (hidden)"] });
	});

	test("a Prop that can't be saved is no step: Undo takes back the last one that was", async () => {
		await reset();
		const frame = await open(page, home);
		await typeOver(page, frame, 'header [data-wc-field="tagline"]', "Accepted");
		await nextUndo(page, "Edit Tagline");
		const south = await settingsOf(page, /Hero · South/);
		await south.fill("Typed into a section that is going");
		// Staff remove the section while the Member's input is still open: the input is refused.
		const now = await api.pageLayouts.get({ siteId, entryId: homeId });
		await api.pageLayouts.save({
			siteId,
			entryId: homeId,
			basedOn: now.version,
			layout: { placements: now.layout.placements.filter((placement) => placement.id !== "south") },
		});
		await said(page, "Someone changed this at the same moment");
		await nextUndo(page, "Edit Tagline");
		expect(await redoButton(page).isDisabled()).toBe(true);
		await undoButton(page).click();
		await said(page, "Undid Edit Tagline");
		await nextUndo(page, null);
		expect(await redoButton(page).getAttribute("aria-label")).toBe("Redo Edit Tagline");
		await drafts({ tagline: "Baked daily", sections: ["North"] });
	});

	test("on an Entry's own page: its title and Fields, a photo and a link are steps; Undo after publishing changes the Draft only", async () => {
		await reset();
		const frame = await open(page, bread);
		await nextUndo(page, null);
		await typeOver(page, frame, "article h1", "Fresher bread");
		await nextUndo(page, "Edit Title");
		await typeOver(page, frame, 'article [data-wc-field="subtitle"]', "Still warm");
		await nextUndo(page, "Edit Subtitle");

		// Published: visitors have both changes. The history is still there, and Undo changes the Draft only.
		await page.locator("[data-wc-publish]").click();
		await page.locator("[data-wc-publish-sheet]").waitFor();
		await page.locator("[data-wc-publish-now='publish']").click();
		await said(page, "Published");
		await page.waitForFunction(
			() => document.querySelector("[data-wc-publish]")?.getAttribute("aria-disabled") === "true",
		);
		expect((await entry()).published?.fields.subtitle).toBe("Still warm");
		await nextUndo(page, "Edit Subtitle");
		await undoButton(page).click();
		await said(page, "Undid Edit Subtitle");
		await frame
			.locator('article [data-wc-field="subtitle"]')
			.filter({ hasText: /^Out of the oven$/ })
			.waitFor();
		await page.locator("body").focus();
		await page.keyboard.press("ControlOrMeta+z");
		await said(page, "Undid Edit Title");
		await frame
			.locator("article h1")
			.filter({ hasText: /^Fresh bread$/ })
			.waitFor();
		let read = await entry();
		expect([read.draft.title, read.draft.fields.subtitle]).toEqual(["Fresh bread", "Out of the oven"]);
		expect([read.published?.title, read.published?.fields.subtitle]).toEqual(["Fresher bread", "Still warm"]);

		// A photo chosen from Media is a step; taken back, the page shows the photo it had.
		const photoRegion = frame.locator('img[data-wc-field="photo"]');
		await photoRegion.click();
		const popover = page.locator('[data-wc-popover="photo"]');
		await popover.getByRole("button", { name: "Choose from Media" }).click();
		const picker = page.locator("[data-wc-media-picker]");
		await picker.locator(`[data-wc-pick="${rolls}"]`).click();
		await picker.locator("[data-wc-pick-select]").click();
		await frame.locator(`img[data-wc-field="photo"][data-wc-media="${rolls}"]`).waitFor();
		await nextUndo(page, "Edit Hero photo");
		await page.keyboard.press("Escape");
		await popover.waitFor({ state: "detached" });
		await undoButton(page).click();
		await said(page, "Undid Edit Hero photo");
		await frame.locator(`img[data-wc-field="photo"][data-wc-media="${loaf}"]`).waitFor();
		await nextUndo(page, null);
		read = await entry();
		expect(read.draft.fields.photo).toBe(loaf);
		await redoButton(page).click();
		await said(page, "Redid Edit Hero photo");
		await frame.locator(`img[data-wc-field="photo"][data-wc-media="${rolls}"]`).waitFor();
		expect((await entry()).draft.fields.photo).toBe(rolls);

		// A link's words changed are a step; taken back, the link shows its words again.
		await frame.locator('a[data-wc-type="link"]').click();
		const linkPopover = page.locator('[data-wc-popover="link"]');
		await linkPopover.locator("[data-wc-link-words]").fill("Order two loaves");
		await frame
			.locator('a[data-wc-type="link"]')
			.filter({ hasText: /^Order two loaves$/ })
			.waitFor();
		await nextUndo(page, "Edit Order button");
		await page.keyboard.press("Escape");
		await linkPopover.waitFor({ state: "detached" });
		await undoButton(page).click();
		await said(page, "Undid Edit Order button");
		await frame
			.locator('a[data-wc-type="link"]')
			.filter({ hasText: /^Order a loaf$/ })
			.waitFor();
		expect((await entry()).draft.fields.cta).toEqual({ url: "/order", text: "Order a loaf" });
		expect(await frame.locator('a[data-wc-type="link"]').getAttribute("href")).toBe("/order");
		await expectAccessibleScreen(page, "Client editing › the Undo history on an Entry's page");
	});

	test("steps keep the order they were made in when an earlier save is answered later", async () => {
		await reset();
		const frame = await open(page, home);
		// The Prop is made first, and its save isn't answered yet.
		const north = await settingsOf(page, /Hero · North/);
		await north.fill("Made first");
		network.holding = true;
		await north.press("Tab");
		// The Tagline is typed second, and its save is answered at once.
		await typeOver(page, frame, 'header [data-wc-field="tagline"]', "Made second");
		await drafts({ tagline: "Made second" });
		// It isn't offered ahead of the earlier step, which is still on its way.
		await page.waitForTimeout(300);
		await nextUndo(page, null);
		network.release();
		// Both are steps now, newest first: the Tagline, then the Prop.
		await nextUndo(page, "Edit Tagline");
		await undoButton(page).click();
		await said(page, "Undid Edit Tagline");
		await nextUndo(page, "Change Hero · North");
		await undoButton(page).click();
		await said(page, "Undid Change Hero · North");
		await nextUndo(page, null);
		await drafts({ tagline: "Baked daily", sections: ["North", "South"] });
	});

	for (const theme of ["light", "dark"] as const) {
		test(`Undo while the Draft can't be reached keeps every step, says so, and works once it is back (${theme})`, async () => {
			await reset();
			await page.emulateMedia({ colorScheme: theme });
			const frame = await open(page, home);
			try {
				// Two steps: text typed in place (saved by a request) and a section hidden.
				await typeOver(page, frame, 'header [data-wc-field="tagline"]', "Typed while online");
				await nextUndo(page, "Edit Tagline");
				await hideFromList(page, "Hero · South");
				await nextUndo(page, "Hide or show Hero · South");

				// The server goes away. Undo can't reach the Draft: the step stays, and so does the one before it.
				network.down = true;
				for (const upstream of network.upstreams.splice(0)) await upstream.close().catch(() => {});
				const kept =
					"Hide or show Hero · South wasn't undone and stays in the history. The Draft can't be changed right now. Try again in a moment.";
				await undoButton(page).click();
				await said(page, kept, 30_000);
				await nextUndo(page, "Hide or show Hero · South");
				expect(await redoButton(page).isDisabled()).toBe(true);
				await drafts({ tagline: "Typed while online", sections: ["North", "South (hidden)"] });
				await expectAccessibleScreen(page, `Client editing › Undo while the Draft can't be reached (${theme})`);

				// It is back: the same steps are taken back, newest first.
				network.down = false;
				let undone = false;
				for (let tries = 0; tries < 40 && !undone; tries++) {
					await undoButton(page).click();
					await page.waitForTimeout(500);
					undone = (await undoNow(page)) === "Edit Tagline";
				}
				expect(undone).toBe(true);
				await said(page, "Undid Hide or show Hero · South");
				await undoButton(page).click();
				await said(page, "Undid Edit Tagline");
				await nextUndo(page, null);
				await drafts({ tagline: "Baked daily", sections: ["North", "South"] });
				expect(await redoButton(page).getAttribute("aria-label")).toBe("Redo Edit Tagline");
			} finally {
				network.down = false;
				await page.emulateMedia({ colorScheme: "light" });
			}
		});
	}

	test("what is typed before the page's Drafts have arrived is a step all the same", async () => {
		await reset();
		// The Entry's Draft is held back from the start: what it holds arrives after the person has typed.
		network.holding = true;
		const frame = await open(page, bread);
		try {
			await typeOver(page, frame, 'article [data-wc-field="subtitle"]', "Typed early");
			await nextUndo(page, "Edit Subtitle");
			expect((await entry()).draft.fields.subtitle).toBe("Typed early");
			// The Draft as the server holds it arrives meanwhile: what was typed stays.
			network.release();
			await page.waitForTimeout(400);
			expect(await frame.locator('article [data-wc-field="subtitle"]').textContent()).toBe("Typed early");
			await undoButton(page).click();
			await said(page, "Undid Edit Subtitle");
			await frame
				.locator('article [data-wc-field="subtitle"]')
				.filter({ hasText: /^Out of the oven$/ })
				.waitFor();
			expect((await entry()).draft.fields.subtitle).toBe("Out of the oven");
		} finally {
			network.release();
		}
	});
});
