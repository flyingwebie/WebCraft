// The Command menu in Edit mode (#139): one menu for everyone, each command shown by Permission. What
// the menu needs comes from the Site's own Edit mode endpoint; whatever the menu hides from a Member
// the server still refuses, through the Site's Edit mode endpoint and the Management API alike.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { answer } from "../harness/code-mode.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSiteHeaders } from "../harness/site-safety.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let author: TestBrowser;
let workspaceId: string;
beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace()).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
});
afterAll(async () => {
	await install.close();
});

type Menu = {
	permissions: string[];
	pages: { id: string; title: string; path: string }[];
	postTypes: { id: string; name: string; archive: boolean; entries: { title: string; path: string }[] }[];
	components: { id: string; name: string }[];
	siteId: string;
	adminOrigin: string;
};

/** A refusal from the Site's Edit mode endpoint: an error status, the Site's headers and the refusal's code. */
async function expectRefused(response: Promise<Response>, code: string) {
	const refused = await response;
	expectSiteHeaders(refused);
	expect(refused.status).toBeGreaterThanOrEqual(400);
	expect(((await refused.json()) as { code?: string }).code).toBe(code);
}

/** A Site with a home Page, a second Page, a Post Type with one Entry, and a published Component. */
async function site(slug: string) {
	const siteId = (await install.createSite(workspaceId, { slug })).id;
	const pageType = (await staff.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	if (!pageType) throw new Error("Page Post Type missing");
	const home = (await staff.api.entries.create({ siteId, postTypeId: pageType.id, title: "Welcome" })).entry;
	await staff.api.pages.setHomePage({ siteId, pageId: home.id });
	await staff.api.entries.create({ siteId, postTypeId: pageType.id, title: "About us" });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "First tale" });
	const { component } = await staff.api.components.create({ siteId, name: "Hero" });
	await staff.api.components.publish({ siteId, componentId: component.id });
	return { siteId, homeId: home.id, postTypeId: postType.id, componentId: component.id };
}

test("Edit mode serves the Command menu's data to everyone in it, by the Permissions they hold", async () => {
	const { siteId, componentId } = await site("menu-data");

	const asEditor = await openEditMode(install, editor, siteId, "/");
	const response = await asEditor.edit("commandMenu", {});
	expectSiteHeaders(response);
	const menu = await answer<Menu>(response);
	expect(menu.permissions).toEqual(["site.view", "entry.edit", "entry.publish"]);
	expect(menu.pages.map((page) => [page.title, page.path])).toEqual([
		["Welcome", "/"],
		["About us", "/about-us"],
	]);
	expect(menu.postTypes.map((type) => [type.name, type.entries.map((entry) => entry.path)])).toEqual([
		["Stories", ["/stories/first-tale"]],
	]);
	// Components are Structure: a Member's menu is never sent them.
	expect(menu.components).toEqual([]);

	const asAuthor = await openEditMode(install, author, siteId, "/");
	const authors = await answer<Menu>(asAuthor.edit("commandMenu", {}));
	expect(authors.permissions).toEqual(["site.view", "entry.edit"]);
	expect(authors.components).toEqual([]);

	const asStaff = await openEditMode(install, staff, siteId, "/");
	const staffs = await answer<Menu>(asStaff.edit("commandMenu", {}));
	expect(staffs.permissions).toEqual(["site.view", "structure.edit", "entry.edit", "entry.publish"]);
	expect(staffs.components.map((component) => component.id)).toEqual([componentId]);
	// Templates and Components open in the Builder, on the admin.
	expect(staffs.siteId).toBe(siteId);
	expect(staffs.adminOrigin).toBe(new URL(install.adminUrl("/")).origin);
});

test("the Management API gives a Member's Command menu no Components either", async () => {
	const { siteId, componentId } = await site("menu-api");
	expect((await editor.api.builder.commandMenu({ siteId })).components).toEqual([]);
	expect((await author.api.builder.commandMenu({ siteId })).components).toEqual([]);
	expect((await staff.api.builder.commandMenu({ siteId })).components.map((component) => component.id)).toEqual([
		componentId,
	]);
});

