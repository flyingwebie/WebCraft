// Opening the visual builder (Staff only): the Draft of the Template or Component, its version for
// the next save, and everything the builder offers to insert and style there, as this kind of
// Template may hold it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;
let siteId: string;
let postTypeId: string;
let cardId: string;
let introClassId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "summary", label: "Summary", type: "text" }],
	});
	postTypeId = postType.id;
	await staff.api.globals.setFields({ siteId, fields: [{ key: "phone", label: "Phone", type: "text" }] });
	const created = await staff.api.designSystem.createClass({
		siteId,
		name: "intro",
		styles: "padding: var(--space-m);",
	});
	introClassId = created.class.id;
	const { component } = await staff.api.components.create({
		siteId,
		name: "Card",
		props: [{ key: "heading", label: "Heading", type: "text", required: true }],
	});
	cardId = component.id;
	await staff.api.loops.create({ siteId, name: "latest-posts", source: "query", query: { postTypes: [postType.key] } });
	await staff.api.forms.create({ siteId, name: "Contact", key: "contact" });
});

afterAll(async () => {
	await install.close();
});

describe("an Entry template the Site hasn't made yet", () => {
	test("opens empty, with no version, offering what an Entry template may hold", async () => {
		const opened = await staff.api.builder.open({ siteId, target: { kind: "entryTemplate", postTypeId } });

		expect(opened.template).toBeNull();
		expect(opened.tree).toEqual({ version: 1, nodes: [] });
		expect(opened.version).toBeNull();
		expect(opened.postType).toMatchObject({ id: postTypeId, name: "Blog posts" });
		const { catalogue } = opened;
		// Elements: semantic ones, never <main> (the Site template has the page's one) nor <script>.
		expect(catalogue.elements).toEqual(expect.arrayContaining(["section", "article", "nav", "figure", "h2", "ul"]));
		expect(catalogue.elements).not.toContain("main");
		expect(catalogue.elements).not.toContain("script");
		// Template commands from the registry, without the Site template's own outlet.
		expect(catalogue.commands).toEqual(expect.arrayContaining(["if", "loop", "form", "pagination", "search"]));
		expect(catalogue.commands).not.toContain("outlet");
		expect(catalogue.classes).toContainEqual({
			id: introClassId,
			name: "intro",
			generated: false,
			styles: "padding: var(--space-m);",
		});
		expect(catalogue.utilities).toContainEqual(expect.objectContaining({ name: "p-m" }));
		expect(catalogue.tokens).toContain("--space-m");
		// The Card isn't published yet, but Drafts may place Drafts.
		expect(catalogue.components).toEqual([
			{ id: cardId, name: "Card", props: [{ key: "heading", label: "Heading", type: "text", required: true }] },
		]);
		expect(catalogue.loops).toEqual([{ name: "latest-posts" }]);
		expect(catalogue.forms).toEqual([expect.objectContaining({ key: "contact", name: "Contact" })]);
		expect(catalogue.values).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ path: "title", group: "entry" }),
				expect.objectContaining({ path: "summary", label: "Summary", group: "entry" }),
				expect.objectContaining({ path: "site.phone", label: "Phone", group: "globals" }),
			]),
		);
		expect(opened.darkMode).toBe(false);
		expect(opened.language).toEqual({ code: "en", direction: "ltr" });
	});

	test("opens what was saved since, with the version a save names", async () => {
		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup:
				'<article class="intro" data-wc-label="Post" data-wc-id="post"><h1 data-wc-id="t">{{ title }}</h1></article>',
		});

		const opened = await staff.api.builder.open({ siteId, target: { kind: "entryTemplate", postTypeId } });

		expect(opened.template).toMatchObject({ id: saved.template.id, status: "draft" });
		expect(opened.tree).toEqual(saved.template.draft);
		expect(opened.version).toBe(saved.version);
	});
});

describe("the Site template", () => {
	test("may hold <main> and the content outlet, and reads only the Globals", async () => {
		const opened = await staff.api.builder.open({ siteId, target: { kind: "siteTemplate" } });

		expect(opened.catalogue.elements).toContain("main");
		expect(opened.catalogue.commands).toContain("outlet");
		expect(opened.catalogue.values.map((value) => value.group)).not.toContain("entry");
		expect(opened.postType).toBeNull();
	});
});

describe("a Component", () => {
	test("opens with its Props, which its tree reads as props.x, and never offers itself to place", async () => {
		const opened = await staff.api.builder.open({ siteId, target: { kind: "component", componentId: cardId } });

		expect(opened.component).toMatchObject({ id: cardId, name: "Card", status: "draft" });
		expect(opened.props).toEqual([expect.objectContaining({ key: "heading", label: "Heading", type: "text" })]);
		expect(opened.catalogue.values).toContainEqual(expect.objectContaining({ path: "props.heading", group: "props" }));
		expect(opened.catalogue.components).toEqual([]);
		expect(opened.usage).toEqual({ pages: 0 });
	});
});

describe("refused", () => {
	test("for Pages, which have no Entry or Archive template", async () => {
		const { postTypes } = await staff.api.postTypes.list({ siteId });
		const pages = postTypes.find((postType) => postType.builtIn === "page")?.id ?? "";
		await expect(
			staff.api.builder.open({ siteId, target: { kind: "entryTemplate", postTypeId: pages } }),
		).rejects.toMatchObject({ code: "PAGES_HAVE_NO_ENTRY_TEMPLATE" });
		await expect(
			staff.api.builder.open({ siteId, target: { kind: "archiveTemplate", postTypeId: pages } }),
		).rejects.toMatchObject({ code: "ARCHIVE_UNAVAILABLE" });
	});

	test("for Members: the builder changes Structure", async () => {
		const { browser: owner } = await install.createMember({ workspaceId, role: "owner" });
		await expect(owner.api.builder.open({ siteId, target: { kind: "siteTemplate" } })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
