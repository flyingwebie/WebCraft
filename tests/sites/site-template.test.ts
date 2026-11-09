// The Site template: one per Site, wrapping every page with its header, footer and the place where
// the page's content goes (`{{@outlet}}`, inside the page's one <main>). Until a Site publishes its
// own, every page has the built-in one: a skip link and <main>.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

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

/** A new Site with a Blog posts Post Type at /blog/{slug}, its published Entry template and one published Entry. */
async function siteWithPost(): Promise<{ siteId: string; url: string }> {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	return { siteId, url: `https://${slug}.live.test/blog/fresh-bread` };
}

async function bodyOf(url: string): Promise<string> {
	const response = await install.request(url);
	expect(response.status).toBe(200);
	return /<body>\n([\s\S]*)\n<\/body>/.exec(await expectSafePage(response))?.[1] ?? "";
}

describe("the built-in Site template", () => {
	test("wraps every page until the Site publishes its own: a skip link, then the page's content in <main>", async () => {
		const { url } = await siteWithPost();

		expect(await bodyOf(url)).toBe(
			[
				'<a class="wc-skip-link" href="#wc-main">Skip to main content</a>',
				'<main id="wc-main" tabindex="-1"><article><h1>Fresh bread</h1></article></main>',
			].join("\n"),
		);
	});
});

const SKIP_LINK = '<a class="wc-skip-link" href="#wc-main">Skip to main content</a>';

