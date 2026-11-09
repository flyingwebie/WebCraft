// Components: reusable pieces of Structure with Props (GLOSSARY.md). Staff build them as element
// trees with a Draft and a published version; Props are declared with the Field types.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { element, tree, value } from "../harness/trees.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
});

afterAll(async () => {
	await install.close();
});

describe("creating a Component", () => {
	test("Staff declare its Props with the Field types; it starts as an empty Draft", async () => {
		const { component } = await staff.api.components.create({
			siteId,
			name: "PostCard",
			props: [
				{ key: "heading", label: "Heading", type: "text", required: true, maxLength: 80 },
				{ key: "featured", label: "Featured", type: "boolean" },
				{
					key: "tone",
					label: "Tone",
					type: "select",
					options: [
						{ value: "calm", label: "Calm" },
						{ value: "loud", label: "Loud" },
					],
					default: "calm",
				},
			],
		});

		expect(component).toMatchObject({
			siteId,
			name: "PostCard",
			module: null,
			status: "draft",
			published: null,
			publishedAt: null,
			draft: {
				props: [
					{ key: "heading", label: "Heading", type: "text", required: true, maxLength: 80, default: null },
					{ key: "featured", type: "boolean", required: false },
					{ key: "tone", type: "select", default: "calm", multiple: false },
				],
				tree: { version: 1, nodes: [] },
			},
		});
		const { component: read, usage } = await staff.api.components.get({ siteId, componentId: component.id });
		expect(read).toEqual(component);
		expect(usage).toEqual({ pages: 0, usedIn: [] });
		const { components } = await staff.api.components.list({ siteId });
		expect(components.map((listed) => [listed.name, listed.status, listed.usage.pages])).toContainEqual([
			"PostCard",
			"draft",
			0,
		]);
	});

	test("Props are checked as Fields are, each problem where it is", async () => {
		await expect(
			staff.api.components.create({
				siteId,
				name: "Broken",
				props: [
					{ key: "heading", label: "Heading", type: "text" },
					{ key: "size", label: "Size", type: "select", options: [] },
					{ key: "heading", label: "Again", type: "text" },
					{ key: "and", label: "And", type: "text" },
				],
			}),
		).rejects.toMatchObject({
			code: "COMPONENT_INVALID",
			data: {
				problems: [
					{ at: "props[1].options" },
					{ at: "props[2].key", message: expect.stringContaining("Two Props") },
					{ at: "props[3].key" },
				],
			},
		});
	});

	test("its name is a PascalCase tag name, unique on the Site", async () => {
		for (const name of ["postCard", "POSTCARD", "Post-Card", "Post Card", "", "P".repeat(65)]) {
			await expect(staff.api.components.create({ siteId, name })).rejects.toMatchObject({
				code: "COMPONENT_INVALID",
				data: { problems: [{ at: "name" }] },
			});
		}
		await staff.api.components.create({ siteId, name: "Banner" });
		await expect(staff.api.components.create({ siteId, name: "Banner" })).rejects.toMatchObject({
			code: "COMPONENT_NAME_TAKEN",
		});
	});

	test("is Structure: Members can't create or see Components", async () => {
		await expect(owner.api.components.create({ siteId, name: "Sneaky" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(owner.api.components.list({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("a Component's Draft", () => {
	test("is Template markup that reads its Props as props.x and the Globals as site.x", async () => {
		await staff.api.globals.setFields({ siteId, fields: [{ key: "phone", label: "Phone", type: "text" }] });
		const { component } = await staff.api.components.create({
			siteId,
			name: "Notice",
			props: [
				{ key: "heading", label: "Heading", type: "text" },
				{ key: "link", label: "Link", type: "link" },
			],
		});

		const saved = await staff.api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup:
				'<aside><h2>{{ props.heading }}</h2><a href="{{ props.link.url }}">{{ props.link.text }}</a> Call {{ site.phone }}</aside>',
		});

		const ids = [...saved.markup.matchAll(/data-wc-id="([A-Za-z0-9]{12})"/g)].map((match) => match[1]);
		expect(saved.markup).toBe(
			`<aside data-wc-id="${ids[0]}"><h2 data-wc-id="${ids[1]}">{{ props.heading }}</h2>` +
				`<a href="{{ props.link.url }}" data-wc-id="${ids[2]}">{{ props.link.text }}</a> Call {{ site.phone }}</aside>`,
		);
		expect(saved.notices).toEqual([]);
		expect(saved.component).toMatchObject({ status: "draft", published: null });
		expect(saved.component.draft.props.map((prop) => prop.key)).toEqual(["heading", "link"]);
		const read = await staff.api.components.getMarkup({ siteId, componentId: component.id });
		expect(read.markup).toEqual({ draft: saved.markup, published: null });
		expect(read.usage).toEqual({ pages: 0, usedIn: [] });
		expect(read.component).toEqual(saved.component);
	});

	test("reads nothing else: other names are refused with their line", async () => {
		const { component } = await staff.api.components.create({
			siteId,
			name: "Strict",
			props: [{ key: "link", label: "Link", type: "link" }],
		});

		await expect(
			staff.api.components.saveMarkup({
				siteId,
				componentId: component.id,
				markup: "<p>{{ props.nope }}</p>\n<p>{{ title }} {{ props.link.colour }}</p>",
			}),
		).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: {
				problems: [
					{ line: 1, column: 7, message: "There is no Prop named nope on this Component." },
					{ line: 2, column: 7, message: expect.stringContaining("reads only its Props (props.x) and the Globals") },
					{ line: 2, column: 19, message: "props.link.colour: the Prop link has no part named colour." },
				],
			},
		});
	});

	test("holds neither <main> nor {{@outlet}}: it goes inside pages", async () => {
		const { component } = await staff.api.components.create({ siteId, name: "Frame" });

		await expect(
			staff.api.components.saveMarkup({ siteId, componentId: component.id, markup: "<main>{{@outlet}}</main>" }),
		).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: {
				problems: [
					{ line: 1, column: 1 },
					{ line: 1, column: 7 },
				],
			},
		});
	});

	test("saved with new Props, its markup is checked against them; a Prop keeps its type", async () => {
		const { component } = await staff.api.components.create({
			siteId,
			name: "Teaser",
			props: [{ key: "heading", label: "Heading", type: "text" }],
		});

		const saved = await staff.api.components.saveMarkup({
			siteId,
			componentId: component.id,
			props: [
				{ key: "heading", label: "Heading", type: "text" },
				{ key: "count", label: "Count", type: "number", default: 3 },
			],
			markup: "<p>{{ props.heading }} ({{ props.count }})</p>",
		});
		expect(saved.component.draft.props.map((prop) => [prop.key, prop.type])).toEqual([
			["heading", "text"],
			["count", "number"],
		]);

		await expect(
			staff.api.components.saveDraft({
				siteId,
				componentId: component.id,
				props: [{ key: "heading", label: "Heading", type: "number" }],
			}),
		).rejects.toMatchObject({
			code: "COMPONENT_INVALID",
			data: { problems: [{ at: "props[0].type", message: "heading is a text Prop; a Prop keeps its type." }] },
		});
		await expect(
			staff.api.components.saveDraft({
				siteId,
				componentId: component.id,
				props: [{ key: "heading", label: "Heading", type: "text" }],
			}),
		).rejects.toMatchObject({
			code: "TEMPLATE_INVALID",
			data: { problems: [{ message: "There is no Prop named count on this Component." }] },
		});
	});

	test("can be saved as an element tree", async () => {
		const { component } = await staff.api.components.create({
			siteId,
			name: "Quote",
			props: [{ key: "words", label: "Words", type: "text" }],
		});

		const { component: saved } = await staff.api.components.saveDraft({
			siteId,
			componentId: component.id,
			tree: tree(element("blockquote", [value("props.words")])),
		});

		expect(saved.draft.tree.nodes[0]).toMatchObject({
			type: "element",
			tag: "blockquote",
			id: expect.stringMatching(/^[A-Za-z0-9]{12}$/),
			children: [{ type: "value", path: "props.words" }],
		});
	});
});
