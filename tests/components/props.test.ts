// Props use the Field types (GLOSSARY.md): a Placement's fixed values are read through each Prop's
// type, a value read where the Component is placed passes on as it is, and everything is escaped
// for where it lands on the page.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { pdf, photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-04-05T10:30:00Z") });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

type PropInput = NonNullable<Parameters<TestBrowser["api"]["components"]["create"]>[0]["props"]>;

let kinds = 0;

/**
 * A published Component and a Post Type whose published Entry template is `placing`; answers what
 * one published Entry's page shows inside <main>.
 */
async function rendered(
	component: { name: string; props: PropInput; markup: string },
	placing: string,
	options: { fields?: PropInput; values?: Record<string, unknown>; title?: string } = {},
): Promise<string> {
	const key = `kind-${++kinds}`;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: `Kind ${kinds}`,
		key,
		urlPattern: `/${key}/{slug}`,
		fields: options.fields ?? [],
	});
	const { component: made } = await staff.api.components.create({
		siteId,
		name: component.name,
		props: component.props,
	});
	await staff.api.components.saveMarkup({ siteId, componentId: made.id, markup: component.markup });
	await staff.api.components.publish({ siteId, componentId: made.id });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: postType.id, markup: placing });
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: options.title ?? "An Entry",
		fields: options.values ?? {},
	});
	const { entry: published } = await editor.api.entries.publish({ siteId, entryId: entry.id });
	const response = await install.request(`https://bakery.live.test/${key}/${published.published?.slug}`);
	expect(response.status).toBe(200);
	return /<main[^>]*>([\s\S]*)<\/main>/.exec(await response.text())?.[1] ?? "";
}

