import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let sequence = 0;
beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "popups", version: "1.0.0" });
});

test("API publishing clients are directed to the Popup before previewing or scheduling its backing Component", async () => {
	const fixture = await scene();
	await fixture.change();
	const { siteId, popup } = fixture;
	const { secret } = await createApiToken(fixture.admin, {
		workspaceId: fixture.workspaceId,
		name: "Popup publisher",
		toolsets: ["publishing"],
	});
	const { api } = tokenClient(install, secret);
	const refusal = { code: "POPUP_PUBLISH_REQUIRED", data: { item: { kind: "popup", id: popup.id } } };
	await expect(api.components.publish({ siteId, componentId: popup.componentId })).rejects.toMatchObject(refusal);
	await expect(
		api.publishing.schedule({
			siteId,
			item: { kind: "component", id: popup.componentId },
			at: new Date(install.clock.now().getTime() + 60_000),
		}),
	).rejects.toMatchObject(refusal);
	const preview = (await api.popups.publish({ siteId, popupId: popup.id })) as unknown as {
		preview: { item: unknown };
		confirmation: { id: string };
	};
	expect(preview.preview.item).toEqual({ kind: "popup", id: popup.id });
	expect(await fixture.html()).toContain("Original Popup tree");
	await api.popups.publish({ siteId, popupId: popup.id, confirmation: preview.confirmation.id });
	expect(await fixture.html()).toContain("Changed Popup tree");
	expect((await fixture.api.popups.get({ siteId, popupId: popup.id })).popup.published?.layout).toBe("bar");
});

test("a schedule freezes the whole Popup and refuses its backing Component on its own", async () => {
	const fixture = await scene();
	await fixture.change();
	const { api, siteId, popup } = fixture;
	const at = new Date(install.clock.now().getTime() + 60_000);
	await expect(
		api.publishing.schedule({ siteId, item: { kind: "component", id: popup.componentId }, at }),
	).rejects.toMatchObject({ code: "POPUP_PUBLISH_REQUIRED" });
	await api.publishing.schedule({ siteId, item: { kind: "popup", id: popup.id }, at });
	await api.popups.saveDraft({ siteId, popupId: popup.id, popup: { layout: "slide-in" } });
	await api.components.saveMarkup({ siteId, componentId: popup.componentId, markup: "<p>Later unscheduled tree</p>" });
	install.clock.advance(60_000);
	expect((await install.drainJobs()).failed).toEqual([]);
	const html = await fixture.html();
	expect(html).toContain("Changed Popup tree");
	expect(html).not.toContain("Later unscheduled tree");
	expect(html).not.toContain("Unrelated pending Component");
	expect((await api.popups.get({ siteId, popupId: popup.id })).popup.published).toMatchObject({
		layout: "bar",
		barPosition: "top",
		barBehavior: "push",
	});
	expect((await fixture.history()).copies.filter((copy) => copy.type === "revision")).toHaveLength(2);
});

test("Publish all includes the Popup once, and a retained Component publishes normally after its Popup is deleted", async () => {
	const fixture = await scene();
	await fixture.change();
	const { api, siteId, popup } = fixture;
	const drafts = (await api.publishing.drafts({ siteId })).drafts;
	expect(drafts.filter((draft) => draft.item.kind === "popup" && draft.item.id === popup.id)).toHaveLength(1);
	expect(drafts.some((draft) => draft.item.kind === "component" && draft.item.id === popup.componentId)).toBe(false);
	await expect(
		api.publishing.publishAll({ siteId, items: [{ kind: "component", id: popup.componentId }] }),
	).rejects.toMatchObject({ code: "PUBLISH_ALL_INVALID" });
	const items = [{ kind: "popup" as const, id: popup.id }];
	const preview = await api.publishing.publishAll({ siteId, items });
	if (preview.published) throw new Error("Expected a confirmation");
	await api.publishing.publishAll({ siteId, items, confirmation: preview.confirmation.id });
	expect(await fixture.html()).toContain("Changed Popup tree");
	expect(await fixture.html()).not.toContain("Unrelated pending Component");
	const foreign = (await install.createSite(fixture.workspaceId)).id;
	await expect(api.components.publish({ siteId: foreign, componentId: popup.componentId })).rejects.toMatchObject({
		code: "COMPONENT_NOT_FOUND",
	});
	const removal = await api.popups.delete({ siteId, popupId: popup.id });
	if (removal.deleted) throw new Error("Expected a confirmation");
	await api.popups.delete({ siteId, popupId: popup.id, confirmation: removal.confirmation.id });
	await api.components.saveMarkup({
		siteId,
		componentId: popup.componentId,
		markup: "<p>Retained reusable Component</p>",
	});
	await api.components.publish({ siteId, componentId: popup.componentId });
	expect(await fixture.html()).toContain("Retained reusable Component");
});

