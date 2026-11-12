// The builder's canvas: a tree rendered as the Site renders it, with real values where the Site has
// them, every element tagged with its id, no scripts, Media on the admin host, and the Design
// system's Draft's stylesheet. One-off styles show as the generated Classes they will become, for
// the preview only. A tree a save would refuse is refused the same way.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { withoutCodeRanges } from "../harness/code-mode.ts";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectNoInlineCode } from "../harness/site-safety.ts";
import { element, outlet, text, tree, value, withId } from "../harness/trees.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let postTypeId: string;
let introClassId: string;
let cardId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "note", label: "Note", type: "text" },
		],
	});
	postTypeId = postType.id;
	await staff.api.entries.create({
		siteId,
		postTypeId,
		title: "Fresh bread",
		fields: { summary: "Out of the oven at seven <b>sharp</b>" },
	});
	await staff.api.globals.setFields({ siteId, fields: [{ key: "phone", label: "Phone", type: "text" }] });
	introClassId = (
		await staff.api.designSystem.createClass({ siteId, name: "intro", styles: "padding: var(--space-m);" })
	).class.id;
	const { component } = await staff.api.components.create({
		siteId,
		name: "Card",
		props: [{ key: "heading", label: "Heading", type: "text", default: "A card" }],
	});
	cardId = component.id;
	await staff.api.components.saveMarkup({
		siteId,
		componentId: cardId,
		markup: '<aside data-wc-id="card-root"><h2 data-wc-id="card-title">{{ props.heading }}</h2></aside>',
	});
});

afterAll(async () => {
	await install.close();
});

const entryTemplate = () => ({ kind: "entryTemplate" as const, postTypeId });

