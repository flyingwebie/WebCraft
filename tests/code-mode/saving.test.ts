// Code mode's HTML panel (ADR 0016): the page previews the markup as Staff type it, rendered by the
// server through the same parser as saving, and nothing is saved until Staff save. A save that
// doesn't parse is refused with each problem's line and column. A save over a Draft that someone
// changed since it was opened gets a conflict (CHANGED_MEANWHILE) naming the newer version, so the
// panel can offer to reload it or to overwrite it; nothing is merged silently.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { answer, mainOf, openCodeMode } from "../harness/code-mode.ts";
import { type EditModeBrowser, openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let otherStaff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;
const path = "/blog/fresh-bread";

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	otherStaff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

type Opened = { ref: string; markup: string; version: string | null };
type Preview = { html: string; stylesheet: { hash: string; css: string }; notices: { message: string }[] };
type Saved = { markup: string; version: string; notices: { line: number; column: number; message: string }[] };
type Refusal = {
	code: string;
	data?: { problems?: { line: number; column: number; message: string }[]; version?: string | null };
};

const ARTICLE =
	'<article data-wc-id="article"><h1 data-wc-id="title">{{ title }}</h1><Strap heading="Fresh" data-wc-id="placed" /></article>';

let sites = 0;

/** A Site with a published Blog post, whose Entry template places a published Strap Component. */
async function bakery() {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
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
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: ARTICLE,
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	return { siteId, slug, postTypeId: postType.id, componentId: component.id };
}

async function refusal(response: Response, status: number): Promise<Refusal> {
	expect(response.status).toBe(status);
	return (await response.json()) as Refusal;
}

describe("the preview while typing", () => {
	let site: Awaited<ReturnType<typeof bakery>>;
	let coding: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		coding = await openCodeMode(install, staff, site.siteId, path);
	});

	test("renders the page with the unsaved markup, as Code mode shows it, and saves nothing", async () => {
		const markup = ARTICLE.replace("</article>", '<p data-wc-id="typed">Only a preview</p></article>');

		const preview = await answer<Preview>(
			coding.edit("code/preview", { path, markup: { ref: "content", text: markup } }),
		);

		expect(mainOf(preview.html)).toBe(
			'<article data-wc-code="content#article"><h1 data-wc-code="content#title">Fresh bread</h1><div data-wc-code="content/placed#strap"><h2 data-wc-code="content/placed#heading">Fresh</h2></div><p data-wc-code="content#typed">Only a preview</p></article>',
		);
		const draft = await staff.api.templates.getEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
		});
		expect(draft.markup?.draft).toBe(ARTICLE);
		expect(mainOf(await (await coding.page(path)).text())).not.toContain("Only a preview");
	});

	test("previews a Component through every Placement of it on the page", async () => {
		const preview = await answer<Preview>(
			coding.edit("code/preview", {
				path,
				markup: {
					ref: "content/placed",
					text: '<div data-wc-id="strap"><h2 data-wc-id="heading">{{ props.heading }}!</h2></div>',
				},
			}),
		);

		expect(mainOf(preview.html)).toContain('<h2 data-wc-code="content/placed#heading">Fresh!</h2>');
	});

	test("an inline style previews as the generated Class it becomes, which only a save adds to the Design system", async () => {
		const markup = ARTICLE.replace('<h1 data-wc-id="title">', '<h1 style="color: rebeccapurple" data-wc-id="title">');

		const preview = await answer<Preview>(
			coding.edit("code/preview", { path, markup: { ref: "content", text: markup } }),
		);

		const name = /<h1 class="(style-[0-9a-f]+)"/.exec(preview.html)?.[1];
		expect(name).toBeDefined();
		expect(preview.stylesheet.css).toContain(`.${name}`);
		expect(preview.stylesheet.css).toContain("rebeccapurple");
		expect(preview.notices.length).toBe(1);
		const { designSystem } = await staff.api.designSystem.get({ siteId: site.siteId });
		expect(designSystem.draft.classes.map((each) => each.name)).not.toContain(name);
	});

	test("markup that doesn't parse answers its problems, with line and column", async () => {
		const response = await coding.edit("code/preview", {
			path,
			markup: {
				ref: "content",
				text: '<article data-wc-id="article">\n  <h1 onclick="go()">{{ title }}</h1>\n</article>',
			},
		});

		const refused = await refusal(response, 400);
		expect(refused.code).toBe("TEMPLATE_MARKUP_INVALID");
		expect(refused.data?.problems?.[0]).toMatchObject({ line: 2, column: 7 });
	});

	test("without changes, previews the page as Code mode shows it", async () => {
		const preview = await answer<Preview>(coding.edit("code/preview", { path }));

		expect(mainOf(preview.html)).toContain('<h1 data-wc-code="content#title">Fresh bread</h1>');
		expect(preview.stylesheet.hash).toMatch(/^[0-9a-f]{16}$/);
	});
});

