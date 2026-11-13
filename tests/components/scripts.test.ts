// Component scripts (GLOSSARY.md, ADR 0022, ADR 0023): one optional script per Component, Structure
// with a Draft, published with its Component. Pages never carry it inline: it is its own file named
// by its hash on the Site's domain, loaded once per page however many Placements the page has, after
// the Site script and before the page script, and WebCraft calls the function it exports once for
// each Placement's root, where only the Props marked `exposed` are written as `data-` attributes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { answer, codeTagsIn, headOf, mainOf, openCodeMode } from "../harness/code-mode.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { fakeNpmPackage } from "../harness/fake-npm.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

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

let sites = 0;

/**
 * A live Site with a published `Card` Component (a `title` Prop, exposed, and a `note` Prop, not),
 * and a Blog post whose Entry template places it.
 */
async function bakery(markup = '<article><Card title="{{ title }}" note="secret" /></article>') {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	const { component } = await staff.api.components.create({ siteId, name: "Card" });
	await staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup:
			"{{@props}}\ntitle: text exposed\nnote: text\n{{/props}}\n<div><h2>{{ props.title }}</h2><p>{{ props.note }}</p></div>",
	});
	await staff.api.components.publish({ siteId, componentId: component.id });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: postType.id, markup });
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	return { siteId, origin: `https://${slug}.live.test`, componentId: component.id, entryId: entry.id, postType };
}

/** Every `<script>` tag of a page that runs code (structured data, JSON, is left out), as written. */
function scriptTagsIn(html: string): string[] {
	return [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)]
		.map((match) => match[0])
		.filter((tag) => !tag.startsWith('<script type="application/ld+json">'));
}

/** The addresses of the scripts a page's <head> loads, in order. */
function scriptSourcesIn(html: string): string[] {
	return [...headOf(html).matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g)].map((match) => match[1] ?? "");
}

/** A visitor's page, checked for the Site's headers, its strict policy and no inline code. */
async function visit(origin: string, at = path): Promise<string> {
	const response = await install.request(`${origin}${at}`);
	expect(response.status).toBe(200);
	return expectSafePage(response);
}

