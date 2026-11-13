// Code mode (ADR 0016) is a third way of using Edit mode, for Staff and the Superadmin only. With it
// on, a page shows the Drafts of the Site's Structure (its Templates, the Components they place and
// the Design system) around the Drafts of its Content, and every element carries where it comes
// from, so selecting it opens its Template or Component. Content editing keeps showing the published
// Structure, Members never get Code mode, and visitors never see any of it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { codeTagsIn, headOf, mainOf, openCodeMode, siteStylesheetIn } from "../harness/code-mode.ts";
import { type EditModeBrowser, openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
const origin = "https://bakery.sites.test";
const path = "/blog/fresh-bread";

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;

	await staff.api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	await editor.api.globals.saveDraft({ siteId, fields: { tagline: "Baked daily" } });
	await editor.api.globals.publish({ siteId });

	// The Site template: published with a header, its Draft adds a footer.
	const site = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header data-wc-id="header"><p data-wc-id="tagline">{{ site.tagline }}</p></header><main data-wc-id="main">{{@outlet}}</main>',
	});
	await staff.api.templates.publish({ siteId, templateId: site.template.id });
	await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header data-wc-id="header"><p data-wc-id="tagline">{{ site.tagline }}</p></header><main data-wc-id="main">{{@outlet}}</main><footer data-wc-id="footer"><p data-wc-id="footnote">Draft footer</p></footer>',
	});

	// A Component, published, whose Draft uses a Class only the Design system's Draft has.
	await staff.api.designSystem.createClass({ siteId, name: "strap-title", styles: "color: rebeccapurple;" });
	const { component } = await staff.api.components.create({
		siteId,
		name: "Strap",
		props: [{ key: "heading", label: "Heading", type: "text" }],
	});
	await staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<div data-wc-id="strap"><h2 data-wc-id="heading">{{ props.heading }}</h2></div>',
	});
	await staff.api.components.publish({ siteId, componentId: component.id });
	await staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup:
			'<div data-wc-id="strap"><h2 class="strap-title" data-wc-id="heading">{{ props.heading }} (Draft)</h2></div>',
	});

	// The Entry template places it; its Draft adds a paragraph.
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const entry = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup:
			'<article data-wc-id="article"><h1 data-wc-id="title">{{ title }}</h1><Strap heading="Fresh" data-wc-id="placed" /></article>',
	});
	await staff.api.templates.publish({ siteId, templateId: entry.template.id });
	await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup:
			'<article data-wc-id="article"><h1 data-wc-id="title">{{ title }}</h1><Strap heading="Fresh" data-wc-id="placed" /><p data-wc-id="added">New in the Draft</p></article>',
	});
	const { entry: post } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await editor.api.entries.publish({ siteId, entryId: post.id });
});

afterAll(async () => {
	await install.close();
});

