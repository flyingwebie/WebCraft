// Making Components from what is already built (#134, decided in #121): Make Component moves an
// element of a Template or Component into a new Component and leaves a Placement in its place, so
// visitors see the same page. What the markup read there comes in through Props the new Component
// declares (the user's decision: never literal copies of the values), and chosen fixed text can
// become text Props whose default is the text. New Component can place the new, empty Component
// at once. Each is one step: refused, it changes nothing.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openDraft } from "../harness/co-editing.ts";
import { answer, openCodeMode } from "../harness/code-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let kinds = 0;

/** A Post Type with a few Fields, its Entry template from markup, and one published Entry; answers both. */
async function entryPage(markup: string): Promise<{ postTypeId: string; path: string }> {
	const key = `kind-${++kinds}`;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: `Kind ${kinds}`,
		key,
		urlPattern: `/${key}/{slug}`,
		fields: [
			{ key: "summary", label: "Summary", type: "text", maxLength: 200 },
			{ key: "more", label: "Read more", type: "link" },
			{
				key: "steps",
				label: "Steps",
				type: "repeater",
				fields: [{ key: "line", label: "Line", type: "text" }],
			},
		],
	});
	await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: postType.id, markup });
	await publishTemplate(postType.id);
	const created = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Sourdough",
		fields: {
			summary: "Slow and sour",
			more: { url: "/guides/sourdough", text: "The whole guide" },
			steps: [{ line: "Feed the starter" }, { line: "Bake" }],
		},
	});
	const { entry } = await editor.api.entries.publish({ siteId, entryId: created.entry.id });
	return { postTypeId: postType.id, path: `/${key}/${entry.published?.slug}` };
}

/** What a published page shows inside <main>, without the elements' ids. */
async function mainOf(path: string): Promise<string> {
	const response = await install.request(`https://bakery.live.test${path}`);
	expect(response.status).toBe(200);
	return /<main[^>]*>([\s\S]*)<\/main>/.exec(await expectSafePage(response))?.[1] ?? "";
}

async function publishTemplate(postTypeId: string): Promise<void> {
	const { template } = await staff.api.templates.getEntryTemplate({ siteId, postTypeId });
	await staff.api.templates.publish({ siteId, templateId: template?.id ?? "" });
}

async function entryTemplate(postTypeId: string) {
	const { template } = await staff.api.templates.getEntryTemplate({ siteId, postTypeId });
	if (!template) throw new Error("No Entry template.");
	return template.draft;
}

/** Template markup without its elements' ids, which are new for every test. */
function withoutIds(markup: string | null | undefined): string {
	return (markup ?? "").replaceAll(/ data-wc-id="[^"]*"/g, "");
}

async function componentNames(): Promise<string[]> {
	return (await staff.api.components.list({ siteId })).components.map((component) => component.name);
}

