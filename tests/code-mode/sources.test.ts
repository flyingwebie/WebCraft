// Selecting an element in Code mode opens the whole Template or Component it comes from as Template
// markup, scrolled to the element (ADR 0016, and the decision on how Code mode maps back to data):
// inside a placed Component, that Component, with a breadcrumb to step out to the Templates and
// Components placing it, and the "used on N pages" warning. The panel suggests what the markup may
// read and place: Fields, Globals, Props, Components, Template commands, presets and Classes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { answer, openCodeMode } from "../harness/code-mode.ts";
import type { EditModeBrowser } from "../harness/edit-mode.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;
const path = "/blog/fresh-bread";

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

/** What opening a source in Code mode answers. */
type Source = {
	source: { kind: string; id: string | null; name: string | null; editable: boolean };
	ref: string;
	markup: string;
	version: string | null;
	element: { id: string; tag: string } | null;
	breadcrumb: { label: string | null; kind: string; ref: string }[];
	path: { id: string; label: string }[];
	usage: { pages: number } | null;
	suggestions: {
		values: { path: string; label: string | null; type: string; group: string; sample?: string }[];
		components: { name: string; props: { key: string; label: string; required: boolean }[] }[];
		commands: { name: string; block: boolean; snippet: string }[];
		presets: { id: string; snippet: string }[];
		loops: unknown[];
		classes: { name: string; utility: boolean }[];
	};
};

let sites = 0;

/**
 * A Site whose published Blog post shows a Strap Component, which places a Badge Component, all
 * published, so every page of the Post Type shows both.
 */
async function bakery(options: { siteTemplate?: boolean } = {}) {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await staff.api.globals.setFields({
		siteId,
		fields: [
			{ key: "tagline", label: "Tagline", type: "text" },
			{ key: "address", label: "Address", type: "group", fields: [{ key: "city", label: "City", type: "text" }] },
		],
	});
	await editor.api.globals.saveDraft({ siteId, fields: { tagline: "Baked daily", address: { city: "Cork" } } });
	await editor.api.globals.publish({ siteId });
	if (options.siteTemplate !== false) {
		const site = await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup:
				'<header data-wc-id="header"><p data-wc-id="tagline">{{ site.tagline }}</p></header><main data-wc-id="main">{{@outlet}}</main>',
		});
		await staff.api.templates.publish({ siteId, templateId: site.template.id });
	}
	await staff.api.designSystem.createClass({ siteId, name: "badge" });
	const badge = await staff.api.components.create({
		siteId,
		name: "Badge",
		props: [{ key: "text", label: "Text", type: "text", required: true }],
	});
	await staff.api.components.saveMarkup({
		siteId,
		componentId: badge.component.id,
		markup: '<span class="badge" data-wc-id="badge">{{ props.text }}</span>',
	});
	await staff.api.components.publish({ siteId, componentId: badge.component.id });
	const strap = await staff.api.components.create({
		siteId,
		name: "Strap",
		props: [{ key: "heading", label: "Heading", type: "text" }],
	});
	await staff.api.components.saveMarkup({
		siteId,
		componentId: strap.component.id,
		markup:
			'<div data-wc-id="strap"><h2 data-wc-id="heading">{{ props.heading }}</h2><Badge text="New" data-wc-id="badged" /></div>',
	});
	await staff.api.components.publish({ siteId, componentId: strap.component.id });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "subtitle", label: "Subtitle", type: "text" },
			{ key: "link", label: "Read more", type: "link" },
		],
	});
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup:
			'<article data-wc-id="article">\n  <h1 data-wc-id="title">{{ title }}</h1>\n  <Strap heading="{{ subtitle }}" data-wc-id="placed" />\n</article>',
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	for (const title of ["Fresh bread", "Rye loaves", "Spelt rolls"]) {
		const { entry } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title });
		await editor.api.entries.publish({ siteId, entryId: entry.id });
	}
	return {
		siteId,
		postTypeId: postType.id,
		templateId: template.template.id,
		strapId: strap.component.id,
		badgeId: badge.component.id,
	};
}

