import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
beforeAll(async () => {
	install = await createTestInstall();
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "extra-blocks", version: "1.0.0" });
	const workspace = await install.createWorkspace("Extra blocks");
	siteId = (await install.createSite(workspace.id, { slug: "extra" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	editor = (await install.createMember({ workspaceId: workspace.id, role: "editor" })).browser;
});
afterAll(async () => {
	await install?.close();
});

test("Staff allow declarative Module Blocks per Post Type; editors fill existing Fields and visitors get semantic markup", async () => {
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Stories",
		key: "stories",
		urlPattern: "/stories/{slug}",
		fields: [{ key: "body", label: "Body", type: "body" }],
	});
	expect((await editor.api.entries.bodyComponents({ siteId, postTypeId: postType.id })).components).toEqual([]);
	await staff.api.postTypes.update({
		siteId,
		postTypeId: postType.id,
		fields: [{ key: "body", label: "Body", type: "body", components: ["extra-blocks:Accordion"] }],
	});
	expect((await editor.api.entries.bodyComponents({ siteId, postTypeId: postType.id })).components).toMatchObject([
		{ id: "extra-blocks:Accordion", props: [{ key: "items", type: "repeater" }] },
	]);
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Questions",
		bodyFormat: "markdown",
		fields: {
			body: '<Accordion items="[{&quot;heading&quot;:&quot;Delivery?&quot;,&quot;text&quot;:&quot;Every day.&quot;}]" />',
		},
	});
	expect(entry.problems).toEqual([]);
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article>{{ body }}</article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	const html = await expectSafePage(await install.request("https://extra.live.test/stories/questions"));
	expect(html).toContain("<summary>Delivery?</summary>");
	expect(html).toContain("Every day.");
	expect(html).not.toContain('data-wc-module="extra-blocks"');
});

test("all four types are reusable Components; scripts are same-origin and used only on rendered pages", async () => {
	const { components } = await staff.api.components.list({ siteId });
	expect(
		components
			.filter((c) => c.module?.id === "extra-blocks")
			.map((c) => c.name)
			.sort(),
	).toEqual(["Accordion", "Gallery", "MapEmbed", "Tabs"]);
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Views",
		key: "views",
		urlPattern: "/views/{slug}",
		fields: [{ key: "showTabs", label: "Show tabs", type: "boolean" }],
	});
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup:
			'<Tabs label="Details" items="[{&quot;heading&quot;:&quot;First&quot;,&quot;text&quot;:&quot;First panel&quot;},{&quot;heading&quot;:&quot;Second&quot;,&quot;text&quot;:&quot;Second panel&quot;}]" />',
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Panels" });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	const response = await install.request("https://extra.live.test/views/panels");
	const html = await expectSafePage(response);
	expect(html).toContain("First panel");
	expect(html).toContain("Second panel");
	expect(html).toContain('<template data-wc-consent="media">');
	expect(html).toMatch(/src="\/_wc\/js\/[a-f0-9]{16}\.js" defer data-wc-module="extra-blocks"/);
	const { template: hidden } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '{{@if showTabs}}<Tabs label="Conditional" />{{/if}}<p>No visible Blocks</p>',
	});
	await staff.api.templates.publish({ siteId, templateId: hidden.id });
	const conditional = await expectSafePage(await install.request("https://extra.live.test/views/panels"));
	expect(conditional).not.toContain('data-wc-module="extra-blocks"');
	const { component: nested } = await staff.api.components.create({ siteId, name: "DetailsCard" });
	await staff.api.components.saveMarkup({
		siteId,
		componentId: nested.id,
		markup:
			'<Tabs label="Nested" items="[{&quot;heading&quot;:&quot;Nested heading&quot;,&quot;text&quot;:&quot;Nested text&quot;}]" />',
	});
	await staff.api.components.publish({ siteId, componentId: nested.id });
	const { template: nestedTemplate } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<DetailsCard />",
	});
	await staff.api.templates.publish({ siteId, templateId: nestedTemplate.id });
	const withNested = await expectSafePage(await install.request("https://extra.live.test/views/panels"));
	expect(withNested).toContain("Nested text");
	expect(withNested).toContain('data-wc-module="extra-blocks"');
	const { template: plain } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<p>No Blocks here</p>",
	});
	await staff.api.templates.publish({ siteId, templateId: plain.id });
	const empty = await expectSafePage(await install.request("https://extra.live.test/views/panels"));
	expect(empty).not.toContain('data-wc-module="extra-blocks"');
});

