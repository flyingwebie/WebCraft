import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DocumentJson } from "@webcraft/core";
import { createApiToken } from "../harness/api-tokens.ts";
import { openDraft } from "../harness/co-editing.ts";
import { pdf, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { answerOf, connectMcp } from "../harness/mcp.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;
beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace()).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});
afterAll(async () => {
	await install.close();
});
async function subject(slug: string) {
	const siteId = (await install.createSite(workspaceId, { slug })).id;
	const { component } = await staff.api.components.create({ siteId, name: "Card" });
	return { siteId, componentId: component.id };
}

test("Component markup declares Props, prints their flags and defaults, and saves losslessly", async () => {
	const target = await subject("declarations");
	const saved = await staff.api.components.saveMarkup({
		...target,
		markup:
			'{{@props}}\n  heading: text required default="Welcome" exposed\n  featured: boolean default=false\n{{/props}}\n<h2>{{ props.heading }}</h2>',
	});
	expect(saved.component.draft.props).toMatchObject([
		{ key: "heading", type: "text", required: true, default: "Welcome", exposed: true },
		{ key: "featured", type: "boolean", default: false },
	]);
	expect(saved.markup).toStartWith('{{@props}}\n  heading: text required default="Welcome" exposed');
	const again = await staff.api.components.saveMarkup({ ...target, markup: saved.markup, basedOn: saved.version });
	expect(again.component.draft).toEqual(saved.component.draft);
	expect(again.markup).toBe(saved.markup);
});

test("declarations preserve every supported Prop type, nested settings and media defaults", async () => {
	const target = await subject("all-props");
	await staff.api.postTypes.create({
		siteId: target.siteId,
		name: "People",
		key: "people",
		urlPattern: "/people/{slug}",
	});
	const { media } = await staff.api.media.upload({ siteId: target.siteId, file: upload(pdf(), "guide.pdf") });
	const { component } = await staff.api.components.saveDraft({
		...target,
		props: [
			{
				key: "heading",
				label: "Heading",
				type: "text",
				help: 'Say "hello"\n{{/props}}',
				required: true,
				translatable: false,
				minLength: 1,
				maxLength: 80,
				pattern: "[A-Z].*",
				default: "Hello",
				exposed: true,
			},
			{ key: "rich", label: "Rich", type: "richText", maxLength: 100, default: "<p>Read</p>" },
			{ key: "count", label: "Count", type: "number", min: 1, max: 5, integer: true, default: 2 },
			{ key: "featured", label: "Featured", type: "boolean", default: false },
			{ key: "when", label: "When", type: "date", mode: "time", min: "09:00", max: "18:00", default: "10:30" },
			{
				key: "tone",
				label: "Tone",
				type: "select",
				multiple: true,
				options: [{ value: "calm", label: "Calm" }],
				min: 1,
				max: 1,
				default: ["calm"],
			},
			{ key: "image", label: "Image", type: "media", default: media.id },
			{ key: "link", label: "Link", type: "link", default: { url: "/about", text: "About" } },
			{ key: "mail", label: "Mail", type: "email", default: "shop@example.test", pattern: ".*@example.test" },
			{
				key: "person",
				label: "Person",
				type: "relationship",
				postTypes: ["people"],
				multiple: true,
				twoWay: false,
				min: 1,
				max: 3,
			},
			{
				key: "group",
				label: "Group",
				type: "group",
				fields: [{ key: "title", label: "Title", type: "text", default: "Nested", exposed: true }],
			},
			{
				key: "rows",
				label: "Rows",
				type: "repeater",
				min: 1,
				max: 3,
				fields: [
					{
						key: "group",
						label: "Group",
						type: "group",
						fields: [{ key: "cost", label: "Cost", type: "number", default: 2 }],
					},
				],
			},
		],
	});
	const printed = await staff.api.components.getMarkup(target);
	const saved = await staff.api.components.saveMarkup({ ...target, markup: printed.markup.draft });
	expect(saved.component.draft).toEqual(component.draft);
	expect(saved.markup).toBe(printed.markup.draft);
	const alias = await staff.api.components.saveMarkup({
		...target,
		markup: '{{@props}}\nlink: url default="/about"\n{{/props}}\n<a href="{{ props.link.url }}">About</a>',
	});
	expect(alias.component.draft.props[0]).toMatchObject({ type: "link", default: { url: "/about", text: "" } });
});

