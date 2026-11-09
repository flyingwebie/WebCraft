// The builder and Template markup are two views of one Draft (ADR 0017). The builder prints its
// tree as markup (one-off styles as inline styles) and saves it through the same markup saves as
// Code mode, the CLI and AI clients, based on the version it opened; reading markup back gives the
// same tree and keeps unsaved one-off styles pending. Switching views saves and reformats nothing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { element, text, tree, value, withId } from "../harness/trees.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let postTypeId: string;
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
		fields: [{ key: "summary", label: "Summary", type: "text" }],
	});
	postTypeId = postType.id;
	await staff.api.designSystem.createClass({ siteId, name: "intro", styles: "padding: var(--space-m);" });
	const { component } = await staff.api.components.create({
		siteId,
		name: "Card",
		props: [{ key: "heading", label: "Heading", type: "text", default: "A card" }],
	});
	cardId = component.id;
});

afterAll(async () => {
	await install.close();
});

const target = () => ({ kind: "entryTemplate" as const, postTypeId });

describe("the builder's tree as Template markup", () => {
	test("prints its layer labels and pending one-off styles, saving nothing", async () => {
		const built = tree(
			withId("hero", element("section", [withId("heading", element("h2", [value("title")]), { label: "Title" })]), {
				label: "Hero",
			}),
		);

		const { markup } = await staff.api.builder.markup({
			siteId,
			target: target(),
			tree: built,
			styles: { heading: "color:red;margin-top: 0" },
		});

		expect(markup).toBe(
			'<section data-wc-label="Hero" data-wc-id="hero">' +
				'<h2 style="color: red; margin-top: 0;" data-wc-label="Title" data-wc-id="heading">{{ title }}</h2></section>',
		);
		expect((await staff.api.templates.getEntryTemplate({ siteId, postTypeId })).template).toBeNull();

		const read = await staff.api.builder.read({ siteId, target: target(), markup });

		expect(read.tree).toEqual(built as unknown as typeof read.tree);
		expect(read.styles).toEqual({ heading: "color: red; margin-top: 0;" });
		expect(read.notices).toEqual([]);
		const { designSystem } = await staff.api.designSystem.get({ siteId });
		expect(designSystem.draft.classes.map((each) => each.name)).toEqual(["intro"]);
	});

	test("is saved through the markup save: one-off styles become generated Classes, and the builder opens the same Draft", async () => {
		const opened = await staff.api.builder.open({ siteId, target: target() });
		const built = tree(withId("lead", element("p", [text("Hi")]), { classes: [] }));
		const { markup } = await staff.api.builder.markup({
			siteId,
			target: target(),
			tree: built,
			styles: { lead: "color: blue" },
		});

		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup,
			basedOn: opened.version,
		});

		const generated = /<p class="(style-[0-9a-f]{8})" data-wc-id="lead">Hi<\/p>/.exec(saved.markup)?.[1];
		expect(generated).toBeDefined();
		const again = await staff.api.builder.open({ siteId, target: target() });
		expect(again.tree).toEqual(saved.template.draft);
		expect(again.version).toBe(saved.version);
		expect(again.catalogue.classes).toContainEqual(
			expect.objectContaining({ name: generated, generated: true, styles: "color: blue;" }),
		);
		// Reading the saved markup keeps the Class: it is no longer pending.
		const read = await staff.api.builder.read({ siteId, target: target(), markup: saved.markup });
		expect(read.tree).toEqual(saved.template.draft);
		expect(read.styles).toEqual({});
		// A save based on the version before is someone else's change meanwhile.
		await expect(
			staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup, basedOn: opened.version }),
		).rejects.toMatchObject({ code: "CHANGED_MEANWHILE", data: { version: saved.version } });
	});

	test("markup typed with its own line breaks reads into a tree that prints back exactly as typed", async () => {
		const typed = [
			'<article class="intro" data-wc-id="post">',
			'  <h1 data-wc-id="t">{{ title }}</h1>',
			"  {{@if summary}}",
			'    <p data-wc-id="s">{{ summary }}</p>',
			"  {{/if}}",
			"</article>",
		].join("\n");

		const read = await staff.api.builder.read({ siteId, target: target(), markup: typed });
		const { markup } = await staff.api.builder.markup({ siteId, target: target(), tree: read.tree });

		expect(markup).toBe(typed);
	});

	test("markup that can't be read is refused with each problem's line and column", async () => {
		await expect(
			staff.api.builder.read({ siteId, target: target(), markup: "<p>\n  <script>x</script>\n</p>" }),
		).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: { problems: [expect.objectContaining({ line: 2, column: 3 })] },
		});
	});
});

describe("a Component", () => {
	test("is saved with the Props the builder gave it, and its tree reads them", async () => {
		const props = [
			{ key: "heading", label: "Heading", type: "text" as const, default: "A card" },
			{ key: "note", label: "Note", type: "text" as const, default: "Fresh daily" },
		];
		const built = tree(withId("n", element("p", [value("props.note")])));
		const { markup } = await staff.api.builder.markup({
			siteId,
			target: { kind: "component", componentId: cardId },
			tree: built,
			props,
		});
		const opened = await staff.api.builder.open({ siteId, target: { kind: "component", componentId: cardId } });

		await staff.api.components.saveMarkup({ siteId, componentId: cardId, markup, props, basedOn: opened.version });

		const again = await staff.api.builder.open({ siteId, target: { kind: "component", componentId: cardId } });
		expect(again.props?.map((prop) => [prop.key, prop.default])).toEqual([
			["heading", "A card"],
			["note", "Fresh daily"],
		]);
		expect(again.tree).toEqual(built as unknown as typeof again.tree);
	});
});
