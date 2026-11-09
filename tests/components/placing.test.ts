// Placing Components: a PascalCase tag with Props as attributes places a Component in a Template
// (or another Component); each Placement has its own Prop values, and visitors see the Component's
// published version wherever it is placed.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

type PropInput = Parameters<TestBrowser["api"]["components"]["create"]>[0]["props"];

/** A Component with its Props and markup, published unless asked not to; answers its id. */
async function component(
	name: string,
	props: PropInput,
	markup: string,
	options: { publish?: boolean } = {},
): Promise<string> {
	const { component: made } = await staff.api.components.create({ siteId, name, props });
	await staff.api.components.saveMarkup({ siteId, componentId: made.id, markup });
	if (options.publish !== false) await staff.api.components.publish({ siteId, componentId: made.id });
	return made.id;
}

let kinds = 0;

/** A Post Type with a `summary` Field; answers it and its URL key. */
async function postType(): Promise<{ postTypeId: string; key: string }> {
	const key = `kind-${++kinds}`;
	const { postType: made } = await staff.api.postTypes.create({
		siteId,
		name: `Kind ${kinds}`,
		key,
		urlPattern: `/${key}/{slug}`,
		fields: [{ key: "summary", label: "Summary", type: "text" }],
	});
	return { postTypeId: made.id, key };
}

/** Publishes an Entry of the Post Type and answers what its page shows inside <main>. */
async function page(
	kind: { postTypeId: string; key: string },
	entry: { title: string; summary?: string },
): Promise<string> {
	const created = await editor.api.entries.create({
		siteId,
		postTypeId: kind.postTypeId,
		title: entry.title,
		fields: { summary: entry.summary ?? null },
	});
	const { entry: published } = await editor.api.entries.publish({ siteId, entryId: created.entry.id });
	return mainOf(`/${kind.key}/${published.published?.slug}`);
}

/** What a published page shows inside <main>. */
async function mainOf(path: string): Promise<string> {
	const response = await install.request(`https://bakery.sites.test${path}`);
	expect(response.status).toBe(200);
	return /<main[^>]*>([\s\S]*)<\/main>/.exec(await response.text())?.[1] ?? "";
}

describe("placing a Component", () => {
	test("a PascalCase tag places it; each copy shows its own Prop values", async () => {
		const cardId = await component(
			"PostCard",
			[
				{ key: "heading", label: "Heading", type: "text", required: true },
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
				{ key: "featured", label: "Featured", type: "boolean" },
			],
			"<article><h2>{{ props.heading }}</h2>{{@if props.featured}}<p>Featured</p>{{/if}}<p>{{ props.tone }}</p></article>",
		);
		const kind = await postType();

		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: kind.postTypeId,
			markup:
				'<PostCard heading="{{ title }}" featured/>\n<PostCard heading="Fixed &amp; fine" tone="loud"></PostCard>',
		});

		const [first, , second] = saved.template.draft.nodes;
		expect(first).toEqual({
			type: "component",
			id: expect.stringMatching(/^[A-Za-z0-9]{12}$/),
			component: cardId,
			props: [
				{ name: "heading", value: [{ type: "value", path: "title" }] },
				{ name: "featured", value: [] },
			],
		});
		expect(second).toMatchObject({
			type: "component",
			component: cardId,
			props: [
				{ name: "heading", value: [{ type: "text", text: "Fixed & fine" }] },
				{ name: "tone", value: [{ type: "text", text: "loud" }] },
			],
		});
		expect(saved.markup).toBe(
			`<PostCard heading="{{ title }}" featured data-wc-id="${first?.type === "component" ? first.id : ""}" />\n` +
				`<PostCard heading="Fixed &amp; fine" tone="loud" data-wc-id="${second?.type === "component" ? second.id : ""}" />`,
		);
		await staff.api.templates.publish({ siteId, templateId: saved.template.id });

		expect(await page(kind, { title: "Fresh <bread>" })).toBe(
			"<article><h2>Fresh &lt;bread&gt;</h2><p>Featured</p><p>Calm</p></article>\n" +
				"<article><h2>Fixed &amp; fine</h2><p>Loud</p></article>",
		);
	});
});

