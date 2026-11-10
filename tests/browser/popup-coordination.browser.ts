import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Page } from "playwright";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, pageErrors, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let workspaceId: string;
let count = 0;
const rules = {
	paths: [],
	postTypeIds: [],
	entryIds: [],
	languages: [],
	devices: ["phone", "tablet", "desktop"],
	visitors: "all",
};
beforeAll(async () => {
	install = await startBrowserInstall();
	const { api } = await install.install.superadmin();
	await api.modules.approve({ moduleId: "popups", version: "1.0.0" });
	workspaceId = (await install.install.createWorkspace()).id;
});
afterAll(async () => {
	await install.close();
});
async function scene(
	configs: Record<string, unknown>[],
	options: { banner?: boolean; links?: boolean; tall?: boolean; navigation?: boolean } = {},
) {
	const { api } = await install.install.superadmin();
	const slug = `popup-${++count}`;
	const siteId = (await install.install.createSite(workspaceId, { slug })).id;
	await install.goLive(siteId);
	let commands = "";
	for (const [index, config] of configs.entries()) {
		install.install.clock.advance(1);
		const { popup } = await api.popups.create({ siteId, name: `Promotion ${index + 1}`, key: `offer-${index + 1}` });
		await api.components.saveMarkup({
			siteId,
			componentId: popup.componentId,
			markup: `<p>{{ props.text }}</p><a id="${typeof config.mainButton === "string" ? config.mainButton.slice(1) : `accept-${index + 1}`}" href="#result">Continue</a>`,
		});
		await api.popups.saveDraft({ siteId, popupId: popup.id, popup: { trigger: { kind: "load" }, rules, ...config } });
		await api.popups.saveContent({
			siteId,
			popupId: popup.id,
			values: { title: `Promotion ${index + 1}`, text: "An accessible promotion.", enabled: true },
		});
		await api.popups.publish({ siteId, popupId: popup.id });
		await api.popups.publishContent({ siteId, popupId: popup.id });
		if (options.links) commands += `{{@popup offer-${index + 1}}}`;
	}
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Pages for promotions",
		urlPattern: "/promotions/{slug}",
	});
	const saved = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<h1>{{ title }}</h1>${options.navigation ? '<a href="#target">Read details</a>' : ""}${commands}${options.banner ? "{{@consentSettings}}" : ""}${options.tall ? "<p>Further down this page.</p>".repeat(120) : ""}<p id="target">Reached the offer.</p><p id="result">Continue reading.</p>`,
	});
	await api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Offers", slug: "offers" });
	await api.entries.publish({ siteId, entryId: entry.id });
	return install.liveUrl(slug, "/promotions/offers");
}
async function shown(page: Page, name = "Promotion 1") {
	const dialog = page.getByRole("dialog", { name, exact: true });
	await dialog.waitFor({ state: "visible", timeout: 5000 });
	return dialog;
}

test("consent starts the delay; the opened dialog has keyboard focus and reduced motion", async () => {
	const url = await scene([{ trigger: { kind: "delay", seconds: 5 } }], { banner: true });
	const page = await install.newPage("dark");
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.clock.install();
	await page.goto(url);
	await page.clock.fastForward(20000);
	expect(await page.locator("dialog.wc-popup[open]").count()).toBe(0);
	await page.getByRole("button", { name: "Reject all", exact: true }).click();
	await page.clock.fastForward(4000);
	expect(await page.locator("dialog.wc-popup[open]").count()).toBe(0);
	await page.clock.fastForward(1000);
	const dialog = await shown(page);
	expect(await dialog.evaluate((e) => getComputedStyle(e).animationName)).toBe("none");
	await expectNoAxeViolations(page, "delayed promotion after consent");
	await page.keyboard.press("Escape");
	await dialog.waitFor({ state: "detached" });
	await page.close();
});

test("simultaneous Triggers use one promotion slot and one Bar, including unmount and navigation", async () => {
	const url = await scene([{ layout: "modal" }, { layout: "slide-in" }, { layout: "bar" }]);
	const page = await install.newPage("light");
	await page.goto(url);
	const first = await shown(page);
	expect(await page.locator("dialog.wc-popup[open]").count()).toBe(2);
	await expectNoAxeViolations(page, "Modal alongside a Bar");
	await first.evaluate((e) => e.remove());
	const second = await shown(page, "Promotion 2");
	expect(await page.locator("dialog.wc-popup[open]").count()).toBe(2);
	await expectNoAxeViolations(page, "Slide-in alongside a Bar");
	await second.getByRole("button", { name: "Close", exact: true }).focus();
	await page.keyboard.press("Escape");
	await second.waitFor({ state: "detached" });
	expect(await page.locator("dialog.wc-popup[open]").count()).toBe(1);
	await page.goto("about:blank");
	expect(await page.getByRole("dialog").count()).toBe(0);
	expect(pageErrors(page)).toEqual([]);
	await page.close();
});

test("fragment navigation preserves Click and pending automatic Triggers", async () => {
	const url = await scene([{ trigger: { kind: "click" } }, { trigger: { kind: "delay", seconds: 5 } }], {
		links: true,
		navigation: true,
	});
	const page = await install.newPage("dark");
	await page.clock.install();
	await page.goto(url);
	await page.getByRole("link", { name: "Read details", exact: true }).click();
	await page.waitForURL(/#target$/);
	await page.getByRole("link", { name: "Promotion 1", exact: true }).click();
	const first = await shown(page);
	await page.keyboard.press("Escape");
	await first.waitFor({ state: "detached" });
	await page.goBack();
	await page.waitForURL(url);
	await page.clock.fastForward(5000);
	const second = await shown(page, "Promotion 2");
	await expectNoAxeViolations(page, "promotion after same-document navigation");
	await page.keyboard.press("Escape");
	await second.waitFor({ state: "detached" });
	expect(pageErrors(page)).toEqual([]);
	await page.close();
});

test("a failing dialog and unavailable storage cannot hold the next accessible promotion", async () => {
	const url = await scene([{}, {}]);
	const page = await install.newPage("dark");
	await page.addInitScript(() => {
		Object.defineProperty(window, "localStorage", {
			get() {
				throw new DOMException("Storage unavailable", "SecurityError");
			},
		});
		const show = HTMLDialogElement.prototype.showModal;
		HTMLDialogElement.prototype.showModal = function () {
			if (this.textContent?.includes("Promotion 1")) throw new Error("Cannot open");
			show.call(this);
		};
	});
	await page.goto(url);
	const second = await shown(page, "Promotion 2");
	await expectNoAxeViolations(page, "promotion with unavailable local storage");
	await second.getByRole("button", { name: "Close", exact: true }).click();
	expect(pageErrors(page)).toEqual([]);
	await page.close();
});

for (const kind of ["visit", "interval", "closed", "submitted"] as const)
	test(`frequency ${kind} prevents another opening on the next page view`, async () => {
		const url = await scene([{ frequency: { kind, days: 1 }, mainButton: "#accept" }]);
		const page = await install.newPage("light");
		await page.goto(url);
		const dialog = await shown(page);
		if (kind === "submitted") await dialog.getByRole("link", { name: "Continue", exact: true }).click();
		else await dialog.getByRole("button", { name: "Close", exact: true }).click();
		await page.reload();
		await page.waitForLoadState("networkidle");
		expect(await page.locator("dialog.wc-popup[open]").count()).toBe(0);
		await page.close();
	});

test("display rules distinguish phone, tablet and returning visitors without trapping focus", async () => {
	const url = await scene([{ layout: "slide-in", rules: { ...rules, devices: ["tablet"], visitors: "returning" } }]);
	const page = await install.newPage("dark");
	await page.setViewportSize({ width: 800, height: 1000 });
	await page.goto(url);
	await page.waitForLoadState("networkidle");
	expect(await page.locator("dialog.wc-popup[open]").count()).toBe(0);
	await page.reload();
	const dialog = await shown(page);
	await expectNoAxeViolations(page, "returning visitor on tablet");
	await page.getByRole("heading", { name: "Offers", exact: true }).evaluate((e) => {
		e.setAttribute("tabindex", "-1");
		(e as HTMLElement).focus();
	});
	expect(await dialog.evaluate((e) => e.contains(document.activeElement))).toBe(false);
	await page.setViewportSize({ width: 390, height: 844 });
	await page.reload();
	await page.waitForLoadState("networkidle");
	expect(await page.locator("dialog.wc-popup[open]").count()).toBe(0);
	await page.close();
});

for (const kind of ["scroll", "element", "exit", "idle"] as const)
	test(`${kind} Trigger opens a named, dismissible dialog`, async () => {
		const trigger =
			kind === "scroll"
				? { kind, percent: 50 }
				: kind === "element"
					? { kind, selector: "#target" }
					: kind === "idle"
						? { kind, seconds: 3 }
						: { kind };
		const url = await scene([{ trigger }], { tall: true });
		const page = await install.newPage("light");
		if (kind === "idle") await page.clock.install();
		await page.goto(url);
		if (kind === "scroll" || kind === "element") await page.locator("#target").scrollIntoViewIfNeeded();
		else if (kind === "exit") {
			await page.mouse.move(100, 100);
			await page.mouse.move(100, -5);
		} else await page.clock.fastForward(3000);
		const dialog = await shown(page);
		await expectNoAxeViolations(page, `${kind} promotion`);
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "detached" });
		await page.close();
	});

test("visit frequency counts keyboard activity and expires only after inactivity", async () => {
	const url = await scene([{ frequency: { kind: "visit", days: 1 } }]);
	const page = await install.newPage("light");
	await page.clock.install();
	await page.goto(url);
	await (await shown(page)).getByRole("button", { name: "Close", exact: true }).click();
	await page.clock.fastForward(29 * 60_000);
	await page.keyboard.press("ArrowDown");
	await page.clock.fastForward(29 * 60_000);
	await page.reload();
	await page.waitForLoadState("networkidle");
	expect(await page.locator("dialog.wc-popup[open]").count()).toBe(0);
	await page.clock.fastForward(31 * 60_000);
	await page.reload();
	await shown(page);
	await page.close();
});
