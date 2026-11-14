// The building area's chrome for Staff (ADR 0037, BA-04; SPEC 2, 4, 7 and 10): the rail, the bottom
// bar and the canvas around the frame.
// - the sizes of SPEC 4 at 1440 × 900: rail and bar 48, the bar's side clusters 400, rail buttons 28
//   with 16 px icons, Publish 112 × 32;
// - a side gutter narrows the frame symmetrically; at 768 the page's own `(max-width: 768px)` matches
//   inside the frame; a width wider than the pane zooms the page out and says so; double-click and the
//   readout's reset go back to full width; the readout comes 300 ms after the pointer and leaves 1.5 s
//   after it, and names the breakpoint the width is in, from the Design system;
// - Hide interface keeps the rail, the bar and the selection's outline;
// - Dark preview switches the page's Dark mode in the frame only;
// - Exit ends the session (the next edit request answers EDIT_MODE_ENDED) and goes back to the admin;
// - under 1024 px a notice covers the shell, and widening the window gives focus back where it was;
// - the chrome passes the accessibility checks with the page in light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Frame, Page } from "playwright";

import type { TestAccount, TestBrowser } from "../harness/index.ts";
import { enterBuildingArea, focusShellStart, settled } from "./building-area.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let superadmin: TestBrowser;
let siteId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	superadmin = await local.superadmin();
	const { api } = superadmin;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Davide Del Gatto" })).account;

	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header><p>Welcome to <a href="/">Acme Bakery</a>.</p></header><main>{{@outlet}}</main><footer><p>Harbour Street, Cork.</p></footer>',
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "subtitle", label: "Subtitle", type: "text" }],
	});
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1><p>{{ subtitle }}</p></article>",
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: post } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven at seven" },
	});
	await api.entries.publish({ siteId, entryId: post.id });
	// Dark mode on, and the 768 px breakpoint named as the Site names it.
	const { draft } = (await api.designSystem.get({ siteId })).designSystem;
	await api.designSystem.saveDraft({
		siteId,
		darkMode: true,
		tokens: {
			...draft.tokens,
			breakpoints: draft.tokens.breakpoints.map((each) => (each.width === 768 ? { ...each, name: "tablet" } : each)),
		},
	});
	await api.designSystem.publish({ siteId });
});

afterAll(async () => {
	await install?.close();
});

/** A page in Chromium in the building area, on the post, `width` × `height`. */
async function opened(options: { width?: number; height?: number; returnTo?: string; signedIn?: boolean } = {}) {
	const page = await install.newPage("light");
	await page.setViewportSize({ width: options.width ?? 1440, height: options.height ?? 900 });
	// Signed in to the admin too, for the way back to land on the admin's screen.
	if (options.signedIn) await install.signIn(page, staff);
	const frame = await enterBuildingArea(install, page, {
		as: staff,
		siteId,
		slug,
		open: `/page${path}`,
		...(options.returnTo ? { returnTo: options.returnTo } : {}),
	});
	await settled(page);
	return { page, frame };
}

/** The size of an element of the shell, rounded. */
async function sizeOf(page: Page, selector: string): Promise<{ width: number; height: number }> {
	const box = await page.locator(selector).first().boundingBox();
	if (!box) throw new Error(`${selector} isn't shown.`);
	return { width: Math.round(box.width), height: Math.round(box.height) };
}

/** The frame's box on the shell's window. */
async function frameBox(page: Page) {
	const box = await page.locator("[data-wc-frame-box]").boundingBox();
	const canvas = await page.locator("[data-wc-canvas]").boundingBox();
	if (!box || !canvas) throw new Error("No frame.");
	return { box, canvas };
}

/** The page's own width, as its media queries see it. */
async function pageWidth(frame: Frame): Promise<number> {
	return frame.evaluate(() => window.innerWidth);
}

/** Drags a gutter by `dx`, `dy` pixels of the shell with the pointer. */
async function dragGutter(page: Page, side: "start" | "end" | "below", dx: number, dy = 0): Promise<void> {
	const box = await page.locator(`[data-wc-gutter="${side}"]`).boundingBox();
	if (!box) throw new Error(`No ${side} gutter.`);
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 5 });
	await page.mouse.move(x + dx, y + dy, { steps: 5 });
	await page.mouse.up();
	await settled(page);
}

/** Waits until the frame is done easing to its new size (200 ms). */
async function eased(page: Page): Promise<void> {
	await page.waitForTimeout(300);
	await settled(page);
}

const readout = (page: Page) => page.locator("[data-wc-readout]");

/**
 * One page at 1440 × 900 for the checks that leave the frame as they found it (or nearly): the link
 * that enters the building area allows only a few uses a minute from one address.
 */