test("Publish all orders a new Popup between the Components it uses and those reusing its tree", async () => {
	const { api } = await install.superadmin();
	const workspace = await install.createWorkspace();
	const siteId = (await install.createSite(workspace.id)).id;
	const { component: leaf } = await api.components.create({ siteId, name: "Leaf" });
	await api.components.saveMarkup({ siteId, componentId: leaf.id, markup: "<p>Shared details</p>" });
	const { popup } = await api.popups.create({ siteId, name: "Offer", key: "offer" });
	await api.components.saveMarkup({ siteId, componentId: popup.componentId, markup: "<Leaf/>" });
	const backing = (await api.components.get({ siteId, componentId: popup.componentId })).component;
	const { component: wrapper } = await api.components.create({ siteId, name: "Wrapper" });
	await api.components.saveMarkup({ siteId, componentId: wrapper.id, markup: `<${backing.name}/>` });
	const items = [
		{ kind: "component" as const, id: wrapper.id },
		{ kind: "popup" as const, id: popup.id },
		{ kind: "component" as const, id: leaf.id },
	];
	const preview = await api.publishing.publishAll({ siteId, items });
	if (preview.published) throw new Error("Expected a confirmation");
	expect(preview.preview.items.map((item) => item.item)).toEqual([
		{ kind: "component", id: leaf.id },
		{ kind: "popup", id: popup.id },
		{ kind: "component", id: wrapper.id },
	]);
	const done = await api.publishing.publishAll({ siteId, items, confirmation: preview.confirmation.id });
	expect(done.published).toBe(true);
	expect((await api.components.getMarkup({ siteId, componentId: wrapper.id })).markup.published).toContain(
		backing.name,
	);
	expect((await api.popups.get({ siteId, popupId: popup.id })).popup.published).not.toBeNull();
});
afterAll(async () => {
	await install.close();
});

async function scene() {
	const admin = await install.superadmin();
	const { api } = admin;
	const workspace = await install.createWorkspace();
	const siteId = (await install.createSite(workspace.id, { slug: `popup-publication-${++sequence}` })).id;
	const { popup } = await api.popups.create({ siteId, name: "Offer", key: "offer" });
	await api.components.saveMarkup({ siteId, componentId: popup.componentId, markup: "<p>Original Popup tree</p>" });
	await api.popups.saveContent({ siteId, popupId: popup.id, values: { title: "Offer", enabled: true } });
	await api.popups.publish({ siteId, popupId: popup.id });
	await api.popups.publishContent({ siteId, popupId: popup.id });
	const { component } = await api.components.create({ siteId, name: "Other" });
	await api.components.saveMarkup({ siteId, componentId: component.id, markup: "<p>Original other Component</p>" });
	await api.components.publish({ siteId, componentId: component.id });
	const { postType } = await api.postTypes.create({ siteId, name: "Offers", urlPattern: "/offers/{slug}" });
	const backing = (await api.components.get({ siteId, componentId: popup.componentId })).component;
	const { template } = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<h1>{{ title }}</h1>{{@popup offer}}<${backing.name}/><Other/>`,
	});
	await api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Offers", slug: "today" });
	await api.entries.publish({ siteId, entryId: entry.id });
	const origin = await goLive(install, siteId);
	const history = () => api.history.list({ siteId, item: { kind: "popup", id: popup.id } });
	const html = async () => expectSafePage(await install.request(`${origin}/offers/today`));
	const change = async () => {
		await api.popups.saveDraft({
			siteId,
			popupId: popup.id,
			popup: { layout: "bar", barPosition: "top", barBehavior: "push" },
		});
		await api.components.saveMarkup({ siteId, componentId: popup.componentId, markup: "<p>Changed Popup tree</p>" });
		await api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: "<p>Unrelated pending Component</p>",
		});
	};
	return { admin, api, workspaceId: workspace.id, siteId, popup, component, history, html, change };
}

test("publishing a backing Component is refused with its Popup action, leaving live Structure and history intact", async () => {
	const fixture = await scene();
	const { api, siteId, popup } = fixture;
	const before = (await fixture.history()).copies.filter((copy) => copy.type === "revision").length;
	await fixture.change();
	await expect(api.components.publish({ siteId, componentId: popup.componentId })).rejects.toMatchObject({
		code: "POPUP_PUBLISH_REQUIRED",
		data: { item: { kind: "popup", id: popup.id } },
	});
	const html = await fixture.html();
	expect(html).toContain("Original Popup tree");
	expect(html).not.toContain("Changed Popup tree");
	expect((await api.popups.get({ siteId, popupId: popup.id })).popup.published?.layout).toBe("modal");
	expect((await fixture.history()).copies.filter((copy) => copy.type === "revision").length).toBe(before);
	await api.popups.publish({ siteId, popupId: popup.id });
	const published = await fixture.html();
	expect(published).toContain("Changed Popup tree");
	expect(published).toContain('data-layout="bar"');
	expect(published).toContain("Original other Component");
	expect(published).not.toContain("Unrelated pending Component");
	expect((await fixture.history()).copies.filter((copy) => copy.type === "revision").length).toBe(before + 1);
});
