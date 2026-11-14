// A Page's Placements in the building area (BA-09; ADR 0037 › 1.3). A Page holds placed Components
// only: its content is its Page layout. For Staff the frame tags each element a Placement shows with
// `content/<placement id>#<element id>`, and the shell opens each Placement's Component by that
// reference with `code/editor` (and Code mode's `code/open`), which follow it from the Page's Draft
// Page layout. The Page layout itself is the Page's Content: it opens read only, never as markup.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type BuildingAreaBrowser, openBuildingArea } from "../harness/building-area.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let quoteId: string;
let pageId: string;
const path = "/home";

type EditorAnswer = {
	ref: string;
	editable: boolean;
	name: string | null;
	target: { kind: string; componentId?: string };
	opened: { tree: { nodes: { id?: string; type: string }[] }; props: { key: string }[] | null };
	pageLayout: { id: string; title: string } | null;
};

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;

	const site = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: '<header data-wc-id="header"><p data-wc-id="name">Acme Bakery</p></header><main data-wc-id="main">{{@outlet}}</main>',
	});
	await staff.api.templates.publish({ siteId, templateId: site.template.id });
	const { component } = await staff.api.components.create({
		siteId,
		name: "CustomerQuote",
		props: [
			{ key: "quote", label: "Quote", type: "text" },
			{ key: "name", label: "Name", type: "text" },
		],
	});
	quoteId = component.id;
	await staff.api.components.saveMarkup({
		siteId,
		componentId: quoteId,
		markup:
			'<blockquote data-wc-id="box"><p data-wc-id="quote">{{ props.quote }}</p><cite data-wc-id="who">{{ props.name }}</cite></blockquote>',
	});
	await staff.api.components.publish({ siteId, componentId: quoteId });
	const props = (await staff.api.components.get({ siteId, componentId: quoteId })).component.draft.props;

	const pagesId = (await staff.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id;
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: pagesId ?? "", title: "Home", slug: "home" });
	pageId = entry.id;
	const state = await staff.api.pageLayouts.get({ siteId, entryId: pageId });
	await staff.api.pageLayouts.save({
		siteId,
		entryId: pageId,
		basedOn: state.version,
		layout: {
			placements: [
				{ id: "quote", component: quoteId, props, values: { quote: { en: "Best buns in Cork" }, name: { en: "Aoife" } } },
			],
		},
	});
	await staff.api.entries.publish({ siteId, entryId: pageId });
});

afterAll(async () => {
	await install.close();
});

describe("a Page's Placements, for Staff", () => {
	let building: BuildingAreaBrowser;

	beforeAll(async () => {
		building = await openBuildingArea(install, staff, siteId, { path });
	});

	test("the frame tags a Placement's elements through it", async () => {
		const html = await (await building.page(path)).text();
		expect(html).toContain('data-wc-code="content/quote#box"');
		expect(html).toContain('data-wc-code="content/quote#quote"');
		expect(html).toContain('data-wc-page-placement="quote"');
	});

	test("`code/editor` opens a Placement's Component by the page's reference", async () => {
		for (const ref of ["content/quote", "content/quote#who"]) {
			const response = await building.edit("code/editor", { path, ref });
			expect(response.status).toBe(200);
			const opened = (await response.json()) as EditorAnswer;
			expect(opened.ref).toBe("content/quote");
			expect(opened.target).toEqual({ kind: "component", componentId: quoteId });
			expect(opened.editable).toBe(true);
			expect(opened.name).toBe("CustomerQuote");
			expect(opened.opened.tree.nodes.map((node) => node.id)).toEqual(["box"]);
			expect(opened.opened.props?.map((prop) => prop.key)).toEqual(["quote", "name"]);
		}
	});

	test("Code mode's `code/open` follows it too (it answered 404 before)", async () => {
		const response = await building.edit("code/open", { path, ref: "content/quote#quote" });
		expect(response.status).toBe(200);
		const opened = (await response.json()) as {
			source: { kind: string; id: string | null };
			element: { id: string } | null;
			breadcrumb: { kind: string }[];
		};
		expect(opened.source).toMatchObject({ kind: "component", id: quoteId });
		expect(opened.element?.id).toBe("quote");
		expect(opened.breadcrumb.map((step) => step.kind)).toEqual(["pageLayout", "component"]);
	});

	test("the Page layout itself opens read only, and is never saved as markup", async () => {
		const response = await building.edit("code/editor", { path, ref: "content" });
		expect(response.status).toBe(200);
		expect(((await response.json()) as EditorAnswer).editable).toBe(false);
		const saved = await building.edit("code/save", { path, ref: "content", markup: "<p>No</p>", version: null });
		expect(saved.status).toBe(404);
		expect(((await saved.json()) as { code: string }).code).toBe("CODE_SOURCE_NOT_FOUND");
	});

	test("a Placement the Page doesn't have is not found", async () => {
		for (const ref of ["content/elsewhere", "content/quote/inner#x"]) {
			const refused = await building.edit("code/editor", { path, ref });
			expect(refused.status).toBe(404);
			expect(((await refused.json()) as { code: string }).code).toBe("CODE_SOURCE_NOT_FOUND");
		}
	});
});

test("a Member can't open a Page's Placements as Structure", async () => {
	const building = await openBuildingArea(install, editor, siteId, { path });
	const refused = await building.edit("code/editor", { path, ref: "content/quote" });
	expect(refused.status).toBe(403);
	expect(((await refused.json()) as { code: string }).code).toBe("FORBIDDEN");
});