describe("fixed Prop values", () => {
	test("are read through each Prop's Field type", async () => {
		const { media: leaflet } = await editor.api.media.upload({ siteId, file: upload(pdf(), "allergens.pdf") });
		expect((await install.drainJobs()).failed).toEqual([]);
		const fileUrl = (await editor.api.media.get({ siteId, mediaId: leaflet.id })).media.url;

		const main = await rendered(
			{
				name: "Specimen",
				props: [
					{ key: "words", label: "Words", type: "text" },
					{ key: "rich", label: "Rich", type: "richText" },
					{ key: "price", label: "Price", type: "number" },
					{ key: "open", label: "Open", type: "boolean" },
					{ key: "day", label: "Day", type: "date" },
					{
						key: "size",
						label: "Size",
						type: "select",
						options: [
							{ value: "small", label: "Small" },
							{ value: "large", label: "Large" },
						],
					},
					{
						key: "sizes",
						label: "Sizes",
						type: "select",
						multiple: true,
						options: [
							{ value: "small", label: "Small" },
							{ value: "large", label: "Large" },
						],
					},
					{ key: "more", label: "More", type: "link" },
					{ key: "plain", label: "Plain link", type: "link" },
					{ key: "mail", label: "Mail", type: "email" },
					{ key: "file", label: "File", type: "media" },
					{
						key: "address",
						label: "Address",
						type: "group",
						fields: [
							{ key: "street", label: "Street", type: "text" },
							{ key: "city", label: "City", type: "text" },
						],
					},
					{
						key: "team",
						label: "Team",
						type: "repeater",
						fields: [{ key: "name", label: "Name", type: "text" }],
					},
				],
				markup: [
					"<dl>",
					"<dt>text</dt><dd>{{ props.words }}</dd>",
					"<dt>rich</dt><dd>{{ props.rich }}</dd>",
					"<dt>number</dt><dd>{{ props.price | number: 2 }}</dd>",
					"<dt>boolean</dt><dd>{{@if props.open}}open{{@else}}closed{{/if}}</dd>",
					"<dt>date</dt><dd>{{ props.day | date: iso }}</dd>",
					"<dt>select</dt><dd>{{ props.size }} ({{ props.size.value }})</dd>",
					"<dt>several</dt><dd>{{ props.sizes }}</dd>",
					'<dt>link</dt><dd><a href="{{ props.more.url }}">{{ props.more }}</a> <a href="{{ props.plain.url }}">{{ props.plain }}</a></dd>',
					"<dt>email</dt><dd>{{ props.mail }}</dd>",
					'<dt>file</dt><dd><a href="{{ props.file }}">Allergens</a></dd>',
					"<dt>group</dt><dd>{{ props.address.street }}, {{ props.address.city }}</dd>",
					"<dt>repeater</dt><dd>{{ props.team.name }}</dd>",
					"</dl>",
				].join(""),
			},
			[
				"<Specimen",
				' words="Crusty &amp; warm"',
				' rich="<p>Hi <script>alert(1)</script><b>there</b></p>"',
				' price="3.5"',
				" open",
				' day="2026-03-02"',
				' size="large"',
				' sizes="small, large"',
				` more='{"url": "/about", "text": "About us"}'`,
				' plain="/menu"',
				' mail="Shop@Bakery.example"',
				` file="media:${leaflet.id}"`,
				` address='{"street": "1 Main St", "city": "Dublin"}'`,
				` team='[{"name": "Ada"}, {"name": "Grace"}]'`,
				" />",
			].join(""),
		);

		expect(main).toBe(
			[
				"<dl>",
				"<dt>text</dt><dd>Crusty &amp; warm</dd>",
				"<dt>rich</dt><dd><p>Hi <b>there</b></p></dd>",
				"<dt>number</dt><dd>3.50</dd>",
				"<dt>boolean</dt><dd>open</dd>",
				"<dt>date</dt><dd>2026-03-02</dd>",
				"<dt>select</dt><dd>Large (large)</dd>",
				"<dt>several</dt><dd>Small, Large</dd>",
				'<dt>link</dt><dd><a href="/about">About us</a> <a href="/menu">/menu</a></dd>',
				"<dt>email</dt><dd>shop@bakery.example</dd>",
				`<dt>file</dt><dd><a href="${fileUrl}">Allergens</a></dd>`,
				"<dt>group</dt><dd>1 Main St, Dublin</dd>",
				"<dt>repeater</dt><dd>Ada, Grace</dd>",
				"</dl>",
			].join(""),
		);
	});

	test("a media Prop on an <img> renders as a Media image, the page's first one loading eagerly", async () => {
		const { media } = await editor.api.media.upload({
			siteId,
			file: upload(await photo({ width: 80, height: 40 }), "loaf.jpg"),
		});
		expect((await install.drainJobs()).failed).toEqual([]);
		const original = (await editor.api.media.get({ siteId, mediaId: media.id })).media.url;

		const main = await rendered(
			{
				name: "Photo",
				props: [{ key: "image", label: "Image", type: "media" }],
				markup: '<figure><img src="{{ props.image }}" alt="A loaf"></figure>',
			},
			`<Photo image="media:${media.id}" />`,
		);

		// Smaller than the smallest variant: the cleaned original alone, sized, loading first.
		expect(main).toBe(
			`<figure><img src="${original}" alt="A loaf" width="80" height="40" loading="eager" fetchpriority="high"></figure>`,
		);
	});

	test("a Prop left out shows its default; true/false left out is false", async () => {
		const main = await rendered(
			{
				name: "Defaults",
				props: [
					{ key: "greeting", label: "Greeting", type: "text", default: "Hello" },
					{ key: "loud", label: "Loud", type: "boolean" },
					{ key: "times", label: "Times", type: "number", default: 2 },
				],
				markup: "<p>{{ props.greeting }} ×{{ props.times }}{{@if props.loud}}!{{/if}}</p>",
			},
			'<Defaults /><Defaults greeting="Hi" loud="true" times="3" /><Defaults loud="false" />',
		);

		expect(main).toBe("<p>Hello ×2</p><p>Hi ×3!</p><p>Hello ×2</p>");
	});

	test("that don't fit their Prop are refused when the Template is saved", async () => {
		const { component } = await staff.api.components.create({
			siteId,
			name: "Strict",
			props: [
				{ key: "address", label: "Address", type: "group", fields: [{ key: "city", label: "City", type: "text" }] },
				{
					key: "rows",
					label: "Rows",
					type: "repeater",
					max: 1,
					fields: [{ key: "n", label: "N", type: "number" }],
				},
				{ key: "when", label: "When", type: "date" },
				{ key: "more", label: "More", type: "link" },
			],
		});
		await staff.api.components.saveMarkup({ siteId, componentId: component.id, markup: "<p>{{ props.when }}</p>" });
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Strict kind",
			urlPattern: "/strict/{slug}",
		});

		await expect(
			staff.api.templates.saveEntryTemplateMarkup({
				siteId,
				postTypeId: postType.id,
				markup: [
					`<Strict address="Dublin" />`,
					`<Strict address='{"town": "Cork"}' />`,
					`<Strict rows='[{"n": "one"}]' />`,
					`<Strict rows='[{"n": 1}, {"n": 2}]' />`,
					`<Strict when="2 March" more="javascript:alert(1)" />`,
				].join("\n"),
			}),
		).rejects.toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: {
				problems: [
					{ line: 1, message: "address: a Group's value is written as JSON." },
					{ line: 2, message: "address: town: the Group has no Field named town." },
					{ line: 3, message: "rows: rows[0].n: A number value is a number." },
					{ line: 4, message: "rows: At most 1 rows." },
					{ line: 5, message: "when: Not a date written as 2026-03-02." },
					{ line: 5, message: "more: A link goes to an http, https, mailto or tel address, a path or an #anchor." },
				],
			},
		});
	});
});