describe("opening the Template an element comes from", () => {
	let site: Awaited<ReturnType<typeof bakery>>;
	let coding: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		coding = await openCodeMode(install, staff, site.siteId, path);
	});

	test("opens the page's Entry template as Template markup, at the element, with its version", async () => {
		const opened = await answer<Source>(coding.edit("code/open", { path, ref: "content#title" }));

		expect(opened.source).toEqual({ kind: "entryTemplate", id: site.templateId, name: "Blog posts", editable: true });
		expect(opened.ref).toBe("content");
		expect(opened.markup).toBe(
			'<article data-wc-id="article">\n  <h1 data-wc-id="title">{{ title }}</h1>\n  <Strap heading="{{ subtitle }}" data-wc-id="placed" />\n</article>',
		);
		expect(opened.version).toMatch(/^[0-9a-f]{16}$/);
		expect(opened.element).toEqual({ id: "title", tag: "h1" });
		expect(opened.path).toEqual([
			{ id: "article", label: "article" },
			{ id: "title", label: "h1" },
		]);
		expect(opened.breadcrumb).toEqual([{ label: "Blog posts", kind: "entryTemplate", ref: "content" }]);
		expect(opened.usage).toBeNull();
	});

	test("opens the Site template for its elements", async () => {
		const opened = await answer<Source>(coding.edit("code/open", { path, ref: "site#tagline" }));

		expect(opened.source.kind).toBe("siteTemplate");
		expect(opened.markup).toContain('<p data-wc-id="tagline">{{ site.tagline }}</p>');
		expect(opened.path.map((step) => step.label)).toEqual(["header", "p"]);
	});

	test("without an element, opens the page's content: its Entry template", async () => {
		const opened = await answer<Source>(coding.edit("code/open", { path, ref: null }));

		expect(opened.source.kind).toBe("entryTemplate");
		expect(opened.element).toBeNull();
		expect(opened.path).toEqual([]);
	});

	test("inside a placed Component, opens that Component, with a breadcrumb to step out and where it is used", async () => {
		const opened = await answer<Source>(coding.edit("code/open", { path, ref: "content/placed/badged#badge" }));

		expect(opened.source).toEqual({ kind: "component", id: site.badgeId, name: "Badge", editable: true });
		expect(opened.ref).toBe("content/placed/badged");
		expect(opened.markup).toBe('<span class="badge" data-wc-id="badge">{{ props.text }}</span>');
		expect(opened.path).toEqual([{ id: "badge", label: "span.badge" }]);
		// Each step out opens the Template or Component placing it, at the Placement.
		expect(opened.breadcrumb).toEqual([
			{ label: "Blog posts", kind: "entryTemplate", ref: "content#placed" },
			{ label: "Strap", kind: "component", ref: "content/placed#badged" },
			{ label: "Badge", kind: "component", ref: "content/placed/badged" },
		]);
		// The three published Blog posts show it, through Strap.
		expect(opened.usage).toEqual({ pages: 3 });
	});

	test("a Placement shows in the Template that places it as one tag, with its Props", async () => {
		const opened = await answer<Source>(coding.edit("code/open", { path, ref: "content#placed" }));

		expect(opened.element).toEqual({ id: "placed", tag: "Strap" });
		expect(opened.path.map((step) => step.label)).toEqual(["article", "<Strap>"]);
	});

	test("a Site without a Site template opens the built-in one, which saving makes its own", async () => {
		const plain = await bakery({ siteTemplate: false });
		const other = await openCodeMode(install, staff, plain.siteId, path);

		const opened = await answer<Source>(other.edit("code/open", { path, ref: "site" }));

		expect(opened.source).toEqual({ kind: "siteTemplate", id: null, name: null, editable: true });
		expect(opened.markup).toMatch(/^<main data-wc-id="[^"]+">\{\{@outlet\}\}<\/main>$/);
		expect(opened.version).toBeNull();
	});

	test("refuses a source the page doesn't show", async () => {
		for (const ref of ["content/nowhere#x", "elsewhere", "content#", "content/placed/badged/x#y"]) {
			const refused = await coding.edit("code/open", { path, ref });
			expect(refused.status).toBe(404);
			expect(((await refused.json()) as { code: string }).code).toBe("CODE_SOURCE_NOT_FOUND");
		}
		const nowhere = await coding.edit("code/open", { path: "/blog/nothing-here", ref: "content" });
		expect(nowhere.status).toBe(404);
	});

	test("Members in Edit mode can't open code", async () => {
		const editing = await openEditMode(install, editor, site.siteId, path);

		const refused = await editing.edit("code/open", { path, ref: "content#title" });
		expect(refused.status).toBe(403);
		expect(((await refused.json()) as { code: string }).code).toBe("FORBIDDEN");
	});
});

