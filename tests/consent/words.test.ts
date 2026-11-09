// The Consent banner's words are Content (ADR 0020, ADRs 0003 and 0014): Members write them in a
// Draft, per language, and publish them; visitors see what is published. A word nobody wrote shows
// WebCraft's own in the page's language; a language without its own value shows the Default
// language's, one word at a time.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let editor: TestBrowser;
let author: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

/** A Site in English and French with a published home page and an outside script in Analytics, so pages ask. */
async function newSite() {
	const slug = `words-${++sites}`;
	const { id: siteId } = await install.createSite(workspaceId, { name: "Bakery", slug });
	await goLive(install, siteId);
	await staff.api.languages.add({ siteId, code: "fr" });
	const pages = (await editor.api.postTypes.list({ siteId })).postTypes.find((postType) => postType.builtIn === "page");
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: pages?.id as string, title: "Home" });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.pages.setHomePage({ siteId, pageId: entry.id });
	await staff.api.outsideScripts.add({
		siteId,
		name: "Visitor counter",
		placement: "head",
		consentCategory: "analytics",
		source: { kind: "url", url: "https://tags.example.com/count.js" },
	});
	return { siteId, url: (path: string) => `https://${slug}.live.test${path}` };
}

/** The banner's markup on a page. */
async function bannerOn(url: string): Promise<string> {
	const html = await expectSafePage(await install.request(url));
	return /<section class="wc-consent"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
}

/** The text of an element of the banner, by its class. */
function textOf(banner: string, className: string): string | undefined {
	return new RegExp(`<[a-z0-9]+ class="${className}"[^>]*>([^<]*)<`).exec(banner)?.[1];
}

/** The text of one of the banner's buttons, by its action. */
function buttonOf(banner: string, action: string): string | undefined {
	return new RegExp(`data-wc-consent-action="${action}"[^>]*>([^<]*)</button>`).exec(banner)?.[1];
}