describe("a Component's Draft and publishing", () => {
	test("editing a Component changes every copy once it is published, never before", async () => {
		const badgeId = await component(
			"Badge",
			[{ key: "label", label: "Label", type: "text" }],
			"<span>{{ props.label }}</span>",
		);
		const blog = await postType();
		const news = await postType();
		for (const kind of [blog, news]) {
			const saved = await staff.api.templates.saveEntryTemplateMarkup({
				siteId,
				postTypeId: kind.postTypeId,
				markup: `<p><Badge label="${kind.key}" /></p>`,
			});
			await staff.api.templates.publish({ siteId, templateId: saved.template.id });
		}
		expect(await page(blog, { title: "One" })).toBe(`<p><span>${blog.key}</span></p>`);
		expect(await page(news, { title: "Two" })).toBe(`<p><span>${news.key}</span></p>`);

		// The Draft changes nothing visitors see.
		const saved = await staff.api.components.saveMarkup({
			siteId,
			componentId: badgeId,
			markup: "<strong>{{ props.label }}!</strong>",
		});
		expect(saved.component.status).toBe("changed");
		expect(await mainOf(`/${blog.key}/one`)).toBe(`<p><span>${blog.key}</span></p>`);

		const { published, component: after } = await staff.api.components.publish({ siteId, componentId: badgeId });

		expect(published).toMatchObject({ kind: "component", id: badgeId, pathChanges: [] });
		expect(after).toMatchObject({ status: "published", published: { tree: saved.component.draft.tree } });
		expect(await mainOf(`/${blog.key}/one`)).toBe(`<p><strong>${blog.key}!</strong></p>`);
		expect(await mainOf(`/${news.key}/two`)).toBe(`<p><strong>${news.key}!</strong></p>`);
		const entry = (await (await install.superadmin()).api.audit.list({ limit: 20 })).entries.find(
			(logged) => logged.action === "component.publish",
		);
		expect(entry).toMatchObject({ siteId, details: { componentId: badgeId, name: "Badge" } });
	});

	test("its Props and tree are published as one item", async () => {
		const tagId = await component("Tag", [{ key: "word", label: "Word", type: "text" }], "<em>{{ props.word }}</em>");
		const kind = await postType();
		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: kind.postTypeId,
			markup: '<p><Tag word="old" /></p>',
		});
		await staff.api.templates.publish({ siteId, templateId: saved.template.id });
		expect(await page(kind, { title: "Tagged" })).toBe("<p><em>old</em></p>");

		// A new Prop and the tree reading it, in the Draft: the published Component still has neither.
		await staff.api.components.saveMarkup({
			siteId,
			componentId: tagId,
			props: [
				{ key: "word", label: "Word", type: "text" },
				{ key: "colour", label: "Colour", type: "text", default: "red" },
			],
			markup: "<em>{{ props.word }} in {{ props.colour }}</em>",
		});
		expect(await mainOf(`/${kind.key}/tagged`)).toBe("<p><em>old</em></p>");
		// Templates' Drafts place the Component's Draft, with its new Prop.
		const placing = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: kind.postTypeId,
			markup: '<p><Tag word="new" colour="blue" /></p>',
		});
		// Published Templates place published Components: colour isn't one of its Props yet.
		await expect(staff.api.templates.publish({ siteId, templateId: placing.template.id })).rejects.toMatchObject({
			code: "TEMPLATE_INVALID",
			data: { problems: [{ message: "Tag has no Prop named colour." }] },
		});

		await staff.api.components.publish({ siteId, componentId: tagId });
		expect(await mainOf(`/${kind.key}/tagged`)).toBe("<p><em>old in red</em></p>");
		await staff.api.templates.publish({ siteId, templateId: placing.template.id });
		expect(await mainOf(`/${kind.key}/tagged`)).toBe("<p><em>new in blue</em></p>");
	});

	test("a Template placing a Component that isn't published can't be published", async () => {
		await component("Later", [], "<p>Soon</p>", { publish: false });
		const kind = await postType();
		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: kind.postTypeId,
			markup: "<Later />",
		});

		await expect(staff.api.templates.publish({ siteId, templateId: saved.template.id })).rejects.toMatchObject({
			code: "TEMPLATE_INVALID",
			data: { problems: [{ at: "nodes[0].component", message: "Later isn't published yet: publish it first." }] },
		});
	});

	test("a Component placing one that isn't published can't be published either", async () => {
		await component("Inner", [], "<b>in</b>", { publish: false });
		const outerId = await component("Outer", [], "<p><Inner /></p>", { publish: false });

		await expect(staff.api.components.publish({ siteId, componentId: outerId })).rejects.toMatchObject({
			code: "TEMPLATE_INVALID",
			data: { problems: [{ message: "Inner isn't published yet: publish it first." }] },
		});
	});

	test("only Staff publish Components", async () => {
		const id = await component("Stamp", [], "<p>Stamp</p>", { publish: false });

		await expect(editor.api.components.publish({ siteId, componentId: id })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});

describe("what a Placement can't be", () => {
	let cardId: string;
	let kind: { postTypeId: string; key: string };

	beforeAll(async () => {
		cardId = await component(
			"Card",
			[
				{ key: "heading", label: "Heading", type: "text", required: true },
				{ key: "count", label: "Count", type: "number", max: 9 },
			],
			"<div><h2>{{ props.heading }}</h2>{{ props.count }}</div>",
		);
		kind = await postType();
	});

	const save = (markup: string) =>
		staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: kind.postTypeId, markup });
	const refusals = async (markup: string) => {
		const refusal = await save(markup).then(
			() => undefined,
			(error: { code?: string; data?: { problems?: unknown } }) => error,
		);
		expect(refusal?.code).toBe("TEMPLATE_MARKUP_INVALID");
		return refusal?.data?.problems;
	};

	test("a copy's internals can't be edited on their own: a stored Placement holds only its Prop values", async () => {
		const placement = {
			type: "component",
			component: cardId,
			props: [{ name: "heading", value: [{ type: "text", text: "Hi" }] }],
		};

		for (const internals of [
			{ children: [{ type: "text", text: "Mine" }] },
			{ tree: { version: 1, nodes: [] } },
			{ nodes: [] },
		]) {
			await expect(
				staff.api.templates.saveEntryTemplate({
					siteId,
					postTypeId: kind.postTypeId,
					tree: { version: 1, nodes: [{ ...placement, ...internals }] } as never,
				}),
			).rejects.toMatchObject({
				code: "TEMPLATE_INVALID",
				data: {
					problems: [
						{
							at: `nodes[0].${Object.keys(internals)[0]}`,
							message: expect.stringContaining("the Component's elements are changed in the Component, for every copy"),
						},
					],
				},
			});
		}
	});

	test("in markup a Placement holds nothing between its tags", async () => {
		expect(await refusals('<Card heading="Hi">\n  <p>Mine</p>\n</Card>')).toEqual([
			{ line: 1, column: 20, message: expect.stringContaining("<Card> holds nothing: write <Card … />") },
		]);
	});

	test("names a Component the Site has, and only its Props, each as declared, once", async () => {
		expect(await refusals('<Nope />\n<Card heading="Hi" colour="red" Count="2" heading="Again" />')).toEqual([
			{ line: 1, column: 1, message: "There is no Component named Nope." },
			{ line: 2, column: 20, message: "Card has no Prop named colour." },
			{ line: 2, column: 33, message: "Card has no Prop named Count: Props are written as declared, count." },
			{ line: 2, column: 43, message: "heading is given twice." },
		]);
	});

	test("gives every required Prop, and fixed values its Props can hold", async () => {
		expect(await refusals('<Card count="many" />\n<Card heading="Hi" count="12" />')).toEqual([
			{ line: 1, column: 1, message: "Card needs heading: the Prop is required." },
			{ line: 1, column: 14, message: "count: a number, such as 3 or 2.5." },
			{ line: 2, column: 27, message: "count: At most 9." },
		]);
	});

	test("reads only values its place has", async () => {
		expect(await refusals('<Card heading="{{ nope }}" />')).toEqual([
			{ line: 1, column: 19, message: "There is no value named nope here." },
		]);
	});

	test("sits only where its Component's HTML can go", async () => {
		expect(await refusals('<p><Card heading="Hi" /></p>')).toEqual([
			{
				line: 1,
				column: 4,
				message: "Card can't go here: <div> can't go inside <p>: a browser would end the paragraph before it.",
			},
		]);
		await expect(
			staff.api.templates.saveEntryTemplate({
				siteId,
				postTypeId: kind.postTypeId,
				tree: {
					version: 1,
					nodes: [
						{
							type: "element",
							tag: "p",
							attributes: [],
							classes: [],
							children: [
								{
									type: "component",
									component: cardId,
									props: [{ name: "heading", value: [{ type: "text", text: "Hi" }] }],
								},
							],
						},
					],
				} as never,
			}),
		).rejects.toMatchObject({
			code: "TEMPLATE_INVALID",
			data: { problems: [{ at: "nodes[0].children[0]", message: expect.stringContaining("Card can't go here") }] },
		});
	});

	test("names its Component by an id the Site has", async () => {
		const unknown = "3f9a1c2b-7d4e-4f60-9a1c-2b7d4e5f6071";

		await expect(
			staff.api.templates.saveEntryTemplate({
				siteId,
				postTypeId: kind.postTypeId,
				tree: { version: 1, nodes: [{ type: "component", component: unknown, props: [] }] } as never,
			}),
		).rejects.toMatchObject({
			code: "TEMPLATE_INVALID",
			data: {
				problems: [{ at: "nodes[0].component", message: `There is no Component with the id ${unknown} on this Site.` }],
			},
		});
	});
});