describe("a Component script", () => {
	let site: Awaited<ReturnType<typeof bakery>>;
	const code = 'export default function (root) {\n\troot.dataset.ran = "yes";\n}\n';

	beforeAll(async () => {
		site = await bakery();
	});

	test("is a Draft Staff save on its Component; visitors run nothing of it until it is published", async () => {
		expect(await staff.api.components.getScript({ siteId: site.siteId, componentId: site.componentId })).toEqual({
			script: null,
		});

		const saved = await staff.api.components.saveScriptDraft({
			siteId: site.siteId,
			componentId: site.componentId,
			code,
			basedOn: null,
		});

		expect(saved.script).toMatchObject({
			componentId: site.componentId,
			status: "draft",
			draft: { code, consentCategory: "necessary", libraryIds: [] },
			published: null,
		});
		expect(saved.version).toMatch(/^[0-9a-f]{16}$/);
		expect(await staff.api.components.getScript({ siteId: site.siteId, componentId: site.componentId })).toEqual({
			script: saved.script,
		});
		const html = await visit(site.origin);
		expect(scriptTagsIn(html)).toEqual([]);
	});

	test("is published with its Component, as its own file loaded once, never inline", async () => {
		await staff.api.components.publish({ siteId: site.siteId, componentId: site.componentId });
		const { script } = await staff.api.components.getScript({ siteId: site.siteId, componentId: site.componentId });
		expect(script).toMatchObject({ status: "published", published: { code, consentCategory: "necessary" } });

		const html = await visit(site.origin);

		// Every script is a file of the Site.
		for (const tag of scriptTagsIn(html))
			expect(tag).toMatch(/^<script\b[^>]*\bsrc="\/_wc\/js\/[^"]+"[^>]*><\/script>$/);
		const sources = scriptSourcesIn(html);
		const loaders = sources.filter((src) => src.startsWith("/_wc/js/component/"));
		expect(loaders).toEqual([
			expect.stringMatching(new RegExp(`^/_wc/js/component/${site.componentId}/[0-9a-f]{16}\\.js$`)),
		]);
		expect(headOf(html)).toContain(`<script type="module" src="${loaders[0]}"></script>`);

		// The loader imports the script's own file, named by its hash, and hands it to WebCraft.
		const loader = await install.request(`${site.origin}${loaders[0]}`);
		expect(loader.status).toBe(200);
		expect(loader.headers.get("cache-control")).toContain("immutable");
		const imported = /from "\.\.\/\.\.\/([0-9a-f]{16}\.js)"/.exec(await loader.text())?.[1];
		const file = await install.request(`${site.origin}/_wc/js/${imported}`);
		expect(file.status).toBe(200);
		expect(file.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(file.headers.get("cache-control")).toContain("immutable");
		expect(await file.text()).toBe(code);
	});
});

/** Makes and publishes a Component with a script, answering its id. */
async function scriptedComponent(siteId: string, name: string, markup: string, code: string): Promise<string> {
	const { component } = await staff.api.components.create({ siteId, name });
	await staff.api.components.saveMarkup({ siteId, componentId: component.id, markup });
	await staff.api.components.saveScriptDraft({ siteId, componentId: component.id, code });
	await staff.api.components.publish({ siteId, componentId: component.id });
	return component.id;
}

describe("a page with several Placements", () => {
	let site: Awaited<ReturnType<typeof bakery>>;
	const ids: Record<string, string> = {};
	let html: string;

	beforeAll(async () => {
		site = await bakery();
		const { siteId } = site;
		ids.card = site.componentId;
		await staff.api.components.saveScriptDraft({ siteId, componentId: ids.card, code: "export default () => {};" });
		await staff.api.components.publish({ siteId, componentId: ids.card });
		ids.badge = await scriptedComponent(siteId, "Badge", "<span>New</span>", "export default () => {};");
		ids.hero = await scriptedComponent(siteId, "Hero", "<section><h1>Hello</h1></section>", "export default () => {};");
		ids.banner = await scriptedComponent(siteId, "Banner", "<div>Open daily</div>", "export default () => {};");
		// A Component placed inside another gets its own call: Badge sits inside Card from now on.
		await staff.api.components.saveMarkup({
			siteId,
			componentId: ids.card,
			markup:
				"{{@props}}\ntitle: text exposed\nnote: text\n{{/props}}\n<div><h2>{{ props.title }}</h2><Badge /><p>{{ props.note }}</p></div>",
		});
		await staff.api.components.publish({ siteId, componentId: ids.card });
		// A Component without a script loads nothing.
		const { component: plain } = await staff.api.components.create({ siteId, name: "Plain" });
		await staff.api.components.saveMarkup({ siteId, componentId: plain.id, markup: "<p>Plain</p>" });
		await staff.api.components.publish({ siteId, componentId: plain.id });
		const siteTemplate = await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: "<header><Banner /></header><main>{{@outlet}}</main>",
		});
		await staff.api.templates.publish({ siteId, templateId: siteTemplate.template.id });
		const { template } = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: site.postType.id,
			markup:
				'<article><Plain /><Hero /><Card title="{{ title }}" note="secret" /><Hero /><Card title="Second" note="hidden" /></article>',
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });
		await staff.api.scripts.saveDraft({ siteId, entryId: null, code: "/* Site script */" });
		await staff.api.scripts.saveDraft({ siteId, entryId: site.entryId, code: "/* page script */" });
		for (const entryId of [null, site.entryId]) {
			const { script } = await staff.api.scripts.get({ siteId, entryId });
			await staff.api.scripts.publish({ siteId, scriptId: script?.id as string });
		}
		html = await visit(site.origin);
	});

	test("loads the Site script, then each Component script once by its first Placement, then the page script", async () => {
		const component = (name: string) => new RegExp(`^/_wc/js/component/${ids[name]}/[0-9a-f]{16}\\.js$`);
		const order = scriptSourcesIn(html).map((src) => {
			for (const name of ["banner", "hero", "card", "badge"]) if (component(name).test(src)) return name;
			return src;
		});
		const { script: siteScript } = await staff.api.scripts.get({ siteId: site.siteId, entryId: null });
		const { script: pageScript } = await staff.api.scripts.get({ siteId: site.siteId, entryId: site.entryId });
		const siteAt = order.indexOf(`/_wc/js/${siteScript?.version}.js`);
		const pageAt = order.indexOf(`/_wc/js/${pageScript?.version}.js`);
		expect(siteAt).toBeGreaterThanOrEqual(0);
		// Between them: WebCraft's runtime, then the Components in the order of their first Placement on the page.
		expect(order.slice(siteAt + 1, pageAt)).toEqual([
			expect.stringMatching(/^\/_wc\/js\/[0-9a-f]{16}\.js$/),
			"banner",
			"hero",
			"card",
			"badge",
		]);
		expect(pageAt).toBe(order.length - 1);
		for (const tag of scriptTagsIn(html)) expect(tag).toMatch(/\bsrc="\/_wc\/js\//);
	});

	test("tags each Placement's root with its Component, and only exposed Props as data- attributes", () => {
		const roots = [...mainOf(html).matchAll(/<([a-z0-9]+)([^>]*)\bdata-wc-component="([^"]+)"([^>]*)>/g)].map(
			(match) => `<${match[1]}${match[2]}data-wc-component="${match[3]}"${match[4]}>`,
		);
		expect(roots).toEqual([
			`<section data-wc-component="${ids.hero}">`,
			`<div data-wc-component="${ids.card}" data-title="Fresh bread">`,
			`<span data-wc-component="${ids.badge}">`,
			`<section data-wc-component="${ids.hero}">`,
			`<div data-wc-component="${ids.card}" data-title="Second">`,
			`<span data-wc-component="${ids.badge}">`,
		]);
		expect(html).not.toContain("data-note");
		expect(mainOf(html)).toContain("<p>Plain</p>");
	});
});

