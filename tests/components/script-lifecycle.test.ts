// A Component script around its Component's life: a Popup's Component carries its script through
// Publish all, a Scheduled publish freezes the script with its Component, each publish keeps a
// Revision of it, its history names it as a Component script, and deleting its Component keeps the
// published file served for 30 days like any replaced script (ADR 0023).
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let workspaceId: string;
let sites = 0;

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "popups", version: "1.0.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
});

afterAll(async () => {
	await install.close();
});

/** A Site with a published `Card` Component and its published script. */
async function cardSite(code = "export default () => {};") {
	const siteId = (await install.createSite(workspaceId, { slug: `script-life-${++sites}` })).id;
	const { api } = await install.superadmin();
	const { component } = await api.components.create({ siteId, name: "Card" });
	await api.components.saveMarkup({ siteId, componentId: component.id, markup: "<div><p>Card</p></div>" });
	const { script } = await api.components.saveScriptDraft({ siteId, componentId: component.id, code });
	await api.components.publish({ siteId, componentId: component.id });
	return { api, siteId, componentId: component.id, scriptId: script.id };
}

test("a script-only change to a Popup's Component shows in Publish all as the Popup, which publishes it", async () => {
	const siteId = (await install.createSite(workspaceId, { slug: `script-life-${++sites}` })).id;
	const { api } = await install.superadmin();
	const { popup } = await api.popups.create({ siteId, name: "Offer", key: "offer" });
	await api.components.saveMarkup({ siteId, componentId: popup.componentId, markup: "<p>Offer</p>" });
	await api.popups.publish({ siteId, popupId: popup.id });
	const structure = (drafts: { item: { kind: string } }[]) =>
		drafts.filter((draft) => draft.item.kind !== "popupContent");
	expect(structure((await api.publishing.drafts({ siteId })).drafts)).toEqual([]);

	await api.components.saveScriptDraft({ siteId, componentId: popup.componentId, code: "export default () => {};" });

	const { drafts } = await api.publishing.drafts({ siteId });
	expect(structure(drafts).map((draft) => draft.item)).toEqual([{ kind: "popup", id: popup.id }]);
	const items = [{ kind: "popup" as const, id: popup.id }];
	const preview = (await api.publishing.publishAll({ siteId, items })) as { confirmation?: { id: string } };
	await api.publishing.publishAll({ siteId, items, confirmation: preview.confirmation?.id });
	const { script } = await api.components.getScript({ siteId, componentId: popup.componentId });
	expect(script?.status).toBe("published");
	expect(structure((await api.publishing.drafts({ siteId })).drafts)).toEqual([]);
});

test("a Scheduled publish of a Component freezes its script: one saved after scheduling waits", async () => {
	const { api, siteId, componentId } = await cardSite("export default () => 'first';");
	await api.components.saveScriptDraft({ siteId, componentId, code: "export default () => 'scheduled';" });
	await api.publishing.schedule({
		siteId,
		item: { kind: "component", id: componentId },
		at: new Date(install.clock.now().getTime() + 60_000),
	});
	await api.components.saveScriptDraft({ siteId, componentId, code: "export default () => 'after';" });

	await install.clock.advance(60_000);
	expect((await install.drainJobs()).failed).toEqual([]);

	const { script } = await api.components.getScript({ siteId, componentId });
	expect(script?.published?.code).toBe("export default () => 'scheduled';");
	expect(script?.draft.code).toBe("export default () => 'after';");
	expect(script?.status).toBe("changed");
});

test("its history is a Component script's, named after its Component, with a Revision for each publish", async () => {
	const { api, siteId, componentId, scriptId } = await cardSite();
	await api.components.saveScriptDraft({ siteId, componentId, code: "export default () => { /* two */ };" });
	await api.components.publish({ siteId, componentId });

	const page = await api.history.list({ siteId, item: { kind: "script", id: scriptId } });

	expect(page.item).toMatchObject({ kind: "script", name: "Card", scriptKind: "component" });
	expect(page.copies.filter((copy) => copy.type === "revision")).toHaveLength(2);
});

test("deleting a Component keeps its published script's files served for pages loaded before", async () => {
	const { api, siteId, componentId } = await cardSite("export default (root) => { root.dataset.on = '1'; };");
	const origin = await goLive(install, siteId);
	const { postType } = await api.postTypes.create({ siteId, name: "Notes", urlPattern: "/notes/{slug}" });
	const placing = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><Card /></article>",
	});
	await api.templates.publish({ siteId, templateId: placing.template.id });
	const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Ovens" });
	await api.entries.publish({ siteId, entryId: entry.id });
	const html = await expectSafePage(await install.request(`${origin}/notes/ovens`));
	const loader = /<script type="module" src="(\/_wc\/js\/component\/[^"]+)"><\/script>/.exec(html)?.[1] as string;
	const file = `/_wc/js/${/from "\.\.\/\.\.\/([0-9a-f]{16}\.js)"/.exec(await (await install.request(`${origin}${loader}`)).text())?.[1]}`;
	const freed = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article></article>",
	});
	await api.templates.publish({ siteId, templateId: freed.template.id });

	const asked = await api.components.delete({ siteId, componentId });
	await api.components.delete({ siteId, componentId, confirmation: asked.deleted ? "" : asked.confirmation.id });

	for (const name of [loader, file]) {
		const served = await install.request(`${origin}${name}`);
		expect({ name, status: served.status }).toEqual({ name, status: 200 });
		expect(served.headers.get("cache-control")).toContain("immutable");
	}
	await install.clock.advance(31 * 24 * 60 * 60 * 1000);
	expect((await install.drainJobs()).failed).toEqual([]);
	expect((await install.request(`${origin}${file}`)).status).toBe(404);
});