test("invalid declarations refuse the whole save with their source line", async () => {
	const target = await subject("bad-props");
	const before = await staff.api.components.getMarkup(target);
	for (const [markup, line] of [
		["<p>Before</p>\n{{@props}}\nheading: text\n{{/props}}", 2],
		["{{@props}}\n{{/props}}\n{{@props}}\n{{/props}}", 3],
		["{{@props}}\nheading: mystery\n{{/props}}", 2],
		['{{@props}}\ncount: number default="no"\n{{/props}}', 2],
		["{{@props}}\nheading: text\nheading: text\n{{/props}}", 3],
		['{{@props}}\nheading: text exposed="yes"\n{{/props}}', 2],
		['{{@props}}\nheading: text id="bad id"\n{{/props}}', 2],
		['{{@props}}\nheading: text id="same"\nother: text id="same"\n{{/props}}', 3],
		["{{@props}}\ngroup: group fields=[null]\n{{/props}}", 2],
		[
			'{{@props}}\ngroup: group fields=[{"key":"x","label":"X","type":"text","id":"same"},{"key":"y","label":"Y","type":"text","id":"same"}]\n{{/props}}',
			2,
		],
		['{{@props}}\nheading: text\n{{/props}}\n<div style="color: red">{{ props.missing }}</div>', 4],
	] as const) {
		await expect(staff.api.components.saveMarkup({ ...target, markup })).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: { problems: expect.arrayContaining([expect.objectContaining({ line })]) },
		});
		expect((await staff.api.components.getMarkup(target)).version).toBe(before.version);
	}
	await expect(
		staff.api.templates.saveSiteTemplateMarkup({
			siteId: target.siteId,
			markup: "{{@props}}\nx: text\n{{/props}}\n<main>{{@outlet}}</main>",
		}),
	).rejects.toMatchObject({
		code: "TEMPLATE_MARKUP_INVALID",
		data: { problems: [expect.objectContaining({ line: 1 })] },
	});
});

test("renames follow declaration identity, keep Placement values, and leave visitors unchanged until publish", async () => {
	const target = await subject("rename-props");
	const saved = await staff.api.components.saveMarkup({
		...target,
		markup: "{{@props}}\nheading: text\n{{/props}}\n<h2>{{ props.heading }}</h2>",
	});
	await staff.api.components.publish(target);
	const { postType } = await staff.api.postTypes.create({
		siteId: target.siteId,
		name: "Stories",
		urlPattern: "/stories/{slug}",
	});
	const placed = await staff.api.templates.saveEntryTemplateMarkup({
		siteId: target.siteId,
		postTypeId: postType.id,
		markup: '<Card heading="Keep me" />',
	});
	await staff.api.templates.publish({ siteId: target.siteId, templateId: placed.template.id });
	const renamed = await staff.api.components.saveMarkup({
		...target,
		markup: saved.markup.replace("heading:", "title:").replace("props.heading", "props.title"),
	});
	expect(renamed.component.draft.props[0]?.id).toBe(saved.component.draft.props[0]?.id);
	const draft = await staff.api.templates.getEntryTemplateMarkup({ siteId: target.siteId, postTypeId: postType.id });
	expect(draft.markup?.draft).toContain('title="Keep me"');
	expect(draft.markup?.published).toContain('heading="Keep me"');
	await staff.api.components.publish(target);
	const live = await staff.api.templates.getEntryTemplateMarkup({ siteId: target.siteId, postTypeId: postType.id });
	expect(live.markup?.published).toContain('title="Keep me"');
});