describe("a page in Code mode", () => {
	let coding: EditModeBrowser;
	let html: string;

	beforeAll(async () => {
		coding = await openCodeMode(install, staff, siteId, path);
		html = await expectSafePage(await coding.page(path), "editMode");
	});

	test("shows the Drafts of its Templates and of the Components they place", () => {
		expect(mainOf(html)).toBe(
			[
				'<article data-wc-code="content#article">',
				'<h1 data-wc-code="content#title">Fresh bread</h1>',
				'<div data-wc-code="content/placed#strap"><h2 class="strap-title" data-wc-code="content/placed#heading">Fresh (Draft)</h2></div>',
				'<p data-wc-code="content#added">New in the Draft</p>',
				"</article>",
			].join(""),
		);
	});

	test("tags every element with its Template or Component and its id, through the Placements that show it", () => {
		expect(codeTagsIn(html)).toEqual([
			["header", "site#header"],
			["p", "site#tagline"],
			["main", "site#main"],
			["article", "content#article"],
			["h1", "content#title"],
			["div", "content/placed#strap"],
			["h2", "content/placed#heading"],
			["p", "content#added"],
			["footer", "site#footer"],
			["p", "site#footnote"],
		]);
	});

	test("links the Design system's Draft, which only Code mode gets", async () => {
		const href = siteStylesheetIn(html);
		expect(href).toMatch(/^\/_webcraft\/edit\/css\/[0-9a-f]{16}\.css$/);
		const response = await coding.browser.request(`${origin}${href}`);
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
		expect(await response.text()).toContain(".strap-title");

		// Nobody else gets it: not without the edit cookie, nor a Member in Edit mode.
		expect((await install.request(`${origin}${href}`)).status).toBe(404);
		const member = await openEditMode(install, editor, siteId, path);
		expect((await member.browser.request(`${origin}${href}`)).status).toBe(404);
	});

	test("loads Code mode's own script after the editing bar's, both as files on the Site's domain", () => {
		const scripts = [...headOf(html).matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
		expect(scripts).toEqual([
			expect.stringMatching(/^\/_webcraft\/edit\/assets\/bar-[0-9a-f]{16}\.js$/),
			expect.stringMatching(/^\/_webcraft\/edit\/assets\/code-[0-9a-f]{16}\.js$/),
		]);
		expect(html).toContain('<meta name="webcraft-code-mode" content="on">');
	});

	test("carries no Content editing tags: selecting an element opens its code instead", () => {
		expect(html).not.toContain("data-wc-item");
	});

	test("turning it off shows Content editing again, with the published Structure", async () => {
		const other = await openCodeMode(install, staff, siteId, path);
		expect((await other.edit("code/stop")).status).toBe(200);

		const page = await (await other.page(path)).text();
		expect(page).not.toContain("data-wc-code");
		expect(page).not.toContain("webcraft-code-mode");
		expect(mainOf(page)).toMatch(
			/^<article><h1 data-wc-item="entry:[^"]+" data-wc-field="title"[^>]*>Fresh bread<\/h1>/,
		);
		expect(mainOf(page)).toContain("<h2>Fresh</h2>");
		expect(mainOf(page)).not.toContain("New in the Draft");
		expect(siteStylesheetIn(page)).toMatch(/^\/_wc\/css\//);
	});
});

describe("who gets Code mode", () => {
	test("the editing bar offers Code mode to Staff, never to Members", async () => {
		const coding = await openEditMode(install, staff, siteId, path);
		const editing = await openEditMode(install, editor, siteId, path);

		const forStaff = (await (await coding.edit("state", { path })).json()) as { canCode: boolean };
		const forMember = (await (await editing.edit("state", { path })).json()) as { canCode: boolean };

		expect(forStaff.canCode).toBe(true);
		expect(forMember.canCode).toBe(false);
	});

	test("Members in Edit mode can't turn it on", async () => {
		const editing = await openEditMode(install, editor, siteId, path);

		const refused = await editing.edit("code/start");
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { code: string }).code).toBe("FORBIDDEN");
		expect(await (await editing.page(path)).text()).not.toContain("data-wc-code");
	});

	test("a Member's page ignores a Code mode cookie copied from Staff", async () => {
		const coding = await openCodeMode(install, staff, siteId, path);
		const editing = await openEditMode(install, editor, siteId, path);
		const codeCookie = [...coding.browser.cookies].find(([name]) => name.endsWith("webcraft.code"));
		const editCookie = [...editing.browser.cookies].find(([name]) => name.endsWith("webcraft.edit"));
		expect(codeCookie).toBeDefined();

		const page = await install.request(`${origin}${path}`, {
			headers: { cookie: [editCookie, codeCookie].map((pair) => pair?.join("=")).join("; ") },
		});
		const body = await page.text();
		expect(body).toContain("data-wc-item");
		expect(body).not.toContain("data-wc-code");
		expect(body).not.toContain("New in the Draft");
	});

	test("visitors never see Code mode, whatever cookie they send", async () => {
		const page = await install.request(`${origin}${path}`, { headers: { cookie: "__Host-webcraft.code=on" } });
		const body = await page.text();

		expect(body).not.toContain("data-wc-");
		expect(body).not.toContain("New in the Draft");
		expect(body).not.toContain("/_webcraft/");
	});

	test("Staff whose session ended get no Code mode", async () => {
		const coding = await openCodeMode(install, staff, siteId, path);
		await coding.edit("end");

		const body = await (await coding.page(path)).text();
		expect(body).not.toContain("data-wc-");
		expect((await coding.edit("code/start")).status).toBe(401);
	});
});
