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

test("a Module used only inside a hidden Popup declares its consented script, and switching it off removes its output", async () => {
	const { api } = await install.superadmin();
	await api.modules.approve({ moduleId: "popups", version: "1.0.0" });
	await api.modules.approve({ moduleId: "extra-blocks", version: "1.0.0" });
	const workspace = await install.createWorkspace();
	const siteId = (await install.createSite(workspace.id, { slug: "popup-block" })).id;
	const { popup } = await api.popups.create({ siteId, name: "Offer", key: "offer" });
	await api.components.saveMarkup({
		siteId,
		componentId: popup.componentId,
		markup: `<Tabs label="Offer details" items='${JSON.stringify([{ heading: "Details", text: "An offer" }])}'/>`,
	});
	await api.popups.saveContent({ siteId, popupId: popup.id, values: { title: "Offer", enabled: true } });
	await api.popups.publish({ siteId, popupId: popup.id });
	await api.popups.publishContent({ siteId, popupId: popup.id });
	const { postType } = await api.postTypes.create({ siteId, name: "Offers", urlPattern: "/offers/{slug}" });
	const { template } = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>{{@popup offer}}",
	});
	await api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Offers", slug: "details" });
	await api.entries.publish({ siteId, entryId: entry.id });
	const origin = await goLive(install, siteId);
	const html = await expectSafePage(await install.request(`${origin}/offers/details`));
	expect(html).toContain('data-extra-block="tabs"');
	expect(html).toContain('data-wc-module="extra-blocks"');
	expect(html).toContain('data-wc-consent="media"');
	await api.modules.setOnSite({ siteId, moduleId: "extra-blocks", on: false });
	const disabled = await expectSafePage(await install.request(`${origin}/offers/details`));
	expect(disabled).not.toContain('data-extra-block="tabs"');
	expect(disabled).not.toContain('data-wc-module="extra-blocks"');
	expect(disabled).toContain("data-wc-popup=");
});