describe("Prop values read where the Component is placed", () => {
	test("pass a value on as it is: a date stays a date, a Relationship keeps its parts", async () => {
		const { postType: topics } = await staff.api.postTypes.create({
			siteId,
			name: "Topics",
			key: "topics",
			urlPattern: "/topics/{slug}",
		});
		const { entry: bread } = await editor.api.entries.create({ siteId, postTypeId: topics.id, title: "Bread" });
		await editor.api.entries.publish({ siteId, entryId: bread.id });

		const main = await rendered(
			{
				name: "Byline",
				props: [
					{ key: "when", label: "When", type: "date" },
					{ key: "label", label: "Label", type: "text" },
					{ key: "topic", label: "Topic", type: "relationship", postTypes: ["topics"] },
				],
				markup:
					'<p>{{ props.when | date: long }} · {{ props.label }} · <a href="{{ props.topic.url }}">{{ props.topic.title }}</a></p>',
			},
			'<Byline when="{{ publishedAt }}" label="By {{ title }} on {{ publishedAt | date: iso }}" topic="{{ category }}" />',
			{
				title: "Loaves & <fishes>",
				fields: [{ key: "category", label: "Category", type: "relationship", postTypes: ["topics"] }],
				values: { category: bread.id },
			},
		);

		expect(main).toBe(
			'<p>April 5, 2026 · By Loaves &amp; &lt;fishes&gt; on 2026-04-05 · <a href="/topics/bread">Bread</a></p>',
		);
	});

	test("Relationship Props written as Entry ids show those published Entries of their Post Types", async () => {
		const { postType: shops } = await staff.api.postTypes.create({
			siteId,
			name: "Shops",
			key: "shops",
			urlPattern: "/shops/{slug}",
		});
		const { entry: open } = await editor.api.entries.create({ siteId, postTypeId: shops.id, title: "Market Street" });
		await editor.api.entries.publish({ siteId, entryId: open.id });
		const { entry: soon } = await editor.api.entries.create({ siteId, postTypeId: shops.id, title: "Harbour" });

		const main = await rendered(
			{
				name: "ShopList",
				props: [{ key: "shops", label: "Shops", type: "relationship", postTypes: ["shops"], multiple: true }],
				markup: "<p>{{ props.shops.title }} ({{ props.shops.url }})</p>",
			},
			`<ShopList shops="${open.id}, ${soon.id}" />`,
		);

		expect(main).toBe("<p>Market Street (/shops/market-street)</p>");
	});

	test("are escaped for where they land, and unsafe addresses never reach the page", async () => {
		const main = await rendered(
			{
				name: "Risky",
				props: [
					{ key: "heading", label: "Heading", type: "text" },
					{ key: "target", label: "Target", type: "text" },
				],
				markup: '<a href="{{ props.target }}" title="{{ props.heading }}">{{ props.heading }}</a>',
			},
			'<Risky heading="{{ title }}" target="javascript:alert(1)" />',
			{ title: '"><script>alert(1)</script>' },
		);

		expect(main).toBe(
			'<a href="#" title="&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;">"&gt;&lt;script&gt;alert(1)&lt;/script&gt;</a>',
		);
	});
});