describe("Make Component", () => {
	test("moves the element into a new Component with Props for what it read; visitors see the same page", async () => {
		const { postTypeId, path } = await entryPage(
			[
				"<article>",
				"<div><h2>{{ title }}</h2><p>{{ summary }}</p>",
				'<a href="{{ more.url }}">{{ more.text }}</a>',
				"<ol>{{@loop steps as step}}<li>{{ step.line }} ({{ loop.index }})</li>{{/loop}}</ol>",
				"<p>Baked fresh</p></div>",
				"</article>",
			].join(""),
		);
		const before = await mainOf(path);
		const draft = await entryTemplate(postTypeId);
		const node = (draft.nodes[0] as { children: unknown[] }).children[0];

		const made = await staff.api.components.make({
			siteId,
			name: "PostCard",
			source: { kind: "entryTemplate", postTypeId },
			path: [0, 0, 0],
			node,
		});

		// The Entry's values come in through Props, declared as the Post Type declares those Fields.
		expect(made.component).toMatchObject({ name: "PostCard", status: "draft", module: null });
		expect(made.component.draft.props).toEqual([
			expect.objectContaining({ key: "title", type: "text" }),
			expect.objectContaining({ key: "summary", type: "text", maxLength: 200 }),
			expect.objectContaining({ key: "more", type: "link", label: "Read more" }),
			expect.objectContaining({
				key: "steps",
				type: "repeater",
				fields: [expect.objectContaining({ key: "line", type: "text" })],
			}),
		]);
		const { markup } = await staff.api.components.getMarkup({ siteId, componentId: made.component.id });
		expect(withoutIds(markup.draft)).toContain("{{@props}}");
		expect(withoutIds(markup.draft)).toContain("<h2>{{ props.title }}</h2><p>{{ props.summary }}</p>");
		expect(withoutIds(markup.draft)).toContain('<a href="{{ props.more.url }}"');
		expect(withoutIds(markup.draft)).toContain(
			"{{@loop props.steps as step}}<li>{{ step.line }} ({{ loop.index }})</li>",
		);

		// A Placement takes its place, each Prop bound to what the markup read there.
		const after = await entryTemplate(postTypeId);
		const placed = (after.nodes[0] as { children: unknown[] }).children[0];
		expect(placed).toEqual({
			type: "component",
			id: made.placement.id,
			component: made.component.id,
			props: [
				{ name: "title", value: [{ type: "value", path: "title" }] },
				{ name: "summary", value: [{ type: "value", path: "summary" }] },
				{ name: "more", value: [{ type: "value", path: "more" }] },
				{ name: "steps", value: [{ type: "value", path: "steps" }] },
			],
		});
		expect(made.placement.path).toEqual([0, 0, 0]);
		const { markup: template } = await staff.api.templates.getEntryTemplateMarkup({ siteId, postTypeId });
		expect(withoutIds(template?.draft)).toContain(
			'<PostCard title="{{ title }}" summary="{{ summary }}" more="{{ more }}" steps="{{ steps }}"',
		);

		// Visitors see nothing new until both are published, then the same page.
		expect(await mainOf(path)).toBe(before);
		await staff.api.components.publish({ siteId, componentId: made.component.id });
		await publishTemplate(postTypeId);
		expect(await mainOf(path)).toBe(before);
		expect(before).toContain("Feed the starter (1)");
	});

	test("chosen fixed text becomes a text Prop with the text as its default", async () => {
		const { postTypeId, path } = await entryPage(
			"<section><div><h3>  Opening hours  </h3><p>Every day</p><p>{{ title }}</p></div></section>",
		);
		const before = await mainOf(path);
		const node = ((await entryTemplate(postTypeId)).nodes[0] as { children: unknown[] }).children[0];

		const made = await staff.api.components.make({
			siteId,
			name: "OpeningHours",
			source: { kind: "entryTemplate", postTypeId },
			path: [0, 0, 0],
			node,
			texts: [{ index: 0, key: "heading" }],
		});

		expect(made.component.draft.props).toEqual([
			expect.objectContaining({ key: "title", type: "text" }),
			expect.objectContaining({ key: "heading", type: "text", default: "Opening hours" }),
		]);
		const { markup } = await staff.api.components.getMarkup({ siteId, componentId: made.component.id });
		expect(withoutIds(markup.draft)).toContain("<h3>  {{ props.heading }}  </h3><p>Every day</p>");
		// The default gives the text: the Placement doesn't repeat it.
		const placed = ((await entryTemplate(postTypeId)).nodes[0] as { children: unknown[] }).children[0];
		expect(placed).toMatchObject({ props: [{ name: "title", value: [{ type: "value", path: "title" }] }] });

		await staff.api.components.publish({ siteId, componentId: made.component.id });
		await publishTemplate(postTypeId);
		expect(await mainOf(path)).toBe(before);
	});

	test("inside a Component, the outer Component's Props pass through Props of the new one", async () => {
		const { component: hero } = await staff.api.components.create({ siteId, name: "Hero" });
		await staff.api.components.saveMarkup({
			siteId,
			componentId: hero.id,
			markup: [
				"{{@props}}",
				'  heading: text required label="Heading" maxLength=80',
				"  dark: boolean",
				"{{/props}}",
				"<section>{{@if props.dark}}<h1>{{ props.heading }}</h1>{{/if}}<p>{{ site.name }}</p></section>",
			].join("\n"),
		});
		const { component: read } = await staff.api.components.get({ siteId, componentId: hero.id });
		const condition = (read.draft.tree.nodes[0] as { children: unknown[] }).children[0];

		const made = await staff.api.components
			.make({
				siteId,
				name: "HeroTitle",
				source: { kind: "component", componentId: hero.id },
				path: [0, 0, 0],
				node: { type: "element", tag: "div", attributes: [], classes: [], children: [] },
			})
			.catch((error: unknown) => error);
		// Only an element or a Placement becomes a Component, and only as the editor saw it.
		expect(made).toMatchObject({ code: "CHANGED_MEANWHILE" });
		const refused = await staff.api.components
			.make({
				siteId,
				name: "HeroTitle",
				source: { kind: "component", componentId: hero.id },
				path: [0, 0, 0],
				node: condition,
			})
			.catch((error: unknown) => error);
		expect(refused).toMatchObject({ code: "COMPONENT_INVALID" });

		const section = read.draft.tree.nodes[0];
		const title = await staff.api.components.make({
			siteId,
			name: "HeroTitle",
			source: { kind: "component", componentId: hero.id },
			path: [0],
			node: section,
		});
		expect(title.component.draft.props).toEqual([
			expect.objectContaining({ key: "dark", type: "boolean" }),
			expect.objectContaining({ key: "heading", type: "text", required: true, maxLength: 80 }),
		]);
		const { markup: heroMarkup } = await staff.api.components.getMarkup({ siteId, componentId: hero.id });
		expect(withoutIds(heroMarkup.draft)).toContain('<HeroTitle dark="{{ props.dark }}" heading="{{ props.heading }}"');
		const { markup: titleMarkup } = await staff.api.components.getMarkup({
			siteId,
			componentId: title.component.id,
		});
		// The Globals read as they are; the outer Props through the new Component's own.
		expect(withoutIds(titleMarkup.draft)).toContain(
			"{{@if props.dark}}<h1>{{ props.heading }}</h1>{{/if}}<p>{{ site.name }}</p>",
		);
	});

	test("refused, nothing is made: a name in use, a bad name, a change meanwhile, a Body field", async () => {
		const { postTypeId } = await entryPage("<article><div><h2>{{ title }}</h2></div></article>");
		const node = ((await entryTemplate(postTypeId)).nodes[0] as { children: unknown[] }).children[0];
		const before = await entryTemplate(postTypeId);
		const names = await componentNames();
		const make = (name: string, change: object = {}) =>
			staff.api.components
				.make({ siteId, name, source: { kind: "entryTemplate", postTypeId }, path: [0, 0, 0], node, ...change })
				.catch((error: unknown) => error);

		expect(await make("PostCard")).toMatchObject({ code: "COMPONENT_NAME_TAKEN" });
		expect(await make("postCard")).toMatchObject({ code: "COMPONENT_INVALID" });
		expect(await make("Card", { path: [0, 0, 1] })).toMatchObject({ code: "CHANGED_MEANWHILE" });
		expect(await make("Card", { texts: [{ index: 3, key: "heading" }] })).toMatchObject({
			code: "COMPONENT_INVALID",
		});
		expect(await make("Card", { texts: [{ index: 0, key: "and" }] })).toMatchObject({ code: "COMPONENT_INVALID" });
		expect(await componentNames()).toEqual(names);
		expect(await entryTemplate(postTypeId)).toEqual(before);

		// A Body field can't be a Prop.
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Articles",
			key: "articles",
			urlPattern: "/articles/{slug}",
			fields: [{ key: "body", label: "Body", type: "body" }],
		});
		await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: "<article><div>{{ body }}</div></article>",
		});
		const bodyNode = ((await entryTemplate(postType.id)).nodes[0] as { children: unknown[] }).children[0];
		const refused = await staff.api.components
			.make({
				siteId,
				name: "ArticleBody",
				source: { kind: "entryTemplate", postTypeId: postType.id },
				path: [0, 0, 0],
				node: bodyNode,
			})
			.catch((error: unknown) => error);
		expect(refused).toMatchObject({ code: "COMPONENT_INVALID" });
		expect(await componentNames()).toEqual(names);
	});

	test("two people making Components of one name at once: one is made, the other is told the name is taken", async () => {
		const { postTypeId } = await entryPage(
			"<article><div><h2>{{ title }}</h2></div><div><p>{{ summary }}</p></div></article>",
		);
		const article = (await entryTemplate(postTypeId)).nodes[0] as { children: unknown[] };
		const other = (await install.createStaff({ workspaces: [workspaceId] })).browser;
		const make = (browser: TestBrowser, index: number) =>
			browser.api.components
				.make({
					siteId,
					name: "SameName",
					source: { kind: "entryTemplate", postTypeId },
					path: [0, 0, index],
					node: article.children[index],
				})
				.then(
					() => "made",
					(error: { code?: string }) => error.code,
				);

		const outcomes = await Promise.all([make(staff, 0), make(other, 1)]);

		expect(outcomes.sort()).toEqual(["COMPONENT_NAME_TAKEN", "made"]);
		expect((await componentNames()).filter((name) => name === "SameName")).toHaveLength(1);
	});

	test("only people who may change the Structure make Components", async () => {
		const { postTypeId } = await entryPage("<article><div><h2>{{ title }}</h2></div></article>");
		const node = ((await entryTemplate(postTypeId)).nodes[0] as { children: unknown[] }).children[0];
		const refused = await editor.api.components
			.make({ siteId, name: "Nope", source: { kind: "entryTemplate", postTypeId }, path: [0, 0, 0], node })
			.catch((error: unknown) => error);
		expect(refused).toMatchObject({ code: "FORBIDDEN" });
	});

	test("people editing the Template live see the Placement arrive", async () => {
		const { postTypeId } = await entryPage("<article><div><h2>{{ title }}</h2></div></article>");
		const template = await staff.api.templates.getEntryTemplate({ siteId, postTypeId });
		const live = await openDraft(install, staff, siteId, { kind: "template", id: template.template?.id ?? "" });
		const node = ((await entryTemplate(postTypeId)).nodes[0] as { children: unknown[] }).children[0];
		const made = await staff.api.components.make({
			siteId,
			name: "LiveCard",
			source: { kind: "entryTemplate", postTypeId },
			path: [0, 0, 0],
			node,
		});
		await live.untilDraft(
			(draft) =>
				((draft as { nodes: { children: { id: string }[] }[] }).nodes[0]?.children[0]?.id ?? "") === made.placement.id,
			"the Placement",
		);
		live.close();
	});
});

