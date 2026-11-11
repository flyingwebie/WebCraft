import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DocumentJson } from "@webcraft/core";
import { openDraft, openDraftInEditMode, upgradeDraft } from "../harness/co-editing.ts";
import { answer, openCodeMode } from "../harness/code-mode.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage, expectSiteHeaders } from "../harness/site-safety.ts";
import { exportedArchive, importArchive } from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";
import { sample } from "../modules/sample/index.ts";
import { publishEverything } from "../site-transfer/support.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

test("read-only Module Components keep their Props and page usage in the live panels", async () => {
	const catalogueInstall = await createTestInstall({ modules: [sample] });
	try {
		const { api } = await catalogueInstall.superadmin();
		await api.modules.approve({ moduleId: "sample", version: "1.0.0" });
		const workspace = await catalogueInstall.createWorkspace("Module layers");
		const { id: siteId } = await catalogueInstall.createSite(workspace.id, { slug: "module-layers" });
		const staff = (await catalogueInstall.createStaff({ workspaces: [workspace.id] })).browser;
		const { postType } = await api.postTypes.create({ siteId, name: "Stories", urlPattern: "/{slug}" });
		const { template } = await api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: '<NoteCard data-wc-id="placed" body="{{ title }}" />',
		});
		await api.templates.publish({ siteId, templateId: template.id });
		for (const slug of ["first", "second"]) {
			const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title: slug, slug });
			await api.entries.publish({ siteId, entryId: entry.id });
		}
		const code = await openCodeMode(catalogueInstall, staff, siteId, "/first");
		const response = await code.edit("code/editor", { path: "/first", ref: "content/placed" });
		expectSiteHeaders(response);
		const result = await answer<{
			editable: boolean;
			opened: { usage: { pages: number } | null; component: unknown; props: unknown[] };
		}>(Promise.resolve(response));
		expect(result.editable).toBe(false);
		expect(result.opened.component).toBeNull();
		expect(result.opened.props).toContainEqual(expect.objectContaining({ key: "body", required: true }));
		expect(result.opened.usage).toEqual({ pages: 2 });
	} finally {
		await catalogueInstall.close();
	}
});

test("Hidden placement is a shared, validated Draft setting and survives a Site transfer", async () => {
	const { api } = await install.superadmin();
	const workspace = await install.createWorkspace("Hidden placements");
	const site = await install.createSite(workspace.id, { name: "Hidden placements", slug: "hidden-placements" });
	const staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	const { component } = await api.components.create({ siteId: site.id, name: "Notice" });
	await api.components.saveMarkup({
		siteId: site.id,
		componentId: component.id,
		markup: '<p data-wc-id="notice">A private draft notice</p>',
	});
	await api.components.publish({ siteId: site.id, componentId: component.id });
	const { template } = await api.templates.saveSiteTemplateMarkup({
		siteId: site.id,
		markup: '<header><Notice data-wc-id="placed" /></header><main>{{@outlet}}</main>',
	});
	const { postType } = await api.postTypes.create({ siteId: site.id, name: "Stories", urlPattern: "/{slug}" });
	const body = await api.templates.saveEntryTemplateMarkup({
		siteId: site.id,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>",
	});
	await api.templates.publish({ siteId: site.id, templateId: body.template.id });
	const { entry } = await api.entries.create({
		siteId: site.id,
		postTypeId: postType.id,
		title: "Example",
		slug: "example",
	});
	await api.entries.publish({ siteId: site.id, entryId: entry.id });
	const code = await openCodeMode(install, staff, site.id, "/example");
	const opened = await answer<{ opened: { template: { id: string }; tree: unknown } }>(
		code.edit("code/editor", { path: "/example", ref: "site" }),
	);
	expect(opened.opened.template.id).toBe(template.id);
	const first = await openDraftInEditMode(code, { kind: "template", id: template.id });
	const second = await openDraft(install, staff, site.id, { kind: "template", id: template.id });
	first.change((current) => {
		const draft = JSON.parse(JSON.stringify(current));
		draft.nodes[0].children[0].hidden = true;
		return draft as DocumentJson;
	});
	await first.saved();
	expect(first.refusals).toEqual([]);
	await second.untilDraft(
		(draft) => JSON.stringify(draft).includes('"hidden":true'),
		"Hidden placement reaches the co-editor",
	);
	first.change((current) => {
		const draft = JSON.parse(JSON.stringify(current));
		draft.nodes[0].children[0].hidden = "sometimes";
		return draft as DocumentJson;
	});
	await first.until(() => first.refusals.length === 1, "invalid Hidden placement is refused");
	expect(first.refusals[0]?.code).toBe("TEMPLATE_INVALID");
	await first.untilDraft((draft) => !JSON.stringify(draft).includes("sometimes"), "the validated Draft is restored");
	const markup = (await api.templates.getSiteTemplateMarkup({ siteId: site.id })).markup?.draft ?? "";
	expect(markup).toContain("data-wc-hidden");
	await api.templates.saveSiteTemplateMarkup({ siteId: site.id, markup });
	await api.templates.publish({ siteId: site.id, templateId: template.id });
	const origin = await goLive(install, site.id);
	expect(await expectSafePage(await install.request(`${origin}/example`))).not.toContain("A private draft notice");
	expect(await expectSafePage(await code.page("/example"))).toContain("A private draft notice");
	first.close();
	second.close();
	const copied = await importArchive(install, staff, workspace.id, await exportedArchive(install, staff, site.id), {
		name: "Hidden copy",
		slug: "hidden-copy",
	});
	expect(copied.status).toBe("done");
	const siteId = copied.site?.id ?? "";
	expect((await api.templates.getSiteTemplateMarkup({ siteId })).markup?.draft).toContain("data-wc-hidden");
	await publishEverything(staff, siteId);
	const copyOrigin = await goLive(install, siteId);
	expect(await expectSafePage(await install.request(`${copyOrigin}/example`))).not.toContain("A private draft notice");
});

