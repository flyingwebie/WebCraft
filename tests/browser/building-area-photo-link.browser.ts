// Photo and button/link popovers in client editing (ADR 0037, BA-15; SPEC 13.3, `client/03`, `client/04`),
// for a Member, in Chromium:
// - photos and links are marked like text; a click (or Enter once one has focus) opens its popover
//   beside or under it, which names it (the outline keeps no chip), closes with Escape and gives focus
//   back to it;
// - a photo: Choose from Media (the Media picker), Upload and a file dropped on the photo each put a
//   photo in the Draft; its description saves as typed, in the page's language; its Focal point moves by
//   a drag on the photo and by the arrow keys (Shift for 10); Remove photo asks for a second click;
// - a link: its words and a Page chosen from the searchable list, an email and a new tab each save to
//   the Draft and render; an address a link may not go to is refused; Remove link empties it;
// - Preview opens nothing; the popovers pass axe, light and dark.
// The building area's own test of the old editing bar's image popover, Media library and Focal point
// (`edit-mode-in-place.browser.ts`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Page } from "playwright";

import { photo, upload } from "../harness/images.ts";
import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { enterBuildingArea, eventually, settled } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, forgetPageErrors, pageErrors, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let api: TestBrowser["api"];
let editor: TestAccount;
let siteId: string;
let entryId: string;
let loaf: string;
let rolls: string;
const slug = "bakery";
const path = "/bakes/fresh-bread";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	({ api } = await local.superadmin());
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	editor = (await local.createMember({ workspaceId, role: "editor", name: "Giulia Romano" })).account;
	await api.languages.add({ siteId, code: "it" });
	const image = async (name: string, wider: number) => {
		const { media } = await api.media.upload({
			siteId,
			file: upload(await photo({ width: 640 + wider, height: 480 }), name),
		});
		return media.id;
	};
	loaf = await image("loaf.jpg", 0);
	rolls = await image("rolls.jpg", 20);
	await api.media.update({ siteId, mediaId: loaf, alt: "A round sourdough loaf" });
	await local.drainJobs();

	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>Acme Bakery</p></header><main>{{@outlet}}</main><footer><p>Harbour Street, Cork.</p></footer>",
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const pagesId = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id ?? "";
	for (const [title, pageSlug] of [
		["Home", "home"],
		["Menu", "menu"],
		["Visit us", "visit-us"],
	] as const) {
		const { entry } = await api.entries.create({ siteId, postTypeId: pagesId, title, slug: pageSlug });
		await api.entries.publish({ siteId, entryId: entry.id });
		if (pageSlug === "home") await api.pages.setHomePage({ siteId, pageId: entry.id });
	}
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Bakes",
		urlPattern: "/bakes/{slug}",
		fields: [
			{ key: "subtitle", label: "Subtitle", type: "text" },
			{ key: "cta", label: "Order button", type: "link" },
			{ key: "photo", label: "Hero photo", type: "media" },
		],
	});
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: [
			"<article><h1>{{ title }}</h1><p>{{ subtitle }}</p>",
			'<p><a href="{{ cta.url }}">{{ cta.text }}</a></p>',
			'<img src="{{ photo }}" width="480" height="360">',
			"</article>",
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven at seven", cta: { url: "/menu", text: "See the menu" }, photo: loaf },
	});
	entryId = entry.id;
	await api.entries.publish({ siteId, entryId });
	await install.goLive(siteId);
});

afterAll(async () => {
	await install?.close();
});

type Box = { x: number; y: number; width: number; height: number };

async function box(page: Page, selector: string): Promise<Box> {
	const found = await page.locator(selector).first().boundingBox();
	if (!found) throw new Error(`${selector} isn't shown.`);
	return found;
}

async function boxIn(frame: Frame, selector: string): Promise<Box> {
	const found = await frame.locator(selector).first().boundingBox();
	if (!found) throw new Error(`${selector} isn't shown in the page.`);
	return found;
}

