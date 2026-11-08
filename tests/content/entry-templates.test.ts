// Entry templates: one per Post Type, stored as an element tree (ADR 0002) with a Draft and a
// published version. They are Structure: only Staff (and the Superadmin) save and publish them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { element, type TestNode, text, tree, value } from "../harness/trees.ts";

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

describe("saving an Entry template", () => {
	test("stores the tree as its Draft, with an id on every element; nothing is published yet", async () => {
		expect((await staff.api.templates.getEntryTemplate({ siteId, postTypeId })).template).toBeNull();
		const draft = tree(
			element("ARTICLE", [
				element("h1", [value("title")]),
				element("p", [text("By "), value("author"), text(" on "), value("publishedAt")]),
				element("a", [text("Read more")], {
					href: [{ type: "text", text: "/blog/" }, value("slug")],
					"Aria-Label": "More",
				}),
			]),
		);

		const { template } = await staff.api.templates.saveEntryTemplate({ siteId, postTypeId, tree: draft });

		expect(template).toMatchObject({ kind: "entry", postTypeId, status: "draft", published: null });
		const article = template.draft.nodes[0];
		expect(article).toMatchObject({ type: "element", tag: "article", id: expect.stringMatching(/^[A-Za-z0-9]{12}$/) });
		const link = article?.type === "element" ? article.children[2] : undefined;
		expect(link).toMatchObject({
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
		});
		expect((await staff.api.templates.getEntryTemplate({ siteId, postTypeId })).template).toEqual(template);
	});

	test("keeps element ids it is given, so saving the same tree again changes nothing", async () => {
		const { template: first } = await staff.api.templates.getEntryTemplate({ siteId, postTypeId }).then((answer) => ({
			template: answer.template,
		}));
		if (!first) throw new Error("The template should exist by now.");

		const { template: again } = await staff.api.templates.saveEntryTemplate({ siteId, postTypeId, tree: first.draft });

		expect(again.draft).toEqual(first.draft);
		expect(again.id).toBe(first.id);
	});

	test("publishing makes the Draft the published version; a later Draft is a change", async () => {
		const { template } = await staff.api.templates.saveEntryTemplate({
			siteId,
			postTypeId,
			tree: tree(element("article", [element("h1", [value("title")])])),
		});

		await staff.api.templates.publish({ siteId, templateId: template.id });
		const published = (await staff.api.templates.getEntryTemplate({ siteId, postTypeId })).template;
		expect(published).toMatchObject({ status: "published", published: published?.draft });

		await staff.api.templates.saveEntryTemplate({
			siteId,
			postTypeId,
			tree: tree(element("article", [element("h2", [value("title")])])),
		});
		const changed = (await staff.api.templates.getEntryTemplate({ siteId, postTypeId })).template;
		expect(changed?.status).toBe("changed");
		expect(changed?.published).toEqual(published?.published ?? null);
	});

	test("Members can't read, save or publish Templates: they are Structure", async () => {
		const { template } = await staff.api.templates.saveEntryTemplate({
			siteId,
			postTypeId,
			tree: tree(element("h1", [value("title")])),
		});

		await expect(owner.api.templates.getEntryTemplate({ siteId, postTypeId })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(
			owner.api.templates.saveEntryTemplate({ siteId, postTypeId, tree: tree(element("h1")) }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(owner.api.templates.publish({ siteId, templateId: template.id })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});

describe("refused trees", () => {
	const refuses = async (nodes: TestNode[] | unknown, at: string) => {
		const input = Array.isArray(nodes) ? tree(...(nodes as TestNode[])) : nodes;
		await expect(staff.api.templates.saveEntryTemplate({ siteId, postTypeId, tree: input })).rejects.toMatchObject({
			code: "TEMPLATE_INVALID",
			data: { problems: [{ at }] },
		});
	};

	test("scripts, and elements Templates don't have", async () => {
		await refuses([element("script", [text("alert(1)")])], "nodes[0].tag");
		for (const tag of [
			"style",
			"iframe",
			"object",
			"embed",
			"form",
			"input",
			"meta",
			"link",
			"base",
			"svg",
			"blink",
			"x-widget",
		]) {
			await refuses([element("div", [element(tag)])], "nodes[0].children[0].tag");
		}
	});

	test("event handler attributes, inline styles, class names, srcdoc and WebCraft's own data attributes", async () => {
		for (const name of ["onclick", "OnLoad", "style", "class", "srcdoc", "data-wc-field", "x:y", "1st"]) {
			await refuses([element("p", [], { [name]: "x" })], "nodes[0].attributes[0]");
		}
	});

	test("values with names the Entry doesn't have", async () => {
		await refuses([element("p", [value("price")])], "nodes[0].children[0].path");
		await refuses([element("a", [], { href: [value("site.url")] })], "nodes[0].attributes[0].value[0].path");
		await refuses([element("p", [value("summary; drop")])], "nodes[0].children[0].path");
	});

	test("a <main> element: the page's <main> holds the Entry template", async () => {
		await refuses([element("main", [element("h1", [value("title")])])], "nodes[0].tag");
	});

	test("children of void elements, the same id twice, and Classes the Site doesn't have", async () => {
		await refuses([element("img", [text("caption")], { alt: "" })], "nodes[0].children");
		const twice = { ...element("p"), id: "same" };
		await refuses([twice, twice], "nodes[1].id");
		await refuses([{ ...element("p"), classes: ["no-such-class"] }], "nodes[0].classes[0]");
	});

	test("anything that isn't a tree of this version", async () => {
		await refuses({ version: 2, nodes: [] }, "version");
		await refuses({ version: 1, nodes: "<h1>Hi</h1>" }, "nodes");
		await refuses({ version: 1, nodes: [{ type: "comment", text: "x" }] }, "nodes[0]");
	});

	test("an Entry template for a Post Type the Site doesn't have", async () => {
		await expect(
			staff.api.templates.saveEntryTemplate({
				siteId,
				postTypeId: "00000000-0000-4000-8000-000000000000",
				tree: tree(element("h1")),
			}),
		).rejects.toMatchObject({ code: "POST_TYPE_NOT_FOUND" });
	});
});