test("a Member is refused Templates, Components and Structure, on the Site and in the Management API", async () => {
	const { siteId, postTypeId, componentId } = await site("menu-structure");
	const editing = await openEditMode(install, editor, siteId, "/");

	// Code mode and everything it serves: Templates' and Components' markup, CSS, scripts, its own menu.
	const structureOnSite: [string, unknown][] = [
		["code/start", {}],
		["code/commandMenu", {}],
		["code/editor", { path: "/", ref: null }],
		["code/open", { path: "/", ref: null }],
		["code/save", { path: "/", ref: "template:site", markup: "<main></main>", version: null }],
		["code/saveCss", { target: { kind: "site" }, text: "body{}", version: null }],
		["code/saveScript", { path: "/", kind: "site", code: "", version: null }],
		["code/createComponent", { name: "Mine" }],
		["code/createClass", { name: "mine" }],
	];
	for (const [action, body] of structureOnSite) {
		const refused = await editing.edit(action, body);
		expectSiteHeaders(refused);
		expect([action, refused.status]).toEqual([action, 403]);
	}
	// Page layout settings are Structure too: refused as any other missing Permission is, and left as they were.
	const settings = await editing.edit("layout/configure", { enabled: true });
	expect(settings.status).toBe(403);
	await expectRefused(Promise.resolve(settings), "FORBIDDEN");
	expect(await staff.api.pageLayouts.settings({ siteId })).toEqual({ enabled: false, allowedComponents: [] });

	const api = editor.api;
	const forbidden = { status: 403 };
	await expect(api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main></main>" })).rejects.toMatchObject(
		forbidden,
	);
	await expect(
		api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: "<article></article>" }),
	).rejects.toMatchObject(forbidden);
	await expect(api.components.create({ siteId, name: "Mine" })).rejects.toMatchObject(forbidden);
	await expect(api.components.saveMarkup({ siteId, componentId, markup: "<p>Mine</p>" })).rejects.toMatchObject(
		forbidden,
	);
	await expect(api.components.publish({ siteId, componentId })).rejects.toMatchObject(forbidden);
	await expect(api.postTypes.create({ siteId, name: "Mine", urlPattern: "/mine/{slug}" })).rejects.toMatchObject(
		forbidden,
	);
	await expect(api.pageLayouts.configure({ siteId, enabled: true })).rejects.toMatchObject(forbidden);
});

test("a Member is refused other Sites: their menu, their pages and their Edit mode", async () => {
	const mine = await site("menu-mine");
	const foreignWorkspace = (await install.createWorkspace()).id;
	const foreign = (await install.createSite(foreignWorkspace, { slug: "menu-foreign" })).id;
	const foreignStaff = (await install.createStaff({ workspaces: [foreignWorkspace] })).browser;
	const pageType = (await foreignStaff.api.postTypes.list({ siteId: foreign })).postTypes.find(
		(type) => type.builtIn === "page",
	);
	if (!pageType) throw new Error("Page Post Type missing");
	const theirs = (await foreignStaff.api.entries.create({ siteId: foreign, postTypeId: pageType.id, title: "Theirs" }))
		.entry;

	await expect(editor.api.builder.commandMenu({ siteId: foreign })).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
	await expect(editor.api.editMode.open({ siteId: foreign, path: "/" })).rejects.toMatchObject({
		code: "SITE_NOT_FOUND",
	});
	await expect(editor.api.pageLayouts.get({ siteId: foreign, entryId: theirs.id })).rejects.toMatchObject({
		code: "SITE_NOT_FOUND",
	});

	// An Edit mode session reaches its own Site only, whatever ids a request names.
	const editing = await openEditMode(install, editor, mine.siteId, "/");
	const layout = await editing.edit("layout/get", { entryId: theirs.id });
	expectSiteHeaders(layout);
	expect(layout.status).toBe(404);
	const saved = await editing.edit("save", { item: `entry:${theirs.id}`, field: "title", value: "Mine now" });
	expect(saved.status).toBeGreaterThanOrEqual(400);
	expect((await foreignStaff.api.entries.get({ siteId: foreign, entryId: theirs.id })).entry.draft.title).toBe(
		"Theirs",
	);
});

