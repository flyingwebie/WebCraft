import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
beforeAll(async () => {
	install = await createTestInstall();
	const workspace = await install.createWorkspace();
	siteId = (await install.createSite(workspace.id)).id;
	staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
});
afterAll(async () => {
	await install.close();
});

test("Checks collect composed Draft pages, fragments and SEO warnings, clear after fixes, and never block publishing", async () => {
	await staff.api.seoSettings.update({ siteId, socialCards: { enabled: false } });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Articles",
		key: "articles",
		urlPattern: "/articles/{slug}",
		fields: [{ key: "body", label: "Body", type: "body" }],
	});
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup:
			'<h1>{{ title }}</h1><h1>Again</h1><h3>Skipped</h3><img src="https://example.com/a.jpg"><a href="/">Read more</a><span role="button" tabindex="0"></span>{{ body }}',
	});
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Article",
		fields: {
			body: [
				{ type: "table", rows: [["Name"], ["Bread"]], headerRow: false },
				{ type: "video", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "" },
			],
		},
	});
	const result = await staff.api.checks.list({ siteId });
	const checks = result.checks.filter((c) => c.item.id === entry.id);
	expect(checks.map((c) => c.check)).toEqual(
		expect.arrayContaining([
			"multipleH1",
			"skippedHeading",
			"missingAlt",
			"vagueLink",
			"emptyButton",
			"tableHeader",
			"untitledVideo",
			"seoImageMissing",
		]),
	);
	expect(checks.some((c) => c.check === "missingMain" || c.check === "missingLanguage")).toBe(false);
	expect(checks.every((c) => c.href.startsWith(`/sites/${siteId}/`) || c.href.startsWith(`/builder/${siteId}/`))).toBe(
		true,
	);
	await staff.api.templates.publish({ siteId, templateId: template.id });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup:
			'<h1>{{ title }}</h1><h2>Details</h2><img src="https://example.com/a.jpg" data-wc-decorative><a href="/">Our products</a><span role="button" tabindex="0">Save changes</span>',
	});
	await staff.api.entries.saveDraft({ siteId, entryId: entry.id, fields: { body: [] } });
	expect(
		(await staff.api.checks.list({ siteId })).checks.filter(
			(c) => c.item.id === entry.id && !c.check.startsWith("seo"),
		),
	).toEqual([]);
	const { component } = await staff.api.components.create({ siteId, name: "Fragment", props: [] });
	await staff.api.components.saveMarkup({ siteId, componentId: component.id, markup: "<p>Reusable text</p>" });
	expect((await staff.api.checks.list({ siteId })).checks.filter((c) => c.item.id === component.id)).toEqual([]);
});

test("Code mode checks the unsaved composition without adding check markup to the page", async () => {
	const { openCodeMode } = await import("../harness/code-mode.ts");
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Previews",
		key: "previews",
		urlPattern: "/previews/{slug}",
	});
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Preview" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	const coding = await openCodeMode(install, staff, siteId, "/previews/preview");
	const response = await coding.edit("code/preview", {
		path: "/previews/preview",
		markup: {
			ref: "content",
			text: '<h1>Title</h1><h3 data-wc-id="skip">Skipped</h3><img src="https://example.com/a.jpg" data-wc-decorative>',
		},
	});
	expect(response.status).toBe(200);
	const result = (await response.json()) as { html: string; checks: { check: string; at: string; detail?: string }[] };
	expect(result.checks).toContainEqual({ check: "skippedHeading", at: "content#skip", detail: "H1 → H3" });
	expect(result.checks.some((c) => c.check === "missingAlt")).toBe(false);
	expect(result.html).not.toContain("data-wc-decorative");
	expect(result.html).not.toContain("data-wc-check");
});

