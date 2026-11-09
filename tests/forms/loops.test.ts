// Forms together with Loops, pagination and time (GLOSSARY.md › Form, Loop): a page shows a placed
// Form once, never once per Loop item; a Form on page N of a paginated Loop posts back to page N and
// its errors and message show there, while the cached page N stays everyone's; a page kept until a
// `now` Condition changes still gives each answer its own Form token.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type forms from "@webcraft/module-forms";

import { formVisitor } from "../harness/forms.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let siteId: string;
let formId: string;
let recipesId: string;
let pagesId: string;

const SITE = "https://bakery.sites.test";
const DAY = 24 * 60 * 60 * 1000;
/** A time-trap token as pages carry them: never the cache's mark. */
const TOKEN = /^[0-9a-z]+\.[A-Za-z0-9_-]{43}$/;

/** The Submissions kept for the Form, newest first. */
async function kept() {
	return (await moduleApi<typeof forms>(owner, "forms").submissions.list({ siteId, formId, folder: "inbox" }))
		.submissions;
}

/** Saves and publishes the Archive template of Recipes as `markup`. */
async function archive(markup: string): Promise<void> {
	const { template } = await staff.api.templates.saveArchiveTemplateMarkup({ siteId, postTypeId: recipesId, markup });
	await staff.api.templates.publish({ siteId, templateId: template.id });
}

/** What a page's <main> holds. */
function mainOf(html: string): string {
	return /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? "";
}

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-04-01T09:00:00Z") });
	await (await install.superadmin()).api.modules.approve({ moduleId: "forms", version: "1.0.0" });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	const { form } = await staff.api.forms.create({ siteId, name: "Order", key: "order" });
	formId = form.id;
	await staff.api.forms.saveDraft({
		siteId,
		formId,
		form: {
			fields: [
				{ key: "name", type: "text", label: "Your name", required: true },
				{ key: "email", type: "email", label: "Email", required: true },
			],
			success: { kind: "message", message: "Thanks for your order." },
		},
	});
	await staff.api.forms.publish({ siteId, formId });
	recipesId = (
		await staff.api.postTypes.create({ siteId, name: "Recipes", key: "recipes", urlPattern: "/recipes/{slug}" })
	).postType.id;
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	pagesId = postTypes.find((postType) => postType.builtIn === "page")?.id ?? "";
	for (const title of ["Crumble", "Brioche", "Apple tart"]) {
		const { entry } = await staff.api.entries.create({ siteId, postTypeId: recipesId, title });
		await staff.api.entries.publish({ siteId, entryId: entry.id });
		install.clock.advance(DAY);
	}
	const { loop } = await staff.api.loops.create({
		siteId,
		name: "paged-recipes",
		source: "query",
		query: { postTypes: ["recipes"], limit: 2, paginate: true },
	});
	await staff.api.loops.publish({ siteId, loopId: loop.id });
});

afterAll(async () => {
	await install.close();
});

