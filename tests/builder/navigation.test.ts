import { afterAll, beforeAll, expect, test } from "bun:test";
import { answer, openCodeMode } from "../harness/code-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage, expectSiteHeaders } from "../harness/site-safety.ts";

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

test("destinations follow the picked Draft Entry, nested repeated Placements and chosen Pages", async () => {
	const siteId = (await install.createSite(workspaceId)).id;
	const api = staff.api;
	const target = { kind: "siteTemplate" as const };
	expect(await api.builder.destinations({ siteId, target })).toMatchObject({ pages: [], reason: "noHomePage" });
	const pages = (await api.postTypes.list({ siteId })).postTypes.find((p) => p.builtIn === "page");
	if (!pages) throw new Error("Page Post Type missing");
	const home = (await api.entries.create({ siteId, postTypeId: pages.id, title: "Welcome" })).entry;
	await api.pages.setHomePage({ siteId, pageId: home.id });
	expect((await api.builder.destinations({ siteId, target })).pages).toMatchObject([{ path: "/", refs: ["site"] }]);
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Stories",
		urlPattern: "/stories/{slug}",
		fields: [],
	});
	const entryTarget = { kind: "entryTemplate" as const, postTypeId: postType.id };
	expect((await api.builder.destinations({ siteId, target: entryTarget })).reason).toBe("noEntries");
	const first = (await api.entries.create({ siteId, postTypeId: postType.id, title: "First" })).entry;
	await install.clock.advance(1000);
	await api.entries.create({ siteId, postTypeId: postType.id, title: "Newest" });
	const component = (await api.components.create({ siteId, name: "Inner", props: [] })).component;
	await api.components.saveMarkup({ siteId, componentId: component.id, markup: '<p data-wc-id="label">Inner</p>' });
	const outer = (await api.components.create({ siteId, name: "Outer", props: [] })).component;
	await api.components.saveMarkup({ siteId, componentId: outer.id, markup: '<Inner data-wc-id="inner" />' });
	await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<Outer data-wc-id="one" /><Outer data-wc-id="two" />{{@if false}}<Inner data-wc-id="absent" />{{/if}}',
	});
	expect((await api.builder.destinations({ siteId, target: entryTarget })).pages[0]?.path).toBe("/stories/newest");
	expect((await api.builder.destinations({ siteId, target: entryTarget, entryId: first.id })).pages[0]?.path).toBe(
		"/stories/first",
	);
	const destinations = await api.builder.destinations({
		siteId,
		target: { kind: "component", componentId: component.id },
	});
	expect(destinations.pages).toHaveLength(2);
	expect(destinations.pages[0]?.refs).toEqual(["content/one/inner", "content/two/inner"]);
	const destination = destinations.pages[0];
	if (!destination) throw new Error("Destination missing");
	const coding = await openCodeMode(install, staff, siteId, destination.path);
	await expectSafePage(await coding.page(destination.path), "editMode");
	const opened = await answer<{ target: unknown }>(
		coding.edit("code/editor", { path: destination.path, ref: destination.refs[1] }),
	);
	expect(opened.target).toEqual({ kind: "component", componentId: component.id });
	await api.templates.saveArchiveTemplateMarkup({ siteId, postTypeId: postType.id, markup: "<h1>Archive</h1>" });
	expect(
		(await api.builder.destinations({ siteId, target: { kind: "archiveTemplate", postTypeId: postType.id } })).pages[0]
			?.path,
	).toBe("/stories");
	expect((await api.builder.destinations({ siteId, target: { kind: "searchTemplate" } })).reason).toBe("noSearchPage");
	await api.pages.setSearchPage({ siteId, pageId: home.id });
	expect(await api.builder.destinations({ siteId, target: { kind: "searchTemplate" } })).toMatchObject({
		pages: [],
		reason: "saveFirst",
	});
	await api.templates.saveSearchTemplateMarkup({ siteId, markup: "<h1>Search</h1>" });
	expect((await api.builder.destinations({ siteId, target: { kind: "searchTemplate" } })).pages[0]?.path).toBe("/");
	await expect(api.builder.destinations({ siteId, target: entryTarget, entryId: home.id })).rejects.toMatchObject({
		code: "ENTRY_NOT_FOUND",
	});
});

test("a one-use two-origin handoff starts Code mode and carries structural selection, with fresh permission", async () => {
	const siteId = (await install.createSite(workspaceId)).id;
	const { url } = await staff.api.editMode.open({ siteId, path: "/", code: true, selection: "site#@1.0.0" });
	const browser = install.browser({ origin: new URL(url).origin });
	const response = await browser.request(url);
	expectSiteHeaders(response);
	expect(response.status).toBe(303);
	expect(response.headers.get("location")).toBe("/#wc-selection=site%23%401.0.0");
	expect(response.headers.get("set-cookie")).toContain("code=on");
	const replay = await browser.request(url);
	expectSiteHeaders(replay);
	expect(replay.status).toBe(403);
	const member = (await install.createMember({ workspaceId, role: "editor" })).browser;
	const ordinary = await member.api.editMode.open({ siteId });
	const tampered = new URL(ordinary.url);
	tampered.searchParams.set("code", "1");
	const refused = await install.browser({ origin: tampered.origin }).request(tampered.href);
	expectSiteHeaders(refused);
	expect(refused.status).toBe(403);
	expect(refused.headers.get("set-cookie") ?? "").not.toContain("code=on");
	await expect(member.api.editMode.open({ siteId, code: true })).rejects.toMatchObject({ code: "FORBIDDEN" });
	await expect(staff.api.editMode.open({ siteId, code: true, path: "//outside.test" })).rejects.toMatchObject({
		code: "EDIT_PATH_INVALID",
	});
});

test("an empty Component placed on a real page remains an editing destination", async () => {
	const siteId = (await install.createSite(workspaceId)).id;
	const api = staff.api;
	const { postType } = await api.postTypes.create({ siteId, name: "Stories", urlPattern: "/stories/{slug}" });
	await api.entries.create({ siteId, postTypeId: postType.id, title: "First" });
	const { component } = await api.components.create({ siteId, name: "Empty" });
	await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<Empty data-wc-id="empty" />{{@if false}}<Empty data-wc-id="absent" />{{/if}}',
	});
	const found = await api.builder.destinations({ siteId, target: { kind: "component", componentId: component.id } });
	expect(found.pages).toEqual([{ path: "/stories/first", title: "First", refs: ["content/empty"] }]);
	const coding = await openCodeMode(install, staff, siteId, "/stories/first");
	await expectSafePage(await coding.page("/stories/first"), "editMode");
	const response = await coding.edit("code/editor", { path: "/stories/first", ref: "content/empty" });
	expectSiteHeaders(response);
	expect(await answer<{ target: unknown }>(response)).toMatchObject({
		target: { kind: "component", componentId: component.id },
	});
});