test("all rules use resolved Props and composed Body headings; reusable fragments have no document requirements", async () => {
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Composition",
		key: "composition",
		urlPattern: "/composition/{slug}",
		fields: [
			{ key: "body", label: "Body", type: "body" },
			{ key: "label", label: "Label", type: "text" },
		],
	});
	const { component } = await staff.api.components.create({ siteId, name: "SectionHeading", props: [] });
	await staff.api.components.saveMarkup({ siteId, componentId: component.id, markup: "<h2>Section</h2>" });
	await staff.api.components.publish({ siteId, componentId: component.id });
	await staff.api.postTypes.update({
		siteId,
		postTypeId: postType.id,
		fields: [
			{ key: "body", label: "Body", type: "body", components: [component.id] },
			{ key: "label", label: "Label", type: "text" },
		],
	});
	await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup:
			'<h1>{{ title }}</h1>{{ body }}<p lang="">Language</p><a href="/">{{ label }}</a><span role="button">Read more</span><table><tbody><tr><td>No header</td></tr></tbody></table><video src="https://example.com/movie.mp4"></video>',
	});
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Composed",
		fields: {
			body: [
				{ type: "component", component: component.id, props: [] },
				{ type: "heading", level: 3, text: "Detail" },
			],
			label: "",
		},
	});
	const report = await staff.api.checks.entry({ siteId, entryId: entry.id });
	expect(report.checks.map((c) => c.check)).toEqual(
		expect.arrayContaining(["missingLanguage", "vagueLink", "vagueButton", "tableHeader", "untitledVideo"]),
	);
	expect(report.checks.filter((c) => c.check === "skippedHeading")).toEqual([]);
	const opened = await staff.api.builder.open({ siteId, target: { kind: "entryTemplate", postTypeId: postType.id } });
	const preview = await staff.api.builder.preview({
		siteId,
		target: { kind: "entryTemplate", postTypeId: postType.id },
		tree: opened.tree,
	});
	expect(preview.checks.map((c) => c.check)).toContain("vagueLink");
	expect(preview.checks.some((c) => c.check === "skippedHeading")).toBe(false);
	expect(preview.html).not.toContain("data-wc-body");
	await staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<h4 data-wc-id="deep">Skipped section</h4>',
	});
	const changed = (await staff.api.checks.entry({ siteId, entryId: entry.id })).checks.find(
		(c) => c.componentId === component.id,
	);
	expect(changed?.check).toBe("skippedHeading");
	expect(changed?.href).toBe(`/builder/${siteId}/component/${component.id}?element=deep`);
	const simple = await staff.api.components.create({ siteId, name: "Rules", props: [] });
	await staff.api.components.saveMarkup({
		siteId,
		componentId: simple.component.id,
		markup:
			'<img src="https://example.com/a.jpg"><a href="/"></a><span role="button"></span><table><tbody><tr><td>No header</td></tr></tbody></table><video src="https://example.com/movie.mp4"></video>',
	});
	const source = await staff.api.builder.open({
		siteId,
		target: { kind: "component", componentId: simple.component.id },
	});
	const fragment = await staff.api.builder.preview({
		siteId,
		target: { kind: "component", componentId: simple.component.id },
		tree: source.tree,
	});
	expect(fragment.checks.map((c) => c.check)).toEqual(
		expect.arrayContaining(["missingAlt", "vagueLink", "emptyButton", "tableHeader", "untitledVideo"]),
	);
	expect(fragment.checks.some((c) => c.check === "missingH1" || c.check === "missingMain")).toBe(false);
	await staff.api.templates.saveSiteTemplateMarkup({ siteId, markup: '<main aria-hidden="true">{{@outlet}}</main>' });
	await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: postType.id, markup: "<p>{{ title }}</p>" });
	const missing = await staff.api.checks.entry({ siteId, entryId: entry.id });
	expect(missing.checks.map((c) => c.check)).toEqual(expect.arrayContaining(["missingH1", "missingMain"]));
	await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: '<main>{{@outlet}}</main><div role="main">Another</div>',
	});
	expect((await staff.api.checks.entry({ siteId, entryId: entry.id })).checks.map((c) => c.check)).toContain(
		"multipleMain",
	);
});