describe("saving", () => {
	test("writes the Draft only when Staff save, as the admin would, and answers the markup as stored", async () => {
		const site = await bakery();
		const coding = await openCodeMode(install, staff, site.siteId, path);
		const opened = await answer<Opened>(coding.edit("code/open", { path, ref: "content#title" }));
		const markup = ARTICLE.replace("</article>", "<p>Saved from Code mode</p></article>");

		const saved = await answer<Saved>(
			coding.edit("code/save", { path, ref: "content", markup, version: opened.version }),
		);

		// The new element got its id.
		expect(saved.markup).toMatch(/<p data-wc-id="[A-Za-z0-9]+">Saved from Code mode<\/p><\/article>$/);
		expect(saved.version).not.toBe(opened.version);
		const draft = await staff.api.templates.getEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
		});
		expect(draft.markup?.draft).toBe(saved.markup);
		expect(draft.version).toBe(saved.version);
		// Code mode shows the Draft; visitors still see what is published.
		expect(mainOf(await (await coding.page(path)).text())).toContain("Saved from Code mode");
		const visitor = await install.request(`https://${site.slug}.sites.test${path}`);
		expect(await visitor.text()).not.toContain("Saved from Code mode");
	});

	test("saves a Component, and the Site template, making the Site's own from the built-in one", async () => {
		const site = await bakery();
		const coding = await openCodeMode(install, staff, site.siteId, path);
		const strap = await answer<Opened>(coding.edit("code/open", { path, ref: "content/placed#heading" }));
		await answer(
			coding.edit("code/save", {
				path,
				ref: "content/placed",
				markup: strap.markup.replace("</h2>", " today</h2>"),
				version: strap.version,
			}),
		);
		const builtIn = await answer<Opened>(coding.edit("code/open", { path, ref: "site" }));
		expect(builtIn.version).toBeNull();

		await answer(
			coding.edit("code/save", {
				path,
				ref: "site",
				markup: `<header><p>Acme</p></header>${builtIn.markup}`,
				version: null,
			}),
		);

		const page = await (await coding.page(path)).text();
		expect(page).toContain('<h2 data-wc-code="content/placed#heading">Fresh today</h2>');
		expect(page).toMatch(
			/<header data-wc-code="site#[A-Za-z0-9]+"><p data-wc-code="site#[A-Za-z0-9]+">Acme<\/p><\/header>/,
		);
		const { component } = await staff.api.components.get({ siteId: site.siteId, componentId: site.componentId });
		expect(component.status).toBe("changed");
	});

	test("refuses markup that doesn't parse, saving nothing", async () => {
		const site = await bakery();
		const coding = await openCodeMode(install, staff, site.siteId, path);
		const opened = await answer<Opened>(coding.edit("code/open", { path, ref: "content" }));

		const refused = await refusal(
			await coding.edit("code/save", {
				path,
				ref: "content",
				markup: "<article><script>alert(1)</script></article>",
				version: opened.version,
			}),
			400,
		);

		expect(refused.code).toBe("TEMPLATE_MARKUP_INVALID");
		expect(refused.data?.problems?.[0]).toMatchObject({ line: 1, column: 10 });
		const draft = await staff.api.templates.getEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
		});
		expect(draft.markup?.draft).toBe(ARTICLE);
	});

	test("Members in Edit mode can't preview or save code", async () => {
		const site = await bakery();
		const editing = await openEditMode(install, editor, site.siteId, path);

		expect((await refusal(await editing.edit("code/preview", { path }), 403)).code).toBe("FORBIDDEN");
		const save = await editing.edit("code/save", { path, ref: "content", markup: ARTICLE, version: null });
		expect((await refusal(save, 403)).code).toBe("FORBIDDEN");
	});
});

