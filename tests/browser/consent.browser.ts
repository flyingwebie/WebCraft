// The Consent banner in a real browser (ADR 0020): each layout passes axe-core and the keyboard
// checks in light and dark, is reached and answered from the keyboard (the dialog layout keeps focus
// inside itself, as a modal dialog must, and Escape closes it), "Cookie settings" opens it again, and
// motion stays still for visitors who ask for reduced motion. Answering lets held-back scripts run
// (they never run before), the choice holds on the next page, and a held-back video's placeholder
// loads that one video. Without JavaScript nothing shows and nothing held back runs. With an outside
// consent service, the service's answer (TCF, the consent-mode signal or `webcraft.consent.set`)
// decides. Every page is a Site's page under the strict policy.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import { expectAccessibleScreen, expectKeyboardUsable, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let workspaceId: string;

/** The Site template every Site here uses: a header with navigation, the content, and a footer with "Cookie settings". */
const SITE_TEMPLATE = [
	'<header><p><a href="/">Acme Bakery</a></p><nav aria-label="Main"><ul>',
	'<li><a href="/notes/ovens">Our ovens</a></li><li><a href="/">Home</a></li>',
	"</ul></nav></header>",
	"<main>{{@outlet}}</main>",
	"<footer><p>Open every day from seven.</p>{{@consentSettings}}</footer>",
].join("");

let sites = 0;

/**
 * A Site asking for consent in a mode and layout: a published home page, a note at /notes/ovens whose
 * body shows a video, and two outside scripts (pasted code the Site serves as files), one in Analytics
 * and one in Marketing, each marking the page when it runs.
 */
async function consentSite(mode: "optIn" | "optOut" | "outside", layout: "bar" | "box" | "dialog"): Promise<string> {
	const local = install.install;
	const { api } = await local.superadmin();
	const slug = `consent-${++sites}`;
	const siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const site = await api.templates.saveSiteTemplateMarkup({ siteId, markup: SITE_TEMPLATE });
	await api.templates.publish({ siteId, templateId: site.template.id });
	const pages = (await api.postTypes.list({ siteId })).postTypes.find((postType) => postType.builtIn === "page");
	const { entry: home } = await api.entries.create({ siteId, postTypeId: pages?.id as string, title: "Welcome" });
	await api.entries.publish({ siteId, entryId: home.id });
	await api.pages.setHomePage({ siteId, pageId: home.id });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Notes",
		urlPattern: "/notes/{slug}",
		fields: [{ key: "body", label: "Body", type: "body" }],
	});
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1>{{ body }}</article>",
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const { entry: note } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Our ovens",
		slug: "ovens",
		fields: {
			body: [
				{ type: "paragraph", text: "Baked in stone ovens since 1952." },
				{ type: "video", url: "https://vimeo.com/76979871", title: "Inside the bakery" },
			],
		},
	});
	await api.entries.publish({ siteId, entryId: note.id });
	for (const category of ["analytics", "marketing"] as const) {
		await api.outsideScripts.add({
			siteId,
			name: `${category} counter`,
			placement: "bodyEnd",
			consentCategory: category,
			source: { kind: "snippet", snippet: `<script>document.documentElement.dataset.${category} = "ran";</script>` },
		});
	}
	await api.consentBanner.setSettings({ siteId, mode, layout });
	return slug;
}

/** Which held-back scripts ran on the page. */
function ran(page: Page): Promise<{ analytics: boolean; marketing: boolean }> {
	return page.evaluate(() => ({
		analytics: document.documentElement.dataset.analytics === "ran",
		marketing: document.documentElement.dataset.marketing === "ran",
	}));
}

/** Opens a Site's page (the note, unless given) and waits for the consent script to have run. */
async function open(page: Page, slug: string, path = "/notes/ovens"): Promise<void> {
	await page.goto(install.siteUrl(slug, path));
	await page.waitForLoadState("load");
	await page.waitForFunction(() => document.documentElement.hasAttribute("data-wc-consent-state"));
}

/** Presses one of the banner's buttons from the keyboard. */
async function pressButton(page: Page, name: string): Promise<void> {
	await page.getByRole("button", { name, exact: true }).focus();
	await page.keyboard.press("Enter");
}

/** Waits until the visitor's choice is recorded (the Site's answer sets the cookie). */
async function recorded(page: Page): Promise<void> {
	await page.waitForFunction(() => document.cookie.includes("webcraft.consent="));
}

