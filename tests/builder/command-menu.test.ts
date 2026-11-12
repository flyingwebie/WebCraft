// The Command menu's data (#131): the Permissions it shows commands for, checked with can() on the
// Site (ADR 0028), and Go to's lists, the same through the Builder's API and Code mode's Edit mode
// endpoint.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { answer, openCodeMode } from "../harness/code-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSiteHeaders } from "../harness/site-safety.ts";

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

test("Go to lists Pages, each Post Type's Entries, Templates and the Site's own Components", async () => {
	const siteId = (await install.createSite(workspaceId)).id;
	const api = staff.api;
	const pages = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	if (!pages) throw new Error("Page Post Type missing");
	const home = (await api.entries.create({ siteId, postTypeId: pages.id, title: "Welcome" })).entry;
	await api.pages.setHomePage({ siteId, pageId: home.id });
	await api.entries.create({ siteId, postTypeId: pages.id, title: "About us" });
	const { postType } = await api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	await api.entries.create({ siteId, postTypeId: postType.id, title: "First tale" });
	const { component } = await api.components.create({ siteId, name: "Hero" });
	const { component: card } = await api.components.create({ siteId, name: "Card" });
	// A Placement's "on N pages" badge lists what places its Component (#134).
	const { template } = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><Card /></article>",
	});

	const menu = await api.builder.commandMenu({ siteId });

	expect(menu.permissions).toEqual(["site.view", "structure.edit", "entry.edit", "entry.publish"]);
	expect(menu.pages.map((page) => [page.title, page.path])).toEqual([
		["Welcome", "/"],
		["About us", "/about-us"],
	]);
	expect(menu.postTypes).toEqual([
		{
			id: postType.id,
			name: "Stories",
			archive: true,
			entries: [{ id: expect.any(String), title: "First tale", path: "/stories/first-tale" }],
		},
	]);
	expect(menu.components).toEqual([
		{
			id: card.id,
			name: "Card",
			usedIn: [
				{ kind: "template", id: template.id, templateKind: "entry", postTypeId: postType.id, versions: ["draft"] },
			],
		},
		{ id: component.id, name: "Hero", usedIn: [] },
	]);

	const coding = await openCodeMode(install, staff, siteId, "/");
	const response = await coding.edit("code/commandMenu", { path: "/" });
	expectSiteHeaders(response);
	expect(await answer(response)).toEqual(menu);
});

test("a Member sees only the Permissions their role gives them, never Code mode's", async () => {
	const siteId = (await install.createSite(workspaceId)).id;
	const editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	const author = (await install.createMember({ workspaceId, role: "author" })).browser;

	expect((await editor.api.builder.commandMenu({ siteId })).permissions).toEqual([
		"site.view",
		"entry.edit",
		"entry.publish",
	]);
	expect((await author.api.builder.commandMenu({ siteId })).permissions).toEqual(["site.view", "entry.edit"]);
	const other = (await install.createSite((await install.createWorkspace()).id)).id;
	await expect(editor.api.builder.commandMenu({ siteId: other })).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
});