let sharedPage: Promise<{ page: Page; frame: Frame }> | undefined;
function shared() {
	sharedPage ??= opened();
	return sharedPage;
}

afterAll(async () => {
	// The browser may be gone already with the Install.
	await (await sharedPage)?.page
		.context()
		.close()
		.catch(() => {});
});

describe("the building area's chrome, for Staff", () => {
	test("has the sizes of SPEC 4 at 1440 × 900", async () => {
		const { page } = await shared();
		expect(await sizeOf(page, '[data-building-region="rail"]')).toEqual({ width: 48, height: 852 });
		expect(await sizeOf(page, '[data-building-region="bar"]')).toEqual({ width: 1440, height: 48 });
		expect((await sizeOf(page, '[data-wc-bar-cluster="start"]')).width).toBe(400);
		expect((await sizeOf(page, '[data-wc-bar-cluster="end"]')).width).toBe(400);
		expect(await sizeOf(page, "[data-wc-logo]")).toEqual({ width: 28, height: 28 });
		for (const place of ["content", "templates", "media", "styles", "loops", "components", "more"]) {
			expect(await sizeOf(page, `[data-wc-place="${place}"]`)).toEqual({ width: 28, height: 28 });
			expect(await sizeOf(page, `[data-wc-place="${place}"] svg`)).toEqual({ width: 16, height: 16 });
		}
		for (const each of ["dark-preview", "panels", "hide-interface", "settings", "exit"]) {
			expect(await sizeOf(page, `[data-wc-rail="${each}"]`)).toEqual({ width: 28, height: 28 });
		}
		expect(await sizeOf(page, "[data-wc-avatar]")).toEqual({ width: 28, height: 28 });
		expect(await sizeOf(page, '[data-wc-bar="undo"]')).toEqual({ width: 30, height: 28 });
		expect(await sizeOf(page, "[data-wc-publish]")).toEqual({ width: 112, height: 32 });

		// Places are shown but not there yet; their names say so.
		expect(await page.getByRole("button", { name: "Media · not available yet" }).getAttribute("aria-disabled")).toBe(
			"true",
		);
		// The avatar names the person; Settings opens the Site's settings in the admin, in a new tab.
		expect(await page.getByRole("img", { name: "Signed in as Davide Del Gatto" }).textContent()).toBe("DG");
		const settings = page.getByRole("link", { name: "Site settings (opens in a new tab)" });
		expect(await settings.getAttribute("href")).toBe(install.adminUrl(`/sites/${siteId}/domains`));
		expect(await settings.getAttribute("target")).toBe("_blank");
		// Undo and Redo have nothing yet; Publish waits for its ticket and never changes width.
		expect(await page.locator('[data-wc-bar="undo"]').isDisabled()).toBe(true);
		expect(await page.locator('[data-wc-bar="redo"]').isDisabled()).toBe(true);
		expect(await page.locator("[data-wc-publish]").isDisabled()).toBe(true);
		expect(await page.locator("[data-wc-draft-state]").getAttribute("data-wc-draft-state")).toBe("saved");
		// The frame sits on the chrome with a 12 px gutter left, right and below.
		const { box, canvas } = await frameBox(page);
		expect(Math.round(box.x - canvas.x)).toBe(12);
		expect(Math.round(canvas.x + canvas.width - (box.x + box.width))).toBe(12);
		expect(Math.round(canvas.y + canvas.height - (box.y + box.height))).toBe(12);
	});

	test("a side gutter narrows the frame symmetrically; at 768 the page's media query matches; the readout names the breakpoint", async () => {
		const { page, frame } = await opened();
		const full = await pageWidth(frame);
		expect(full).toBe(1440 - 48 - 24);
		expect(await frame.evaluate(() => matchMedia("(max-width: 768px)").matches)).toBe(false);

		// Dragging the end gutter towards the middle takes as much off the other side.
		await dragGutter(page, "end", -(full - 768) / 2);
		expect(await pageWidth(frame)).toBe(768);
		expect(await frame.evaluate(() => matchMedia("(max-width: 768px)").matches)).toBe(true);
		const { box, canvas } = await frameBox(page);
		expect(Math.round(box.width)).toBe(768);
		expect(Math.abs(box.x - canvas.x - (canvas.x + canvas.width - (box.x + box.width)))).toBeLessThanOrEqual(1);

		// Narrower than the pane, the readout stays: the width, the height, 100 % and the breakpoint.
		await readout(page).waitFor();
		expect(await page.locator("[data-wc-width]").inputValue()).toBe("768");
		expect(await page.locator("[data-wc-zoom]").textContent()).toContain("100 %");
		expect(await page.locator("[data-wc-breakpoint]").getAttribute("data-wc-breakpoint")).toBe("tablet");
		expect(await page.locator('[data-wc-preset="tablet"]').getAttribute("aria-pressed")).toBe("true");

		// The start gutter, dragged outwards, widens by twice the move.
		await dragGutter(page, "start", -50);
		expect(await pageWidth(frame)).toBe(868);

		// Phone: under the first breakpoint, none is named.
		await page.locator('[data-wc-preset="phone"]').click();
		await eased(page);
		expect(await pageWidth(frame)).toBe(390);
		expect(await page.locator("[data-wc-breakpoint]").count()).toBe(0);

		// Double-click a gutter: back to full width, and the readout leaves 1.5 s after the pointer.
		await page.locator('[data-wc-gutter="end"]').dblclick();
		await eased(page);
		expect(await pageWidth(frame)).toBe(full);
		// Focus in the readout keeps it; away from it, and the pointer gone, it leaves.
		await focusShellStart(page);
		await page.mouse.move(700, 400);
		await readout(page).waitFor({ state: "detached", timeout: 4000 });
		await page.context().close();
	});

	test("a width wider than the pane zooms the page out and says so; the reset goes back to full width", async () => {
		const { page, frame } = await opened();
		await page.locator('[data-wc-gutter="end"]').focus();
		await readout(page).waitFor();
		const field = page.locator("[data-wc-width]");
		await field.fill("1920");
		await field.press("Enter");
		await eased(page);
		expect(await pageWidth(frame)).toBe(1920);
		const zoom = Math.round(((1440 - 48 - 24) / 1920) * 100);
		expect(await page.locator("[data-wc-zoom]").textContent()).toContain(`${zoom} %`);
		expect(await page.locator("[data-wc-zoomed-out]").textContent()).toBe(`Zoomed out to ${zoom} % to fit the width`);
		// The frame still fills the pane, the page drawn smaller in it.
		const { box } = await frameBox(page);
		expect(Math.round(box.width)).toBe(1440 - 48 - 24);
		expect(await page.locator("[data-wc-breakpoint]").getAttribute("data-wc-breakpoint")).toBe("2xl");

		await page.locator("[data-wc-reset-zoom]").click();
		await eased(page);
		expect(await pageWidth(frame)).toBe(1440 - 48 - 24);
		expect(await page.locator("[data-wc-reset-zoom]").count()).toBe(0);

		// Never narrower than 320: the keyboard way of the gutter goes no further.
		await page.locator('[data-wc-gutter="end"]').focus();
		await page.keyboard.press("Home");
		await eased(page);
		expect(await pageWidth(frame)).toBe(320);
		await page.keyboard.press("Enter");
		await eased(page);
		expect(await pageWidth(frame)).toBe(1440 - 48 - 24);
		await page.context().close();
	});

	test("the readout comes 300 ms after the pointer reaches a gutter and leaves 1.5 s after it goes", async () => {
		const { page } = await shared();
		const gutter = await page.locator('[data-wc-gutter="end"]').boundingBox();
		if (!gutter) throw new Error("No gutter.");
		await page.mouse.move(gutter.x + gutter.width / 2, gutter.y + gutter.height / 2);
		expect(await readout(page).count()).toBe(0);
		await readout(page).waitFor({ timeout: 2000 });
		await page.mouse.move(700, 400);
		await page.waitForTimeout(600);
		expect(await readout(page).count()).toBe(1);
		await readout(page).waitFor({ state: "detached", timeout: 3000 });
	});

	test("Hide interface keeps the rail, the bar and the selection's outline", async () => {
		const { page, frame } = await shared();
		const title = await frame.locator("h1").boundingBox();
		if (!title) throw new Error("No title.");
		await page.mouse.click(title.x + 5, title.y + title.height / 2);
		await page.locator('[data-wc-outline="selected"]').waitFor();

		await page.getByRole("button", { name: "Hide the interface" }).click();
		expect(await page.locator("[data-interface]").getAttribute("data-interface")).toBe("hidden");
		expect(await page.getByRole("button", { name: "Show the interface" }).isVisible()).toBe(true);
		expect(await page.locator('[data-building-region="rail"]').isVisible()).toBe(true);
		expect(await page.locator('[data-building-region="bar"]').isVisible()).toBe(true);
		expect(await page.locator('[data-wc-outline="selected"]').isVisible()).toBe(true);

		await page.getByRole("button", { name: "Show the interface" }).click();
		expect(await page.locator("[data-interface]").getAttribute("data-interface")).toBe("shown");
	});

	test("Dark preview switches the page's Dark mode in the frame only", async () => {
		const { page, frame } = await shared();
		const scheme = () => frame.evaluate(() => getComputedStyle(document.documentElement).colorScheme);
		const preview = page.getByRole("button", { name: "Dark preview" });
		expect(await preview.getAttribute("aria-pressed")).toBe("false");
		expect(await scheme()).not.toContain("dark");

		await preview.click();
		expect(await preview.getAttribute("aria-pressed")).toBe("true");
		expect(await frame.evaluate(() => document.documentElement.getAttribute("data-wc-theme"))).toBe("dark");
		expect(await scheme()).toContain("dark");
		// The shell's own document is untouched: the chrome is always dark anyway.
		expect(await page.evaluate(() => document.documentElement.hasAttribute("data-wc-theme"))).toBe(false);

		// It holds for the next page the frame shows, too.
		await Promise.all([
			frame.waitForNavigation(),
			frame.evaluate(() => {
				setTimeout(() => location.reload(), 0);
			}),
		]);
		await frame.waitForLoadState("load");
		expect(await frame.evaluate(() => document.documentElement.getAttribute("data-wc-theme"))).toBe("dark");

		await preview.click();
		expect(await frame.evaluate(() => document.documentElement.getAttribute("data-wc-theme"))).toBe("light");
	});

	test("Exit ends the session and goes back to the admin", async () => {
		const returnTo = `/sites/${siteId}/media`;
		const { page } = await opened({ returnTo, signedIn: true });
		const token = await page.evaluate(
			() =>
				(JSON.parse(document.getElementById("webcraft-building-area-config")?.textContent ?? "{}") as { token: string })
					.token,
		);
		const site = new URL(page.url());
		const held = await page.context().cookies(site.origin);
		// A second tab on the Site's address, to send an edit request from once the first has left.
		const other = await page.context().newPage();
		await other.goto(page.url());

		await page.getByRole("button", { name: "Exit" }).click();
		await page.waitForURL((url) => url.href === install.adminUrl(returnTo));
		expect(await page.context().cookies(site.origin)).not.toContainEqual(
			expect.objectContaining({ name: "webcraft.edit" }),
		);

		// The next edit request, even with the cookies the browser held, finds the session ended: it was
		// ended on the server, not only forgotten by the browser.
		await page.context().addCookies(held);
		const answer = await other.evaluate(
			async ({ path, token }) => {
				const response = await fetch("/_webcraft/edit/api/state", {
					method: "POST",
					headers: { "content-type": "application/json", "x-webcraft-edit-token": token },
					body: JSON.stringify({ path }),
				});
				return { status: response.status, code: ((await response.json()) as { code: string }).code };
			},
			{ path, token },
		);
		expect(answer).toEqual({ status: 401, code: "EDIT_MODE_ENDED" });
		await page.context().close();
	});

	test("under 1024 px a notice covers the shell; widening gives focus back where it was", async () => {
		const { page } = await opened({ width: 1280 });
		const hide = page.getByRole("button", { name: "Hide the interface" });
		await hide.focus();

		await page.setViewportSize({ width: 1000, height: 800 });
		const notice = page.getByRole("dialog", { name: "The building area needs a window at least 1024 px wide" });
		await notice.waitFor();
		expect(await page.locator('[data-building-region="rail"]').getAttribute("inert")).toBe("");
		expect(await page.locator("main#wc-canvas").getAttribute("inert")).toBe("");
		expect(await page.evaluate(() => document.activeElement?.hasAttribute("data-wc-narrow"))).toBe(true);

		await page.setViewportSize({ width: 1280, height: 800 });
		await notice.waitFor({ state: "detached" });
		expect(await page.locator('[data-building-region="rail"]').getAttribute("inert")).toBeNull();
		expect(await page.evaluate(() => document.activeElement?.getAttribute("data-wc-rail"))).toBe("hide-interface");
		await page.context().close();
	});

	for (const theme of THEMES) {
		test(`passes the accessibility checks, with the page in ${theme}, the readout open`, async () => {
			const page = await install.newPage(theme);
			await page.setViewportSize({ width: 1440, height: 900 });
			await enterBuildingArea(install, page, { as: staff, siteId, slug, open: `/page${path}` });
			// The readout shows while the frame is narrower than the pane: check it too.
			await page.locator('[data-wc-gutter="end"]').focus();
			await page.keyboard.press("ArrowLeft");
			await eased(page);
			await readout(page).waitFor();
			await expectAccessibleScreen(page, `building area chrome (${theme})`);
			await page.context().close();
		});
	}
});