test("live panel services retain Site permissions, tenant boundaries and existing validation", async () => {
	const { api } = await install.superadmin();
	const workspace = await install.createWorkspace("Panel permissions");
	const site = await install.createSite(workspace.id, { name: "Ours", slug: "panel-permissions" });
	const foreign = await install.createSite(workspace.id, { name: "Another Site", slug: "other-panels" });
	const staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	const member = (await install.createMember({ workspaceId: workspace.id, role: "editor" })).browser;
	const { postType } = await api.postTypes.create({ siteId: foreign.id, name: "Private type", urlPattern: "/{slug}" });
	const coding = await openCodeMode(install, staff, site.id);
	const editing = await openEditMode(install, member, site.id);
	for (const [action, body] of [
		["code/editor", { path: "/", ref: "site" }],
		["code/editorRead", { path: "/", ref: "site", markup: "<p>Test</p>" }],
		["code/editorMarkup", { path: "/", ref: "site", draft: { tree: { version: 1, nodes: [] } } }],
		["code/editorService", { method: "globals.get", input: {} }],
	] as const) {
		const refused = await editing.edit(action, body);
		expectSiteHeaders(refused);
		expect(refused.status).toBe(403);
		const noToken = await coding.edit(action, body, { headerToken: null });
		expectSiteHeaders(noToken);
		expect(noToken.status).toBe(403);
	}
	const wrongSite = await coding.edit("code/editorService", {
		method: "postTypes.update",
		input: { siteId: foreign.id, postTypeId: postType.id, fields: [] },
	});
	expectSiteHeaders(wrongSite);
	expect(wrongSite.status).toBe(404);
	const invalid = await coding.edit("code/editorRead", { path: "/", ref: "site", markup: "<script>alert(1)</script>" });
	expectSiteHeaders(invalid);
	expect(invalid.status).toBe(400);
	const design = await openDraftInEditMode(coding, { kind: "designSystem" });
	const memberDesign = await upgradeDraft(install, member, site.id, { kind: "designSystem" });
	expect(memberDesign instanceof Response && memberDesign.status).toBe(403);
	const made = await coding.edit("code/editorService", {
		method: "classes.create",
		input: { siteId: foreign.id, name: "local-panel-class" },
	});
	expectSiteHeaders(made);
	expect(made.status).toBe(200);
	await design.untilDraft(
		(draft) => JSON.stringify(draft).includes("local-panel-class"),
		"a Class write reaches the shared Design system",
	);
	design.close();
	expect(JSON.stringify(await api.designSystem.get({ siteId: foreign.id }))).not.toContain("local-panel-class");
	expect(JSON.stringify(await api.designSystem.get({ siteId: site.id }))).toContain("local-panel-class");
});

test("a canonical API deletion reaches an already open Template Draft and stays deleted", async () => {
	const workspace = await install.createWorkspace("Deleting layers");
	const site = await install.createSite(workspace.id, { name: "Delete layers", slug: "delete-layers" });
	const staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	const saved = await staff.api.templates.saveSiteTemplateMarkup({
		siteId: site.id,
		markup:
			'<header data-wc-id="header"><p data-wc-id="keep">Keep me</p><p data-wc-id="remove">Remove me</p></header><main data-wc-id="main">{{@outlet}}</main>',
	});
	const code = await openCodeMode(install, staff, site.id);
	const peer = await openDraftInEditMode(code, { kind: "template", id: saved.template.id });
	try {
		await staff.api.templates.saveSiteTemplateMarkup({
			siteId: site.id,
			markup:
				'<header data-wc-id="header"><p data-wc-id="keep">Keep me</p></header><main data-wc-id="main">{{@outlet}}</main>',
		});
		await peer.untilDraft(
			(draft) => !JSON.stringify(draft).includes("Remove me"),
			"API deletion reaches the live editor",
		);
		peer.change((current) => {
			const draft = JSON.parse(JSON.stringify(current));
			draft.nodes[0].label = "Still here";
			return draft as DocumentJson;
		});
		await peer.saved();
		expect((await staff.api.templates.getSiteTemplateMarkup({ siteId: site.id })).markup?.draft).not.toContain(
			"Remove me",
		);
	} finally {
		peer.close();
	}
});