describe("text that reads like a Placement's root", () => {
	test("loads no Component script: only a root the page really shows does (audit A3-5)", async () => {
		// The page places no Card; its Entry's title, which an Author writes, names Card as a root would.
		const site = await bakery("<article><h1>{{ title }}</h1></article>");
		const { siteId, componentId } = site;
		await staff.api.components.saveScriptDraft({ siteId, componentId, code: "export default () => {};" });
		await staff.api.components.publish({ siteId, componentId });
		const title = `Bread data-wc-component="${componentId}" for all`;
		await editor.api.entries.saveDraft({ siteId, entryId: site.entryId, title });
		await editor.api.entries.publish({ siteId, entryId: site.entryId });

		const html = await visit(site.origin);
		expect(mainOf(html)).toContain(`<h1>${title}</h1>`);
		expect(scriptSourcesIn(html).filter((src) => src.includes("/_wc/js/component/"))).toEqual([]);
		expect(scriptTagsIn(html)).toEqual([]);
	});
});

describe("where Component scripts run", () => {
	let site: Awaited<ReturnType<typeof bakery>>;
	const published = "export default (root) => { root.dataset.version = 'published'; };";
	const draft = "export default (root) => { root.dataset.version = 'draft'; };";

	beforeAll(async () => {
		site = await bakery();
		await staff.api.components.saveScriptDraft({ siteId: site.siteId, componentId: site.componentId, code: published });
		await staff.api.components.publish({ siteId: site.siteId, componentId: site.componentId });
		await staff.api.components.saveScriptDraft({ siteId: site.siteId, componentId: site.componentId, code: draft });
	});

	/** The loaders of Component scripts a page loads, as written. */
	const loadersIn = (html: string) =>
		[...headOf(html).matchAll(/<script type="module" src="[^"]*\/component\/[^"]+"[^>]*><\/script>/g)].map(
			(match) => match[0],
		);

	test("Edit mode runs the published one, saying which Component it is, and watches for Placements added later", async () => {
		const editing = await openEditMode(install, editor, site.siteId, path);
		const html = await expectSafePage(await editing.page(path), "editMode");

		expect(loadersIn(html)).toEqual([
			expect.stringMatching(
				new RegExp(
					`^<script type="module" src="/_wc/js/component/${site.componentId}/[0-9a-f]{16}\\.js" data-wc-component-script="${site.componentId}" data-wc-component-name="Card"></script>$`,
				),
			),
		]);
		expect(headOf(html)).toMatch(/<script src="\/_wc\/js\/[0-9a-f]{16}\.js" defer data-wc-watch><\/script>/);
		const loader = /src="([^"]+)"/.exec(loadersIn(html)[0] ?? "")?.[1];
		const imported = /from "\.\.\/\.\.\/([0-9a-f]{16}\.js)"/.exec(
			await (await editing.browser.request(`${site.origin}${loader}`)).text(),
		)?.[1];
		expect(await (await install.request(`${site.origin}/_wc/js/${imported}`)).text()).toBe(published);
	});

	test("Safe mode runs none of them", async () => {
		const editing = await openEditMode(install, editor, site.siteId, path, { safeMode: true });
		const html = await expectSafePage(await editing.page(path), "editMode");

		expect(loadersIn(html)).toEqual([]);
		expect(html).not.toContain("/_wc/js/");
		// Its Placements' roots aren't tagged for a script that doesn't run.
		expect(html).not.toContain("data-wc-component=");
	});

	test("Code mode runs the Draft, from a file only Staff in Code mode get", async () => {
		const coding = await openCodeMode(install, staff, site.siteId, path);
		const html = await (await coding.page(path)).text();

		const [tag] = loadersIn(html);
		const loader = /src="([^"]+)"/.exec(tag ?? "")?.[1] ?? "";
		expect(loader).toMatch(new RegExp(`^/_webcraft/edit/js/component/${site.componentId}/[0-9a-f]{16}\\.js$`));
		const file = await coding.browser.request(`${site.origin}${loader}`);
		expect(file.headers.get("cache-control")).toBe("no-store");
		const imported = /from "\.\.\/\.\.\/([0-9a-f]{16}\.js)"/.exec(await file.text())?.[1];
		expect(await (await coding.browser.request(`${site.origin}/_webcraft/edit/js/${imported}`)).text()).toBe(draft);

		// Nobody else gets a Draft.
		expect((await install.request(`${site.origin}${loader}`)).status).toBe(404);
		expect((await install.request(`${site.origin}/_wc/js/${imported}`)).status).toBe(404);
		const member = await openEditMode(install, editor, site.siteId, path);
		expect((await member.browser.request(`${site.origin}${loader}`)).status).toBe(404);
	});
});

