// Template markup is lossless (ADR 0017): printing a stored tree and saving that markup gives the
// same tree back, for every element setting and every Placement of a Component. Checked once by
// hand for every setting, then over many generated trees.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fc from "fast-check";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { placedForm, type TestNode, type TestTree } from "../harness/trees.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let postTypeId: string;
/** Two generated Classes of the Site and a token utility: their ids, and their names in markup. */
let classes: { id: string; name: string }[];
/** A Component with text Props, one of them written in camelCase. */
let cardId: string;
/** Two Forms of the Site, placed with `{{@form <key>}}`. */
let formIds: string[];

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
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: '<p style="color: red">a</p><p style="color: blue">b</p>',
	});
	classes = saved.template.draft.nodes.map((node, index) => ({
		id: (node as { classes: string[] }).classes[0] ?? "",
		name: /the Class (style-[0-9a-f]{8})/.exec(saved.notices[index]?.message ?? "")?.[1] ?? "",
	}));
	// The padding utility of the default spacing step m: stored by an id made from the token's.
	const utility = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: '<p class="p-m">c</p>',
	});
	classes.push({ id: (utility.template.draft.nodes[0] as { classes: string[] }).classes[0] ?? "", name: "p-m" });
	const { component } = await staff.api.components.create({
		siteId,
		name: "Card",
		props: [
			{ key: "heading", label: "Heading", type: "text" },
			{ key: "note", label: "Note", type: "text" },
			{ key: "heroImage", label: "Hero image", type: "text" },
		],
	});
	cardId = component.id;
	await staff.api.components.saveMarkup({ siteId, componentId: cardId, markup: "<span>{{ props.heading }}</span>" });
	formIds = [
		(await staff.api.forms.create({ siteId, name: "Contact", key: "contact" })).form.id,
		(await staff.api.forms.create({ siteId, name: "Wedding cake", key: "wedding-cake" })).form.id,
	];
});

afterAll(async () => {
	await install.close();
});

/** Saves a tree, then its printed markup; answers both saves. */
async function roundTrip(tree: TestTree) {
	const fromTree = await staff.api.templates.saveEntryTemplate({ siteId, postTypeId, tree });
	const printed = await staff.api.templates.getEntryTemplateMarkup({ siteId, postTypeId });
	const markup = printed.markup?.draft ?? "";
	const fromMarkup = await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup });
	return { tree: fromTree.template.draft, markup, again: fromMarkup };
}

const el = (
	id: string,
	tag: string,
	children: TestNode[] = [],
	attributes: { name: string; value: unknown[] }[] = [],
	classIds: string[] = [],
) => ({ type: "element", id, tag, attributes, classes: classIds, children }) as TestNode;
const text = (value: string) => ({ type: "text", text: value }) as const;
const value = (path: string, format?: unknown) => ({ type: "value", path, ...(format ? { format } : {}) }) as TestNode;

describe("a placed Form", () => {
	test("prints as {{@form <key>}}, and saving the markup gives the same tree", async () => {
		const tree: TestTree = {
			version: 1,
			nodes: [el("box", "section", [placedForm(formIds[1] ?? "")]), placedForm(formIds[0] ?? "")],
		};

		const { tree: stored, markup, again } = await roundTrip(tree);

		expect(markup).toBe('<section data-wc-id="box">{{@form wedding-cake}}</section>{{@form contact}}');
		expect(again.template.draft).toEqual(stored);
	});
});