describe("an Entry template", () => {
	test("shows the Entry saved last, every element tagged with its id, styled by the Draft's Classes", async () => {
		const shown = tree(
			withId(
				"post",
				element("article", [
					withId("title", element("h1", [value("title")])),
					withId("lead", element("p", [value("summary")])),
					withId("empty", element("p", [value("note")])),
					{ type: "component", id: "card", component: cardId, props: [] },
				]),
				{ classes: [introClassId] },
			),
		);

		const { html, css } = await staff.api.builder.preview({ siteId, target: entryTemplate(), tree: shown });

		expect(html).toContain('<article class="intro" data-wc-code="b#post">');
		expect(withoutCodeRanges(html)).toContain('<h1 data-wc-code="b#title">Fresh bread</h1>');
		// Values are escaped as on the Site.
		expect(html).toContain("Out of the oven at seven &lt;b&gt;sharp&lt;/b&gt;");
		// A value the Entry doesn't have shows as written, so the element doesn't vanish.
		expect(withoutCodeRanges(html)).toContain('<p data-wc-code="b#empty">{{ note }}</p>');
		// A Component's elements carry the Placement's id first.
		expect(withoutCodeRanges(html)).toContain(
			'<aside data-wc-code="b/card#card-root"><h2 data-wc-code="b/card#card-title">A card</h2>',
		);
		expect(css).toContain("@layer reset, tokens, base, classes, utilities, custom;");
		expect(css).toContain(".intro{padding:var(--space-m)}");
		expectNoInlineCode(html);
	});

	test("previews the picked Entry's Draft and refuses another Post Type's Entry", async () => {
		const ownSite = (await install.createSite((await install.createWorkspace("Picker")).id, { slug: "picker" })).id;
		const api = (await install.superadmin()).api;
		const { postType } = await api.postTypes.create({
			siteId: ownSite,
			name: "Stories",
			urlPattern: "/stories/{slug}",
			fields: [],
		});
		const first = (await api.entries.create({ siteId: ownSite, postTypeId: postType.id, title: "First draft" })).entry;
		await install.clock.advance(1000);
		await api.entries.create({ siteId: ownSite, postTypeId: postType.id, title: "Newest draft" });
		const input = {
			siteId: ownSite,
			target: { kind: "entryTemplate" as const, postTypeId: postType.id },
			tree: tree(element("h1", [value("title")])),
		};
		expect((await api.builder.preview(input)).html).toContain("Newest draft");
		expect((await api.builder.preview({ ...input, entryId: first.id })).html).toContain("First draft");
		const other = (
			await api.postTypes.create({ siteId: ownSite, name: "Other", urlPattern: "/other/{slug}", fields: [] })
		).postType;
		const foreign = (await api.entries.create({ siteId: ownSite, postTypeId: other.id, title: "Wrong" })).entry;
		await expect(api.builder.preview({ ...input, entryId: foreign.id })).rejects.toMatchObject({
			code: "ENTRY_NOT_FOUND",
		});
	});

	test("shows a one-off style as the generated Class it will become, saving nothing", async () => {
		const shown = tree(withId("lead", element("p", [text("Hi")])));

		const { html, css } = await staff.api.builder.preview({
			siteId,
			target: entryTemplate(),
			tree: shown,
			styles: { lead: "color: red; margin-top: 0" },
		});

		const name = /<p class="(style-[0-9a-f]{8})" data-wc-code="b#lead">Hi<\/p>/.exec(withoutCodeRanges(html))?.[1];
		expect(name).toBeDefined();
		expect(css).toContain(`.${name}{color:red;margin-top:0}`);
		const { designSystem } = await staff.api.designSystem.get({ siteId });
		expect(designSystem.draft.classes.map((each) => each.name)).toEqual(["intro"]);
	});

	test("shows a Media image from the admin host, where the canvas is", async () => {
		const { media } = await staff.api.media.upload({
			siteId,
			file: upload(await photo({ width: 400, height: 300 }), "loaf.jpg"),
		});
		await install.drainJobs();
		const shown = tree(withId("pic", element("img", [], { src: `media:${media.id}`, alt: "" })));

		const { html } = await staff.api.builder.preview({ siteId, target: entryTemplate(), tree: shown });

		expect(html).toContain(`src="/api/media/${siteId}/`);
		expect(html).not.toContain('"/_media/');
		const src = /src="([^"]+)"/.exec(html)?.[1] ?? "";
		expect((await staff.request(install.adminUrl(src))).status).toBe(200);
	});

	test("refuses what a save would refuse, saying where", async () => {
		const refused = async (input: { tree: unknown; styles?: Record<string, string> }, at: string) => {
			await expect(staff.api.builder.preview({ siteId, target: entryTemplate(), ...input })).rejects.toMatchObject({
				code: "TEMPLATE_INVALID",
				data: { problems: [expect.objectContaining({ at })] },
			});
		};
		await refused({ tree: tree(element("main")) }, "nodes[0].tag");
		await refused({ tree: tree(element("script", [text("alert(1)")])) }, "nodes[0].tag");
		await refused({ tree: tree(element("p", [value("price")])) }, "nodes[0].children[0].path");
		await refused(
			{ tree: tree(withId("lead", element("p"))), styles: { lead: "background: url(javascript:alert(1))" } },
			"styles.lead",
		);
	});
});

describe("the Site template", () => {
	test("shows a placeholder where each page's content goes, and Globals with no value as written", async () => {
		const shown = tree(
			withId("top", element("header", [withId("phone", element("p", [value("site.phone")]))])),
			withId("main", element("main", [outlet()])),
		);

		const { html } = await staff.api.builder.preview({ siteId, target: { kind: "siteTemplate" }, tree: shown });

		expect(withoutCodeRanges(html)).toContain('<p data-wc-code="b#phone">{{ site.phone }}</p>');
		expect(withoutCodeRanges(html)).toContain(
			'<main data-wc-code="b#main"><span data-wc-builder-placeholder="outlet"></span></main>',
		);
	});
});

describe("a Component", () => {
	test("reads a Prop the builder added before saving it, with its default", async () => {
		const shown = tree(withId("n", element("p", [value("props.note")])));

		const { html } = await staff.api.builder.preview({
			siteId,
			target: { kind: "component", componentId: cardId },
			tree: shown,
			props: [
				{ key: "heading", label: "Heading", type: "text", default: "A card" },
				{ key: "note", label: "Note", type: "text", default: "Fresh daily" },
			],
		});

		expect(withoutCodeRanges(html)).toBe('<p data-wc-code="b#n">Fresh daily</p>');
	});
});