describe("New Component, placed", () => {
	test("makes an empty Component and places it where the insert point is, in one step", async () => {
		const { postTypeId } = await entryPage("<article><h2>{{ title }}</h2></article>");
		const article = (await entryTemplate(postTypeId)).nodes[0] as { children: unknown[] };

		const made = await staff.api.components.create({
			siteId,
			name: "Banner",
			place: { source: { kind: "entryTemplate", postTypeId }, path: [0, 0, 1], list: article.children },
		});

		expect("placement" in made && made.placement.path).toEqual([0, 0, 1]);
		expect(made.component).toMatchObject({ name: "Banner", draft: { props: [], tree: { nodes: [] } } });
		const after = (await entryTemplate(postTypeId)).nodes[0] as { children: unknown[] };
		expect(after.children[1]).toEqual({
			type: "component",
			id: "placement" in made ? made.placement.id : "",
			component: made.component.id,
			props: [],
		});

		// The list changed since it was read: nothing is made.
		const names = await componentNames();
		const refused = await staff.api.components
			.create({
				siteId,
				name: "Late",
				place: { source: { kind: "entryTemplate", postTypeId }, path: [0, 0, 0], list: article.children },
			})
			.catch((error: unknown) => error);
		expect(refused).toMatchObject({ code: "CHANGED_MEANWHILE" });
		expect(await componentNames()).toEqual(names);
	});
});