describe("a Component script's Consent category", () => {
	test("is Necessary unless Staff choose another; visitors who haven't accepted it don't run it", async () => {
		const site = await bakery();
		const code = "export default () => {};";
		const saved = await staff.api.components.saveScriptDraft({
			siteId: site.siteId,
			componentId: site.componentId,
			code,
			consentCategory: "marketing",
		});
		expect(saved.script.draft.consentCategory).toBe("marketing");
		await staff.api.components.publish({ siteId: site.siteId, componentId: site.componentId });

		const html = await visit(site.origin);

		// Held back as inert markup the consent script turns into a running script once Marketing is accepted.
		expect(headOf(html)).toMatch(
			new RegExp(
				`<template data-wc-consent="marketing"><script type="module" src="/_wc/js/component/${site.componentId}/[0-9a-f]{16}\\.js"></script></template>`,
			),
		);
		expect(html).toContain('<meta name="webcraft-consent-mode" content="optIn">');
		// People editing are never asked: Edit mode runs it.
		const editing = await openEditMode(install, editor, site.siteId, path);
		const edit = await (await editing.page(path)).text();
		expect(edit).not.toContain("data-wc-consent");
		expect(edit).toContain(`/_wc/js/component/${site.componentId}/`);

		// Saving only the code keeps the category.
		const again = await staff.api.components.saveScriptDraft({
			siteId: site.siteId,
			componentId: site.componentId,
			code: "export default () => { /* changed */ };",
		});
		expect(again.script.draft.consentCategory).toBe("marketing");
	});
});

