// The Staging address shows the Site with all its Drafts (ADR 0014): Content Drafts (Entries, the
// Globals, the Consent banner's words) and Structure Drafts (Templates, Components, Loops, Forms, the
// Design system and its stylesheet, the Site and page scripts), through the same renderer as the
// Site's domains. Never-published Entries and Pages are reachable at the address their Draft would be
// published at. It is never indexed, never kept by anyone, and never a page's canonical address.
// Visitors on the Site's domain keep seeing what is published.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { canonicalIn } from "../harness/seo.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive, openStaging, type StagingBrowser } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type TestSite = {
	siteId: string;
	pagesId: string;
	postTypeId: string;
	/** The Site on its Primary domain, as visitors see it. */
	live: string;
	/** The Site on its Staging address, opened by Staff. */
	staging: StagingBrowser;
};

/**
 * A live Site with a published Blog post at /blog/fresh-bread ("Fresh bread"), a published Page at
 * /about ("About us"), the home page, and a Site template reading the Global `tagline`.
 */
async function newSite(): Promise<TestSite> {
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: `drafts-${++sites}` })).id;
	await staff.api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	await staff.api.globals.saveDraft({ siteId, fields: { tagline: "Baked daily" } });
	await staff.api.globals.publish({ siteId });
	const site = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>{{ site.tagline }}</p></header><main>{{@outlet}}</main>",
	});
	await staff.api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		key: "posts",
		urlPattern: "/blog/{slug}",
	});
	const entryTemplate = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: entryTemplate.template.id });
	const post = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await staff.api.entries.publish({ siteId, entryId: post.entry.id });
	const pagesId = (await staff.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")
		?.id as string;
	const home = await staff.api.entries.create({ siteId, postTypeId: pagesId, title: "Home" });
	await staff.api.entries.publish({ siteId, entryId: home.entry.id });
	await staff.api.pages.setHomePage({ siteId, pageId: home.entry.id });
	const about = await staff.api.entries.create({ siteId, postTypeId: pagesId, title: "About us", slug: "about" });
	await staff.api.entries.publish({ siteId, entryId: about.entry.id });
	const live = await goLive(install, siteId);
	return { siteId, pagesId, postTypeId: postType.id, live, staging: await openStaging(install, staff, siteId) };
}

/** A page's HTML, checked as every Site page is (security headers, its policy, no inline code). */
async function html(response: Response): Promise<string> {
	expect(response.status).toBe(200);
	return expectSafePage(response, "strict");
}

/** The id of the Blog post at /blog/fresh-bread. */
async function freshBread(site: TestSite): Promise<string> {
	const { entries } = await staff.api.entries.list({ siteId: site.siteId, postTypeId: site.postTypeId });
	return entries.find((entry) => entry.published?.title === "Fresh bread")?.id as string;
}

describe("Content Drafts", () => {
	test("an Entry's Draft and the Globals' Draft show on the Staging address; visitors still see what is published", async () => {
		const site = await newSite();
		await staff.api.entries.saveDraft({
			siteId: site.siteId,
			entryId: await freshBread(site),
			title: "Fresh sourdough",
		});
		await staff.api.globals.saveDraft({ siteId: site.siteId, fields: { tagline: "Baked twice daily" } });

		const staged = await html(await site.staging.page("/blog/fresh-bread"));
		expect(staged).toContain("<h1>Fresh sourdough</h1>");
		expect(staged).toContain("<p>Baked twice daily</p>");

		const visitors = await html(await install.request(`${site.live}/blog/fresh-bread`));
		expect(visitors).toContain("<h1>Fresh bread</h1>");
		expect(visitors).toContain("<p>Baked daily</p>");
	});

	test("are never kept: a Draft saved between two requests shows on the next one", async () => {
		const site = await newSite();
		const entryId = await freshBread(site);
		const first = await site.staging.page("/blog/fresh-bread");
		expect(first.headers.get("x-cache")).toBeNull();
		expect(first.headers.get("etag")).toBeNull();
		expect(first.headers.get("cache-control")).toBe("private, no-store");
		expect(await first.text()).toContain("<h1>Fresh bread</h1>");

		await staff.api.entries.saveDraft({ siteId: site.siteId, entryId, title: "Fresh rye" });
		expect(await (await site.staging.page("/blog/fresh-bread")).text()).toContain("<h1>Fresh rye</h1>");
	});

	test("the Consent banner's Draft words show there", async () => {
		const site = await newSite();
		const markup = "<header><p>{{ site.tagline }}</p>{{@consentSettings}}</header><main>{{@outlet}}</main>";
		const saved = await staff.api.templates.saveSiteTemplateMarkup({ siteId: site.siteId, markup });
		await staff.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });
		await staff.api.consentBanner.saveDraft({ siteId: site.siteId, fields: { heading: "Cookies, freshly baked" } });

		expect(await html(await site.staging.page("/about"))).toContain("Cookies, freshly baked");
		expect(await html(await install.request(`${site.live}/about`))).not.toContain("Cookies, freshly baked");
	});
});