test("deleting and changing Prop types reports each affected Placement once and drops values only on publish", async () => {
	const target = await subject("drop-props");
	const original = await staff.api.components.saveMarkup({
		...target,
		markup: "{{@props}}\nheading: text\ncount: number\n{{/props}}\n<p>{{ props.heading }} {{ props.count }}</p>",
	});
	await staff.api.components.publish(target);
	const wrapper = await staff.api.components.create({ siteId: target.siteId, name: "Wrapper" });
	await staff.api.components.saveMarkup({
		siteId: target.siteId,
		componentId: wrapper.component.id,
		markup: '<Card heading="Nested" count="2" />',
	});
	await staff.api.components.publish({ siteId: target.siteId, componentId: wrapper.component.id });
	const { postType } = await staff.api.postTypes.create({
		siteId: target.siteId,
		name: "Articles",
		urlPattern: "/articles/{slug}",
		fields: [{ key: "body", label: "Body", type: "body", components: [target.componentId] }],
	});
	const placed = await staff.api.templates.saveEntryTemplateMarkup({
		siteId: target.siteId,
		postTypeId: postType.id,
		markup: '<Card heading="Fixed" count="3" /><Wrapper /><article>{{ body }}</article>',
	});
	await staff.api.templates.publish({ siteId: target.siteId, templateId: placed.template.id });
	const { entry } = await staff.api.entries.create({
		siteId: target.siteId,
		postTypeId: postType.id,
		title: "Example",
		fields: {
			body: [
				{
					type: "component",
					component: target.componentId,
					props: [
						{ name: "heading", value: "Body" },
						{ name: "count", value: "4" },
					],
				},
			],
		},
	});
	await staff.api.entries.publish({ siteId: target.siteId, entryId: entry.id });
	const origin = await goLive(install, target.siteId);
	const visible = () => install.request(`${origin}/articles/example`).then(expectSafePage);
	expect(await visible()).toContain("Fixed 3");
	const changed = await staff.api.components.saveMarkup({
		...target,
		markup: `{{@props}}\ncount: text id="${original.component.draft.props[1]?.id}"\n{{/props}}\n<p>{{ props.count }}</p>`,
	});
	expect(changed.propImpact).toEqual({ placements: 3, message: "3 Placements lose their value" });
	expect(await visible()).toContain("Fixed 3");
	const retained = await staff.api.templates.getEntryTemplateMarkup({ siteId: target.siteId, postTypeId: postType.id });
	await staff.api.templates.saveEntryTemplateMarkup({
		siteId: target.siteId,
		postTypeId: postType.id,
		markup: retained.markup?.draft ?? "",
	});
	expect(
		(await staff.api.templates.getEntryTemplateMarkup({ siteId: target.siteId, postTypeId: postType.id })).markup
			?.draft,
	).toContain('heading="Fixed"');
	const retainedNode = (
		await staff.api.templates.getEntryTemplateMarkup({ siteId: target.siteId, postTypeId: postType.id })
	).template?.draft.nodes[0];
	expect(retainedNode?.type === "component" ? retainedNode.props : []).toContainEqual(
		expect.objectContaining({
			name: "count",
			retained: original.component.draft.props[1]?.id,
			value: [{ type: "text", text: "3" }],
		}),
	);
	// Restoring the old declarations before publish cancels the loss.
	const undone = await staff.api.components.saveMarkup({ ...target, markup: original.markup });
	expect(undone.propImpact.placements).toBe(0);
	await staff.api.components.saveMarkup({ ...target, markup: changed.markup });
	await staff.api.components.publish(target);
	const holder = await staff.api.templates.getEntryTemplateMarkup({ siteId: target.siteId, postTypeId: postType.id });
	expect(holder.markup?.draft).not.toContain("heading=");
	expect(holder.markup?.published).not.toContain("count=");
	const nested = await staff.api.components.getMarkup({ siteId: target.siteId, componentId: wrapper.component.id });
	expect(nested.markup.published).not.toContain("count=");
	const body = await staff.api.entries.get({ siteId: target.siteId, entryId: entry.id });
	expect(JSON.stringify(body.entry.published)).not.toContain('"value":"Body"');
	expect((await staff.api.components.getMarkup(target)).propImpact.placements).toBe(0);
	expect(await visible()).not.toContain("Fixed 3");
});

test("nested Field identities survive renames and report nested type losses without guessing identities", async () => {
	const target = await subject("nested-identities");
	const original = await staff.api.components.saveMarkup({
		...target,
		markup:
			'{{@props}}\ncard: group fields=[{"key":"heading","label":"Heading","type":"text"},{"key":"count","label":"Count","type":"number"}]\n{{/props}}\n<p>{{ props.card.heading }}</p>',
	});
	await staff.api.components.publish(target);
	const { postType } = await staff.api.postTypes.create({
		siteId: target.siteId,
		name: "Stories",
		urlPattern: "/stories/{slug}",
	});
	await staff.api.templates.saveEntryTemplateMarkup({
		siteId: target.siteId,
		postTypeId: postType.id,
		markup: `<Card card='{{ ${JSON.stringify('{"heading":"Words","count":3}')} it: ${JSON.stringify('{"heading":"Parole","count":4}')} }}' />`,
	});
	const renamed = await staff.api.components.saveMarkup({
		...target,
		markup: original.markup
			.replaceAll('"key":"heading"', '"key":"title"')
			.replace("props.card.heading", "props.card.title"),
	});
	const placing = await staff.api.templates.getEntryTemplateMarkup({ siteId: target.siteId, postTypeId: postType.id });
	const node = placing.template?.draft.nodes[0];
	expect(node && node.type === "component" ? node.props[0]?.value : null).toEqual([
		{ type: "text", text: '{"title":"Words","count":3}', translations: { it: '{"title":"Parole","count":4}' } },
	]);
	const changed = await staff.api.components.saveMarkup({
		...target,
		markup: renamed.markup.replace('"type":"number"', '"type":"text"'),
	});
	expect(changed.propImpact.placements).toBe(1);
	await staff.api.components.publish(target);
	expect(
		(await staff.api.templates.getEntryTemplateMarkup({ siteId: target.siteId, postTypeId: postType.id })).markup
			?.draft,
	).not.toContain("&quot;count&quot;");
	const priorId = changed.component.draft.props[0]?.id;
	const replacement = await staff.api.components.saveMarkup({
		...target,
		markup: "{{@props}}\nother: text\n{{/props}}\n<p>{{ props.other }}</p>",
	});
	expect(replacement.component.draft.props[0]?.id).not.toBe(priorId);
});