beforeAll(async () => {
	install = await startBrowserInstall();
	workspaceId = (await install.install.createWorkspace("Acme Ltd")).id;
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`the banner as a bar or a box, ${theme}`, () => {
		for (const layout of ["bar", "box"] as const) {
			test(`${layout}: accessible, answered from the keyboard, opened again from "Cookie settings"`, async () => {
				const slug = await consentSite("optIn", layout);
				const page = await install.newPage(theme);
				await open(page, slug);
				const banner = page.getByRole("region", { name: "Privacy choices" });

				await banner.waitFor({ state: "visible" });
				expect(await ran(page)).toEqual({ analytics: false, marketing: false });
				// The page stays usable around it, and the keyboard reaches it right after the skip link.
				await expectAccessibleScreen(page, `the ${layout} banner (${theme})`);
				const stops = await page.evaluate(() =>
					[...document.querySelectorAll<HTMLElement>("[data-tab-stop]")].map((element) => element.textContent?.trim()),
				);
				expect(stops.slice(0, 4)).toEqual(["Skip to main content", "Reject all", "Accept all", "Choose"]);

				// Choose shows the categories; focus moves to the first one that can change.
				await pressButton(page, "Choose");
				const analytics = page.getByRole("checkbox", { name: "Analytics" });
				await expect(analytics.evaluate((element) => element === document.activeElement)).resolves.toBe(true);
				expect(await page.getByRole("checkbox", { name: "Necessary" }).isDisabled()).toBe(true);
				await expectNoAxeViolations(page, `the ${layout} banner's categories (${theme})`);
				await page.keyboard.press("Space");
				await pressButton(page, "Save choices");
				await banner.waitFor({ state: "hidden" });
				await recorded(page);
				expect(await ran(page)).toEqual({ analytics: true, marketing: false });
				await expectAccessibleScreen(page, `a page once the ${layout} banner is answered (${theme})`);

				// The choice holds on the next page.
				await open(page, slug, "/");
				expect(await banner.isVisible()).toBe(false);
				expect(await ran(page)).toEqual({ analytics: true, marketing: false });

				// "Cookie settings" opens it again with the choice made, and Escape closes it, focus back on the button.
				const settings = page.getByRole("button", { name: "Cookie settings" });
				await settings.focus();
				await page.keyboard.press("Enter");
				await banner.waitFor({ state: "visible" });
				expect(await analytics.isChecked()).toBe(true);
				expect(await page.getByRole("checkbox", { name: "Marketing" }).isChecked()).toBe(false);
				const headingFocused = await page.evaluate(
					() => document.activeElement === document.getElementById("wc-consent-title"),
				);
				expect(headingFocused).toBe(true);
				await page.keyboard.press("Escape");
				await banner.waitFor({ state: "hidden" });
				await expect(settings.evaluate((element) => element === document.activeElement)).resolves.toBe(true);
			});
		}
	});

	describe(`the banner as a dialog, ${theme}`, () => {
		test("modal: focus stays inside it, it passes axe, Escape closes it; answering it lets the page be used", async () => {
			const slug = await consentSite("optIn", "dialog");
			const page = await install.newPage(theme);
			await open(page, slug);
			const dialog = page.getByRole("dialog", { name: "Privacy choices" });
			await dialog.waitFor({ state: "visible" });

			await expectNoAxeViolations(page, `the dialog banner (${theme})`);
			// Tab moves through the dialog only: nothing behind it can be reached while it is open.
			for (let press = 0; press < 8; press++) {
				await page.keyboard.press("Tab");
				const inside = await dialog.evaluate(
					(element) => element.contains(document.activeElement) || document.activeElement === document.body,
				);
				expect({ press, inside }).toEqual({ press, inside: true });
			}
			await page.keyboard.press("Escape");
			await dialog.waitFor({ state: "hidden" });
			expect(await ran(page)).toEqual({ analytics: false, marketing: false });

			// Not answered: it asks again on the next page. Rejecting holds everything back for good.
			await open(page, slug);
			await dialog.waitFor({ state: "visible" });
			await pressButton(page, "Reject all");
			await dialog.waitFor({ state: "hidden" });
			await recorded(page);
			expect(await ran(page)).toEqual({ analytics: false, marketing: false });
			await expectAccessibleScreen(page, `a page once the dialog banner is answered (${theme})`);
			await open(page, slug);
			expect(await dialog.isVisible()).toBe(false);
			expect(await ran(page)).toEqual({ analytics: false, marketing: false });

			// "Cookie settings" opens it again as a modal dialog.
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Cookie settings" }),
				"dialog",
				`the dialog banner opened again (${theme})`,
			);
			await page.getByRole("button", { name: "Cookie settings" }).focus();
			await page.keyboard.press("Enter");
			await pressButton(page, "Accept all");
			await dialog.waitFor({ state: "hidden" });
			await page.waitForFunction(() => document.documentElement.dataset.marketing === "ran");
			expect(await ran(page)).toEqual({ analytics: true, marketing: true });
		});
	});

	describe(`a held-back video, ${theme}`, () => {
		test("shows a labelled placeholder; Load content loads that one only, remembered only when asked", async () => {
			const slug = await consentSite("optIn", "box");
			const page = await install.newPage(theme);
			await open(page, slug, "/notes/ovens");
			const placeholder = page.locator(".wc-consent-placeholder");
			await placeholder.waitFor({ state: "visible" });

			expect(await page.getByRole("link", { name: "Play video: Inside the bakery" }).isVisible()).toBe(false);
			await expectAccessibleScreen(page, `a page with a held-back video (${theme})`);

			// Load content: that video's player, focused.
			await pressButton(page, "Load content");
			const player = page.locator(".wc-embed > iframe");
			await player.waitFor({ state: "attached" });
			expect(await player.getAttribute("src")).toStartWith("https://player.vimeo.com/video/76979871");
			expect(await player.getAttribute("title")).toBe("Inside the bakery");
			// Nothing was remembered: the banner still asks, and the next page holds the video back again.
			expect(await page.getByRole("region", { name: "Privacy choices" }).isVisible()).toBe(true);
			await open(page, slug, "/notes/ovens");
			await placeholder.waitFor({ state: "visible" });

			// Ticking the box remembers Media: the next page shows the video's own link.
			await page.getByRole("checkbox", { name: "Always load Media content" }).check();
			await pressButton(page, "Load content");
			await recorded(page);
			await open(page, slug, "/notes/ovens");
			expect(await placeholder.isVisible()).toBe(false);
			expect(await page.getByRole("link", { name: "Play video: Inside the bakery" }).isVisible()).toBe(true);
			expect(await ran(page)).toEqual({ analytics: false, marketing: false });
		});
	});
}

