// Template markup through the Management API: Staff (and AI clients, the CLI and Code mode later)
// read and write Templates as Template markup, a lossless text view of the stored element tree
// (ADR 0017). The markup is never stored as text: saving parses it into a tree, reading prints it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let siteId: string;
let postTypeId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "summary", label: "Summary", type: "text" }],
	});
	postTypeId = postType.id;
});

afterAll(async () => {
	await install.close();
});

/** The ids of the elements in a tree, depth first. */
function elementIds(nodes: readonly unknown[]): string[] {
	return nodes.flatMap((node) => {
		const element = node as { type: string; id?: string; children?: unknown[] };
		return element.type === "element" ? [element.id ?? "", ...elementIds(element.children ?? [])] : [];
	});
}

describe("saving Template markup", () => {
	test("stores it as the Draft's element tree, gives every element an id and answers the markup with them", async () => {
		const markup = [
			"<article>",
			"  <h1>{{ title }}</h1>",
			'  <a href="/blog/{{ slug }}" aria-label="More">Read more</a>',
			"</article>",
		].join("\n");

		const saved = await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup });

		expect(saved.notices).toEqual([]);
		expect(saved.template).toMatchObject({ kind: "entry", postTypeId, status: "draft", published: null });
		const [articleId = "", headingId = "", linkId = ""] = elementIds(saved.template.draft.nodes);
		expect(saved.template.draft).toEqual({
			version: 1,
			nodes: [
				{
					type: "element",
					id: articleId,
					tag: "article",
					attributes: [],
					classes: [],
					children: [
						{ type: "text", text: "\n  " },
						{
							type: "element",
							id: headingId,
							tag: "h1",
							attributes: [],
							classes: [],
							children: [{ type: "value", path: "title" }],
						},
						{ type: "text", text: "\n  " },
						{
							type: "element",
							id: linkId,
							tag: "a",
							attributes: [
								{
									name: "href",
									value: [
										{ type: "text", text: "/blog/" },
										{ type: "value", path: "slug" },
									],
								},
								{ name: "aria-label", value: [{ type: "text", text: "More" }] },
							],
							classes: [],
							children: [{ type: "text", text: "Read more" }],
						},
						{ type: "text", text: "\n" },
					],
				},
			],
		});
		expect(articleId).toMatch(/^[A-Za-z0-9]{12}$/);
		expect(saved.markup).toBe(
			[
				`<article data-wc-id="${articleId}">`,
				`  <h1 data-wc-id="${headingId}">{{ title }}</h1>`,
				`  <a href="/blog/{{ slug }}" aria-label="More" data-wc-id="${linkId}">Read more</a>`,
				"</article>",
			].join("\n"),
		);
	});

	test("keeps the ids it is given, so saving the markup it answered changes nothing", async () => {
		const first = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup: "<section><h2>{{ summary }}</h2></section>",
		});

		const again = await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: first.markup });

		expect(again.template.draft).toEqual(first.template.draft);
		expect(again.markup).toBe(first.markup);
		expect(again.template.id).toBe(first.template.id);
	});

	test("reads a Template's Draft and published version as markup", async () => {
		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup: "<p>{{ summary }}</p>",
		});
		expect(await staff.api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).toEqual({
			template: saved.template,
			markup: { draft: saved.markup, published: null },
		});

		await staff.api.templates.publish({ siteId, templateId: saved.template.id });
		await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: "<p>Changed</p>" });
		const read = await staff.api.templates.getEntryTemplateMarkup({ siteId, postTypeId });

		expect(read.markup?.published).toBe(saved.markup);
		expect(read.markup?.draft).toMatch(/^<p data-wc-id="[A-Za-z0-9]{12}">Changed<\/p>$/);
	});

	test("a Post Type without an Entry template reads as null", async () => {
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Events", urlPattern: "/events/{slug}" });

		expect(await staff.api.templates.getEntryTemplateMarkup({ siteId, postTypeId: postType.id })).toEqual({
			template: null,
			markup: null,
		});
	});

	test("Members can't read or save Template markup: Templates are Structure", async () => {
		await expect(owner.api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			owner.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: "<p>Hi</p>" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
