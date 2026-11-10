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
	const { entry: excluded } = await staff.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Excluded",
		slug: "excluded",
	});
	const { postType: otherType } = await staff.api.postTypes.create({
		siteId,
		name: "Other offers",
		urlPattern: "/other/{slug}",
	});
	const literal = `A seasonal promotion ${entry.id} ${media.id}`;
	const { component: image } = await staff.api.components.create({
		siteId,
		name: "PromoImage",
		props: [
			{ key: "photo", label: "Photo", type: "media" },
			{ key: "reference", label: "Reference", type: "text" },
		],
	});
	await staff.api.components.saveMarkup({
		siteId,
		componentId: image.id,
		markup: '<img src="{{ props.photo }}" alt="Transferred photo"><p>{{ props.reference }}</p>',
	});
	await staff.api.components.publish({ siteId, componentId: image.id });
	const { popup } = await staff.api.popups.create({ siteId, name: "Seasonal", key: "seasonal" });
	await staff.api.components.saveMarkup({
		siteId,
		componentId: popup.componentId,
		markup: `<p>{{ props.text }}</p><img src="{{ props.image }}"><PromoImage photo="media:${media.id}" reference="${entry.id}"/>`,
	});
	await staff.api.popups.saveDraft({
		siteId,
		popupId: popup.id,
		popup: {
			rules: {
				paths: ["/offers/*"],
				postTypeIds: [postType.id],
				entryIds: [entry.id],
				excludePostTypeIds: [otherType.id],
				excludeEntryIds: [excluded.id],
				languages: [],
				devices: ["phone", "tablet", "desktop"],
				visitors: "all",
			},
		},
	});
	await staff.api.popups.saveContent({
		siteId,
		popupId: popup.id,
		values: { title: `Offer ${entry.id}`, text: literal, enabled: true, image: media.id },
	});
	await staff.api.popups.saveContent({ siteId, popupId: popup.id, language: "it", values: { title: "Offerta" } });
	await staff.api.popups.publish({ siteId, popupId: popup.id });
	await staff.api.popups.publishContent({ siteId, popupId: popup.id });
	await staff.api.components.saveMarkup({
		siteId,
		componentId: popup.componentId,
		markup: "<p>Unpublished Popup tree</p>",
	});
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
	for (const old of [siteId, popup.id, popup.componentId, postType.id, otherType.id, entry.id, excluded.id])
		expect(JSON.stringify([copied.id, copied.siteId, copied.componentId, copied.draft.rules])).not.toContain(old);
	const copiedMediaId = content.content.draft.values.image;
	expect(copiedMediaId).toEqual(expect.any(String));
	expect(copiedMediaId).not.toBe(media.id);
	expect(content.content.draft.values.text).toContain(literal);
	expect(
		(await targetStaff.api.popups.get({ siteId: targetId, popupId: copied.id, language: "en" })).content.draft.values
			.title,
	).toBe(`Offer ${entry.id}`);
	expect(
		(await targetStaff.api.modules.siteList({ siteId: targetId })).modules.find((m) => m.id === "popups")?.on,
	).toBe(false);
	const copiedPostType = (await targetStaff.api.postTypes.list({ siteId: targetId })).postTypes.find(
		(type) => type.key === "offers",
	);
	const copiedTemplate = await targetStaff.api.templates.getEntryTemplateMarkup({
		siteId: targetId,
		postTypeId: copiedPostType?.id ?? "",
	});
	expect(copiedTemplate.template?.draft.nodes[1]).toEqual({ type: "popup", popup: copied.id });
	expect(copiedTemplate.markup?.draft).toContain("{{@popup seasonal}}");
	expect(
		(await targetStaff.api.components.getMarkup({ siteId: targetId, componentId: copied.componentId })).markup.draft,
	).toContain("Unpublished Popup tree");
	for (const kind of ["popup", "popupContent"] as const) {
		const item = { kind, id: copied.id };
		const history = await targetStaff.api.history.list({ siteId: targetId, item });
		const revision = history.copies.find((copy) => copy.type === "revision");
		expect(revision).toBeDefined();
		await targetStaff.api.history.restore({
			siteId: targetId,
			item,
			copy: { type: "revision", id: revision?.id ?? "" },
		});
	}
	const restored = await targetStaff.api.popups.get({ siteId: targetId, popupId: copied.id });
	expect(restored.content.draft.values.image).toBe(copiedMediaId);
	expect(restored.content.draft.values.text).toContain(literal);
	expect(restored.popup.draft.rules).toEqual(copied.draft.rules);
	const restoredTree = await targetStaff.api.components.getMarkup({
		siteId: targetId,
		componentId: copied.componentId,
	});
	expect(restoredTree.markup.draft).toContain("<PromoImage");
	expect(restoredTree.markup.draft).toContain(`photo="media:${copiedMediaId}"`);
	expect(restoredTree.markup.draft).toContain(`reference="${entry.id}"`);
	expect(restoredTree.markup.draft).not.toContain("Unpublished Popup tree");
	await targetStaff.api.modules.setOnSite({ siteId: targetId, moduleId: "popups", on: true });
	await publishEverything(targetStaff, targetId);
	const origin = await goLive(install, targetId);
	const html = await expectSafePage(await install.request(`${origin}/offers/welcome`));
	expect(html).toContain(literal);
	expect(html).toContain("data-wc-popup=");
	expect(html).toContain("/_media/");
	const imageSource = /<img\b[^>]*\bsrc="([^"]+)"/.exec(html)?.[1];
	expect(imageSource).toEqual(expect.any(String));
	expect(imageSource).not.toContain(media.id);
});
