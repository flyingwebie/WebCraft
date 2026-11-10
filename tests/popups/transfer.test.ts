import { afterAll, beforeAll, expect, test } from "bun:test";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { exportedArchive, importArchive } from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";
import { publishEverything } from "../site-transfer/support.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});
test("Site export/import remaps Popup references, keeps its Module switch and imports both layers as Drafts", async () => {
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "popups", version: "1.0.0" });
	const workspaceId = (await install.createWorkspace()).id;
	const siteId = (await install.createSite(workspaceId, { slug: "popup-source" })).id;
	const staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	await staff.api.languages.add({ siteId, code: "it" });
	const { media } = await staff.api.media.upload({
		siteId,
		file: upload(await photo({ width: 100, height: 80 }), "promotion.jpg"),
	});
	await install.drainJobs();
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Offers",
		key: "offers",
		urlPattern: "/offers/{slug}",
	});
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Welcome",
		slug: "welcome",
	});
	const { popup } = await staff.api.popups.create({ siteId, name: "Seasonal", key: "seasonal" });
	await staff.api.components.saveMarkup({
		siteId,
		componentId: popup.componentId,
		markup: '<p>{{ props.text }}</p><img src="{{ props.image }}">',
	});
	await staff.api.popups.saveDraft({
		siteId,
		popupId: popup.id,
		popup: {
			rules: {
				paths: ["/offers/*"],
				postTypeIds: [postType.id],
				entryIds: [entry.id],
				languages: [],
				devices: ["phone", "tablet", "desktop"],
				visitors: "all",
			},
		},
	});
	await staff.api.popups.saveContent({
		siteId,
		popupId: popup.id,
		values: { title: "Offer", text: "A seasonal promotion", enabled: true, image: media.id },
	});
	await staff.api.popups.saveContent({ siteId, popupId: popup.id, language: "it", values: { title: "Offerta" } });
	await staff.api.popups.publish({ siteId, popupId: popup.id });
	await staff.api.popups.publishContent({ siteId, popupId: popup.id });
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>{{@popup seasonal}}",
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.modules.setOnSite({ siteId, moduleId: "popups", on: false });
	const archive = await exportedArchive(install, staff, siteId);
	const targetWs = (await install.createWorkspace()).id;
	const targetStaff = (await install.createStaff({ workspaces: [targetWs] })).browser;
	const imported = await importArchive(install, targetStaff, targetWs, archive, {
		name: "Imported promotions",
		slug: "popup-copy",
	});
	expect(imported.status).toBe("done");
	const targetId = imported.site?.id;
	if (!targetId) throw new Error("Imported Site missing");
	const [copied] = (await targetStaff.api.popups.list({ siteId: targetId })).popups;
	expect(copied).toBeDefined();
	if (!copied) throw new Error("No imported Popup");
	expect(copied.published).toBeNull();
	const content = await targetStaff.api.popups.get({ siteId: targetId, popupId: copied.id, language: "it" });
	expect(content.content.published).toBeNull();
	expect(content.content.draft.values.title).toBe("Offerta");
	expect(content.content.draft.values.enabled).toBe(true);
	for (const old of [siteId, popup.id, popup.componentId, postType.id, entry.id, media.id])
		expect(JSON.stringify(content)).not.toContain(old);
	expect(
		(await targetStaff.api.modules.siteList({ siteId: targetId })).modules.find((m) => m.id === "popups")?.on,
	).toBe(false);
	const history = await targetStaff.api.history.list({ siteId: targetId, item: { kind: "popup", id: copied.id } });
	expect(history.copies.some((copy) => copy.type === "revision")).toBe(true);
	await targetStaff.api.modules.setOnSite({ siteId: targetId, moduleId: "popups", on: true });
	await publishEverything(targetStaff, targetId);
	const origin = await goLive(install, targetId);
	const html = await expectSafePage(await install.request(`${origin}/offers/welcome`));
	expect(html).toContain("A seasonal promotion");
	expect(html).toContain("data-wc-popup=");
	expect(html).toContain("/_media/");
	expect(html).not.toContain(media.id);
});
