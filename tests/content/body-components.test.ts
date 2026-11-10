// Components in a body (spec story 85): each Body field lists the Components Staff allow in it (empty
// by default). Members insert them and fill their Props, never editing inside them; a body places
// them with the same node as a Template's Placement and renders them the same way. The server
// refuses a Component the Field doesn't allow, Props it doesn't have and values that don't fit them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let author: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let pricingId: string;
let noteId: string;
let draftOnlyId: string;

type PropInput = Parameters<TestBrowser["api"]["components"]["create"]>[0]["props"];
type FieldInputs = Parameters<TestBrowser["api"]["postTypes"]["create"]>[0]["fields"];

/** A Component with its Props and markup, published unless asked not to; answers its id. */
async function component(name: string, props: PropInput, markup: string, publish = true): Promise<string> {
	const { component: made } = await staff.api.components.create({ siteId, name, props });
	await staff.api.components.saveMarkup({ siteId, componentId: made.id, markup });
	if (publish) await staff.api.components.publish({ siteId, componentId: made.id });
	return made.id;
}

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	pricingId = await component(
		"PricingTable",
		[
			{
				key: "plan",
				label: "Plan",
				type: "select",
				required: true,
				options: [
					{ value: "basic", label: "Basic" },
					{ value: "pro", label: "Pro" },
				],
			},
			{ key: "seats", label: "Seats", type: "number" },
			{ key: "featured", label: "Featured", type: "boolean" },
		],
		"<section><h3>{{ props.plan }}</h3>{{@if props.featured}}<p>Featured</p>{{/if}}<p>{{ props.seats }} seats</p></section>",
	);
	noteId = await component("Note", [{ key: "text", label: "Text", type: "text" }], "<aside>{{ props.text }}</aside>");
	draftOnlyId = await component("Later", [], "<div>Later</div>", false);
});

afterAll(async () => {
	await install.close();
});

let kinds = 0;

/** A Post Type whose Body field allows `components`, with an Entry template showing the body. */
async function postTypeAllowing(components: string[]) {
	const key = `kind-${++kinds}`;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: `Kind ${kinds}`,
		key,
		urlPattern: `/${key}/{slug}`,
		fields: [{ key: "body", label: "Body", type: "body", components }],
	});
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article>{{ body }}</article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	return { postType, key };
}

describe("allowing Components in a Body field", () => {
	test("allows none by default; Staff choose among the Site's Components, each once", async () => {
		const { postType } = await postTypeAllowing([]);
		expect(postType.fields[0]).toMatchObject({ type: "body", components: [] });

		const { postType: changed } = await staff.api.postTypes.update({
			siteId,
			postTypeId: postType.id,
			fields: [{ key: "body", label: "Body", type: "body", components: [pricingId, noteId, pricingId] }],
		});
		expect(changed.fields[0]).toMatchObject({ components: [pricingId, noteId] });
	});

	test("a Component the Site doesn't have is refused where it is listed", async () => {
		const fields: FieldInputs = [
			{ key: "body", label: "Body", type: "body", components: [noteId, "8f14e45f-ceea-467a-9575-5ef3d3cbbd6c"] },
		];
		await expect(
			staff.api.postTypes.create({ siteId, name: "Notes", key: "notes", urlPattern: "/notes/{slug}", fields }),
		).rejects.toMatchObject({
			code: "POST_TYPE_INVALID",
			data: { problems: [{ at: "fields[0].components[1]", rule: "componentUnknown" }] },
		});
	});

	test("editors list the Components a body allows that are published, with their Props", async () => {
		const { postType } = await postTypeAllowing([pricingId, draftOnlyId]);
		const { components } = await author.api.entries.bodyComponents({ siteId, postTypeId: postType.id });
		expect(components).toEqual([
			{
				id: pricingId,
				name: "PricingTable",
				props: [
					expect.objectContaining({ key: "plan", type: "select", required: true }),
					expect.objectContaining({ key: "seats", type: "number" }),
					expect.objectContaining({ key: "featured", type: "boolean" }),
				],
			},
		]);
	});
});

