// The home page and the 404 page: Staff choose a Page to answer at `/` and a Page to answer any
// path with no page, with status 404. Without a chosen 404 page, a plain built-in one is used. Both
// render inside the Site template; a 404 is never kept in the page cache.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";

let install: TestInstall;
let admin: TestBrowser;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type TestSite = { siteId: string; pagesId: string; origin: string };

async function newSite(): Promise<TestSite> {
	const slug = `special-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const { postTypes } = await editor.api.postTypes.list({ siteId });
	return {
		siteId,
		pagesId: postTypes.find((postType) => postType.builtIn === "page")?.id ?? "",
		origin: `https://${slug}.sites.test`,
	};
}

async function createPage(site: TestSite, title: string, publish = true): Promise<string> {
	const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId: site.pagesId, title });
	if (publish) await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	return entry.id;
}

/** The status and the page's title at `path`. */
async function visit(site: TestSite, path: string): Promise<{ status: number; title: string; html: string }> {
	const response = await install.request(`${site.origin}${path}`);
	// Redirects carry no page; every page (the 404 page too) is held to the Site's policy.
	const html = response.headers.get("content-type")?.startsWith("text/html")
		? await expectSafePage(response)
		: await response.text();
	return { status: response.status, title: /<title>(.*)<\/title>/.exec(html)?.[1] ?? "", html };
}

describe("the home page", () => {
	test("Staff choose a Page to answer at /; it shows there once it is published", async () => {
		const site = await newSite();
		const welcome = await createPage(site, "Welcome", false);
		expect((await visit(site, "/")).status).toBe(404);

		const { settings } = await staff.api.pages.setHomePage({ siteId: site.siteId, pageId: welcome });
		expect(settings).toEqual({
			homePage: { id: welcome, title: "Welcome" },
			notFoundPage: null,
			searchPage: null,
			languageNotFoundPages: {},
		});
		expect((await visit(site, "/")).status).toBe(404);

		await editor.api.entries.publish({ siteId: site.siteId, entryId: welcome });

		expect(await visit(site, "/")).toMatchObject({ status: 200, title: "Welcome · Acme Bakery" });
		expect((await editor.api.entries.get({ siteId: site.siteId, entryId: welcome })).entry.path).toBe("/");
	});

	test("its own path sends visitors on to /, where it is", async () => {
		const site = await newSite();
		const welcome = await createPage(site, "Welcome");
		await createPage(site, "Ignored");
		await staff.api.pages.setHomePage({ siteId: site.siteId, pageId: welcome });

		const response = await install.request(`${site.origin}/welcome`);

		expect(response.status).toBe(301);
		expect(response.headers.get("location")).toBe("/");
		expect((await visit(site, "/ignored")).status).toBe(200);
	});

	test("choosing another one shows at once, and choosing none leaves / without a page", async () => {
		const site = await newSite();
		const first = await createPage(site, "First");
		const second = await createPage(site, "Second");
		await staff.api.pages.setHomePage({ siteId: site.siteId, pageId: first });
		expect((await visit(site, "/")).title).toBe("First · Acme Bakery");

		await staff.api.pages.setHomePage({ siteId: site.siteId, pageId: second });
		expect((await visit(site, "/")).title).toBe("Second · Acme Bakery");

		await staff.api.pages.setHomePage({ siteId: site.siteId, pageId: null });
		expect((await visit(site, "/")).status).toBe(404);
		expect((await visit(site, "/second")).status).toBe(200);
	});
});