test("automatic translation sends human Block text, keeps settings and references, and tracks source.was", async () => {
	const { translatedSite } = await import("../translation/support.ts");
	const site = await translatedSite(install, { it: "automatic" });
	await site.staff.api.postTypes.update({
		siteId: site.siteId,
		postTypeId: site.postTypeId,
		fields: [
			{ key: "body", label: "Body", type: "body", components: ["extra-blocks:Accordion", "extra-blocks:MapEmbed"] },
		],
	});
	const blocks = [
		{
			id: "questions",
			type: "component",
			component: "extra-blocks:Accordion",
			props: [
				{
					name: "items",
					value: JSON.stringify([{ heading: "Delivery?", text: "<p>Every <strong>day</strong>.</p>" }]),
				},
			],
		},
		{
			id: "map",
			type: "component",
			component: "extra-blocks:MapEmbed",
			props: [
				{ name: "label", value: "Find us" },
				{ name: "url", value: "https://www.openstreetmap.org/export/embed.html?bbox=1,2,3,4" },
			],
		},
	];
	const { entry } = await site.editor.api.entries.create({
		siteId: site.siteId,
		postTypeId: site.postTypeId,
		title: "Directions",
		fields: { body: blocks },
	});
	await site.editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	expect((await install.drainJobs()).failed).toEqual([]);
	const read = (await site.editor.api.entries.get({ siteId: site.siteId, entryId: entry.id, language: "it" })).entry;
	const body = read.draft.fields.body as typeof blocks & { source?: unknown }[];
	expect(body[0]?.props[0]?.value).toContain("[it] Delivery?");
	expect(body[0]?.source).toMatchObject({ id: "questions", by: "ai", was: { component: "extra-blocks:Accordion" } });
	expect(body[1]?.props).toEqual([
		{ name: "label", value: "[it] Find us" },
		{ name: "url", value: "https://www.openstreetmap.org/export/embed.html?bbox=1,2,3,4" },
	]);
	const manual = {
		...body[0],
		props: [{ name: "items", value: JSON.stringify([{ heading: "Consegna?", text: "Ogni giorno." }]) }],
	};
	await site.editor.api.entries.saveDraft({
		siteId: site.siteId,
		entryId: entry.id,
		language: "it",
		fields: { body: [body[1], manual] },
	});
	const markdown = (
		await site.editor.api.entries.get({
			siteId: site.siteId,
			entryId: entry.id,
			language: "it",
			bodyFormat: "markdown",
		})
	).entry.draft.fields.body;
	await site.editor.api.entries.saveDraft({
		siteId: site.siteId,
		entryId: entry.id,
		language: "it",
		bodyFormat: "markdown",
		fields: { body: markdown },
	});
	await site.owner.api.entries.saveDraft({
		siteId: site.siteId,
		entryId: entry.id,
		fields: {
			body: [
				blocks[1],
				{
					...blocks[0],
					props: [{ name: "items", value: JSON.stringify([{ heading: "Weekend delivery?", text: "Only Saturday." }]) }],
				},
			],
		},
	});
	await site.owner.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	expect((await install.drainJobs()).failed).toEqual([]);
	const changed = (await site.editor.api.entries.get({ siteId: site.siteId, entryId: entry.id, language: "it" })).entry;
	const moved = changed.draft.fields.body as typeof body;
	expect(moved.map((block) => block.id)).toEqual(["map", "questions"]);
	expect(moved[1]?.props).toEqual(manual.props);
	expect(moved[1]?.source).toMatchObject({ id: "questions", by: "person", was: { props: blocks[0]?.props } });
	expect(changed.translation?.outdated.map((item) => ({ at: item.at, block: item.block }))).toEqual([
		{ at: "fields.body", block: "questions" },
	]);
});

