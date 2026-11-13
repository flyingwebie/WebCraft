import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { exportedArchive, importArchive } from "../harness/site-transfer.ts";
import { sample } from "../modules/sample/index.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall({ modules: [sample] });
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });
});
afterAll(async () => {
	await install.close();
});
test("Module Page Placements transfer their declared Props without inventing declaration identities", async () => {
	const admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId, { slug: "layout-module" })).id;
	const pageType = (await admin.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	if (!pageType) throw new Error("Missing Page Post Type");
	const { entry } = await admin.api.entries.create({ siteId, postTypeId: pageType.id, title: "Module Page" });
	const { component } = await admin.api.components.get({ siteId, componentId: "sample:NoteCard" });
	await admin.api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [component.id] });
	const state = await admin.api.pageLayouts.get({ siteId, entryId: entry.id });
	await admin.api.pageLayouts.save({
		siteId,
		entryId: entry.id,
		basedOn: state.version,
		layout: {
			placements: [
				{
					id: "module-card",
					component: component.id,
					props: component.draft.props,
					values: { body: { en: "From the Module" } },
				},
			],
		},
	});
	await admin.api.entries.publish({ siteId, entryId: entry.id });
	const copied = await importArchive(install, admin, workspaceId, await exportedArchive(install, admin, siteId), {
		name: "Module copy",
		slug: "layout-module-copy",
	});
	const destination = copied.site?.id;
	if (!destination) throw new Error("Missing copied Site");
	const type = (await admin.api.postTypes.list({ siteId: destination })).postTypes.find(
		(type) => type.builtIn === "page",
	);
	if (!type) throw new Error("Missing copied Page Post Type");
	const [page] = (await admin.api.entries.list({ siteId: destination, postTypeId: type.id })).entries;
	if (!page) throw new Error("Missing copied Page");
	const result = await admin.api.pageLayouts.get({ siteId: destination, entryId: page.id });
	expect(result.placements[0]?.props).toEqual(component.draft.props);
	expect(result.placements[0]?.values).toEqual({ body: "From the Module", tone: "calm" });
	expect(result.settings.allowedComponents).toEqual([component.id]);
});