describe("Libraries a Component script declares", () => {
	test("load once, only on pages that show the Component; the Site's other Libraries load everywhere", async () => {
		const site = await bakery();
		const { siteId } = site;
		fakeNpmPackage(install, `tween-kit-${siteId.slice(0, 8)}`, {
			"1.0.0": { files: { "index.js": "window.tween = 1;" } },
		});
		fakeNpmPackage(install, `menu-kit-${siteId.slice(0, 8)}`, {
			"1.0.0": { files: { "index.js": "window.menu = 1;" } },
		});
		const { library: tween } = await staff.api.libraries.add({
			siteId,
			library: { source: "npm", packageName: `tween-kit-${siteId.slice(0, 8)}`, version: "1.0.0" },
		});
		const { library: menu } = await staff.api.libraries.add({
			siteId,
			library: { source: "npm", packageName: `menu-kit-${siteId.slice(0, 8)}`, version: "1.0.0" },
		});
		await staff.api.components.saveScriptDraft({
			siteId,
			componentId: site.componentId,
			code: "export default () => {};",
			libraryIds: [tween.id, tween.id],
		});
		await staff.api.components.publish({ siteId, componentId: site.componentId });
		// A second Blog post's page places Card twice; the Site's home page places nothing.
		const { template } = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: site.postType.id,
			markup: '<article><Card title="{{ title }}" /><Card title="Again" /></article>',
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });
		const pages = (await staff.api.postTypes.list({ siteId })).postTypes.find(
			(postType) => postType.builtIn === "page",
		);
		const { entry: home } = await editor.api.entries.create({
			siteId,
			postTypeId: pages?.id ?? "",
			title: "Home",
			slug: "home",
		});
		await editor.api.entries.publish({ siteId, entryId: home.id });
		await staff.api.pages.setHomePage({ siteId, pageId: home.id });

		const withCard = scriptSourcesIn(await visit(site.origin));
		expect(withCard.filter((src) => src === tween.src)).toEqual([tween.src]);
		// In the Site's order of Libraries.
		expect(withCard.indexOf(tween.src)).toBeLessThan(withCard.indexOf(menu.src));
		// Libraries load before the Site's own scripts and the Component scripts.
		expect(withCard.indexOf(tween.src)).toBeLessThan(withCard.findIndex((src) => src.includes("/component/")));

		const withoutCard = scriptSourcesIn(await visit(site.origin, "/"));
		expect(withoutCard).toEqual([menu.src]);
		const { script } = await staff.api.components.getScript({ siteId, componentId: site.componentId });
		expect(script?.published?.libraryIds).toEqual([tween.id]);
	});

	test("must be the Site's own", async () => {
		const site = await bakery();
		await expect(
			staff.api.components.saveScriptDraft({
				siteId: site.siteId,
				componentId: site.componentId,
				code: "",
				libraryIds: ["00000000-0000-4000-8000-000000000000"],
			}),
		).rejects.toMatchObject({ code: "LIBRARY_NOT_FOUND" });
	});
});