describe("another Workspace's sources", () => {
	test("a Template or Component of another Site can't be the source: nothing is made", async () => {
		const otherWorkspace = (await install.createWorkspace("Other Ltd")).id;
		const otherSite = (await install.createSite(otherWorkspace, { slug: "elsewhere" })).id;
		const { api: superadmin } = await install.superadmin();
		const { component: theirs } = await superadmin.components.create({ siteId: otherSite, name: "Theirs" });
		const saved = await superadmin.components.saveMarkup({
			siteId: otherSite,
			componentId: theirs.id,
			markup: '<p data-wc-id="p">Theirs</p>',
		});
		const names = await componentNames();
		const source = { kind: "component" as const, componentId: theirs.id };

		const made = await staff.api.components
			.make({ siteId, name: "Stolen", source, path: [0], node: saved.component.draft.tree.nodes[0] })
			.catch((error: unknown) => error);
		const placed = await staff.api.components
			.create({ siteId, name: "Planted", place: { source, path: [0], list: saved.component.draft.tree.nodes } })
			.catch((error: unknown) => error);

		expect(made).toMatchObject({ code: "COMPONENT_NOT_FOUND" });
		expect(placed).toMatchObject({ code: "COMPONENT_NOT_FOUND" });
		expect(await componentNames()).toEqual(names);
		const { markup } = await superadmin.components.getMarkup({ siteId: otherSite, componentId: theirs.id });
		expect(withoutIds(markup.draft)).toBe("{{@props}}\n{{/props}}\n<p>Theirs</p>");
	});
});

describe("from Code mode", () => {
	test("Make Component and New Component are Code mode actions with the same rules", async () => {
		const { postTypeId, path } = await entryPage("<article><div><h2>{{ title }}</h2></div></article>");
		const code = await openCodeMode(install, staff, siteId, path);
		const node = ((await entryTemplate(postTypeId)).nodes[0] as { children: unknown[] }).children[0];

		const made = await answer<{ component: { id: string; name: string }; placement: { id: string } }>(
			code.edit("code/makeComponent", {
				name: "CodeCard",
				source: { kind: "entryTemplate", postTypeId },
				path: [0, 0, 0],
				node,
			}),
		);
		expect(made.component.name).toBe("CodeCard");
		const taken = await code.edit("code/createComponent", { name: "CodeCard" });
		expect(taken.status).toBe(409);
		const fresh = await answer<{ component: { name: string } }>(
			code.edit("code/createComponent", { name: "CodeFooter" }),
		);
		expect(fresh.component.name).toBe("CodeFooter");
	});
});