describe("Entries and Pages never published", () => {
	test("are at the address their Draft would be published at; a Draft slug moves an Entry there", async () => {
		const site = await newSite();
		const draft = await staff.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Spring menu",
		});
		const page = await staff.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Our team",
			slug: "team",
		});
		const child = await staff.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Bakers",
			slug: "bakers",
			parentId: page.entry.id,
		});
		expect(child.entry.status).toBe("draft");

		expect(await html(await site.staging.page("/blog/spring-menu"))).toContain("<h1>Spring menu</h1>");
		expect(await html(await site.staging.page("/team"))).toContain("<title>Our team");
		expect(await html(await site.staging.page("/team/bakers"))).toContain("<title>Bakers");
		expect((await install.request(`${site.live}/blog/spring-menu`)).status).toBe(404);
		expect((await install.request(`${site.live}/team`)).status).toBe(404);

		await staff.api.entries.saveDraft({ siteId: site.siteId, entryId: await freshBread(site), slug: "fresh-loaf" });
		expect(await html(await site.staging.page("/blog/fresh-loaf"))).toContain("<h1>Fresh bread</h1>");
		expect((await site.staging.page("/blog/fresh-bread")).status).toBe(404);
		expect((await install.request(`${site.live}/blog/fresh-bread`)).status).toBe(200);
		void draft;
	});

	test("are reachable in Edit mode too, at their Draft address", async () => {
		const site = await newSite();
		await staff.api.entries.create({ siteId: site.siteId, postTypeId: site.pagesId, title: "Our team", slug: "team" });

		const editing = await openEditMode(install, staff, site.siteId, "/team");
		const page = await editing.page("/team");
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("<title>Our team");
		// The published page keeps its published address in Edit mode.
		expect((await editing.page("/about")).status).toBe(200);
	});

	test("the 404 page there is never kept and never indexed", async () => {
		const site = await newSite();
		const missing = await site.staging.page("/no-such-page");
		expect(missing.status).toBe(404);
		expect(missing.headers.get("cache-control")).toBe("private, no-store");
		expect(missing.headers.get("x-robots-tag")).toBe("noindex");
	});
});

