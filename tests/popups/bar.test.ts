import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { exportedArchive, importArchive, rewritten } from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";
import { publishEverything } from "../site-transfer/support.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});

test("an older Popup archive without Bar options reads and publishes as a bottom overlay", async () => {
	const admin = await install.superadmin();
	const { api } = admin;
	await api.modules.approve({ moduleId: "popups", version: "1.0.0" });
	const workspace = await install.createWorkspace();
	const siteId = (await install.createSite(workspace.id, { slug: "old-bar" })).id;
	const { popup } = await api.popups.create({ siteId, name: "Offer", key: "offer" });
	await api.popups.saveDraft({ siteId, popupId: popup.id, popup: { layout: "bar" } });
	await api.popups.saveContent({ siteId, popupId: popup.id, values: { title: "Offer", enabled: true } });
	const { postType } = await api.postTypes.create({ siteId, name: "Offers", urlPattern: "/offers/{slug}" });
	await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>{{@popup offer}}",
	});
	await api.entries.create({ siteId, postTypeId: postType.id, title: "Offers", slug: "today" });
	const older = rewritten(await exportedArchive(install, admin, siteId), {
		rows: (name, rows) => {
			if (name === "public.popups")
				for (const row of rows) {
					for (const version of [row.draft, row.published])
						if (version) {
							delete (version as Record<string, unknown>).barPosition;
							delete (version as Record<string, unknown>).barBehavior;
						}
				}
			return rows;
		},
	});
	const imported = await importArchive(install, admin, workspace.id, older, { name: "Older Bar", slug: "older-bar" });
	expect(imported.status).toBe("done");
	const copySiteId = imported.site?.id ?? "";
	const [copy] = (await api.popups.list({ siteId: copySiteId })).popups;
	expect(copy?.draft).toMatchObject({ layout: "bar", barPosition: "bottom", barBehavior: "overlay" });
	await publishEverything(admin, copySiteId);
	const origin = await goLive(install, copySiteId);
	const html = await expectSafePage(await install.request(`${origin}/offers/today`));
	expect(html).toContain('data-bar-position="bottom"');
	expect(html).toContain('data-bar-behavior="overlay"');
});
afterAll(async () => {
	await install.close();
});

test("Bar placement and page flow are Structure, default to a bottom overlay, and publish together", async () => {
	const { api } = await install.superadmin();
	await api.modules.approve({ moduleId: "popups", version: "1.0.0" });
	const workspace = await install.createWorkspace();
	const siteId = (await install.createSite(workspace.id, { slug: "bar-settings" })).id;
	const { popup } = await api.popups.create({ siteId, name: "Offer", key: "offer" });
	expect(popup.draft).toMatchObject({ barPosition: "bottom", barBehavior: "overlay" });
	await api.popups.saveDraft({
		siteId,
		popupId: popup.id,
		popup: { layout: "bar", barPosition: "top", barBehavior: "push" },
	});
	await api.popups.saveContent({ siteId, popupId: popup.id, values: { title: "Offer", enabled: true } });
	await api.popups.publish({ siteId, popupId: popup.id });
	await api.popups.publishContent({ siteId, popupId: popup.id });
	await api.popups.saveDraft({ siteId, popupId: popup.id, popup: { barPosition: "bottom", barBehavior: "overlay" } });
	const current = await api.popups.get({ siteId, popupId: popup.id });
	expect(current.popup.draft).toMatchObject({ barPosition: "bottom", barBehavior: "overlay" });
	expect(current.popup.published).toMatchObject({ barPosition: "top", barBehavior: "push" });
	const { postType } = await api.postTypes.create({ siteId, name: "Offers", urlPattern: "/offers/{slug}" });
	const { template } = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>{{@popup offer}}",
	});
	await api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Offers", slug: "today" });
	await api.entries.publish({ siteId, entryId: entry.id });
	const origin = await goLive(install, siteId);
	const html = await expectSafePage(await install.request(`${origin}/offers/today`));
	expect(html).toContain('data-bar-position="top"');
	expect(html).toContain('data-bar-behavior="push"');
	const member = (await install.createMember({ workspaceId: workspace.id, role: "owner" })).browser;
	await expect(
		member.api.popups.saveDraft({ siteId, popupId: popup.id, popup: { barPosition: "top" } }),
	).rejects.toMatchObject({ code: "FORBIDDEN" });
});