describe("every element setting", () => {
	test("prints as this markup, and saving the markup gives the same tree", async () => {
		const tree = {
			version: 1,
			nodes: [
				el(
					"post",
					"article",
					[
						text("Fish & chips <b> {{ not a value }} \\"),
						value("title"),
						text("{"),
						value("publishedAt", { type: "date", style: "long" }),
						value("publishedAt", { type: "date" }),
						value("summary", { type: "truncate", length: 40 }),
						value("summary", { type: "number", digits: 2 }),
						value("summary", { type: "number" }),
						{ type: "comment", text: " A note: {{ title }} & <b> " },
						{
							type: "condition",
							branches: [
								{
									test: {
										type: "and",
										left: { type: "value", path: "summary" },
										right: {
											type: "not",
											operand: {
												type: "compare",
												operator: "==",
												left: { type: "value", path: "status" },
												right: { type: "literal", value: "draft" },
											},
										},
									},
									children: [el("yes", "p", [text("Yes")])],
								},
								{
									test: {
										type: "or",
										left: { type: "literal", value: true },
										right: {
											type: "and",
											left: { type: "value", path: "slug" },
											right: { type: "literal", value: -2.5 },
										},
									},
									children: [text("Maybe")],
								},
							],
							otherwise: [],
						},
						{
							type: "condition",
							branches: [
								{
									test: {
										type: "compare",
										operator: "!=",
										left: {
											type: "and",
											left: { type: "value", path: "title" },
											right: { type: "value", path: "slug" },
										},
										right: { type: "literal", value: 'say "hi" \\ }}' },
									},
									children: [],
								},
							],
							otherwise: null,
						},
						el("code", "pre", [text("\n  indented\r\n")]),
						el(
							"pic",
							"img",
							[],
							[
								{ name: "src", value: [text("/a.png")] },
								{ name: "alt", value: [] },
							],
						),
						el(
							"more",
							"a",
							[text("Read \\")],
							[
								{ name: "href", value: [text("/blog/"), value("slug")] },
								{ name: "hidden", value: [] },
								{
									name: "data-note",
									value: [text('"{{ quoted }}" \\'), value("title", { type: "date", style: "iso" }), text("{")],
								},
							],
						),
					],
					[{ name: "aria-label", value: [text("Post")] }],
					[classes[1]?.id ?? "", classes[0]?.id ?? ""],
				),
			],
		} as TestTree;
		const [red, blue] = [classes[0]?.name, classes[1]?.name];

		const { tree: stored, markup, again } = await roundTrip(tree);

		expect(stored).toEqual(tree as unknown as typeof stored);
		expect(markup).toBe(
			`<article class="${blue} ${red}" aria-label="Post" data-wc-id="post">` +
				"Fish &amp; chips &lt;b&gt; \\{{ not a value }} &#92;{{ title }}&#123;" +
				"{{ publishedAt | date: long }}{{ publishedAt | date }}{{ summary | truncate: 40 }}" +
				"{{ summary | number: 2 }}{{ summary | number }}" +
				"<!-- A note: {{ title }} & <b> -->" +
				'{{@if summary and not status == "draft"}}<p data-wc-id="yes">Yes</p>' +
				"{{@else if true or slug and -2.5}}Maybe{{@else}}{{/if}}" +
				'{{@if (title and slug) != "say \\"hi\\" \\\\ }}"}}{{/if}}' +
				'<pre data-wc-id="code">\n\n  indented&#13;\n</pre>' +
				'<img src="/a.png" alt="" data-wc-id="pic">' +
				'<a href="/blog/{{ slug }}" hidden data-note="&quot;\\{{ quoted }}&quot; &#92;{{ title | date: iso }}&#123;" data-wc-id="more">Read &#92;</a>' +
				"</article>",
		);
		expect(again.template.draft).toEqual(stored);
		expect(again.markup).toBe(markup);
		expect(again.notices).toEqual([]);
	});

	test("Placements print as their Component's tag with their Props, and read back the same", async () => {
		const tree = {
			version: 1,
			nodes: [
				{
					type: "component",
					id: "card1",
					component: cardId,
					props: [
						{ name: "note", value: [text('A & "b" <c> \\'), value("title"), text("{")] },
						{ name: "heroImage", value: [] },
						{ name: "heading", value: [value("publishedAt", { type: "date", style: "long" })] },
					],
				},
				el("wrap", "p", [{ type: "component", id: "card2", component: cardId, props: [] } as TestNode]),
			],
		} as TestTree;

		const { tree: stored, markup, again } = await roundTrip(tree);

		expect(stored).toEqual(tree as unknown as typeof stored);
		expect(markup).toBe(
			'<Card note="A &amp; &quot;b&quot; &lt;c&gt; &#92;{{ title }}&#123;" heroImage heading="{{ publishedAt | date: long }}" data-wc-id="card1" />' +
				'<p data-wc-id="wrap"><Card data-wc-id="card2" /></p>',
		);
		expect(again.template.draft).toEqual(stored);
		expect(again.markup).toBe(markup);
	});

	test("markup written by hand reads into its canonical tree, and prints in canonical form", async () => {
		const handWritten = [
			"<P Title='Hello &amp; welcome' DATA-X=plain>",
			"  {{title}} {{ publishedAt|date:short }}<BR/>",
			"  {{@if   summary  }}yes{{@else if(slug)}}no{{/if}}",
			"</P>",
		].join("\r\n");

		const saved = await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: handWritten });

		const [paragraph] = saved.template.draft.nodes as { id: string }[];
		const id = paragraph?.id ?? "";
		const br = (saved.markup.match(/<br data-wc-id="([A-Za-z0-9]{12})">/) ?? [])[1];
		expect(saved.markup).toBe(
			[
				`<p title="Hello &amp; welcome" data-x="plain" data-wc-id="${id}">`,
				`  {{ title }} {{ publishedAt | date: short }}<br data-wc-id="${br}">`,
				"  {{@if summary}}yes{{@else if slug}}no{{/if}}",
				"</p>",
			].join("\n"),
		);
	});
});