test("builder read and print use the Component block and its new Prop contract before saving", async () => {
	const target = await subject("builder-props");
	const builder = { siteId: target.siteId, target: { kind: "component" as const, componentId: target.componentId } };
	const read = await staff.api.builder.read({
		...builder,
		markup: '{{@props}}\nheading: text exposed default="Preview"\n{{/props}}\n<h2>{{ props.heading }}</h2>',
	});
	expect(read.props).toMatchObject([{ key: "heading", exposed: true }]);
	const printed = await staff.api.builder.markup({ ...builder, tree: read.tree, props: read.props ?? undefined });
	expect(printed.markup).toStartWith('{{@props}}\n  heading: text default="Preview" exposed');
	const again = await staff.api.builder.read({ ...builder, markup: printed.markup });
	expect(again.props).toEqual(read.props);
	expect((await staff.api.components.getMarkup(target)).component.draft.props).toEqual([]);
});

test("the settings API renames its own bindings by id, and shared Draft writes cannot erase pending loss", async () => {
	const target = await subject("shared-props");
	const original = await staff.api.components.saveMarkup({
		...target,
		markup: "{{@props}}\nheading: text\n{{/props}}\n<p>{{ props.heading }}</p>",
	});
	const prop = original.component.draft.props[0];
	if (!prop) throw new Error("missing Prop");
	await staff.api.components.saveDraft({ ...target, props: [{ ...prop, key: "title" }] });
	expect((await staff.api.components.getMarkup(target)).markup.draft).toContain("{{ props.title }}");
	const { postType } = await staff.api.postTypes.create({
		siteId: target.siteId,
		name: "Stories",
		urlPattern: "/stories/{slug}",
	});
	await staff.api.templates.saveEntryTemplateMarkup({
		siteId: target.siteId,
		postTypeId: postType.id,
		markup: '<Card title="Retained" />',
	});
	await staff.api.components.saveMarkup({ ...target, markup: "{{@props}}\n{{/props}}\n<p>Empty</p>" });
	const live = await openDraft(install, staff, target.siteId, { kind: "component", id: target.componentId });
	try {
		live.change((draft) => ({ ...(draft as object), propBaseline: [] }) as DocumentJson);
		await live.saved();
		const read = await staff.api.components.getMarkup(target);
		expect(read.propImpact.placements).toBe(1);
		await staff.api.components.saveMarkup({ ...target, markup: "<p>Legacy client</p>" });
		expect((await staff.api.components.getMarkup(target)).propImpact.placements).toBe(1);
	} finally {
		await live.close();
	}
});

test("MCP reads and writes the canonical declaration block and documents its identity contract", async () => {
	const target = await subject("mcp-props");
	const { secret } = await createApiToken(staff, { workspaceId, name: "Props writer", toolsets: ["structure"] });
	const client = await connectMcp(install, secret);
	try {
		const guide = await client.callTool({ name: "guide_get", arguments: { topic: "template-markup" } });
		expect(JSON.stringify(guide)).toContain("{{@props}}");
		type Saved = Awaited<ReturnType<TestBrowser["api"]["components"]["saveMarkup"]>>;
		const saved = answerOf<Saved>(
			await client.callTool({
				name: "components_save_markup",
				arguments: {
					...target,
					markup: '{{@props}}\nheading: text exposed default="MCP"\n{{/props}}\n<p>{{ props.heading }}</p>',
				},
			}),
		);
		const printed = answerOf<Awaited<ReturnType<TestBrowser["api"]["components"]["getMarkup"]>>>(
			await client.callTool({ name: "components_get_markup", arguments: target }),
		);
		expect(printed.markup.draft).toBe(saved.markup);
		const again = answerOf<Saved>(
			await client.callTool({
				name: "components_save_markup",
				arguments: { ...target, markup: printed.markup.draft, basedOn: printed.version },
			}),
		);
		expect(again.component.draft).toEqual(saved.component.draft);
	} finally {
		await client.close();
	}
});