describe("a Form in a Loop", () => {
	test("can't be placed in a Loop's items, in markup or in a tree; {{@empty}} may hold one", async () => {
		const markup = (text: string) =>
			staff.api.templates.saveArchiveTemplateMarkup({ siteId, postTypeId: recipesId, markup: text });

		await expect(
			markup("{{@loop paged-recipes as r}}<article>{{@form order}}</article>{{/loop}}"),
		).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: {
				problems: [
					{
						line: 1,
						column: 38,
						message: expect.stringContaining("{{@form}} can't go inside a Loop's items"),
					},
				],
			},
		});
		await expect(
			staff.api.templates.saveArchiveTemplate({
				siteId,
				postTypeId: recipesId,
				tree: {
					version: 1,
					nodes: [
						{
							type: "loop",
							source: "paged-recipes",
							alias: "r",
							children: [{ type: "form", form: formId }],
							empty: null,
						},
					],
				},
			}),
		).rejects.toMatchObject({
			code: "TEMPLATE_INVALID",
			data: {
				problems: [{ at: "nodes[0].children[0]", message: expect.stringContaining("can't go inside a Loop's items") }],
			},
		});
		const saved = await markup("{{@loop paged-recipes as r}}<p>{{ r.title }}</p>{{@empty}}{{@form order}}{{/loop}}");
		expect(saved.markup).toContain("{{@empty}}{{@form order}}{{/loop}}");
	});

	test("one a Component brings into a Loop's items shows nothing there; the page's own is Form number 1", async () => {
		const { component } = await staff.api.components.create({ siteId, name: "OrderBox" });
		await staff.api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: "<aside>{{@form order}}</aside>",
		});
		await staff.api.components.publish({ siteId, componentId: component.id });
		await archive(
			"{{@loop paged-recipes as r}}<article><h2>{{ r.title }}</h2><OrderBox /></article>{{/loop}}{{@form order}}",
		);

		const page = await formVisitor(install).open(`${SITE}/recipes`);

		expect(page.status).toBe(200);
		const main = mainOf(page.html);
		expect(main).toStartWith(
			"<article><h2>Apple tart</h2><aside></aside></article><article><h2>Brioche</h2><aside></aside></article>",
		);
		expect(main.match(/<form /g)).toHaveLength(1);
		expect(main).toContain('<form class="wc-form" id="wc-form-1"');
		expect(page.form().hidden).toMatchObject({ "wc-page": "/recipes", "wc-i": "1" });
	});
});

describe("a Form on page 2 of a paginated Archive", () => {
	const PAGE_2 = `${SITE}/recipes?page=2`;

	beforeAll(async () => {
		await archive(
			"{{@loop paged-recipes as r}}<p>{{ r.title }}</p>{{/loop}}{{@pagination paged-recipes}}{{@form order}}",
		);
	});

	test("posts back to page 2, and every answer of the cached page carries a token of its own", async () => {
		const visitor = formVisitor(install);
		const first = await visitor.open(PAGE_2);
		await install.clock.advance(1000);
		const second = await visitor.open(PAGE_2);

		expect(first.status).toBe(200);
		expect(mainOf(first.html)).toStartWith("<p>Crumble</p>");
		expect(first.form().hidden).toMatchObject({ "wc-page": "/recipes?page=2", "wc-i": "1" });
		expect(second.response.headers.get("x-cache")).toBe("HIT");
		expect(first.form().hidden["wc-t"]).toMatch(TOKEN);
		expect(second.form().hidden["wc-t"]).toMatch(TOKEN);
		expect(second.form().hidden["wc-t"]).not.toBe(first.form().hidden["wc-t"]);
		expect(second.response.headers.get("etag")).toBe(first.response.headers.get("etag"));
		// Page 1's Form posts back to page 1.
		expect((await visitor.open(`${SITE}/recipes`)).form().hidden["wc-page"]).toBe("/recipes");
	});

	test("errors come back on page 2, and the cached page 2 stays everyone's", async () => {
		const visitor = formVisitor(install);
		const page = await visitor.open(PAGE_2);
		await install.clock.advance(5000);

		const answer = await visitor.send(page, { name: "Bea", email: "not an email" });

		expect(answer.status).toBe(422);
		expect(answer.headers.get("cache-control")).toBe("no-store");
		const html = await answer.text();
		expect(html).toContain("<title>Error: Recipes · Page 2 · Acme Bakery</title>");
		expect(mainOf(html)).toStartWith("<p>Crumble</p>");
		expect(html).toContain('<a href="#wc-form-1-email">Email: Enter an email address, such as name@example.com.</a>');
		expect(html).toContain('value="Bea"');
		const again = await visitor.open(PAGE_2);
		expect(again.response.headers.get("x-cache")).toBe("HIT");
		expect(again.html).not.toContain("Bea");
		expect(again.html).not.toContain("aria-invalid");
		expect(again.html).not.toContain("wc-form-errors");
		expect(again.form().hidden["wc-t"]).toMatch(TOKEN);
	});

	test("once sent, the visitor sees its message on page 2; the Submission records page 2", async () => {
		const visitor = formVisitor(install);
		const page = await visitor.open(PAGE_2);
		await install.clock.advance(5000);

		const sent = await visitor.send(page, { name: "Ada", email: "ada@example.com" });

		expect(sent.status).toBe(303);
		expect(sent.headers.get("location")).toBe("/recipes?page=2&wc-sent=1#wc-form-1");
		expect((await kept())[0]).toMatchObject({ page: "/recipes?page=2", language: "en" });
		const after = await visitor.open(`${SITE}${sent.headers.get("location")}`);
		expect(after.status).toBe(200);
		expect(after.response.headers.get("cache-control")).toBe("no-store");
		expect(mainOf(after.html)).toStartWith("<p>Crumble</p>");
		expect(after.html).toContain(
			'<div class="wc-form-sent" id="wc-form-1" role="status" tabindex="-1" autofocus><p>Thanks for your order.</p></div>',
		);
		// Everyone else still gets the Form on page 2.
		expect((await visitor.open(PAGE_2)).html).toContain('<form class="wc-form"');
	});
});