/** Waits until the shell has said `text`. */
async function said(page: Page, text: string, timeout = 8000): Promise<void> {
	await page.waitForFunction(
		(text) => (document.querySelector("[data-wc-messages]")?.textContent ?? "").replaceAll(" ", "").includes(text),
		text,
		{ timeout },
	);
}

/** The element focus is on in the page in the frame, as `localName[data-wc-field]`. */
async function focusInPage(frame: Frame): Promise<string | null> {
	return frame.evaluate(() => {
		const element = document.activeElement;
		return element ? `${element.localName}[${element.getAttribute("data-wc-field") ?? ""}]` : null;
	});
}

/** The Draft's values of the Entry the page shows. */
async function draftFields(): Promise<Record<string, unknown>> {
	return (await api.entries.get({ siteId, entryId })).entry.draft.fields as Record<string, unknown>;
}

/**
 * Waits for an upload to be taken: the worker's jobs are run until the page's photo is another one
 * than `before`. Answers the photo it shows then.
 */
async function untilPhotoChanged(page: Page, frame: Frame, before: string | null): Promise<string> {
	for (let attempt = 0; attempt < 80; attempt++) {
		// The web process queued the job on the real clock; the test Install's clock stands still.
		await install.install.clock.set(new Date(Date.now() + 1000));
		await install.install.drainJobs();
		const now = await frame.locator(photoRegion).getAttribute("data-wc-media");
		if (now && now !== before) return now;
		await page.waitForTimeout(250);
	}
	throw new Error("The upload never reached the page.");
}

/** Waits until the frame shows `pathname` with its regions there. */
async function framedAt(page: Page, pathname: string): Promise<Frame> {
	for (let attempt = 0; attempt < 100; attempt++) {
		const handle = await page.locator("iframe[data-wc-frame]").elementHandle();
		const frame = await handle?.contentFrame();
		if (frame && new URL(frame.url()).pathname === pathname) {
			await frame.waitForLoadState("load");
			await frame.locator("h1[contenteditable]").waitFor();
			return frame;
		}
		await page.waitForTimeout(50);
	}
	throw new Error(`The frame never showed ${pathname}.`);
}

const photoRegion = 'img[data-wc-field="photo"]';
const linkRegion = 'a[data-wc-type="link"]';
const photoPopover = '[data-wc-popover="photo"]';
const linkPopover = '[data-wc-popover="link"]';

