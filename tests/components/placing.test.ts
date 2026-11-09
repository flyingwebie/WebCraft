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