test("a Member is refused arranging while it is off, and Components that aren't Allowed", async () => {
	const { siteId, homeId, componentId } = await site("menu-arranging");
	const editing = await openEditMode(install, editor, siteId, "/");
	const read = async () =>
		answer<{ version: string; canArrange: boolean; components: { id: string }[] }>(
			editing.edit("layout/get", { entryId: homeId }),
		);
	const placement = { id: "hero", component: componentId, props: [], values: {} };
	const save = async (placements: unknown[]) =>
		editing.edit("layout/save", { entryId: homeId, layout: { placements }, basedOn: (await read()).version });

	// Off: nothing to arrange with, and the write is refused.
	expect(await read()).toMatchObject({ canArrange: false, components: [] });
	await expectRefused(save([placement]), "ENTRY_INVALID");
	await expect(
		editor.api.pageLayouts.save({
			siteId,
			entryId: homeId,
			basedOn: (await read()).version,
			layout: { placements: [placement] },
		}),
	).rejects.toMatchObject({ code: "ENTRY_INVALID" });

	// On, with no Allowed components: still nothing a Member may insert.
	await staff.api.pageLayouts.configure({ siteId, enabled: true });
	expect(await read()).toMatchObject({ canArrange: true, components: [] });
	await expectRefused(save([placement]), "ENTRY_INVALID");

	await staff.api.pageLayouts.configure({ siteId, allowedComponents: [componentId] });
	expect((await read()).components.map((component) => component.id)).toEqual([componentId]);
	expect((await save([placement])).status).toBe(200);
});

test("a Member is refused moving, hiding and removing a locked Placement", async () => {
	const { siteId, homeId, componentId } = await site("menu-locked");
	await staff.api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [componentId] });
	const first = { id: "first", component: componentId, props: [], values: {} };
	const locked = { id: "locked", component: componentId, props: [], values: {}, locked: true };
	const before = await staff.api.pageLayouts.get({ siteId, entryId: homeId });
	await staff.api.pageLayouts.save({
		siteId,
		entryId: homeId,
		basedOn: before.version,
		layout: { placements: [first, locked] },
	});

	const editing = await openEditMode(install, editor, siteId, "/");
	const version = async () =>
		(await answer<{ version: string }>(editing.edit("layout/get", { entryId: homeId }))).version;
	const save = async (placements: unknown[]) =>
		editing.edit("layout/save", { entryId: homeId, layout: { placements }, basedOn: await version() });

	for (const placements of [
		[locked, first], // moved across it
		[first, { ...locked, hidden: true }], // hidden
		[first], // removed
		[first, { ...locked, locked: false }], // unlocked
	]) {
		await expectRefused(save(placements), "ENTRY_INVALID");
	}
	// What a Member may still do beside it: hide the unlocked one.
	expect((await save([{ ...first, hidden: true }, locked])).status).toBe(200);
});

test("an Author is refused Publish, and sends the page to Review instead", async () => {
	const { siteId, homeId } = await site("menu-review");
	await staff.api.entries.publish({ siteId, entryId: homeId });
	const editing = await openEditMode(install, author, siteId, "/");
	expect((await editing.edit("save", { item: `entry:${homeId}`, field: "title", value: "Welcome, all" })).status).toBe(
		200,
	);

	const published = await editing.edit("publish", { path: "/" });
	expectSiteHeaders(published);
	expect(published.status).toBe(403);
	await expect(author.api.entries.publish({ siteId, entryId: homeId })).rejects.toMatchObject({ status: 403 });

	const submitted = await answer<{ reviews: { status: string }[] }>(
		editing.edit("review/submit", { path: "/", note: "Ready" }),
	);
	expect(submitted.reviews.map((review) => review.status)).toEqual(["inReview"]);
});