describe("a Form on a page a `now` Condition changes", () => {
	test("the page is kept until the date, each answer with its own token, and a token from the cache is taken", async () => {
		const { template } = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: recipesId,
			markup: '<h1>{{ title }}</h1>{{@if now >= "2026-04-20"}}<p>Open</p>{{@else}}<p>Soon</p>{{/if}}{{@form order}}',
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });
		const visitor = formVisitor(install);
		const url = `${SITE}/recipes/brioche`;

		const first = await visitor.open(url);
		await install.clock.advance(1000);
		const cached = await visitor.open(url);
		expect(first.response.headers.get("x-cache")).toBe("MISS");
		expect(cached.response.headers.get("x-cache")).toBe("HIT");
		expect(mainOf(cached.html)).toStartWith("<h1>Brioche</h1><p>Soon</p>");
		expect(cached.form().hidden["wc-t"]).toMatch(TOKEN);
		expect(cached.form().hidden["wc-t"]).not.toBe(first.form().hidden["wc-t"]);
		// The token a cached answer carried is one the Install made: the post is kept.
		await install.clock.advance(5000);
		const sent = await visitor.send(cached, { name: "Cy", email: "cy@example.com" });
		expect(sent.headers.get("location")).toBe("/recipes/brioche?wc-sent=1#wc-form-1");
		expect((await kept())[0]).toMatchObject({ page: "/recipes/brioche", spamReason: null });

		await install.clock.advance(20 * DAY);
		const later = await visitor.open(url);
		expect(later.response.headers.get("x-cache")).toBe("MISS");
		expect(mainOf(later.html)).toStartWith("<h1>Brioche</h1><p>Open</p>");
		expect(later.form().hidden["wc-t"]).toMatch(TOKEN);
		expect((await visitor.open(url)).response.headers.get("x-cache")).toBe("HIT");
	});
});

describe("a Form on page 2 of a paginated Page", () => {
	test("posts back to page 2, and its errors come back there", async () => {
		// The clock moved on past Staff's session: sign in afresh.
		const { api } = await install.superadmin();
		const { template } = await api.templates.saveSiteTemplateMarkup({
			siteId,
			markup:
				"<main>{{@outlet}}{{@loop paged-recipes as r}}<p>{{ r.title }}</p>{{/loop}}{{@pagination paged-recipes}}</main>" +
				"<footer>{{@form order}}</footer>",
		});
		await api.templates.publish({ siteId, templateId: template.id });
		const { entry: about } = await api.entries.create({ siteId, postTypeId: pagesId, title: "About" });
		await api.entries.publish({ siteId, entryId: about.id });
		const visitor = formVisitor(install);

		const page = await visitor.open(`${SITE}/about?page=2`);
		expect(page.status).toBe(200);
		expect(page.form().hidden).toMatchObject({ "wc-page": "/about?page=2", "wc-i": "1" });
		expect(page.form().hidden["wc-t"]).toMatch(TOKEN);
		await install.clock.advance(5000);

		const answer = await visitor.send(page, { name: "Dee" });
		expect(answer.status).toBe(422);
		const html = await answer.text();
		expect(html).toContain("<title>Error: About · Page 2 · Acme Bakery</title>");
		expect(mainOf(html)).toContain("<p>Crumble</p>");
		expect(html).toContain('value="Dee"');
	});
});