describe("generated trees", () => {
	const chars = fc.constantFrom(
		..."ab Z09-!=@/:;'\"&<>{}\\\n\r\t".split(""),
		"é",
		" ",
		"😀",
		"{{",
		"}}",
		"\\{{",
		"-->",
		"<!--",
	);
	const textArb = fc.string({ unit: chars, minLength: 0, maxLength: 10 });
	const path = fc.constantFrom("title", "slug", "summary", "status", "publishedAt");
	const format = fc.oneof(
		fc.constant(undefined),
		fc.record({
			type: fc.constant("date"),
			style: fc.constantFrom("short", "medium", "long", "full", "time", "iso", "datetime"),
		}),
		fc.constant({ type: "date" }),
		fc.record({ type: fc.constant("number"), digits: fc.integer({ min: 0, max: 10 }) }),
		fc.constant({ type: "number" }),
		fc.record({ type: fc.constant("truncate"), length: fc.integer({ min: 1, max: 10_000 }) }),
	);
	const valueArb = fc.record({ path, format }).map(({ path: name, format: chosen }) => value(name, chosen));
	// Fixed text with values in other languages.
	const translatedArb = fc
		.record({
			text: textArb,
			translations: fc.dictionary(fc.constantFrom("fr", "de", "pt-BR", "zh-Hant"), textArb.filter(Boolean), {
				minKeys: 1,
				maxKeys: 3,
			}),
		})
		.map(({ text: written, translations }) => ({ type: "text", text: written, translations }) as const);
	const part = fc.oneof(textArb.map(text), valueArb, translatedArb);
	const attributes = fc.uniqueArray(
		fc.record({
			name: fc.constantFrom("title", "aria-label", "data-x", "href", "lang", "hidden", "alt", "data-long-name"),
			value: fc.array(part, { maxLength: 3 }),
		}),
		{ selector: (attribute) => attribute.name, maxLength: 3 },
	);
	const literal = fc.oneof(
		textArb,
		fc.integer({ min: -1000, max: 1000 }),
		fc.constantFrom(0.5, 12.25, -3.75),
		fc.boolean(),
	);
	const { expression } = fc.letrec((tie) => ({
		expression: fc.oneof(
			{ depthSize: "small", withCrossShrink: true },
			path.map((name) => ({ type: "value", path: name })),
			literal.map((chosen) => ({ type: "literal", value: chosen })),
			tie("expression").map((operand) => ({ type: "not", operand })),
			fc.record({ type: fc.constantFrom("and", "or"), left: tie("expression"), right: tie("expression") }),
			fc.record({
				type: fc.constant("compare"),
				operator: fc.constantFrom("==", "!="),
				left: tie("expression"),
				right: tie("expression"),
			}),
		),
	}));
	const placement = fc
		.uniqueArray(
			fc.record({ name: fc.constantFrom("heading", "note", "heroImage"), value: fc.array(part, { maxLength: 3 }) }),
			{ selector: (prop) => prop.name, maxLength: 3 },
		)
		.map((props) => ({ type: "component", component: cardId, props }));
	const commentText = textArb.filter(
		(candidate) =>
			!candidate.includes("-->") &&
			!candidate.includes("--!>") &&
			!candidate.startsWith(">") &&
			!candidate.startsWith("->") &&
			!candidate.endsWith("<!-"),
	);
	const containers = ["div", "section", "span", "em", "strong", "article", "aside", "blockquote", "pre", "nav"];
	const voids = ["br", "hr", "img", "wbr"];
	const { node } = fc.letrec((tie) => ({
		node: fc.oneof(
			{ depthSize: "small", withCrossShrink: true },
			textArb.map(text),
			valueArb,
			translatedArb,
			placement,
			commentText.map((comment) => ({ type: "comment", text: comment })),
			fc
				.record({ tag: fc.constantFrom(...voids), attributes, classes: fc.subarray([0, 1, 2]) })
				.map(({ tag, attributes: list, classes: chosen }) => ({
					type: "element",
					tag,
					attributes: list,
					classes: chosen.map((index) => classes[index]?.id ?? ""),
					children: [],
				})),
			fc
				.record({
					tag: fc.constantFrom(...containers),
					attributes,
					classes: fc.subarray([2, 1, 0]),
					children: tie("nodes"),
				})
				.map(({ tag, attributes: list, classes: chosen, children }) => ({
					type: "element",
					tag,
					attributes: list,
					classes: chosen.map((index) => classes[index]?.id ?? ""),
					children,
				})),
			fc.constant({ type: "themeToggle" }),
			fc.constant({ type: "consentSettings" }),
			fc.record({
				type: fc.constant("condition"),
				branches: fc.array(fc.record({ test: expression, children: tie("nodes") }), { minLength: 1, maxLength: 3 }),
				otherwise: fc.oneof(fc.constant(null), tie("nodes")),
			}),
		),
		nodes: fc.array(tie("node"), { maxLength: 4 }),
	}));
	// The Language switcher renders a <nav>, and a Form a <form>, so they go where one can: here, at
	// the top level.
	const placedForm = fc.constantFrom(0, 1).map((index) => ({ type: "form", form: formIds[index] }));
	const nodes = fc.array(fc.oneof(node, fc.constant({ type: "languageSwitcher" }), placedForm), { maxLength: 4 });

	test("print → save gives the same tree, and the same markup", async () => {
		await fc.assert(
			fc.asyncProperty(nodes, async (generated) => {
				const { tree, markup, again } = await roundTrip({ version: 1, nodes: generated as TestNode[] });
				expect(again.template.draft).toEqual(tree);
				expect(again.markup).toBe(markup);
			}),
			{ numRuns: 150 },
		);
	}, 120_000);
});
