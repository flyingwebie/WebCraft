// Accessibility defaults every rendered page has, whatever renders it (an Entry through its Entry
// template, a Page, the home page, the 404 page): `lang` and `dir`, a skip link first, pointing at
// the page's one <main>, the landmarks the Site template holds, and the hooks the Design system
// styles (the skip link's reserved class; the focus style reads Design tokens). No script, inline
// style or event handler is ever written.
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let siteId: string;
let pagesId: string;
const origin = "https://bakery.live.test";

beforeAll(async () => {
	install = await createTestInstall();
	const { api } = await install.superadmin();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header><nav aria-label="Main"><a href="/">Home</a></nav></header><div><main>{{@outlet}}</main></div><footer><p>Open daily</p></footer>',
	});
	await api.templates.publish({ siteId, templateId: site.template.id });

	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const entryTemplate = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await api.templates.publish({ siteId, templateId: entryTemplate.template.id });
	const { entry: post } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await api.entries.publish({ siteId, entryId: post.id });

	pagesId = (await api.postTypes.list({ siteId })).postTypes.find((each) => each.builtIn === "page")?.id ?? "";
	const page = async (title: string) => {
		const { entry } = await api.entries.create({ siteId, postTypeId: pagesId, title });
		await api.entries.publish({ siteId, entryId: entry.id });
		return entry.id;
	};
	await page("About");
	await api.pages.setHomePage({ siteId, pageId: await page("Welcome") });
});

afterAll(async () => {
	await install.close();
});

const PAGES = [
	["an Entry's page", "/blog/fresh-bread", 200],
	["a Page", "/about", 200],
	["the home page", "/", 200],
	["the 404 page", "/no-such-page", 404],
] as const;

test.each(PAGES)(
	"%s: lang and dir, a skip link first to the one <main>, the Site template's landmarks",
	async (_name, path, status) => {
		const response = await install.request(`${origin}${path}`);
		expect(response.status).toBe(status);
		const html = await expectSafePage(response);

		expect(html).toStartWith('<!doctype html>\n<html lang="en" dir="ltr">\n');
		const body = /<body>\n([\s\S]*)\n<\/body>/.exec(html)?.[1] ?? "";
		expect(body.split("\n")[0]).toBe('<a class="wc-skip-link" href="#wc-main">Skip to main content</a>');
		expect(body.match(/<main\b[^>]*>/g)).toEqual(['<main id="wc-main" tabindex="-1">']);
		expect(body).toMatch(
			/^[^\n]*\n<header><nav aria-label="Main">[\s\S]*<\/nav><\/header><div><main [\s\S]*<\/main><\/div><footer>/,
		);
	},
);

test("a 404 page under a chosen Page has the same defaults", async () => {
	const { api } = await install.superadmin();
	const { entry } = await api.entries.create({ siteId, postTypeId: pagesId, title: "Lost?" });
	await api.entries.publish({ siteId, entryId: entry.id });
	await api.pages.setNotFoundPage({ siteId, pageId: entry.id });

	const response = await install.request(`${origin}/still/missing`);

	expect(response.status).toBe(404);
	const html = await expectSafePage(response);
	expect(html).toContain("<title>Lost? · Acme Bakery</title>");
	expect(html).toContain('<a class="wc-skip-link" href="#wc-main">Skip to main content</a>');
	expect(html.match(/<main\b[^>]*>/g)).toEqual(['<main id="wc-main" tabindex="-1">']);
});