test("Checks and statement settings stay inside their Site, and only Staff can generate the statement", async () => {
	const workspace = await install.createWorkspace("Other workspace");
	const otherSite = (await install.createSite(workspace.id)).id;
	const owner = (await install.createMember({ workspaceId: workspace.id, role: "owner" })).browser;
	const otherStaff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	await expect(staff.api.checks.list({ siteId: otherSite })).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
	await expect(staff.api.accessibilityStatement.get({ siteId: otherSite })).rejects.toMatchObject({
		code: "SITE_NOT_FOUND",
	});
	await expect(owner.api.accessibilityStatement.get({ siteId: otherSite })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});
	await expect(owner.api.accessibilityStatement.setEnabled({ siteId: otherSite, enabled: true })).rejects.toMatchObject(
		{ code: "FORBIDDEN" },
	);
	const { postType } = await otherStaff.api.postTypes.create({
		siteId: otherSite,
		name: "Other",
		urlPattern: "/other/{slug}",
	});
	const { entry } = await otherStaff.api.entries.create({
		siteId: otherSite,
		postTypeId: postType.id,
		title: "Private entry",
	});
	await expect(staff.api.checks.entry({ siteId, entryId: entry.id })).rejects.toMatchObject({
		code: "ENTRY_NOT_FOUND",
	});
	expect((await otherStaff.api.accessibilityStatement.get({ siteId: otherSite })).settings).toBeNull();
	expect(
		(await owner.api.checks.list({ siteId: otherSite })).checks.every(
			(c) => c.item.kind === "entry" && c.href.startsWith(`/sites/${otherSite}/`),
		),
	).toBe(true);
});

test("the Site list reuses the Design system’s contrast results and clears fixed pairs", async () => {
	const { designSystem } = await staff.api.designSystem.get({ siteId });
	const original = designSystem.draft.tokens;
	const tokens = {
		...original,
		colours: [
			...original.colours,
			{
				name: "low-contrast",
				light: { base: "#949494", steps: { "10": "#ffffff", "95": "#777777" } },
				dark: { base: null, steps: {} },
			},
		],
	};
	await staff.api.designSystem.saveDraft({ siteId, tokens });
	const expected = (await staff.api.designSystem.preview({ siteId })).preview.contrast.filter((c) => !c.passes);
	const checks = (await staff.api.checks.list({ siteId })).checks.filter((c) => c.check === "contrast");
	expect(checks).toHaveLength(expected.length);
	expect(checks).toContainEqual(
		expect.objectContaining({
			params: { ratio: 4.47, required: 4.5 },
			href: `/sites/${siteId}/design-system?tab=tokens`,
		}),
	);
	await staff.api.designSystem.saveDraft({ siteId, tokens: original });
	expect((await staff.api.checks.list({ siteId })).checks.filter((c) => c.detail?.includes("low-contrast"))).toEqual(
		[],
	);
});

test("Search and Archive Checks use the whole page and link to the template that owns the warning", async () => {
	const workspace = await install.createWorkspace();
	const localSite = (await install.createSite(workspace.id)).id;
	const { api } = await install.superadmin();
	const pages = (await api.postTypes.list({ siteId: localSite })).postTypes.find((p) => p.builtIn === "page");
	const search = await api.entries.create({ siteId: localSite, postTypeId: pages?.id ?? "", title: "Search" });
	await api.entries.publish({ siteId: localSite, entryId: search.entry.id });
	await api.pages.setSearchPage({ siteId: localSite, pageId: search.entry.id });
	const report = await api.checks.entry({ siteId: localSite, entryId: search.entry.id });
	expect(report.checks.some((c) => c.check === "missingH1" || c.check === "missingMain")).toBe(false);
	await api.templates.saveSearchTemplateMarkup({ siteId: localSite, markup: "<p>Search the site</p>{{@search}}" });
	const missing = (await api.checks.entry({ siteId: localSite, entryId: search.entry.id })).checks.find(
		(c) => c.check === "missingH1",
	);
	expect(missing?.href).toBe(`/builder/${localSite}/search-template`);
	const { postType } = await api.postTypes.create({
		siteId: localSite,
		name: "Recipes",
		urlPattern: "/recipes/{slug}",
	});
	const archive = await api.templates.saveArchiveTemplateMarkup({
		siteId: localSite,
		postTypeId: postType.id,
		markup: "<p>Recipes</p>",
	});
	const list = await api.checks.list({ siteId: localSite });
	expect(list.checks).toContainEqual(
		expect.objectContaining({
			check: "missingH1",
			item: expect.objectContaining({ id: archive.template.id }),
			href: `/builder/${localSite}/archive-template/${postType.id}`,
		}),
	);
	await api.templates.saveArchiveTemplateMarkup({
		siteId: localSite,
		postTypeId: postType.id,
		markup: "<h1>Recipes</h1>",
	});
	expect(
		(await api.checks.list({ siteId: localSite })).checks.filter((c) => c.item.id === archive.template.id),
	).toEqual([]);
});

