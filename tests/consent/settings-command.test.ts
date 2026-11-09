// "Cookie settings" (ADR 0020): `{{@consentSettings}}` is the Template command for the button that
// opens the Consent banner again. It is a button that starts hidden and shows once the consent
// script runs, so a page without JavaScript never offers a button that does nothing; its words are
// the banner's (Content). A page showing it carries the banner, even when it holds nothing back.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let editor: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

/** A Site with a published home page and a Site template whose footer has `footer` in it. */
async function newSite(footer = "{{@consentSettings}}") {
	const slug = `cookie-settings-${++sites}`;
	const { id: siteId } = await install.createSite(workspaceId, { name: "Bakery", slug });
	const pages = (await editor.api.postTypes.list({ siteId })).postTypes.find((postType) => postType.builtIn === "page");
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: pages?.id as string, title: "Home" });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.pages.setHomePage({ siteId, pageId: entry.id });
	const saved = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: `<main>{{@outlet}}</main><footer><p>© Bakery</p>${footer}</footer>`,
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	return { siteId, url: (path: string) => `https://${slug}.sites.test${path}` };
}

function footerOf(html: string): string {
	return /<footer[^>]*>([\s\S]*)<\/footer>/.exec(html)?.[1] ?? "";
}

describe("{{@consentSettings}}", () => {
	test("is a hidden button with the banner's words; the page carries the banner even with nothing held back", async () => {
		const site = await newSite();

		const html = await expectSafePage(await install.request(site.url("/")));

		expect(footerOf(html)).toBe(
			'<p>© Bakery</p><button type="button" class="wc-consent-settings" aria-controls="wc-consent" hidden>Cookie settings</button>',
		);
		expect(html).toContain('<section class="wc-consent" id="wc-consent"');
		expect(html).toContain('<meta name="webcraft-consent-mode" content="optIn">');
		expect(html).not.toContain("<template");
	});

	test("says what the banner's words say, in the page's language", async () => {
		const site = await newSite();
		await editor.api.consentBanner.saveDraft({ siteId: site.siteId, fields: { settings: "Privacy settings" } });
		await editor.api.consentBanner.publish({ siteId: site.siteId });

		const html = await expectSafePage(await install.request(site.url("/")));

		expect(footerOf(html)).toContain(">Privacy settings</button>");
	});

	test("shows nothing where WebCraft asks nothing: with None, with an outside consent service, in Edit mode", async () => {
		const site = await newSite();
		const editing = await openEditMode(install, staff, site.siteId, "/");
		expect(footerOf(await expectSafePage(await editing.page("/"), "editMode"))).toBe("<p>© Bakery</p>");

		for (const mode of ["none", "outside"] as const) {
			await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode, layout: "bar" });
			const html = await expectSafePage(await install.request(site.url("/")));
			expect({ mode, footer: footerOf(html) }).toEqual({ mode, footer: "<p>© Bakery</p>" });
			expect(html).not.toContain('id="wc-consent"');
		}
	});

	test("reads back as it was written, and is a button: it can't go inside a link or another control", async () => {
		const site = await newSite();
		const { markup } = await staff.api.templates.getSiteTemplateMarkup({ siteId: site.siteId });
		expect(markup?.published).toContain("<footer");
		expect(markup?.published).toContain("{{@consentSettings}}</footer>");

		for (const markupWithIt of [
			'<main>{{@outlet}}</main><footer><a href="/privacy">{{@consentSettings}}</a></footer>',
			"<main>{{@outlet}}</main><footer><ul>{{@consentSettings}}</ul></footer>",
			"<main>{{@outlet}}</main><footer>{{@consentSettings now}}</footer>",
		]) {
			await expect(
				staff.api.templates.saveSiteTemplateMarkup({ siteId: site.siteId, markup: markupWithIt }),
			).rejects.toMatchObject({ code: "TEMPLATE_MARKUP_INVALID" });
		}
	});
});
