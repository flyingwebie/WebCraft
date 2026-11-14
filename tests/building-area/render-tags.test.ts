// What the building area's frame shows (ADR 0037 › 1.3, BA-08). For Staff (`structure.edit`) a page is
// rendered once with both kinds of tags: every element carries where it comes from (`data-wc-code`,
// its Template or Component and its id) and the editable regions keep Edit mode's tags, so one click
// selects an element and, on text, starts typing. It shows the Drafts of the Structure, as Code mode
// did, whatever Code mode's cookie says. A Member's page and visitors' pages are what they were.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type BuildingAreaBrowser, openBuildingArea } from "../harness/building-area.ts";
import { codeTagsIn, headOf, mainOf, siteStylesheetIn } from "../harness/code-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let postTypeId: string;
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
	postTypeId = postType.id;
	const entry = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup:
			'<article data-wc-id="article"><h1 data-wc-id="title">{{ title }}</h1><Strap heading="Fresh" data-wc-id="placed" /></article>',
	});
	await staff.api.templates.publish({ siteId, templateId: entry.template.id });
	await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup:
			'<article data-wc-id="article"><h1 data-wc-id="title">{{ title }}</h1><Strap heading="Fresh" data-wc-id="placed" /><p data-wc-id="added">New in the Draft</p></article>',
	});
	const { entry: post } = await editor.api.entries.create({ siteId, postTypeId, title: "Fresh bread" });
	await editor.api.entries.publish({ siteId, entryId: post.id });
});

afterAll(async () => {
	await install.close();
});

describe("a page in the building area's frame, for Staff", () => {
	let building: BuildingAreaBrowser;
	let html: string;

	beforeAll(async () => {
		building = await openBuildingArea(install, staff, siteId, { path });
		html = await expectSafePage(await building.page(path), "editMode");
	});

	test("shows the Drafts of its Templates and of the Components they place", () => {
		const main = mainOf(html);
		expect(main).toContain("New in the Draft");
		expect(main).toContain("Fresh (Draft)");
		expect(html).toContain("Draft footer");
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

	test("keeps Content editing's tags on the editable regions, beside where they come from", () => {
		// The title is a region of the Entry and an element of the Entry template, in one tag.
		expect(mainOf(html)).toMatch(
			/<h1 data-wc-item="entry:[0-9a-f-]+" data-wc-field="title" data-wc-type="text" data-wc-id="title" data-wc-code="content#title">Fresh bread<\/h1>/,
		);
		// What is typed in a region is the region's alone: no comment ranges inside it.
		expect(html).toMatch(/data-wc-code="content#title">Fresh bread<\/h1>/);
		// So is the Global in the Site template.
		expect(html).toMatch(/<p data-wc-item="globals" data-wc-field="tagline"[^>]* data-wc-code="site#tagline">/);
	});

	test("links the Design system's Draft, and only the page agent of WebCraft's own scripts", () => {
		expect(siteStylesheetIn(html)).toMatch(/^\/_webcraft\/edit\/css\/[0-9a-f]{16}\.css$/);
		const scripts = [...headOf(html).matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1]);
		expect(scripts).toEqual([expect.stringMatching(/^\/_webcraft\/edit\/assets\/agent-[0-9a-f]{16}\.js$/)]);
		expect(html).not.toContain("webcraft-code-mode");
		expect(html).not.toContain("<webcraft-edit-bar");
	});

	test("ignores Code mode's cookie: the same page with it or without it", async () => {
		const codeCookie = building.origin.startsWith("https:") ? "__Host-webcraft.code" : "webcraft.code";
		const cookies = [...building.browser.cookies].map(([name, value]) => `${name}=${value}`);
		const withCookie = await install.request(`${origin}${path}`, {
			headers: { cookie: [...cookies, `${codeCookie}=on`].join("; "), "sec-fetch-dest": "iframe" },
		});
		const body = await withCookie.text();
		expect(codeTagsIn(body)).toEqual(codeTagsIn(html));
		expect(body).toContain("data-wc-item");
		expect(body).not.toContain("webcraft-code-mode");
	});

	test("shows a Template that was never published on the page it makes: an Archive template", async () => {
		await staff.api.templates.saveArchiveTemplateMarkup({
			siteId,
			postTypeId,
			markup: '<section data-wc-id="list"><h1 data-wc-id="heading">All the posts</h1></section>',
		});
		const response = await building.page("/blog");
		expect(response.status).toBe(200);
		const body = await response.text();
		expect(body).toContain("All the posts");
		expect(codeTagsIn(body)).toContainEqual(["h1", "content#heading"]);
	});
});

describe("everyone else's pages are what they were", () => {
	test("a Member in the building area gets the published Structure and only the regions' tags", async () => {
		const building = await openBuildingArea(install, editor, siteId, { path });
		const body = await (await building.page(path)).text();
		expect(body).toContain("data-wc-item");
		expect(body).not.toContain("data-wc-code");
		expect(body).not.toContain("New in the Draft");
		expect(body).not.toContain("Draft footer");
		expect(siteStylesheetIn(body)).toMatch(/^\/_wc\/css\//);
	});

	test("a Member's page ignores Staff's building-area and Code mode cookies copied beside its own", async () => {
		const member = await openBuildingArea(install, editor, siteId, { path });
		const editCookie = [...member.browser.cookies].find(([name]) => name.endsWith("webcraft.edit"));
		const buildCookie = [...member.browser.cookies].find(([name]) => name.endsWith("webcraft.build"));
		expect(editCookie).toBeDefined();
		expect(buildCookie).toBeDefined();
		const page = await install.request(`${origin}${path}`, {
			headers: {
				cookie: [editCookie, buildCookie, ["__Host-webcraft.code", "on"]].map((pair) => pair?.join("=")).join("; "),
				"sec-fetch-dest": "iframe",
			},
		});
		const body = await page.text();
		expect(body).toContain("data-wc-item");
		expect(body).not.toContain("data-wc-code");
		expect(body).not.toContain("New in the Draft");
	});

	test("visitors never see any of it, whatever cookie they send", async () => {
		const page = await install.request(`${origin}${path}`, {
			headers: { cookie: "__Host-webcraft.code=on; __Host-webcraft.build=%2F" },
		});
		const body = await page.text();
		expect(body).not.toContain("data-wc-");
		expect(body).not.toContain("New in the Draft");
		expect(body).not.toContain("/_webcraft/");
	});
});