describe("a save over a Draft that changed since it was opened", () => {
	test("is refused with the newer version, keeping what the other person saved", async () => {
		const site = await bakery();
		const coding = await openCodeMode(install, staff, site.siteId, path);
		const opened = await answer<Opened>(coding.edit("code/open", { path, ref: "content" }));
		const theirs = await otherStaff.api.templates.saveEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			markup: ARTICLE.replace("</article>", "<p>Theirs</p></article>"),
		});

		const refused = await refusal(
			await coding.edit("code/save", {
				path,
				ref: "content",
				markup: ARTICLE.replace("</article>", "<p>Mine</p></article>"),
				version: opened.version,
			}),
			409,
		);

		expect(refused.code).toBe("CHANGED_MEANWHILE");
		expect(refused.data?.version).toBe(theirs.version);
		const draft = await staff.api.templates.getEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
		});
		expect(draft.markup?.draft).toContain("Theirs");

		// Reloading opens what they saved; overwriting saves over that version.
		const reloaded = await answer<Opened>(coding.edit("code/open", { path, ref: "content" }));
		expect(reloaded.version).toBe(theirs.version);
		const overwritten = await answer<Saved>(
			coding.edit("code/save", {
				path,
				ref: "content",
				markup: ARTICLE.replace("</article>", "<p>Mine</p></article>"),
				version: refused.data?.version,
			}),
		);
		expect(overwritten.markup).toContain("Mine");
		expect(overwritten.markup).not.toContain("Theirs");
	});

	test("the same goes for Components and for a Site template made meanwhile", async () => {
		const site = await bakery();
		const coding = await openCodeMode(install, staff, site.siteId, path);
		const strap = await answer<Opened>(coding.edit("code/open", { path, ref: "content/placed" }));
		await otherStaff.api.components.saveMarkup({
			siteId: site.siteId,
			componentId: site.componentId,
			markup: '<div data-wc-id="strap"><h3>{{ props.heading }}</h3></div>',
		});
		await otherStaff.api.templates.saveSiteTemplateMarkup({ siteId: site.siteId, markup: "<main>{{@outlet}}</main>" });

		const component = await coding.edit("code/save", {
			path,
			ref: "content/placed",
			markup: strap.markup,
			version: strap.version,
		});
		expect((await refusal(component, 409)).code).toBe("CHANGED_MEANWHILE");
		const siteTemplate = await coding.edit("code/save", {
			path,
			ref: "site",
			markup: "<main>{{@outlet}}</main><footer>Mine</footer>",
			version: null,
		});
		expect((await refusal(siteTemplate, 409)).code).toBe("CHANGED_MEANWHILE");
	});
});

describe("the Management API's markup saves", () => {
	test("answer the Draft's version, and refuse a save based on an older one", async () => {
		const site = await bakery();
		const { siteId, postTypeId, componentId } = site;
		const first = await staff.api.templates.getEntryTemplateMarkup({ siteId, postTypeId });
		const coding = await openCodeMode(install, staff, siteId, path);
		const opened = await answer<Opened>(coding.edit("code/open", { path, ref: "content" }));
		expect(first.version).toBe(opened.version);

		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup: ARTICLE.replace("Fresh", "Warm"),
			basedOn: first.version,
		});
		await expect(
			otherStaff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: ARTICLE, basedOn: first.version }),
		).rejects.toMatchObject({ code: "CHANGED_MEANWHILE", data: { version: saved.version } });

		const component = await staff.api.components.getMarkup({ siteId, componentId });
		await staff.api.components.saveMarkup({
			siteId,
			componentId,
			markup: component.markup.draft,
			basedOn: component.version,
		});
		await expect(
			staff.api.components.saveMarkup({
				siteId,
				componentId,
				markup: "<p>{{ props.heading }}</p>",
				basedOn: "0000000000000000",
			}),
		).rejects.toMatchObject({ code: "CHANGED_MEANWHILE" });

		await expect(
			staff.api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: "<main>{{@outlet}}</main>",
				basedOn: "0000000000000000",
			}),
		).rejects.toMatchObject({ code: "CHANGED_MEANWHILE", data: { version: null } });
		const made = await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: "<main>{{@outlet}}</main>",
			basedOn: null,
		});
		expect(made.version).toMatch(/^[0-9a-f]{16}$/);
	});
});