test("a bound Group Placement reports nested type loss and drops its binding on publish", async () => {
	const target = await subject("bound-group-loss");
	const first = await staff.api.components.saveMarkup({
		...target,
		markup:
			'{{@props}}\ncard: group fields=[{"key":"count","label":"Count","type":"number"}]\n{{/props}}\n<p>{{ props.card.count }}</p>',
	});
	await staff.api.components.publish(target);
	const { postType } = await staff.api.postTypes.create({
		siteId: target.siteId,
		name: "Stories",
		urlPattern: "/stories/{slug}",
		fields: [
			{ key: "address", label: "Address", type: "group", fields: [{ key: "count", label: "Count", type: "number" }] },
		],
	});
	await staff.api.templates.saveEntryTemplateMarkup({
		siteId: target.siteId,
		postTypeId: postType.id,
		markup: '<Card card="{{ address }}" />',
	});
	const changed = await staff.api.components.saveMarkup({
		...target,
		markup: first.markup.replace('"type":"number"', '"type":"text"'),
	});
	expect(changed.propImpact.placements).toBe(1);
	await staff.api.components.publish(target);
	expect(
		(await staff.api.templates.getEntryTemplateMarkup({ siteId: target.siteId, postTypeId: postType.id })).markup
			?.draft,
	).not.toContain("card=");
});

test("a nested Field rename retains a whole-Group binding's values after publish", async () => {
	const target = await subject("bound-group-rename");
	const first = await staff.api.components.saveMarkup({
		...target,
		markup:
			'{{@props}}\ncard: group fields=[{"key":"heading","label":"Heading","type":"text"}]\n{{/props}}\n<h2>{{ props.card.heading }}</h2>',
	});
	await staff.api.components.publish(target);
	const { postType } = await staff.api.postTypes.create({
		siteId: target.siteId,
		name: "Stories",
		urlPattern: "/stories/{slug}",
		fields: [
			{ key: "address", label: "Address", type: "group", fields: [{ key: "heading", label: "Heading", type: "text" }] },
		],
	});
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId: target.siteId,
		postTypeId: postType.id,
		markup: '<Card card="{{ address }}" />',
	});
	await staff.api.templates.publish({ siteId: target.siteId, templateId: template.id });
	const { entry } = await staff.api.entries.create({
		siteId: target.siteId,
		postTypeId: postType.id,
		title: "Example",
		fields: { address: { heading: "Preserved heading" } },
	});
	await staff.api.entries.publish({ siteId: target.siteId, entryId: entry.id });
	const origin = await goLive(install, target.siteId);
	const visible = async () => expectSafePage(await install.request(`${origin}/stories/example`));
	expect(await visible()).toContain("Preserved heading");
	await staff.api.components.saveMarkup({
		...target,
		markup: first.markup.replace('"key":"heading"', '"key":"title"').replace("props.card.heading", "props.card.title"),
	});
	expect(await visible()).toContain("Preserved heading");
	await staff.api.components.publish(target);
	expect(await visible()).toContain("Preserved heading");
});

test("a live Component rename reaches another open Template Draft without overwriting its other edits", async () => {
	const target = await subject("live-rename-props");
	await staff.api.components.saveMarkup({
		...target,
		markup: "{{@props}}\nheading: text\n{{/props}}\n<p>{{ props.heading }}</p>",
	});
	const { postType } = await staff.api.postTypes.create({
		siteId: target.siteId,
		name: "Stories",
		urlPattern: "/stories/{slug}",
	});
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId: target.siteId,
		postTypeId: postType.id,
		markup: '<Card heading="Keep" /><p>Other text</p>',
	});
	const component = await openDraft(install, staff, target.siteId, { kind: "component", id: target.componentId });
	const holder = await openDraft(install, staff, target.siteId, { kind: "template", id: template.id });
	try {
		component.change((draft) =>
			JSON.parse(
				JSON.stringify(draft)
					.replaceAll('"key":"heading"', '"key":"title"')
					.replaceAll('"path":"props.heading"', '"path":"props.title"'),
			),
		);
		await component.saved();
		await holder.untilDraft(
			(draft) => JSON.stringify(draft).includes('"name":"title"'),
			"the renamed Prop in the open Template",
		);
		holder.change((draft) => JSON.parse(JSON.stringify(draft).replace("Other text", "Other editor")));
		await holder.saved();
		const saved = await staff.api.templates.getEntryTemplateMarkup({ siteId: target.siteId, postTypeId: postType.id });
		expect(saved.markup?.draft).toContain('title="Keep"');
		expect(saved.markup?.draft).toContain("Other editor");
	} finally {
		await component.close();
		await holder.close();
	}
});
