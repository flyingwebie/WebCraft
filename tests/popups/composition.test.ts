import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});
test("a Popup's Component can attach another Popup, including a link back, without repeating dialogs", async () => {
	const { api } = await install.superadmin();
	await api.modules.approve({ moduleId: "popups", version: "1.0.0" });
	const workspace = await install.createWorkspace();
	const siteId = (await install.createSite(workspace.id, { slug: "nested-popups" })).id;
	await goLive(install, siteId);
	const { postType } = await api.postTypes.create({ siteId, name: "Offers", urlPattern: "/offers/{slug}" });
	const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Offers", slug: "welcome" });
	const { template } = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>",
	});
	await api.templates.publish({ siteId, templateId: template.id });
	await api.entries.publish({ siteId, entryId: entry.id });
	const { popup: next } = await api.popups.create({ siteId, name: "Details", key: "details" });
	await api.popups.saveDraft({
		siteId,
		popupId: next.id,
		popup: { rules: { ...next.draft.rules, paths: ["/elsewhere"] } },
	});
	await api.popups.saveContent({ siteId, popupId: next.id, values: { title: "Details", enabled: true } });
	await api.popups.publish({ siteId, popupId: next.id });
	await api.popups.publishContent({ siteId, popupId: next.id });
	const { popup: first } = await api.popups.create({ siteId, name: "Offer", key: "offer" });
	await api.popups.saveDraft({ siteId, popupId: first.id, popup: { trigger: { kind: "load" } } });
	await api.components.saveMarkup({ siteId, componentId: first.componentId, markup: "{{@popup details}}" });
	await api.popups.saveContent({ siteId, popupId: first.id, values: { title: "Offer", enabled: true } });
	await api.popups.publish({ siteId, popupId: first.id });
	await api.popups.publishContent({ siteId, popupId: first.id });
	await api.components.saveMarkup({ siteId, componentId: next.componentId, markup: "{{@popup offer}}" });
	await api.popups.publish({ siteId, popupId: next.id });
	const html = await expectSafePage(await install.request("https://nested-popups.live.test/offers/welcome"));
	expect(html).toContain(`data-popup-id="${first.id}"`);
	expect(html).toContain(`data-popup-id="${next.id}"`);
	expect([...html.matchAll(/<template data-site=/g)]).toHaveLength(2);
	expect(html).toContain('href="#popup-details"');
});
