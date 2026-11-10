import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

test("Staff choose a Social card layout per Site, override it per Post Type and switch cards off", async () => {
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const staff = (await install.createStaff({ workspaces: [workspace.id] })).browser;
	const owner = (await install.createMember({ workspaceId: workspace.id, role: "owner" })).browser;
	const { settings } = await staff.api.seoSettings.get({ siteId: site.id });
	expect(settings).toMatchObject({ socialCards: { enabled: true, layout: "editorial" } });
	await staff.api.seoSettings.update({ siteId: site.id, socialCards: { enabled: false, layout: "orbit" } });
	expect((await owner.api.seoSettings.get({ siteId: site.id })).settings).toMatchObject({
		socialCards: { enabled: false, layout: "orbit" },
	});
	const { postType } = await staff.api.postTypes.create({
		siteId: site.id,
		name: "News",
		urlPattern: "/news/{slug}",
		seo: { socialCardLayout: "frame" },
	});
	expect(postType.seo).toMatchObject({ socialCardLayout: "frame" });
	await staff.api.seoSettings.update({ siteId: site.id, socialCards: { enabled: true } });
	const { entry } = await owner.api.entries.create({
		siteId: site.id,
		postTypeId: postType.id,
		title: "A future page",
	});
	expect(entry.seoPreview.image).toEqual({ from: "socialCard", layout: "frame", state: "onPublish" });
	expect(entry.checks.map((check) => check.check)).not.toContain("seoImageMissing");
	expect(
		(await staff.api.postTypes.update({ siteId: site.id, postTypeId: postType.id, seo: { socialCardLayout: null } }))
			.postType.seo,
	).toMatchObject({ socialCardLayout: null });
	await expect(owner.api.seoSettings.update({ siteId: site.id, socialCards: { enabled: true } })).rejects.toMatchObject(
		{ code: "FORBIDDEN" },
	);
	await expect(
		owner.api.postTypes.update({ siteId: site.id, postTypeId: postType.id, seo: { socialCardLayout: "frame" } }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
	const other = await install.createWorkspace();
	const outsider = (await install.createStaff({ workspaces: [other.id] })).browser;
	await expect(
		outsider.api.seoSettings.update({ siteId: site.id, socialCards: { enabled: true } }),
	).rejects.toBeDefined();
	await expect(
		staff.api.seoSettings.update({ siteId: site.id, socialCards: { layout: "unknown" as never } }),
	).rejects.toBeDefined();
});