describe("the banner's words", () => {
	test("untouched, the banner says WebCraft's own words in the page's language", async () => {
		const site = await newSite();

		const english = await bannerOn(site.url("/"));
		const french = await bannerOn(site.url("/fr"));

		expect(textOf(english, "wc-consent-title")).toBe("Privacy choices");
		expect(buttonOf(english, "accept")).toBe("Accept all");
		expect(buttonOf(english, "reject")).toBe("Reject all");
		expect(textOf(french, "wc-consent-title")).toBe("Vos choix de confidentialité");
		expect(buttonOf(french, "accept")).toBe("Tout accepter");
		expect(english).toContain('<label for="wc-consent-analytics">Analytics</label>');
		expect(french).toContain('<label for="wc-consent-analytics">Statistiques</label>');
		// No link to a privacy policy until the banner has one.
		expect(english).not.toContain("wc-consent-policy");
	});

	test("get answers the Fields, the Draft and published values and WebCraft's words in the language asked for", async () => {
		const site = await newSite();

		const { banner } = await author.api.consentBanner.get({ siteId: site.siteId, language: "fr" });

		expect(banner.text.language).toBe("fr");
		expect(banner.text.status).toBe("published");
		expect(banner.text.published).toBeNull();
		expect(banner.text.fields.map((field) => [field.key, field.type])).toEqual([
			["heading", "text"],
			["message", "text"],
			["acceptAll", "text"],
			["rejectAll", "text"],
			["choose", "text"],
			["save", "text"],
			["settings", "text"],
			["privacyPolicy", "link"],
			["necessary", "text"],
			["necessaryText", "text"],
			["analytics", "text"],
			["analyticsText", "text"],
			["marketing", "text"],
			["marketingText", "text"],
			["media", "text"],
			["mediaText", "text"],
			["embedText", "text"],
			["loadContent", "text"],
			["rememberEmbeds", "text"],
		]);
		expect(banner.text.draft.heading).toBeNull();
		expect(banner.text.defaults).toMatchObject({
			heading: "Vos choix de confidentialité",
			settings: "Paramètres des cookies",
		});
	});

	test("Members write them in a Draft; visitors see them once published, as a new banner version, logged", async () => {
		const site = await newSite();
		await install.request(site.url("/"));

		const saved = await author.api.consentBanner.saveDraft({
			siteId: site.siteId,
			fields: { heading: "Your choices", acceptAll: "Yes to all" },
		});
		expect(saved.banner.text.status).toBe("draft");
		expect(saved.banner.text.draft).toMatchObject({ heading: "Your choices", acceptAll: "Yes to all" });
		expect(textOf(await bannerOn(site.url("/")), "wc-consent-title")).toBe("Privacy choices");

		const published = await editor.api.consentBanner.publish({ siteId: site.siteId });
		expect(published.banner.version).toBe(2);
		expect(published.banner.text.status).toBe("published");

		const page = await install.request(site.url("/"));
		expect(page.headers.get("x-cache")).toBe("MISS");
		const html = await expectSafePage(page);
		expect(html).toContain('<meta name="webcraft-consent-version" content="2">');
		const banner = /<section class="wc-consent"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
		expect(textOf(banner, "wc-consent-title")).toBe("Your choices");
		expect(buttonOf(banner, "accept")).toBe("Yes to all");
		expect(buttonOf(banner, "reject")).toBe("Reject all");
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 20 });
		expect(
			entries
				.filter((entry) => entry.siteId === site.siteId && entry.action === "consentBanner.publish")
				.map((entry) => entry.details),
		).toEqual([{ version: 2 }]);
	});

	test("Authors write them but can't publish them", async () => {
		const site = await newSite();
		await author.api.consentBanner.saveDraft({ siteId: site.siteId, fields: { heading: "Choices" } });

		await expect(author.api.consentBanner.publish({ siteId: site.siteId })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("each language has its own; a language without one shows the Default language's, word by word", async () => {
		const site = await newSite();
		await editor.api.consentBanner.saveDraft({ siteId: site.siteId, fields: { heading: "Your choices" } });
		await editor.api.consentBanner.saveDraft({
			siteId: site.siteId,
			language: "fr",
			fields: { rejectAll: "Non merci" },
		});
		await editor.api.consentBanner.publish({ siteId: site.siteId });

		const french = await bannerOn(site.url("/fr"));

		expect(buttonOf(french, "reject")).toBe("Non merci");
		expect(textOf(french, "wc-consent-title")).toBe("Your choices");
		expect(buttonOf(french, "accept")).toBe("Tout accepter");
		expect(
			(await editor.api.consentBanner.get({ siteId: site.siteId, language: "fr" })).banner.text.draft,
		).toMatchObject({ heading: "Your choices", rejectAll: "Non merci" });
	});

	test("the privacy policy link: an address and its text in each language, WebCraft's text when it has none", async () => {
		const site = await newSite();
		await editor.api.consentBanner.saveDraft({
			siteId: site.siteId,
			fields: { privacyPolicy: { url: "/privacy", text: "How we use your data" } },
		});
		await editor.api.consentBanner.saveDraft({
			siteId: site.siteId,
			language: "fr",
			fields: { privacyPolicy: { url: "/fr/confidentialite", text: "" } },
		});
		await editor.api.consentBanner.publish({ siteId: site.siteId });

		expect(await bannerOn(site.url("/"))).toContain(
			'<p class="wc-consent-policy"><a href="/privacy">How we use your data</a></p>',
		);
		expect(await bannerOn(site.url("/fr"))).toContain(
			'<p class="wc-consent-policy"><a href="/fr/confidentialite">Politique de confidentialité</a></p>',
		);
	});

	test("what is refused: a word of the wrong kind, an unsafe link, a word it doesn't have, a language the Site doesn't have", async () => {
		const site = await newSite();

		for (const change of [
			{ fields: { heading: 42 } },
			{ fields: { privacyPolicy: { url: "javascript:alert(1)", text: "Privacy" } } },
			{ fields: { footer: "Hello" } },
			{ language: "de", fields: { heading: "Ihre Wahl" } },
		]) {
			await expect(editor.api.consentBanner.saveDraft({ siteId: site.siteId, ...change })).rejects.toMatchObject({
				code: "CONSENT_BANNER_INVALID",
			});
		}
	});

	test("a word too long is kept in the Draft and listed, and keeps the words from being published", async () => {
		const site = await newSite();

		const saved = await editor.api.consentBanner.saveDraft({
			siteId: site.siteId,
			fields: { acceptAll: "x".repeat(121) },
		});

		expect(saved.banner.text.problems.map((problem) => problem.at)).toEqual(["fields.acceptAll"]);
		await expect(editor.api.consentBanner.publish({ siteId: site.siteId })).rejects.toMatchObject({
			code: "CONSENT_BANNER_INVALID",
		});
	});

	test("words are text: markup in them is shown, never run", async () => {
		const site = await newSite();
		await editor.api.consentBanner.saveDraft({
			siteId: site.siteId,
			fields: { heading: '<img src=x onerror="alert(1)">', message: "</section><script>alert(1)</script>" },
		});
		await editor.api.consentBanner.publish({ siteId: site.siteId });

		const banner = await bannerOn(site.url("/"));

		expect(textOf(banner, "wc-consent-title")).toBe('&lt;img src=x onerror="alert(1)"&gt;');
		expect(banner).toContain("&lt;/section&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
	});
});