describe("Components placing Components", () => {
	test("a Component places others, passing its own Props on", async () => {
		await component("Line", [{ key: "text", label: "Text", type: "text" }], "<li>{{ props.text }}</li>");
		await component(
			"Pair",
			[
				{ key: "first", label: "First", type: "text" },
				{ key: "second", label: "Second", type: "text", default: "and more" },
			],
			'<ul><Line text="{{ props.first }}" /><Line text="{{ props.second }}" /></ul>',
		);
		const kind = await postType();
		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: kind.postTypeId,
			markup: '<Pair first="{{ title }}" />',
		});
		await staff.api.templates.publish({ siteId, templateId: saved.template.id });

		expect(await page(kind, { title: "Rye" })).toBe("<ul><li>Rye</li><li>and more</li></ul>");
	});

	test("a Component never places itself, directly or through others", async () => {
		const loopId = await component("Loop", [], "<p>Loop</p>", { publish: false });
		await expect(
			staff.api.components.saveMarkup({ siteId, componentId: loopId, markup: "<div><Loop /></div>" }),
		).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: { problems: [{ line: 1, column: 6, message: "A Component can't place itself: Loop would never end." }] },
		});

		await component("Around", [], "<div><Loop /></div>", { publish: false });
		await expect(
			staff.api.components.saveMarkup({ siteId, componentId: loopId, markup: "<div><Around /></div>" }),
		).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: {
				problems: [{ message: "Around places this Component, so placing it here would never end." }],
			},
		});
	});

	test("nor through what is published", async () => {
		// Ping places Pong, and both are published; then Ping's Draft lets go of Pong.
		const pongId = await component("Pong", [], "<p>Pong</p>");
		const pingId = await component("Ping", [], "<div><Pong /></div>");
		await staff.api.components.saveMarkup({ siteId, componentId: pingId, markup: "<p>Ping</p>" });
		// Pong's Draft may place Ping now: Ping's Draft no longer places Pong.
		await staff.api.components.saveMarkup({ siteId, componentId: pongId, markup: "<div><Ping /></div>" });

		// Published, Ping still places Pong.
		await expect(staff.api.components.publish({ siteId, componentId: pongId })).rejects.toMatchObject({
			code: "TEMPLATE_INVALID",
			data: { problems: [{ message: "Ping places this Component, so placing it here would never end." }] },
		});
	});

	test("Components place Components at most 10 deep", async () => {
		// Level11 is the innermost; LevelN places Level(N + 1).
		await component("Level11", [], "<span>11</span>", { publish: false });
		for (let level = 10; level >= 2; level--) {
			await component(`Level${level}`, [], `<span><Level${level + 1} /></span>`, { publish: false });
		}

		await expect(component("Level1", [], "<span><Level2 /></span>", { publish: false })).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: { problems: [{ message: "Components place Components at most 10 deep." }] },
		});
	});

	test("a Component's HTML must fit where it is placed, inside other Components too", async () => {
		await component("Block", [], "<div>Block</div>");
		await expect(component("Para", [], "<p><Block /></p>", { publish: false })).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: {
				problems: [
					{
						line: 1,
						column: 4,
						message: "Block can't go here: <div> can't go inside <p>: a browser would end the paragraph before it.",
					},
				],
			},
		});
	});

	test("publishing a Component checks it still fits wherever it is placed and published", async () => {
		const inlineId = await component("Inline", [], "<span>in line</span>");
		const kind = await postType();
		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: kind.postTypeId,
			markup: "<p>Read <Inline /></p>",
		});
		await staff.api.templates.publish({ siteId, templateId: saved.template.id });
		await component("Wrapper", [], "<p><Inline /></p>");

		// On its own the new Draft is fine; where it is placed, a <div> can't go inside <p>.
		await staff.api.components.saveMarkup({ siteId, componentId: inlineId, markup: "<div>a block</div>" });

		const refusal = await staff.api.components.publish({ siteId, componentId: inlineId }).then(
			() => undefined,
			(error: { code?: string; data?: { problems?: { message: string }[] } }) => error,
		);
		expect(refusal?.code).toBe("TEMPLATE_INVALID");
		expect(refusal?.data?.problems?.map((problem) => problem.message).sort()).toEqual([
			"In the Component Wrapper: Inline can't go here: <div> can't go inside <p>: a browser would end the paragraph before it.",
			`In the Entry template of Kind ${kinds}: Inline can't go here: <div> can't go inside <p>: a browser would end the paragraph before it.`,
		]);
		expect(await page(kind, { title: "Still" })).toBe("<p>Read <span>in line</span></p>");
	});
});

describe("size", () => {
	test("a Template showing more than 100,000 nodes through its Components is refused", async () => {
		// 9,000 nodes: a <ul> of 4,499 items, each an <li> holding its text.
		const items = Array.from({ length: 4_499 }, (_, index) => `<li>${index}</li>`).join("");
		await component("Long", [], `<ul>${items}</ul>`, { publish: false });
		const kind = await postType();

		await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: kind.postTypeId,
			markup: "<Long />".repeat(11),
		});
		await expect(
			staff.api.templates.saveEntryTemplateMarkup({
				siteId,
				postTypeId: kind.postTypeId,
				markup: "<Long />".repeat(12),
			}),
		).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: {
				problems: [
					{
						line: 1,
						column: 89,
						message:
							"With its Components shown, this comes to more than 100,000 nodes: place fewer, or smaller, Components.",
					},
				],
			},
		});
	});
});