describe("photo and link popovers, for an Editor", () => {
	let page: Page;
	let frame: Frame;

	beforeAll(async () => {
		page = await install.newPage("light");
		await page.setViewportSize({ width: 1440, height: 900 });
		frame = await enterBuildingArea(install, page, { as: editor, siteId, slug, open: `/page${path}` });
		await frame.locator("h1[contenteditable]").waitFor();
		await page.locator('[data-wc-client-mark="rest"]').nth(3).waitFor();
	});

	afterAll(async () => {
		await page?.context().close();
	});

	test("photos and links are marked; a click opens the photo's popover beside it; Escape gives focus back", async () => {
		// The title, the Subtitle, the link and the photo, each outlined at rest.
		expect(await page.locator('[data-wc-client-mark="rest"]').count()).toBe(4);
		expect(await frame.locator(photoRegion).getAttribute("aria-label")).toBe("Hero photo: change the photo");
		expect(await frame.locator(photoRegion).getAttribute("aria-haspopup")).toBe("dialog");
		expect(await frame.locator(linkRegion).getAttribute("contenteditable")).toBeNull();

		const shown = await boxIn(frame, photoRegion);
		await page.mouse.move(shown.x + shown.width / 2, shown.y + shown.height / 2);
		await page.locator('[data-wc-client-chip="hover"]', { hasText: "Hero photoClick to edit" }).waitFor();

		await page.mouse.click(shown.x + shown.width / 2, shown.y + shown.height / 2);
		const popover = page.locator(photoPopover);
		await popover.waitFor();
		expect(await popover.getByRole("heading").textContent()).toBe("Hero photo");
		expect(await page.getByRole("dialog", { name: "Hero photo" }).count()).toBe(1);
		// Focus is in it, on Choose from Media; the photo is outlined, and named by the popover only.
		expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Choose from Media");
		await page.locator('[data-wc-client-mark="editing"]').waitFor();
		expect(await page.locator("[data-wc-client-chip]").count()).toBe(0);
		// Its words, as `client/03` has them.
		await popover.getByText("or drop a photo on the picture").waitFor();
		await popover.getByText("Describe the photo · English").waitFor();
		expect(await popover.locator("[data-wc-photo-alt]").inputValue()).toBe("A round sourdough loaf");
		expect(await popover.locator("[data-wc-photo-file-name]").textContent()).toMatch(/^loaf\.jpg · [\d.]+ KB$/);
		// 380 wide, beside the photo, not over it, inside the canvas.
		const card = await box(page, photoPopover);
		expect(card.width).toBe(380);
		expect(card.x + card.width <= shown.x || card.x >= shown.x + shown.width).toBe(true);
		const canvas = await box(page, "[data-wc-canvas]");
		expect(card.y).toBeGreaterThanOrEqual(canvas.y);
		expect(card.y + card.height).toBeLessThanOrEqual(canvas.y + canvas.height);

		await page.keyboard.press("Escape");
		await popover.waitFor({ state: "detached" });
		expect(await focusInPage(frame)).toBe("img[photo]");
		await page.locator('[data-wc-client-chip="focus"]', { hasText: "Hero photoPress Enter to edit" }).waitFor();
	});

	test("Choose from Media puts the chosen photo in the Draft, with the amber dot", async () => {
		// The photo has focus (from Escape): Enter opens its popover.
		await page.keyboard.press("Enter");
		const popover = page.locator(photoPopover);
		await popover.waitFor();
		await popover.getByRole("button", { name: "Choose from Media" }).click();
		const picker = page.locator("[data-wc-media-picker]");
		await picker.waitFor();
		// The popover waits hidden while the picker is up.
		expect(await popover.isHidden()).toBe(true);
		await picker.locator(`[data-wc-pick="${rolls}"]`).click();
		await picker.locator("[data-wc-pick-select]").click();
		await said(page, "Photo changed");

		expect(await eventually(draftFields, (fields) => fields.photo === rolls)).toMatchObject({ photo: rolls });
		await frame.locator(`${photoRegion}[data-wc-media="${rolls}"]`).waitFor();
		// The popover follows its photo, focus back on Choose from Media.
		await popover.locator("[data-wc-photo-file-name]", { hasText: "rolls.jpg" }).waitFor();
		expect(await page.evaluate(() => document.activeElement?.textContent)).toBe("Choose from Media");
		await page.locator('[data-wc-draft-state="changes"]').waitFor({ timeout: 6000 });
		expect(await page.locator("[data-wc-draft-state]").textContent()).toContain("1 change not published");
		await page.locator('[data-wc-client-mark="changed"]').waitFor({ timeout: 6000 });
	});

	test("Upload puts a new photo in the Draft once it is ready", async () => {
		const popover = page.locator(photoPopover);
		await popover.waitFor();
		const before = await frame.locator(photoRegion).getAttribute("data-wc-media");
		await popover.locator("[data-wc-photo-file]").setInputFiles({
			name: "rye.jpg",
			mimeType: "image/jpeg",
			buffer: Buffer.from(await photo({ width: 700, height: 500 })),
		});
		const uploaded = await untilPhotoChanged(page, frame, before);
		await said(page, "Photo changed");

		const fields = await eventually(draftFields, (now) => now.photo === uploaded);
		expect(fields.photo).toBe(uploaded);
		expect([loaf, rolls]).not.toContain(uploaded);
		await frame.locator(`${photoRegion}[data-wc-media="${String(fields.photo)}"]`).waitFor();
		await popover.locator("[data-wc-photo-file-name]", { hasText: "rye.jpg" }).waitFor();
	});

	test("a file dropped on the photo puts it in the Draft", async () => {
		await page.keyboard.press("Escape");
		await page.locator(photoPopover).waitFor({ state: "detached" });
		const before = await frame.locator(photoRegion).getAttribute("data-wc-media");
		const bytes = Buffer.from(await photo({ width: 720, height: 480 })).toString("base64");
		// The drag outlines the photo to drop on; the drop uploads it.
		await frame.evaluate(
			({ bytes, selector }) => {
				const image = document.querySelector(selector);
				if (!image) throw new Error("No photo.");
				const data = new DataTransfer();
				data.items.add(
					new File([Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0))], "spelt.jpg", { type: "image/jpeg" }),
				);
				const at = image.getBoundingClientRect();
				const init = { bubbles: true, cancelable: true, dataTransfer: data, clientX: at.x + 20, clientY: at.y + 20 };
				image.dispatchEvent(new DragEvent("dragover", init));
				(window as unknown as { droppedOn: DataTransfer }).droppedOn = data;
			},
			{ bytes, selector: photoRegion },
		);
		await page.locator('[data-wc-client-chip="hover"]', { hasText: "Drop to use this photo" }).waitFor();
		await frame.evaluate((selector) => {
			const image = document.querySelector(selector);
			const data = (window as unknown as { droppedOn: DataTransfer }).droppedOn;
			image?.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
		}, photoRegion);
		const dropped = await untilPhotoChanged(page, frame, before);

		const fields = await eventually(draftFields, (now) => now.photo === dropped);
		expect(fields.photo).toBe(dropped);
	});

	test("the description saves as typed, in the page's language", async () => {
		const shown = await boxIn(frame, photoRegion);
		await page.mouse.click(shown.x + 30, shown.y + 30);
		const popover = page.locator(photoPopover);
		await popover.waitFor();
		const mediaId = (await frame.locator(photoRegion).getAttribute("data-wc-media")) ?? "";
		const alt = popover.locator("[data-wc-photo-alt]");
		await alt.fill("A tray of golden cardamom buns");
		await said(page, "Description saved");
		const english = await eventually(
			async () => (await api.media.get({ siteId, mediaId, language: "en" })).media.alt,
			(text) => text === "A tray of golden cardamom buns",
		);
		expect(english).toBe("A tray of golden cardamom buns");
		expect(await frame.locator(photoRegion).getAttribute("alt")).toBe("A tray of golden cardamom buns");

		// The Italian page: its description is written in Italian, and the English one stays.
		await page.goto(install.siteUrl(slug, `/_webcraft/build/page/it${path}`));
		frame = await framedAt(page, `/it${path}`);
		const italian = await boxIn(frame, photoRegion);
		await page.mouse.click(italian.x + 30, italian.y + 30);
		await popover.getByText(/^Describe the photo · Ital/).waitFor();
		await popover.locator("[data-wc-photo-alt]").fill("Un vassoio di brioche al cardamomo");
		await popover.locator("[data-wc-photo-alt]").blur();
		await said(page, "Description saved");
		expect(
			await eventually(
				async () => (await api.media.get({ siteId, mediaId, language: "it" })).media.alt,
				(text) => text === "Un vassoio di brioche al cardamomo",
			),
		).toBe("Un vassoio di brioche al cardamomo");
		expect((await api.media.get({ siteId, mediaId, language: "en" })).media.alt).toBe("A tray of golden cardamom buns");
		await page.keyboard.press("Escape");
		await page.goto(install.siteUrl(slug, `/_webcraft/build/page${path}`));
		frame = await framedAt(page, path);
	});

	test("the Focal point moves by a drag on the photo and by the arrow keys, Shift for 10", async () => {
		const shown = await boxIn(frame, photoRegion);
		await page.mouse.click(shown.x + 30, shown.y + 30);
		const popover = page.locator(photoPopover);
		await popover.waitFor();
		const mediaId = (await frame.locator(photoRegion).getAttribute("data-wc-media")) ?? "";
		const focal = async () => (await api.media.get({ siteId, mediaId })).media.focalPoint;

		// Drawn on the photo itself, where the photo is.
		const area = await box(page, "[data-wc-focal-area]");
		expect(Math.abs(area.x - shown.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(area.width - shown.width)).toBeLessThanOrEqual(1);
		await page.mouse.move(area.x + area.width / 2, area.y + area.height / 2);
		await page.mouse.down();
		await page.mouse.move(area.x + area.width * 0.4, area.y + area.height * 0.6, { steps: 4 });
		await page.mouse.move(area.x + area.width * 0.25, area.y + area.height * 0.75, { steps: 4 });
		await page.mouse.up();
		const dragged = await eventually(focal, (point) => point?.x === 25 && point?.y === 75);
		expect(dragged).toEqual({ x: 25, y: 75 });
		const dot = page.getByRole("slider", { name: "Focal point" });
		expect(await dot.getAttribute("aria-valuetext")).toBe("25% across, 75% down");
		// The page's image follows, through WebCraft's own classes.
		await frame.locator(`${photoRegion}.wc-fx-25.wc-fy-75`).waitFor();

		// The dot has focus after the drag: the arrows move it by 1, Shift by 10.
		expect(await page.evaluate(() => document.activeElement?.getAttribute("role"))).toBe("slider");
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("Shift+ArrowDown");
		await page.keyboard.press("Shift+ArrowLeft");
		expect(await eventually(focal, (point) => point?.x === 16 && point?.y === 85)).toEqual({ x: 16, y: 85 });
		await said(page, "Focal point saved at 16% across, 85% down");
	});

	test("Remove photo asks for a second click, and leaves the place to add one", async () => {
		const popover = page.locator(photoPopover);
		await popover.waitFor();
		const remove = popover.locator("[data-wc-photo-remove]");
		await remove.click();
		expect(await remove.textContent()).toBe("Click again to remove");
		expect((await draftFields()).photo).not.toBeNull();
		await remove.click();
		await said(page, "Photo removed");
		expect(await eventually(draftFields, (fields) => fields.photo === null)).toMatchObject({ photo: null });
		// The empty region is still there and marked, saying what it is for.
		const empty = frame.locator('span[data-wc-field="photo"]');
		await empty.waitFor();
		expect(await empty.getAttribute("data-wc-empty-label")).toBe("Add a photo");
		const room = await empty.boundingBox();
		expect((room?.width ?? 0) > 100 && (room?.height ?? 0) > 50).toBe(true);
		await page.keyboard.press("Escape");
		await popover.waitFor({ state: "detached" });
		// Put back a photo for the checks that follow.
		await api.entries.saveDraft({ siteId, entryId, fields: { photo: loaf } });
		await page.reload();
		frame = await framedAt(page, path);
	});

	test("a link: its words and a Page from the searchable list save to the Draft and show", async () => {
		const link = frame.locator(linkRegion);
		expect(await link.getAttribute("data-wc-label")).toBe("Order button");
		const shown = await boxIn(frame, linkRegion);
		await page.mouse.move(shown.x + shown.width / 2, shown.y + shown.height / 2);
		await page.locator('[data-wc-client-chip="hover"]', { hasText: "Order buttonClick to edit" }).waitFor();
		await page.mouse.click(shown.x + shown.width / 2, shown.y + shown.height / 2);
		const popover = page.locator(linkPopover);
		await popover.waitFor();
		// Under the link, named by its Field; focus on its words.
		const card = await box(page, linkPopover);
		expect(card.width).toBe(380);
		expect(card.y).toBeGreaterThanOrEqual(shown.y + shown.height);
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-link-words"))).toBe("");
		expect(await popover.locator("[data-wc-link-words]").inputValue()).toBe("See the menu");
		expect(await popover.locator("[data-wc-link-kind]").inputValue()).toBe("page");
		await popover.locator('[data-wc-link-target="/menu"][aria-selected="true"]').waitFor();
		expect(await popover.locator("[data-wc-link-address-shown]").textContent()).toContain("/menu");
		expect(await page.locator("[data-wc-client-chip]").count()).toBe(0);

		await popover.locator("[data-wc-link-words]").fill("Come and visit");
		await popover.locator("[data-wc-link-search]").fill("visit");
		expect(await popover.locator('[role="option"]').allTextContents()).toEqual(["Visit us"]);
		await page.keyboard.press("Enter");
		await said(page, "Link saved");
		expect(
			await eventually(draftFields, (fields) => (fields.cta as { url?: string } | null)?.url === "/visit-us"),
		).toMatchObject({ cta: { url: "/visit-us", text: "Come and visit" } });
		expect(await link.getAttribute("href")).toBe("/visit-us");
		expect(await link.textContent()).toBe("Come and visit");
		// The page as Edit mode renders it again has the same.
		const rendered = await frame.evaluate(async () => (await fetch(location.href, { cache: "no-store" })).text());
		expect(rendered).toMatch(/<a href="\/visit-us"[^>]*data-wc-type="link"[^>]*>Come and visit<\/a>/);
	});

	test("an email in a new tab saves and renders; an address a link may not go to is refused", async () => {
		const popover = page.locator(linkPopover);
		await popover.locator("[data-wc-link-kind]").selectOption("email");
		await popover.locator("[data-wc-link-address]").fill("orders@acme.test");
		await popover.getByRole("switch", { name: "Open in a new tab" }).click();
		await said(page, "Link saved");
		expect(
			await eventually(draftFields, (fields) => (fields.cta as { newTab?: boolean } | null)?.newTab === true),
		).toMatchObject({ cta: { url: "mailto:orders@acme.test", text: "Come and visit", newTab: true } });
		const link = frame.locator(linkRegion);
		await frame.locator(`${linkRegion}[href="mailto:orders@acme.test"][target="_blank"]`).waitFor();
		expect(await popover.locator("[data-wc-link-address-shown]").textContent()).toBe("orders@acme.test");

		// Once published, visitors get it too, in a new tab.
		await api.entries.publish({ siteId, entryId });
		const live = await (await fetch(install.liveUrl(slug, path))).text();
		expect(live).toContain('<a href="mailto:orders@acme.test" target="_blank" rel="noopener">Come and visit</a>');

		// An address no link may go to: said under the field, and nothing saved.
		await popover.locator("[data-wc-link-kind]").selectOption("url");
		await popover.locator("[data-wc-link-address]").fill("javascript:alert(1)");
		await popover.locator("[data-wc-link-address]").press("Tab");
		await popover.locator("[data-wc-link-problem]").waitFor();
		expect(await popover.locator("[data-wc-link-problem]").textContent()).toContain(
			"A link goes to a web address (http or https)",
		);
		expect(await popover.locator("[data-wc-link-address]").getAttribute("aria-invalid")).toBe("true");
		// And the server refuses it whatever the shell sends (the browser logs the refusal it was sent to get).
		const logged = pageErrors(page).length;
		const refused = await page.evaluate(
			async ({ item }) => {
				const config = JSON.parse(document.getElementById("webcraft-building-area-config")?.textContent ?? "{}") as {
					token: string;
				};
				const response = await fetch("/_webcraft/edit/api/save", {
					method: "POST",
					headers: { "content-type": "application/json", "x-webcraft-edit-token": config.token },
					body: JSON.stringify({ item, field: "cta", value: { url: "javascript:alert(1)", text: "Click" } }),
				});
				return response.status;
			},
			{ item: `entry:${entryId}` },
		);
		expect(refused).toBe(400);
		forgetPageErrors(page, logged, (error) => error.includes("400 (Bad Request)"));
		expect((await draftFields()).cta).toMatchObject({ url: "mailto:orders@acme.test" });
		expect(await link.getAttribute("href")).toBe("mailto:orders@acme.test");
	});

	test("Remove link asks for a second click and empties it; Escape gives focus back to the link", async () => {
		const popover = page.locator(linkPopover);
		const remove = popover.locator("[data-wc-link-remove]");
		await remove.click();
		expect(await remove.textContent()).toBe("Click again to remove");
		await remove.click();
		await said(page, "Link removed");
		// The button went with the link: focus stays in the popover, on its words.
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-link-words"))).toBe(true);
		expect(await eventually(draftFields, (fields) => fields.cta === null)).toMatchObject({ cta: null });
		const link = frame.locator(linkRegion);
		await frame.locator(`${linkRegion}[href=""]`).waitFor();
		expect(await link.textContent()).toBe("");
		expect(await link.getAttribute("data-wc-empty-label")).toBe("Add a link");
		expect(await popover.locator("[data-wc-link-address-shown]").textContent()).toBe("Goes nowhere yet");
		await page.keyboard.press("Escape");
		await popover.waitFor({ state: "detached" });
		expect(await focusInPage(frame)).toBe("a[cta]");
		// Enter opens it again, empty, ready for a link.
		await page.keyboard.press("Enter");
		await popover.waitFor();
		expect(await popover.locator("[data-wc-link-words]").inputValue()).toBe("");
		await page.keyboard.press("Escape");
		await popover.waitFor({ state: "detached" });
	});

	test("the popovers pass the accessibility checks, light and dark; Preview opens nothing", async () => {
		await api.entries.saveDraft({
			siteId,
			entryId,
			fields: { cta: { url: "/menu", text: "See the menu" }, photo: loaf },
		});
		await page.reload();
		frame = await framedAt(page, path);
		for (const theme of ["light", "dark"] as const) {
			await page.emulateMedia({ colorScheme: theme });
			const photoBox = await boxIn(frame, photoRegion);
			await page.mouse.click(photoBox.x + 30, photoBox.y + 30);
			await page.locator(photoPopover).getByText("Describe the photo · English").waitFor();
			await page.mouse.move(700, 870);
			await expectNoAxeViolations(page, `photo popover (${theme})`);
			await page.keyboard.press("Escape");
			const linkBox = await boxIn(frame, linkRegion);
			await page.mouse.click(linkBox.x + 5, linkBox.y + linkBox.height / 2);
			await page.locator(`${linkPopover} [data-wc-link-results] [role="option"]`).first().waitFor();
			await page.mouse.move(700, 870);
			await expectNoAxeViolations(page, `link popover (${theme})`);
			await page.keyboard.press("Escape");
			await page.locator(linkPopover).waitFor({ state: "detached" });
		}
		await page.emulateMedia({ colorScheme: "light" });
		await expectAccessibleScreen(page, "client editing with photos and links");

		// Preview: the page as visitors see it; a click on the photo or the link opens nothing.
		await page.locator('[data-wc-segment="preview"]').click();
		await settled(page);
		const photoBox = await boxIn(frame, photoRegion);
		await page.mouse.click(photoBox.x + 30, photoBox.y + 30);
		await settled(page);
		expect(await page.locator("[data-wc-popover]").count()).toBe(0);
		expect(await frame.locator(photoRegion).getAttribute("tabindex")).toBeNull();
		expect(await frame.locator(photoRegion).getAttribute("role")).toBeNull();
		await page.locator('[data-wc-segment="edit"]').click();
		await settled(page);
		expect(await frame.locator(photoRegion).getAttribute("tabindex")).toBe("0");
	});
});