test("an off Module's compiled declarations still translate stored text without running the Module", async () => {
	const { translatedSite } = await import("../translation/support.ts");
	const site = await translatedSite(install, { it: "automatic" });
	await site.staff.api.postTypes.update({
		siteId: site.siteId,
		postTypeId: site.postTypeId,
		fields: [{ key: "body", label: "Body", type: "body", components: ["extra-blocks:Tabs"] }],
	});
	const { entry } = await site.editor.api.entries.create({
		siteId: site.siteId,
		postTypeId: site.postTypeId,
		title: "Off translation",
		fields: {
			body: [
				{
					id: "tabs",
					type: "component",
					component: "extra-blocks:Tabs",
					props: [
						{ name: "label", value: "Details" },
						{ name: "items", value: JSON.stringify([{ heading: "First", text: "One" }]) },
					],
				},
			],
		},
	});
	await site.staff.api.modules.setOnSite({ siteId: site.siteId, moduleId: "extra-blocks", on: false });
	await site.editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	expect((await install.drainJobs()).failed).toEqual([]);
	const translated = (await site.editor.api.entries.get({ siteId: site.siteId, entryId: entry.id, language: "it" }))
		.entry;
	expect(JSON.stringify(translated.draft.fields.body)).toContain("[it] Details");
});

test("turning the Module off preserves existing Blocks while refusing new or changed unavailable Blocks", async () => {
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Off",
		key: "off",
		urlPattern: "/off/{slug}",
		fields: [{ key: "body", label: "Body", type: "body", components: ["extra-blocks:Accordion"] }],
	});
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Kept",
		fields: { body: [{ id: "kept", type: "component", component: "extra-blocks:Accordion", props: [] }] },
	});
	await staff.api.modules.setOnSite({ siteId, moduleId: "extra-blocks", on: false });
	try {
		expect((await editor.api.entries.bodyComponents({ siteId, postTypeId: postType.id })).components).toEqual([]);
		const saved = await editor.api.entries.saveDraft({
			siteId,
			entryId: entry.id,
			fields: { body: [{ type: "paragraph", text: "Still editable" }, ...(entry.draft.fields.body as unknown[])] },
		});
		expect(saved.entry.problems).toEqual([]);
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		await expect(
			editor.api.entries.create({
				siteId,
				postTypeId: postType.id,
				title: "Refused",
				fields: { body: [{ type: "component", component: "extra-blocks:Accordion", props: [] }] },
			}),
		).rejects.toMatchObject({ code: "ENTRY_INVALID" });
	} finally {
		await staff.api.modules.setOnSite({ siteId, moduleId: "extra-blocks", on: true });
	}
});

