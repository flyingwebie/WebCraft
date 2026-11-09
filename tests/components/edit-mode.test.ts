// Components in Edit mode (ADR 0022): pages show the published Components their Templates place,
// reading the Drafts of the page's Content, and nothing inside a Component is tagged for editing in
// place (its elements are the Component's). The Globals a Component shows are the page's.
import { afterAll, beforeAll, expect, test } from "bun:test";

import { type EditModeBrowser, openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let editing: EditModeBrowser;
const path = "/blog/fresh-bread";

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const editor: TestBrowser = (await install.createMember({ workspaceId, role: "editor", name: "Erin Editor" }))
		.browser;
	await staff.api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	await editor.api.globals.saveDraft({ siteId, fields: { tagline: "Baked daily" } });
	await editor.api.globals.publish({ siteId });
	const { component } = await staff.api.components.create({
		siteId,
		name: "Strap",
		props: [{ key: "heading", label: "Heading", type: "text" }],
	});
	await staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<header><h1>{{ props.heading }}</h1><p>{{ site.tagline }}</p></header>",
	});
	await staff.api.components.publish({ siteId, componentId: component.id });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<article><Strap heading="{{ title }}" /></article>',
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	editing = await openEditMode(install, editor, siteId, path);
});

afterAll(async () => {
	await install.close();
});

const mainOf = (html: string) => /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1];

test("an Edit mode page shows the Components it places, untagged, with the Drafts of its Content", async () => {
	await editing.edit("save", { item: "globals", field: "tagline", value: "Baked twice daily" });

	const html = await (await editing.page(path)).text();

	expect(mainOf(html)).toBe("<article><header><h1>Fresh bread</h1><p>Baked twice daily</p></header></article>");
	// Visitors still see what is published.
	const visitor = await (await install.request(`https://bakery.sites.test${path}`)).text();
	expect(mainOf(visitor)).toBe("<article><header><h1>Fresh bread</h1><p>Baked daily</p></header></article>");
});

test("the Globals a Component shows are the page's: its Publish menu lists their changes", async () => {
	const response = await editing.edit("state", { path });
	const state = (await response.json()) as { changes: { item: string; key: string }[] };

	expect(state.changes.map((change) => [change.item, change.key])).toEqual([["globals", "tagline"]]);
});