describe("the 404 page", () => {
	test("until Staff choose one, a path with no page gets the plain built-in one, in the Site template", async () => {
		const site = await newSite();
		const saved = await staff.api.templates.saveSiteTemplateMarkup({
			siteId: site.siteId,
			markup: "<header><p>Acme Bakery</p></header><main>{{@outlet}}</main><footer><p>Open daily</p></footer>",
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });

		const response = await install.request(`${site.origin}/no/such/page`);

		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const html = await expectSafePage(response);
		expect(html).toContain("<title>Page not found · Acme Bakery</title>");
		expect(/<body>\n([\s\S]*)\n<\/body>/.exec(html)?.[1]).toBe(
			[
				'<a class="wc-skip-link" href="#wc-main">Skip to main content</a>',
				"<header><p>Acme Bakery</p></header>" +
					'<main id="wc-main" tabindex="-1"><h1>Page not found</h1><p>There is no page at this address.</p></main>' +
					"<footer><p>Open daily</p></footer>",
			].join("\n"),
		);
	});

	test("Staff choose a Page as the 404 page; it answers every path with no page, with status 404", async () => {
		const site = await newSite();
		const lost = await createPage(site, "Lost your way?", false);

		const { settings } = await staff.api.pages.setNotFoundPage({ siteId: site.siteId, pageId: lost });
		expect(settings.notFoundPage).toEqual({ id: lost, title: "Lost your way?" });
		// The built-in one stands in until the chosen Page is published.
		expect(await visit(site, "/missing")).toMatchObject({ status: 404, title: "Page not found · Acme Bakery" });

		await editor.api.entries.publish({ siteId: site.siteId, entryId: lost });

		expect(await visit(site, "/missing")).toMatchObject({ status: 404, title: "Lost your way? · Acme Bakery" });
		expect(await visit(site, "/")).toMatchObject({ status: 404, title: "Lost your way? · Acme Bakery" });
		const html = (await visit(site, "/missing")).html;
		expect(html).toContain('<a class="wc-skip-link" href="#wc-main">Skip to main content</a>');
		expect(html).toContain('<main id="wc-main" tabindex="-1"></main>');

		await staff.api.pages.setNotFoundPage({ siteId: site.siteId, pageId: null });
		expect(await visit(site, "/missing")).toMatchObject({ status: 404, title: "Page not found · Acme Bakery" });
	});

	test("is never kept as a page: every answer is fresh, and a page published there shows at once", async () => {
		const site = await newSite();
		const first = await install.request(`${site.origin}/opening-hours`);
		const second = await install.request(`${site.origin}/opening-hours`, {
			headers: { "if-none-match": first.headers.get("etag") ?? "*" },
		});

		for (const response of [first, second]) {
			expect(response.status).toBe(404);
			expect(response.headers.get("cache-control")).toBe("no-store");
			expect(response.headers.get("etag")).toBeNull();
			expect(response.headers.get("x-cache")).toBeNull();
		}
		const head = await install.request(`${site.origin}/opening-hours`, { method: "HEAD" });
		expect(head.status).toBe(404);
		expect(await head.text()).toBe("");

		await createPage(site, "Opening hours");
		expect((await visit(site, "/opening-hours")).status).toBe(200);
	});
});

describe("choosing the home page and the 404 page", () => {
	test("is Staff's: Members see which Pages they are but can't change them", async () => {
		const site = await newSite();
		const welcome = await createPage(site, "Welcome");
		await staff.api.pages.setHomePage({ siteId: site.siteId, pageId: welcome });

		expect((await editor.api.pages.settings({ siteId: site.siteId })).settings.homePage).toEqual({
			id: welcome,
			title: "Welcome",
		});
		for (const change of [
			() => editor.api.pages.setHomePage({ siteId: site.siteId, pageId: null }),
			() => editor.api.pages.setNotFoundPage({ siteId: site.siteId, pageId: welcome }),
		]) {
			await expect(change()).rejects.toMatchObject({ code: "FORBIDDEN" });
		}
	});

	test("takes a Page of the Site, nothing else", async () => {
		const site = await newSite();
		const other = await newSite();
		const elsewhere = await createPage(other, "Elsewhere");
		const { postType } = await staff.api.postTypes.create({
			siteId: site.siteId,
			name: "Blog posts",
			urlPattern: "/blog/{slug}",
		});
		const post = await editor.api.entries.create({ siteId: site.siteId, postTypeId: postType.id, title: "Hello" });

		for (const pageId of [post.entry.id, elsewhere]) {
			await expect(staff.api.pages.setHomePage({ siteId: site.siteId, pageId })).rejects.toMatchObject({
				code: "PAGE_NOT_FOUND",
				status: 404,
			});
			await expect(staff.api.pages.setNotFoundPage({ siteId: site.siteId, pageId })).rejects.toMatchObject({
				code: "PAGE_NOT_FOUND",
			});
		}
	});

	test("is recorded in the Audit log", async () => {
		const site = await newSite();
		const welcome = await createPage(site, "Welcome");

		await staff.api.pages.setHomePage({ siteId: site.siteId, pageId: welcome });
		expect((await admin.api.audit.list({ limit: 1 })).entries[0]).toMatchObject({
			action: "homePage.change",
			siteId: site.siteId,
			details: { pageId: welcome, title: "Welcome" },
		});

		await staff.api.pages.setNotFoundPage({ siteId: site.siteId, pageId: null });
		expect((await admin.api.audit.list({ limit: 1 })).entries[0]).toMatchObject({
			action: "notFoundPage.change",
			details: { pageId: null },
		});
	});
});

describe("paths the Install keeps", () => {
	test("stay outside Pages and Post Types, with a plain 404 until their feature answers them", async () => {
		const site = await newSite();
		const lost = await createPage(site, "Lost your way?");
		await staff.api.pages.setNotFoundPage({ siteId: site.siteId, pageId: lost });

		for (const path of [
			"/_webcraft/forms/contact",
			"/_media/bread-1280.avif",
			"/_content/v1/entries",
			"/_wc/m/analytics/collect",
			"/sitemap.xml",
			"/robots.txt",
			"/llms.txt",
			"/about.md",
		]) {
			const response = await install.request(`${site.origin}${path}`);
			expect(response.status).toBe(404);
			expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
			expect(await response.text()).toBe("Not Found");
		}
	});
});