describe("suggestions", () => {
	let site: Awaited<ReturnType<typeof bakery>>;
	let coding: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		coding = await openCodeMode(install, staff, site.siteId, path);
	});

	test("an Entry template suggests the Entry's Fields and the Globals, with their parts and today's Global values", async () => {
		const { suggestions } = await answer<Source>(coding.edit("code/open", { path, ref: "content#title" }));
		const values = suggestions.values.map(({ path: value, label, group, sample }) => ({ value, label, group, sample }));

		expect(values).toContainEqual({ value: "title", label: null, group: "entry", sample: undefined });
		expect(values).toContainEqual({ value: "subtitle", label: "Subtitle", group: "entry", sample: undefined });
		expect(values).toContainEqual({ value: "link.url", label: "Read more › url", group: "entry", sample: undefined });
		expect(values).toContainEqual({ value: "site.tagline", label: "Tagline", group: "globals", sample: "Baked daily" });
		expect(values).toContainEqual({
			value: "site.address.city",
			label: "Address › City",
			group: "globals",
			sample: "Cork",
		});
		expect(values.some((value) => value.value.startsWith("props."))).toBe(false);
	});

	test("a Component suggests its Props and the Globals, never the Entry's Fields", async () => {
		const { suggestions } = await answer<Source>(coding.edit("code/open", { path, ref: "content/placed#heading" }));
		const paths = suggestions.values.map((value) => value.path);

		expect(paths).toContain("props.heading");
		expect(paths).toContain("site.tagline");
		expect(paths).not.toContain("title");
		expect(paths).not.toContain("subtitle");
	});

	test("suggests the Components that may be placed there, with their Props; never one placing itself", async () => {
		const inEntry = await answer<Source>(coding.edit("code/open", { path, ref: "content#title" }));
		expect(inEntry.suggestions.components).toEqual([
			{ name: "Badge", props: [{ key: "text", label: "Text", required: true }] },
			{ name: "Strap", props: [{ key: "heading", label: "Heading", required: false }] },
		]);

		const inStrap = await answer<Source>(coding.edit("code/open", { path, ref: "content/placed#heading" }));
		expect(inStrap.suggestions.components.map((component) => component.name)).toEqual(["Badge"]);
	});

	test("suggests the Template commands the registry has, as this kind of Template may hold them", async () => {
		const inEntry = await answer<Source>(coding.edit("code/open", { path, ref: "content#title" }));
		const inSite = await answer<Source>(coding.edit("code/open", { path, ref: "site#header" }));

		// Every command of the registry offers itself, each with its snippet: Languages' switcher, Forms and Cookie settings too.
		expect(inEntry.suggestions.commands.map((command) => command.name)).toEqual([
			"if",
			"loop",
			"pagination",
			"themeToggle",
			"languageSwitcher",
			"form",
			"consentSettings",
		]);
		expect(inSite.suggestions.commands.map((command) => command.name)).toEqual([
			"if",
			"loop",
			"outlet",
			"pagination",
			"themeToggle",
			"languageSwitcher",
			"form",
			"consentSettings",
		]);
		expect(inEntry.suggestions.commands).toContainEqual({ name: "form", block: false, snippet: "{{@form $0}}" });
		expect(inSite.suggestions.commands).toContainEqual({ name: "outlet", block: false, snippet: "{{@outlet}}" });
		expect(inEntry.suggestions.commands[0]).toEqual({ name: "if", block: true, snippet: "{{@if $0}}\n{{/if}}" });
		expect(inEntry.suggestions.commands).toContainEqual({
			name: "loop",
			block: true,
			snippet: "{{@loop $0 as item}}\n{{@empty}}\n{{/loop}}",
		});
		// The Site has no Loops yet: none to suggest by name.
		expect(inEntry.suggestions.loops).toEqual([]);
		expect(inEntry.suggestions.presets.map((preset) => preset.id)).toEqual([
			"hasValue",
			"isEmpty",
			"ifElse",
			"loopEmpty",
			"loopFirst",
			"loopLast",
			"loopOddEven",
			"currentLanguage",
			"betweenDates",
			"inRelationship",
		]);
	});

	test("suggests the Site's Loops by name", async () => {
		await staff.api.loops.create({ siteId: site.siteId, name: "latest-posts", source: "query" });

		const { suggestions } = await answer<Source>(coding.edit("code/open", { path, ref: "content#title" }));

		expect(suggestions.loops).toEqual([{ name: "latest-posts" }]);
	});

	test("suggests the Design system's Classes and token utilities by name", async () => {
		const { suggestions } = await answer<Source>(coding.edit("code/open", { path, ref: "content#title" }));

		expect(suggestions.classes).toContainEqual({ name: "badge", utility: false });
		expect(suggestions.classes).toContainEqual({ name: "p-m", utility: true });
	});
});
