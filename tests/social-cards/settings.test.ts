import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { rejection } from "../harness/settled.ts";

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
	expect(
		await rejection(owner.api.seoSettings.update({ siteId: site.id, socialCards: { enabled: true } })),
	).toMatchObject({ code: "FORBIDDEN" });
	expect(
		await rejection(
			owner.api.postTypes.update({ siteId: site.id, postTypeId: postType.id, seo: { socialCardLayout: "frame" } }),
		),
	).toMatchObject({ code: "FORBIDDEN" });
	const other = await install.createWorkspace();
	const outsider = (await install.createStaff({ workspaces: [other.id] })).browser;
	expect(
		await rejection(outsider.api.seoSettings.update({ siteId: site.id, socialCards: { enabled: true } })),
	).toBeDefined();
	expect(
		await rejection(staff.api.seoSettings.update({ siteId: site.id, socialCards: { layout: "unknown" as never } })),
	).toBeDefined();
});