describe("inserting a Component in a body", () => {
	test("a Member places an allowed Component with its Props; visitors see its published version", async () => {
		const { postType, key } = await postTypeAllowing([pricingId]);
		const { entry } = await author.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Plans",
			fields: {
				body: [
					{ type: "paragraph", text: "Choose one:" },
					{
						type: "component",
						component: pricingId,
						props: [
							{ name: "plan", value: "pro" },
							{ name: "seats", value: "5" },
							{ name: "featured", value: "" },
						],
					},
				],
			},
		});
		expect(entry.problems).toEqual([]);
		expect(entry.draft.fields.body).toEqual([
			{ id: expect.any(String), type: "paragraph", text: [{ text: "Choose one:" }] },
			{
				id: expect.any(String),
				type: "component",
				component: pricingId,
				props: [
					{ name: "plan", value: "pro" },
					{ name: "seats", value: "5" },
					{ name: "featured", value: "" },
				],
			},
		]);

		await editor.api.entries.publish({ siteId, entryId: entry.id });
		const response = await install.request(`https://bakery.live.test/${key}/plans`);
		const html = await expectSafePage(response);
		expect(/<article>([\s\S]*?)<\/article>/.exec(html)?.[1]).toBe(
			"<p>Choose one:</p><section><h3>Pro</h3><p>Featured</p><p>5 seats</p></section>",
		);
	});

	test("a Component the Field doesn't allow is refused, as are Props it doesn't have and values that don't fit", async () => {
		const { postType } = await postTypeAllowing([pricingId]);
		const refusals: [unknown, string][] = [
			[{ type: "component", component: noteId, props: [] }, "fields.body[0].component"],
			[{ type: "component", component: draftOnlyId, props: [] }, "fields.body[0].component"],
			[
				{ type: "component", component: pricingId, props: [{ name: "colour", value: "red" }] },
				"fields.body[0].props[0]",
			],
			[
				{
					type: "component",
					component: pricingId,
					props: [
						{ name: "plan", value: "pro" },
						{ name: "seats", value: "many" },
					],
				},
				"fields.body[0].props[1]",
			],
		];
		for (const [block, at] of refusals) {
			await expect(
				author.api.entries.create({ siteId, postTypeId: postType.id, title: "Plans", fields: { body: [block] } }),
				`${JSON.stringify(block)} is refused at ${at}`,
			).rejects.toMatchObject({ code: "ENTRY_INVALID", data: { problems: [{ at }] } });
		}
	});

	test("a required Prop left empty is kept and keeps the Entry from being published", async () => {
		const { postType } = await postTypeAllowing([pricingId]);
		const { entry } = await author.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Plans",
			fields: { body: [{ type: "component", component: pricingId, props: [] }] },
		});
		expect(entry.problems).toEqual([expect.objectContaining({ at: "fields.body[0].props.plan", rule: "prop" })]);
		await expect(editor.api.entries.publish({ siteId, entryId: entry.id })).rejects.toMatchObject({
			code: "ENTRY_INVALID",
		});
	});

	test("a Component Staff stop allowing stays where it is, so the rest of the body still saves, and keeps it from being published", async () => {
		const { postType } = await postTypeAllowing([pricingId, noteId]);
		const { entry } = await author.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Plans",
			fields: {
				body: [
					{ type: "paragraph", text: "Intro" },
					{ type: "component", component: noteId, props: [{ name: "text", value: "Hello" }] },
				],
			},
		});
		await staff.api.postTypes.update({
			siteId,
			postTypeId: postType.id,
			fields: [{ key: "body", label: "Body", type: "body", components: [pricingId] }],
		});

		const blocks = entry.draft.fields.body as Record<string, unknown>[];
		const { entry: saved } = await author.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			fields: { body: [{ ...blocks[0], text: "New intro" }, blocks[1]] },
		});
		expect(saved.problems).toEqual([expect.objectContaining({ at: "fields.body[1].component", rule: "component" })]);
		await expect(editor.api.entries.publish({ siteId, entryId: entry.id })).rejects.toMatchObject({
			code: "ENTRY_INVALID",
		});

		// Placing it again, as a new Block, is refused.
		await expect(
			author.api.entries.saveDraft({
				siteId,
				entryId: entry.id,
				fields: {
					body: [...(saved.draft.fields.body as unknown[]), { type: "component", component: noteId, props: [] }],
				},
			}),
		).rejects.toMatchObject({ code: "ENTRY_INVALID", data: { problems: [{ at: "fields.body[2].component" }] } });
	});
});

describe("Components in a body as Markdown", () => {
	test("Component Props decode the same named entities as Markdown text", async () => {
		const { postType } = await postTypeAllowing([noteId]);
		const { entry } = await author.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Named entities",
			bodyFormat: "markdown",
			fields: { body: '<Note text="&Aacute; &alpha; &CounterClockwiseContourIntegral; &unknown; &copy" />' },
		});
		expect(entry.draft.fields.body).toMatchObject([
			{ type: "component", component: noteId, props: [{ name: "text", value: "Á α ∳ &unknown; &copy" }] },
		]);
	});

	test("a Component is its tag with its Props, both ways", async () => {
		const { postType } = await postTypeAllowing([pricingId]);
		const { entry } = await author.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Plans",
			bodyFormat: "markdown",
			fields: { body: 'Choose:\n\n<PricingTable plan="pro" seats="5" featured />' },
		});
		expect(entry.draft.fields.body).toEqual([
			{ id: expect.any(String), type: "paragraph", text: [{ text: "Choose:" }] },
			{
				id: expect.any(String),
				type: "component",
				component: pricingId,
				props: [
					{ name: "plan", value: "pro" },
					{ name: "seats", value: "5" },
					{ name: "featured", value: "" },
				],
			},
		]);

		const { entry: read } = await author.api.entries.get({ siteId, entryId: entry.id, bodyFormat: "markdown" });
		expect(read.draft.fields.body).toBe('Choose:\n\n<PricingTable plan="pro" seats="5" featured />');
	});

	test("an unknown or unallowed Component, an unknown Prop, a value that doesn't fit and a missing required Prop are refused by line", async () => {
		const { postType } = await postTypeAllowing([pricingId]);
		const markdown = [
			"<Nowhere />", // 1
			'<Note text="Hi" />', // 2
			'<PricingTable plan="pro" colour="red" />', // 3
			'<PricingTable plan="pro" seats="many" />', // 4
			"<PricingTable />", // 5
		].join("\n\n");
		const lines = [1, 3, 5, 7, 9];
		try {
			await author.api.entries.create({
				siteId,
				postTypeId: postType.id,
				title: "Plans",
				bodyFormat: "markdown",
				fields: { body: markdown },
			});
			throw new Error("accepted");
		} catch (error) {
			const problems = (error as { data: { problems: { line: number }[] } }).data.problems;
			expect(problems.map((problem) => problem.line)).toEqual(lines);
		}
	});
});

test("a Markdown copy retains a body's Component tag and Props", async () => {
	const { postType, key } = await postTypeAllowing([noteId]);
	const { entry } = await author.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "A note",
		fields: { body: [{ type: "component", component: noteId, props: [{ name: "text", value: "Fresh bread" }] }] },
	});
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	const response = await install.request(`https://bakery.live.test/${key}/a-note.md`);
	expect(response.status).toBe(200);
	expect(await response.text()).toContain('<Note text="Fresh bread" />');
});