describe("publishing with its Component", () => {
	test("a changed script makes its Component a Draft to publish; Publish all publishes them together", async () => {
		const site = await bakery();
		const { siteId, componentId } = site;
		await staff.api.components.saveScriptDraft({ siteId, componentId, code: "export default () => {};" });
		await staff.api.components.publish({ siteId, componentId });
		expect((await staff.api.publishing.drafts({ siteId })).drafts.map((draft) => draft.item)).toEqual([]);

		await staff.api.components.saveScriptDraft({ siteId, componentId, code: "export default () => { /* new */ };" });

		expect((await staff.api.components.get({ siteId, componentId })).component.status).toBe("changed");
		const { drafts } = await staff.api.publishing.drafts({ siteId });
		expect(drafts.map((draft) => [draft.item, draft.name])).toEqual([[{ kind: "component", id: componentId }, "Card"]]);
		const preview = await staff.api.publishing.publishAll({ siteId, items: [{ kind: "component", id: componentId }] });
		await staff.api.publishing.publishAll({
			siteId,
			items: [{ kind: "component", id: componentId }],
			confirmation: (preview as { confirmation?: { id: string } }).confirmation?.id,
		});

		const { script } = await staff.api.components.getScript({ siteId, componentId });
		expect(script).toMatchObject({ status: "published", published: { code: "export default () => { /* new */ };" } });
		expect((await staff.api.components.get({ siteId, componentId })).component.status).toBe("published");
		// It is never published on its own.
		await expect(staff.api.scripts.publish({ siteId, scriptId: script?.id as string })).rejects.toMatchObject({
			code: "SCRIPT_NOT_FOUND",
		});
		// A script never published and still empty is nothing to publish.
		const { component: empty } = await staff.api.components.create({ siteId, name: "Empty" });
		await staff.api.components.publish({ siteId, componentId: empty.id });
		await staff.api.components.saveScriptDraft({ siteId, componentId: empty.id, code: "  " });
		expect((await staff.api.publishing.drafts({ siteId })).drafts).toEqual([]);
	});
});

type PanelScript = {
	componentId: string;
	name: string;
	editable: boolean;
	pages: number;
	code: string;
	consentCategory: string;
	libraryIds: string[];
	libraries: { id: string; name: string }[];
	version: string | null;
	src: string | null;
	runtime: string;
};

describe("Code mode's JS panel", () => {
	test("shows the Component script of the Placement selected, with how many pages use it, and saves its Draft", async () => {
		const site = await bakery();
		const coding = await openCodeMode(install, staff, site.siteId, path);
		const page = await (await coding.page(path)).text();
		// An element of the Card, reached through its Placement in the page's Entry template.
		const [, inCard] = codeTagsIn(page).find(([tag]) => tag === "h2") ?? [];

		const none = await answer<{ component: PanelScript | null }>(coding.edit("code/scripts", { path, ref: "content" }));
		expect(none.component).toBeNull();
		const opened = await answer<{ component: PanelScript }>(coding.edit("code/scripts", { path, ref: inCard }));
		expect(opened.component).toEqual({
			componentId: site.componentId,
			name: "Card",
			editable: true,
			pages: 1,
			code: "",
			consentCategory: "necessary",
			libraryIds: [],
			libraries: [],
			version: null,
			src: null,
			runtime: expect.stringMatching(/^\/_wc\/js\/[0-9a-f]{16}\.js$/),
		});

		// The Placement itself, as the Entry template's markup selects it, shows the same.
		const placementId = /^content\/([^#/]+)#/.exec(inCard ?? "")?.[1];
		const placement = await answer<{ component: PanelScript }>(
			coding.edit("code/scripts", { path, ref: `content#${placementId}` }),
		);
		expect(placement.component).toEqual(opened.component);

		const code = "export default (root) => { root.dataset.ready = 'yes'; };";
		const saved = await answer<PanelScript>(
			coding.edit("code/saveScript", {
				path,
				kind: "component",
				componentId: site.componentId,
				code,
				consentCategory: "media",
				version: null,
			}),
		);
		expect(saved).toMatchObject({ componentId: site.componentId, code, consentCategory: "media" });
		expect(saved.src).toMatch(new RegExp(`^/_webcraft/edit/js/component/${site.componentId}/[0-9a-f]{16}\\.js$`));
		const { script } = await staff.api.components.getScript({ siteId: site.siteId, componentId: site.componentId });
		expect(script?.draft).toEqual({ code, consentCategory: "media", libraryIds: [] });
		// A newer Draft someone saved meanwhile isn't overwritten.
		const stale = await coding.edit("code/saveScript", {
			path,
			kind: "component",
			componentId: site.componentId,
			code: "export default () => {};",
			version: null,
		});
		expect(stale.status).toBe(409);
		expect(((await stale.json()) as { code: string; data: { version: string } }).data.version).toBe(
			saved.version as string,
		);

		// The page in Code mode runs the Draft at once.
		expect(await (await coding.page(path)).text()).toContain(saved.src as string);
	});
});