describe("a Site's own Site template", () => {
	const markup = [
		'<header><a href="/">Acme Bakery</a><nav aria-label="Main"><ul><li><a href="/blog">Blog</a></li></ul></nav></header>',
		"<main>{{@outlet}}</main>",
		"<footer><p>Open every day from seven.</p></footer>",
	].join("");

	test("Staff write it as Template markup; once published it wraps every page with its header and footer", async () => {
		const { siteId, url } = await siteWithPost();

		const saved = await staff.api.templates.saveSiteTemplateMarkup({ siteId, markup });

		expect(saved.template).toMatchObject({ kind: "site", siteId, postTypeId: null, status: "draft", published: null });
		expect(saved.notices).toEqual([]);
		expect(saved.markup.replaceAll(/ data-wc-id="[^"]+"/g, "")).toBe(markup);
		// A Draft changes nothing visitors see.
		expect(await bodyOf(url)).toEndWith(
			'<main id="wc-main" tabindex="-1"><article><h1>Fresh bread</h1></article></main>',
		);

		await staff.api.templates.publish({ siteId, templateId: saved.template.id });

		expect(await bodyOf(url)).toBe(
			[
				SKIP_LINK,
				'<header><a href="/">Acme Bakery</a><nav aria-label="Main"><ul><li><a href="/blog">Blog</a></li></ul></nav></header>' +
					'<main id="wc-main" tabindex="-1"><article><h1>Fresh bread</h1></article></main>' +
					"<footer><p>Open every day from seven.</p></footer>",
			].join("\n"),
		);
	});

	test("reads back as markup and as a tree, Draft and published, for Staff only", async () => {
		const { siteId } = await siteWithPost();
		expect(await staff.api.templates.getSiteTemplateMarkup({ siteId })).toEqual({
			template: null,
			markup: null,
			version: null,
		});
		expect(await staff.api.templates.getSiteTemplate({ siteId })).toEqual({ template: null });

		const saved = await staff.api.templates.saveSiteTemplateMarkup({ siteId, markup });
		await staff.api.templates.publish({ siteId, templateId: saved.template.id });
		await staff.api.templates.saveSiteTemplateMarkup({ siteId, markup: saved.markup.replace("seven", "eight") });

		const read = await staff.api.templates.getSiteTemplateMarkup({ siteId });
		expect(read.template).toMatchObject({ id: saved.template.id, kind: "site", status: "changed" });
		expect(read.markup).toEqual({ draft: saved.markup.replace("seven", "eight"), published: saved.markup });
		expect((await staff.api.templates.getSiteTemplate({ siteId })).template?.published).toEqual(saved.template.draft);
		await expect(editor.api.templates.getSiteTemplateMarkup({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(editor.api.templates.saveSiteTemplateMarkup({ siteId, markup })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("can be saved as an element tree too, and its Classes show on the page", async () => {
		const { siteId, url } = await siteWithPost();
		// An inline style becomes a generated Class, which a tree can then name by id.
		const styled = await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: '<div style="display: flex"><main>{{@outlet}}</main></div>',
		});
		expect(styled.notices).toHaveLength(1);
		const classId = (styled.template.draft.nodes[0] as { classes: string[] }).classes[0] ?? "";

		const { template } = await staff.api.templates.saveSiteTemplate({
			siteId,
			tree: {
				version: 1,
				nodes: [
					{
						type: "element",
						tag: "div",
						attributes: [],
						classes: [classId],
						children: [{ type: "element", tag: "main", attributes: [], classes: [], children: [{ type: "outlet" }] }],
					},
				],
			},
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });

		expect(await bodyOf(url)).toMatch(
			/\n<div class="style-[a-z0-9]+"><main id="wc-main" tabindex="-1"><article><h1>Fresh bread<\/h1><\/article><\/main><\/div>$/,
		);
	});
});

describe("what a Site template holds: one <main> at the top level of the page, holding the one {{@outlet}}", () => {
	type Problem = { line: number; column: number; message: string };
	let siteId: string;

	beforeAll(async () => {
		siteId = (await siteWithPost()).siteId;
	});

	/** Saving `markup` as the Site template is refused with one problem, at `line` and `column`, holding `says`. */
	async function refuses(markup: string, line: number, column: number, says: string): Promise<void> {
		const error = await staff.api.templates.saveSiteTemplateMarkup({ siteId, markup }).then(
			() => undefined,
			(refused: unknown) => refused,
		);
		expect(error).toMatchObject({ code: "TEMPLATE_MARKUP_INVALID", status: 400 });
		expect((error as { data: { problems: Problem[] } }).data.problems).toEqual([
			{ line, column, message: expect.stringContaining(says) },
		]);
	}

	test("it needs {{@outlet}}, where each page's content goes, exactly once", async () => {
		await refuses("<header>Acme</header>\n<main></main>", 1, 1, "The Site template needs {{@outlet}}");
		await refuses("<main>\n  {{@outlet}}\n  {{@outlet}}\n</main>", 3, 3, "one {{@outlet}}: this is a second one");
		await refuses("<main>{{@outlet now}}</main>", 1, 17, "{{@outlet}} takes nothing");
	});

	test("the outlet goes inside the page's one <main>", async () => {
		await refuses("<div>{{@outlet}}</div>", 1, 6, "{{@outlet}} goes inside <main>");
		await refuses("<main></main>\n<div>{{@outlet}}</div>", 2, 6, "{{@outlet}} goes inside <main>");
		await refuses("<main>{{@outlet}}</main><main></main>", 1, 25, "A page has one <main>: this is a second one");
	});

	test("<main> is a landmark of its own: only <div> elements may be around it", async () => {
		await refuses("<header><main>{{@outlet}}</main></header>", 1, 9, "<main> can't go inside <header>");
		await refuses("<div><section><main>{{@outlet}}</main></section></div>", 1, 15, "<main> can't go inside <section>");
		await refuses("{{@if true}}<main>{{@outlet}}</main>{{/if}}", 1, 13, "<main> can't go inside {{@if}}");
		await refuses("<main>{{@if true}}{{@outlet}}{{/if}}</main>", 1, 19, "{{@outlet}} can't go inside {{@if}}");
	});

	test("WebCraft gives <main> its id and tabindex, for the skip link", async () => {
		await refuses('<main id="content">{{@outlet}}</main>', 1, 1, "WebCraft gives <main> its id and tabindex");
		await refuses('<main tabindex="0">{{@outlet}}</main>', 1, 1, "WebCraft gives <main> its id and tabindex");
	});

	test("a tree is checked the same way, with where each problem is", async () => {
		const error = await staff.api.templates
			.saveSiteTemplate({
				siteId,
				tree: {
					version: 1,
					nodes: [{ type: "element", tag: "header", attributes: [], classes: [], children: [{ type: "outlet" }] }],
				},
			})
			.then(
				() => undefined,
				(refused: unknown) => refused,
			);

		expect(error).toMatchObject({
			code: "TEMPLATE_INVALID",
			data: { problems: [{ at: "nodes[0].children[0]", message: expect.stringContaining("goes inside <main>") }] },
		});
	});

	test("nothing of a refused save is kept, and a Site template that holds what it must is saved", async () => {
		await refuses("<div>{{@outlet}}</div>", 1, 6, "{{@outlet}} goes inside <main>");
		expect(await staff.api.templates.getSiteTemplate({ siteId })).toEqual({ template: null });

		const saved = await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: '<div><header>Acme</header><div><main aria-label="Content">{{@outlet}}</main></div></div>',
		});
		expect(saved.template.status).toBe("draft");
	});
});

describe("Entry templates", () => {
	test("hold neither <main> nor {{@outlet}}: both belong to the Site template around them", async () => {
		const siteId = (await install.createSite(workspaceId, { slug: `outlets-${++sites}` })).id;
		await goLive(install, siteId);
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });

		for (const [markup, says] of [
			["<main>{{ title }}</main>", "An Entry template renders inside the page's <main>"],
			["<article>{{@outlet}}</article>", "{{@outlet}} belongs to the Site template"],
		] as const) {
			await expect(
				staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: postType.id, markup }),
			).rejects.toMatchObject({
				code: "TEMPLATE_MARKUP_INVALID",
				data: { problems: [{ message: expect.stringContaining(says) }] },
			});
		}
		await expect(
			staff.api.templates.saveEntryTemplate({
				siteId,
				postTypeId: postType.id,
				tree: { version: 1, nodes: [{ type: "outlet" }] },
			}),
		).rejects.toMatchObject({ code: "TEMPLATE_INVALID", data: { problems: [{ at: "nodes[0]" }] } });
	});
});