test("Gallery validates real Media references and keeps per-placement alt/Decorative in Checks and Markdown", async () => {
	const { photo, upload } = await import("../harness/images.ts");
	const { media } = await staff.api.media.upload({
		siteId,
		file: upload(await photo({ width: 40, height: 30 }), "gallery.jpg"),
	});
	await install.drainJobs();
	const url = (await staff.api.media.get({ siteId, mediaId: media.id })).media.url;
	expect(url).not.toBeNull();
	const otherWorkspace = await install.createWorkspace("Other client");
	const otherSite = await install.createSite(otherWorkspace.id, { slug: "foreign-extra" });
	const admin = await install.superadmin();
	const { media: foreign } = await admin.api.media.upload({
		siteId: otherSite.id,
		file: upload(await photo({ width: 40, height: 30 }), "private.jpg"),
	});
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Gallery",
		key: "gallery",
		urlPattern: "/gallery/{slug}",
		fields: [{ key: "body", label: "Body", type: "body", components: ["extra-blocks:Gallery"] }],
	});
	const block = (image: string) => ({
		id: "gallery",
		type: "component",
		component: "extra-blocks:Gallery",
		props: [
			{
				name: "images",
				value: JSON.stringify([
					{ image, alt: "Bread", caption: "Morning", decorative: false },
					{ image, alt: "", caption: "", decorative: true },
					{ image, alt: "", caption: "", decorative: false },
				]),
			},
		],
	});
	await expect(
		editor.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Foreign",
			fields: { body: [block(foreign.id)] },
		}),
	).rejects.toMatchObject({ code: "ENTRY_INVALID" });
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Morning",
		fields: { body: [block(media.id)] },
	});
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1>{{ body }}</article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const checks = await editor.api.checks.entry({ siteId, entryId: entry.id });
	expect(checks.checks.filter((c) => c.check === "missingAlt")).toHaveLength(1);
	const markdown = (await editor.api.entries.get({ siteId, entryId: entry.id, bodyFormat: "markdown" })).entry.draft
		.fields.body;
	const saved = await editor.api.entries.saveDraft({
		siteId,
		entryId: entry.id,
		bodyFormat: "markdown",
		fields: { body: markdown },
	});
	expect(saved.entry.draft.fields.body).toEqual(entry.draft.fields.body);
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	const html = await expectSafePage(await install.request("https://extra.live.test/gallery/morning"));
	expect(html).toContain('alt="Bread"');
	expect(html).toContain('alt=""');
	expect(html).toContain("Morning</figcaption>");
	expect(html).toContain(`src="${url}"`);
	// A reusable Gallery can carry fixed JSON Media Props without an Entry Field binding.
	const { template: fixed } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<Gallery images='${JSON.stringify([{ image: media.id, alt: "Fixed gallery", decorative: false, caption: "Fixed" }])}' />`,
	});
	await staff.api.templates.publish({ siteId, templateId: fixed.id });
	const fixedHtml = await expectSafePage(await install.request("https://extra.live.test/gallery/morning"));
	expect(fixedHtml).toContain(`src="${url}"`);
	expect(fixedHtml).toContain('alt="Fixed gallery"');
});

test("maps use the declared host, script assets carry Site headers, and Edit/Code/Safe modes never run the Module script", async () => {
	const { expectSiteHeaders, policyOf } = await import("../harness/site-safety.ts");
	const { openEditMode } = await import("../harness/edit-mode.ts");
	const { openCodeMode } = await import("../harness/code-mode.ts");
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Maps",
		key: "maps",
		urlPattern: "/maps/{slug}",
		fields: [{ key: "body", label: "Body", type: "body", components: ["extra-blocks:MapEmbed"] }],
	});
	const block = (url: string) => ({
		type: "component",
		component: "extra-blocks:MapEmbed",
		props: [
			{ name: "label", value: "Find us" },
			{ name: "url", value: url },
		],
	});
	await expect(
		editor.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: "Bad",
			fields: { body: [block("https://evil.test/map")] },
		}),
	).rejects.toMatchObject({ code: "ENTRY_INVALID" });
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Visit",
		fields: { body: [block("https://www.openstreetmap.org/export/embed.html?bbox=1,2,3,4")] },
	});
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1>{{ body }}</article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	const path = "/maps/visit";
	const response = await install.request(`https://extra.live.test${path}`);
	const html = await expectSafePage(response);
	expect(policyOf(response).get("frame-src")).toContain("https://www.openstreetmap.org");
	expect(html).not.toContain("<iframe");
	const src = /<script src="([^"]+)" defer data-wc-module="extra-blocks"/.exec(html)?.[1] ?? "";
	const asset = await install.request(`https://extra.live.test${src}`);
	expectSiteHeaders(asset);
	expect(asset.status).toBe(200);
	expect(await asset.text()).toContain('createElement("iframe")');
	for (const safeMode of [false, true]) {
		const editing = await openEditMode(install, staff, siteId, path, { safeMode });
		const page = await expectSafePage(await editing.page(path), "editMode");
		expect(page).not.toContain('data-wc-module="extra-blocks"');
	}
	const coding = await openCodeMode(install, staff, siteId, path);
	expect(await expectSafePage(await coding.page(path), "editMode")).not.toContain('data-wc-module="extra-blocks"');
	await staff.api.modules.setOnSite({ siteId, moduleId: "extra-blocks", on: false });
	try {
		const gone = await install.request(`https://extra.live.test${src}`);
		expectSiteHeaders(gone);
		expect(gone.status).toBe(404);
		expect(await expectSafePage(await install.request(`https://extra.live.test${path}`))).not.toContain(
			'data-wc-module="extra-blocks"',
		);
	} finally {
		await staff.api.modules.setOnSite({ siteId, moduleId: "extra-blocks", on: true });
	}
});