describe("Structure Drafts", () => {
	test("Templates' Drafts show there: the Site template's and an Entry template's", async () => {
		const site = await newSite();
		await staff.api.templates.saveSiteTemplateMarkup({
			siteId: site.siteId,
			markup: "<header><p>New header</p></header><main>{{@outlet}}</main>",
		});
		await staff.api.templates.saveEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			markup: "<article><h1>{{ title }}</h1><p>Redesigned</p></article>",
		});

		const staged = await html(await site.staging.page("/blog/fresh-bread"));
		expect(staged).toContain("<p>New header</p>");
		expect(staged).toContain("<p>Redesigned</p>");
		const visitors = await html(await install.request(`${site.live}/blog/fresh-bread`));
		expect(visitors).not.toContain("New header");
		expect(visitors).not.toContain("Redesigned");
	});

	test("a Post Type whose Entry template was never published has pages there, and an Archive template's Draft shows", async () => {
		const site = await newSite();
		const { postType } = await staff.api.postTypes.create({
			siteId: site.siteId,
			name: "Recipes",
			key: "recipes",
			urlPattern: "/recipes/{slug}",
		});
		await staff.api.templates.saveEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: postType.id,
			markup: "<article><h1>{{ title }}</h1></article>",
		});
		await staff.api.templates.saveArchiveTemplateMarkup({
			siteId: site.siteId,
			postTypeId: postType.id,
			markup: "<h1>All recipes</h1>",
		});
		const recipe = await staff.api.entries.create({ siteId: site.siteId, postTypeId: postType.id, title: "Rye loaf" });
		await staff.api.entries.publish({ siteId: site.siteId, entryId: recipe.entry.id });

		expect(await html(await site.staging.page("/recipes/rye-loaf"))).toContain("<h1>Rye loaf</h1>");
		expect(await html(await site.staging.page("/recipes"))).toContain("<h1>All recipes</h1>");
		expect((await install.request(`${site.live}/recipes/rye-loaf`)).status).toBe(404);
		expect((await install.request(`${site.live}/recipes`)).status).toBe(404);
	});

	test("Components' Drafts show where they are placed", async () => {
		const site = await newSite();
		const { component } = await staff.api.components.create({ siteId: site.siteId, name: "Notice" });
		await staff.api.components.saveMarkup({
			siteId: site.siteId,
			componentId: component.id,
			markup: "<p>Open today</p>",
		});
		await staff.api.components.publish({ siteId: site.siteId, componentId: component.id });
		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			markup: "<article><h1>{{ title }}</h1><Notice /></article>",
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });
		await staff.api.components.saveMarkup({
			siteId: site.siteId,
			componentId: component.id,
			markup: "<p>Closed for the holidays</p>",
		});

		expect(await html(await site.staging.page("/blog/fresh-bread"))).toContain("<p>Closed for the holidays</p>");
		expect(await html(await install.request(`${site.live}/blog/fresh-bread`))).toContain("<p>Open today</p>");
	});

	test("the Design system's Draft is the stylesheet the Staging address links, served there only to the people reviewing it", async () => {
		const site = await newSite();
		await staff.api.designSystem.saveDraft({ siteId: site.siteId, customCss: "main { outline: 3px dashed tomato; }" });

		const staged = await html(await site.staging.page("/about"));
		const href = /<link rel="stylesheet" href="(\/_wc\/css\/[0-9a-f]{16}\.css)">/.exec(staged)?.[1] as string;
		const sheet = await site.staging.page(href);
		expect(sheet.status).toBe(200);
		expect(await sheet.text()).toContain("main{outline:3px dashed tomato}");
		// Nobody else gets it: not without access, not on the Site's domain.
		expect((await install.request(`${site.staging.origin}${href}`)).status).toBe(403);
		expect((await install.request(`${site.live}${href}`)).status).toBe(404);
		const visitors = await html(await install.request(`${site.live}/about`));
		expect(visitors).not.toContain(href);
	});

	test("the Site script's Draft runs there; visitors run the published one", async () => {
		const site = await newSite();
		const { script } = await staff.api.scripts.saveDraft({
			siteId: site.siteId,
			entryId: null,
			code: "console.log('published');",
		});
		await staff.api.scripts.publish({ siteId: site.siteId, scriptId: script.id });
		await staff.api.scripts.saveDraft({ siteId: site.siteId, entryId: null, code: "console.log('draft');" });

		const staged = await html(await site.staging.page("/about"));
		const src = /<script src="(\/_wc\/js\/[0-9a-f]{16}\.js)" defer>/.exec(staged)?.[1] as string;
		expect(await (await site.staging.page(src)).text()).toBe("console.log('draft');");
		expect((await install.request(`${site.live}${src}`)).status).toBe(404);
		const visitors = await html(await install.request(`${site.live}/about`));
		const live = /<script src="(\/_wc\/js\/[0-9a-f]{16}\.js)" defer>/.exec(visitors)?.[1] as string;
		expect(await (await install.request(`${site.live}${live}`)).text()).toBe("console.log('published');");
	});

	test("Loops show their Drafts over every Entry's Draft, never-published ones too, linked at their Draft addresses", async () => {
		const site = await newSite();
		const { loop } = await staff.api.loops.create({
			siteId: site.siteId,
			name: "latest-posts",
			source: "query",
			query: { postTypes: ["posts"], sort: [{ by: "title", direction: "asc" }] },
		});
		await staff.api.loops.publish({ siteId: site.siteId, loopId: loop.id });
		const saved = await staff.api.templates.saveSiteTemplateMarkup({
			siteId: site.siteId,
			markup:
				'<header><ul>{{@loop latest-posts as post}}<li><a href="{{ post.url }}">{{ post.title }}</a></li>{{/loop}}</ul></header><main>{{@outlet}}</main>',
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });
		await staff.api.entries.create({ siteId: site.siteId, postTypeId: site.postTypeId, title: "Spring menu" });

		const staged = await html(await site.staging.page("/about"));
		expect(staged).toContain(
			'<ul><li><a href="/blog/fresh-bread">Fresh bread</a></li><li><a href="/blog/spring-menu">Spring menu</a></li></ul>',
		);
		const visitors = await html(await install.request(`${site.live}/about`));
		expect(visitors).toContain('<ul><li><a href="/blog/fresh-bread">Fresh bread</a></li></ul>');

		await staff.api.loops.saveDraft({
			siteId: site.siteId,
			loopId: loop.id,
			query: { postTypes: ["posts"], sort: [{ by: "title", direction: "asc" }], limit: 1 },
		});
		expect(await html(await site.staging.page("/about"))).not.toContain("Spring menu");
	});

	test("a Form's Draft shows there", async () => {
		// Forms show where the Module keeping their Submissions runs.
		await (await install.superadmin()).api.modules.approve({ moduleId: "forms", version: "1.1.0" });
		const site = await newSite();
		const { form } = await staff.api.forms.create({ siteId: site.siteId, name: "Contact", key: "contact" });
		await staff.api.forms.saveDraft({
			siteId: site.siteId,
			formId: form.id,
			form: { fields: [{ key: "email", type: "email", label: "Your email", required: true }] },
		});
		await staff.api.forms.publish({ siteId: site.siteId, formId: form.id });
		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			markup: "<article><h1>{{ title }}</h1>{{@form contact}}</article>",
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });
		await staff.api.forms.saveDraft({
			siteId: site.siteId,
			formId: form.id,
			form: { fields: [{ key: "email", type: "email", label: "Where can we reach you?", required: true }] },
		});

		expect(await html(await site.staging.page("/blog/fresh-bread"))).toContain("Where can we reach you?");
		expect(await html(await install.request(`${site.live}/blog/fresh-bread`))).toContain("Your email");
	});
});

describe("search engines", () => {
	test("are told never to index the Staging address, in the page and in its headers", async () => {
		const site = await newSite();
		const response = await site.staging.page("/blog/fresh-bread");
		expect(response.headers.get("x-robots-tag")).toBe("noindex");
		expect(await html(response)).toContain('<meta name="robots" content="noindex">');
	});

	test("never take it as a page's canonical address: it points at the Primary domain, or nowhere before there is one", async () => {
		const site = await newSite();
		const staged = await html(await site.staging.page("/blog/fresh-bread"));
		expect(canonicalIn(staged)).toBe(`${site.live}/blog/fresh-bread`);

		const before = (await install.createSite(workspaceId, { slug: `drafts-${++sites}` })).id;
		const pages = (await staff.api.postTypes.list({ siteId: before })).postTypes.find(
			(type) => type.builtIn === "page",
		);
		await staff.api.entries.create({ siteId: before, postTypeId: pages?.id as string, title: "Soon", slug: "soon" });
		const unlaunched = await openStaging(install, staff, before);
		const page = await html(await unlaunched.page("/soon"));
		expect(canonicalIn(page)).toBeUndefined();
	});
});