describe("the Site template's values", () => {
	test("are the Site's Globals, as site.x: one footer phone number for every page", async () => {
		const { siteId, url } = await siteWithPost();
		await staff.api.globals.setFields({ siteId, fields: [{ key: "phone", label: "Phone", type: "text" }] });
		await editor.api.globals.saveDraft({ siteId, fields: { phone: "+353 21 000 0000" } });
		await editor.api.globals.publish({ siteId });

		const saved = await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: '<main>{{@outlet}}</main><footer><a href="tel:{{ site.phone }}">{{ site.phone }}</a></footer>',
		});
		await staff.api.templates.publish({ siteId, templateId: saved.template.id });

		expect(await bodyOf(url)).toEndWith('<footer><a href="tel:+353 21 000 0000">+353 21 000 0000</a></footer>');
	});

	test("never an Entry's own: the Site template wraps every page, whatever it shows", async () => {
		const { siteId } = await siteWithPost();

		for (const markup of [
			"<main>{{@outlet}}</main><p>{{ title }}</p>",
			"<main>{{@outlet}}</main><p>{{ site.phone }}</p>",
		]) {
			await expect(staff.api.templates.saveSiteTemplateMarkup({ siteId, markup })).rejects.toMatchObject({
				code: "TEMPLATE_MARKUP_INVALID",
			});
		}
	});

	test("a Global the published Site template reads can't be lost from under it when it is published again", async () => {
		const { siteId } = await siteWithPost();
		await staff.api.globals.setFields({ siteId, fields: [{ key: "phone", label: "Phone", type: "text" }] });
		const saved = await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: "<main>{{@outlet}}</main><footer>{{ site.phone }}</footer>",
		});
		await staff.api.globals.setFields({ siteId, fields: [] });

		await expect(staff.api.templates.publish({ siteId, templateId: saved.template.id })).rejects.toMatchObject({
			code: "TEMPLATE_INVALID",
		});
	});
});