describe("motion", () => {
	test("the banner slides in, except for visitors who ask for reduced motion", async () => {
		const slug = await consentSite("optIn", "bar");
		const page = await install.newPage("light");
		await open(page, slug);
		const animation = () =>
			page.evaluate(() => getComputedStyle(document.getElementById("wc-consent") as HTMLElement).animationName);

		expect(await animation()).toBe("none");
		await page.emulateMedia({ reducedMotion: "no-preference" });
		expect(await animation()).toBe("wc-consent-in");
	});
});

describe("without JavaScript", () => {
	test("no banner shows, nothing held back runs, and the page and its video's link work as they are", async () => {
		const slug = await consentSite("optIn", "bar");
		const page = await install.newPage("light", { javaScript: false });
		await page.goto(install.siteUrl(slug, "/notes/ovens"));

		expect(await page.getByRole("region", { name: "Privacy choices" }).isVisible()).toBe(false);
		expect(await page.getByRole("button", { name: "Cookie settings" }).isVisible()).toBe(false);
		expect(await page.locator(".wc-consent-placeholder").isVisible()).toBe(false);
		const link = page.getByRole("link", { name: "Play video: Inside the bakery" });
		expect(await link.isVisible()).toBe(true);
		expect(await link.getAttribute("href")).toBe("https://vimeo.com/76979871");
	});
});

describe("an outside consent service", () => {
	/** A page of an outside-service Site, with `before` run first, as a service's own script would. */
	async function withService(before: () => void): Promise<Page> {
		const slug = await consentSite("outside", "bar");
		const page = await install.newPage("light");
		await page.addInitScript(before);
		await open(page, slug);
		return page;
	}

	test("shows no banner of WebCraft's, and holds everything back until the service answers", async () => {
		const page = await withService(() => {});

		expect(await page.locator("#wc-consent").count()).toBe(0);
		expect(await page.getByRole("button", { name: "Cookie settings" }).count()).toBe(0);
		expect(await ran(page)).toEqual({ analytics: false, marketing: false });
		await expectKeyboardUsable(page, "a page of a Site with an outside consent service");
	});

	test("reads the TCF v2.2 data: purposes 1, 2, 3, 4 and 7 accept Marketing", async () => {
		const page = await withService(() => {
			const data = {
				eventStatus: "useractioncomplete",
				gdprApplies: true,
				purpose: { consents: { 1: true, 2: true, 3: true, 4: true, 7: true } },
			};
			(window as unknown as { __tcfapi: unknown }).__tcfapi = (
				command: string,
				_version: number,
				callback: (data: unknown, success: boolean) => void,
			) => {
				if (command === "addEventListener") callback(data, true);
			};
		});

		await page.waitForFunction(() => document.documentElement.dataset.marketing === "ran");
		expect(await ran(page)).toEqual({ analytics: false, marketing: true });
	});

	test("reads the consent-mode signal: an update granting analytics_storage accepts Analytics", async () => {
		const page = await withService(() => {
			const layer: unknown[] = [];
			(window as unknown as { dataLayer: unknown[] }).dataLayer = layer;
			layer.push(["consent", "default", { analytics_storage: "denied", ad_storage: "denied" }]);
			setTimeout(() => layer.push(["consent", "update", { analytics_storage: "granted" }]), 50);
		});

		await page.waitForFunction(() => document.documentElement.dataset.analytics === "ran");
		expect(await ran(page)).toEqual({ analytics: true, marketing: false });
		expect(
			await page.evaluate(
				() => (window as unknown as { webcraft: { consent: { answered: boolean } } }).webcraft.consent.answered,
			),
		).toBe(true);
	});

	test("takes webcraft.consent.set() from the Site's own code", async () => {
		const page = await withService(() => {});

		await page.evaluate(() =>
			(
				window as unknown as { webcraft: { consent: { set(choices: Record<string, boolean>): void } } }
			).webcraft.consent.set({ analytics: true, marketing: true }),
		);

		await page.waitForFunction(() => document.documentElement.dataset.marketing === "ran");
		expect(await ran(page)).toEqual({ analytics: true, marketing: true });
	});
});