test("API tokens retain Content permissions, tenant isolation and authoritative Block allowances", async () => {
	const { createApiToken, tokenClient } = await import("../harness/api-tokens.ts");
	const workspace = await install.createWorkspace("Token Blocks");
	const site = await install.createSite(workspace.id, { slug: "token-extra" });
	const admin = await install.superadmin();
	const { postType } = await admin.api.postTypes.create({
		siteId: site.id,
		name: "Stories",
		urlPattern: "/stories/{slug}",
		fields: [{ key: "body", label: "Body", type: "body", components: ["extra-blocks:Accordion"] }],
	});
	const author = await install.createMember({ workspaceId: workspace.id, role: "author" });
	const { secret } = await createApiToken(author.browser, {
		workspaceId: workspace.id,
		name: "Writer",
		toolsets: ["content", "structure"],
	});
	const token = tokenClient(install, secret);
	const input = {
		siteId: site.id,
		postTypeId: postType.id,
		title: "Allowed",
		fields: { body: [{ type: "component", component: "extra-blocks:Accordion", props: [] }] },
	};
	expect((await token.api.entries.create(input)).entry.draft.title).toBe("Allowed");
	await expect(
		token.api.postTypes.update({ siteId: site.id, postTypeId: postType.id, fields: [] }),
	).rejects.toMatchObject({ status: 403 });
	await expect(
		token.api.entries.create({
			...input,
			fields: { body: [{ type: "component", component: "extra-blocks:Gallery", props: [] }] },
		}),
	).rejects.toMatchObject({ code: "ENTRY_INVALID" });
	await expect(token.api.entries.create({ ...input, siteId })).rejects.toMatchObject({ status: 404 });
});

test("Gallery translation changes alt and captions while keeping Media references and Decorative settings", async () => {
	const { translatedSite } = await import("../translation/support.ts");
	const { photo, upload } = await import("../harness/images.ts");
	const site = await translatedSite(install, { it: "automatic" });
	await site.staff.api.postTypes.update({
		siteId: site.siteId,
		postTypeId: site.postTypeId,
		fields: [{ key: "body", label: "Body", type: "body", components: ["extra-blocks:Gallery"] }],
	});
	const { media } = await site.staff.api.media.upload({
		siteId: site.siteId,
		file: upload(await photo({ width: 30, height: 20 }), "gallery.jpg"),
	});
	const { entry } = await site.editor.api.entries.create({
		siteId: site.siteId,
		postTypeId: site.postTypeId,
		title: "Fresh",
		fields: {
			body: [
				{
					id: "photos",
					type: "component",
					component: "extra-blocks:Gallery",
					props: [
						{
							name: "images",
							value: JSON.stringify([{ image: media.id, alt: "Fresh bread", caption: "Morning", decorative: true }]),
						},
					],
				},
			],
		},
	});
	await site.editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	expect((await install.drainJobs()).failed).toEqual([]);
	const translated = (await site.editor.api.entries.get({ siteId: site.siteId, entryId: entry.id, language: "it" }))
		.entry;
	const body = translated.draft.fields.body as {
		id: string;
		props: { name: string; value: string }[];
		source: unknown;
	}[];
	expect(JSON.parse(body[0]?.props[0]?.value ?? "[]")).toEqual([
		{ image: media.id, alt: "[it] Fresh bread", caption: "[it] Morning", decorative: true },
	]);
	expect(body[0]).toMatchObject({ id: "photos", source: { id: "photos", by: "ai" } });
});