test("fragment Checks distinguish unfilled Props from empty placements and locate extra H1s", async () => {
	const { component } = await staff.api.components.create({
		siteId,
		name: "ActionLink",
		props: [{ key: "label", label: "Label", type: "text" }],
	});
	await staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<a data-wc-id="action" href="/">{{ props.label }}</a>',
	});
	const preview = async () => {
		const target = { kind: "component" as const, componentId: component.id };
		const { tree } = await staff.api.builder.open({ siteId, target });
		return staff.api.builder.preview({ siteId, target, tree });
	};
	expect((await preview()).checks).toEqual([]);
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Actions", urlPattern: "/actions/{slug}" });
	await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<h1>{{ title }}</h1><ActionLink label="" />',
	});
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Choose" });
	expect((await staff.api.checks.entry({ siteId, entryId: entry.id })).checks).toContainEqual(
		expect.objectContaining({
			check: "vagueLink",
			componentId: component.id,
			href: `/builder/${siteId}/component/${component.id}?element=action`,
		}),
	);
	await staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<h1>First</h1><h1 data-wc-id="extra">Second</h1>',
	});
	expect((await preview()).checks).toContainEqual({ check: "multipleH1", at: "b#extra" });
	await staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup:
			'<span id="name" hidden>Watch our introduction</span><video src="https://example.com/v.mp4" aria-labelledby="name"></video><a href="/" aria-labelledby="name"></a><p lang="it"><a href="/">clicca qui</a></p><span role="button"></span>',
	});
	const checks = (await preview()).checks;
	expect(checks.filter((c) => c.check === "untitledVideo")).toEqual([]);
	expect(checks.filter((c) => c.check === "vagueLink").map((c) => c.detail)).toEqual(["clicca qui"]);
	expect(checks.map((c) => c.check)).toContain("emptyButton");
});

test("the Site Check collection preserves a planned Social card instead of reporting a fabricated missing Media image", async () => {
	const workspace = await install.createWorkspace();
	const localSite = (await install.createSite(workspace.id)).id;
	const { api } = await install.superadmin();
	const { postType } = await api.postTypes.create({
		siteId: localSite,
		name: "Social stories",
		urlPattern: "/social/{slug}",
	});
	const { entry } = await api.entries.create({ siteId: localSite, postTypeId: postType.id, title: "A story" });
	expect(entry.seoPreview.image).toMatchObject({ from: "socialCard", state: "onPublish" });
	expect(entry.seoPreview.image).not.toHaveProperty("mediaId");
	const checks = (await api.checks.list({ siteId: localSite })).checks.filter((c) => c.item.id === entry.id);
	expect(checks.filter((c) => c.check === "seoImageMissing" || c.check === "seoImageAlt")).toEqual([]);
	await api.seoSettings.update({ siteId: localSite, socialCards: { enabled: false } });
	expect((await api.checks.entry({ siteId: localSite, entryId: entry.id })).checks.map((c) => c.check)).toContain(
		"seoImageMissing",
	);
});
