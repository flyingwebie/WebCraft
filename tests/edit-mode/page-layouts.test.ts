import { afterAll, beforeAll, expect, test } from "bun:test";
import { openDraft } from "../harness/co-editing.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;
beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace()).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});
afterAll(async () => {
	await install.close();
});

test("a Page layout survives Content saves and publishes its Component Props", async () => {
	const siteId = (await install.createSite(workspaceId, { slug: "layout" })).id;
	await goLive(install, siteId);
	const { postTypes } = await editor.api.postTypes.list({ siteId });
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: postTypes[0]!.id, title: "About" });
	const { component } = await staff.api.components.create({
		siteId,
		name: "Hero",
		props: [{ key: "heading", label: "Heading", type: "text", translatable: true }],
	});
	await staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<section><h1>{{ props.heading }}</h1></section>",
	});
	await staff.api.components.publish({ siteId, componentId: component.id });
	await staff.api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [component.id] });
	const initial = await editor.api.pageLayouts.get({ siteId, entryId: entry.id });
	const saved = await editor.api.pageLayouts.save({
		siteId,
		entryId: entry.id,
		basedOn: initial.version,
		layout: {
			placements: [
				{
					id: "hero",
					component: component.id,
					props: component.draft.props,
					values: { heading: { en: "Welcome to Cork" } },
				},
			],
		},
	});
	expect(saved.layout.placements).toHaveLength(1);
	await editor.api.entries.saveDraft({
		siteId,
		entryId: entry.id,
		title: "About us",
		seo: { description: "Our team" },
	});
	expect((await editor.api.pageLayouts.get({ siteId, entryId: entry.id })).layout).toEqual(saved.layout);
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	const html = await expectSafePage(await install.request("https://layout.live.test/about"));
	expect(html).toContain("<h1>Welcome to Cork</h1>");
});

test("Page layout co-editing keeps Props, refuses forged locks, and preserves unrelated Content", async () => {
	const siteId = (await install.createSite(workspaceId, { slug: "shared-layout" })).id;
	const { postTypes } = await editor.api.postTypes.list({ siteId });
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: postTypes[0]!.id, title: "Shared" });
	const { component } = await staff.api.components.create({
		siteId,
		name: "Card",
		props: [{ key: "text", label: "Text", type: "text", translatable: true }],
	});
	await staff.api.components.publish({ siteId, componentId: component.id });
	await staff.api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [component.id] });
	const initial = await editor.api.pageLayouts.get({ siteId, entryId: entry.id });
	const layout = {
		placements: [
			{ id: "card", component: component.id, props: component.draft.props, values: { text: { en: "First" } } },
		],
	};
	await editor.api.pageLayouts.save({ siteId, entryId: entry.id, basedOn: initial.version, layout });
	const live = await openDraft(install, editor, siteId, { kind: "entry", id: entry.id });
	try {
		expect(live.draft()).toMatchObject({ layout });
		live.change((draft) => ({
			...(draft as object),
			layout: { placements: [{ ...layout.placements[0]!, values: { text: { en: "Second" } } }] },
		}));
		await live.saved();
		expect((await editor.api.pageLayouts.get({ siteId, entryId: entry.id })).placements[0]?.values.text).toBe("Second");
		live.change((draft) => ({
			...(draft as object),
			layout: { placements: [{ ...layout.placements[0]!, locked: true }] },
		}));
		await live.until(() => live.refusals.length === 1, "forged lock refusal");
		expect(live.refusals[0]?.code).toBe("ENTRY_INVALID");
		await editor.api.entries.saveDraft({ siteId, entryId: entry.id, title: "Kept" });
		expect((await editor.api.pageLayouts.get({ siteId, entryId: entry.id })).placements[0]?.values.text).toBe("Second");
	} finally {
		live.close();
	}
});

test("Member limits apply to HTTP: switches, nesting, locks, stale versions and tenant boundaries", async () => {
	const siteId = (await install.createSite(workspaceId, { slug: "limits-layout" })).id;
	const { postTypes } = await editor.api.postTypes.list({ siteId });
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: postTypes[0]!.id, title: "Limits" });
	const { component } = await staff.api.components.create({ siteId, name: "Hero" });
	await staff.api.components.publish({ siteId, componentId: component.id });
	const placement = { id: "hero", component: component.id, props: [], values: {} };
	let state = await editor.api.pageLayouts.get({ siteId, entryId: entry.id });
	const save = (layout: unknown, basedOn = state.version) =>
		editor.api.pageLayouts.save({ siteId, entryId: entry.id, basedOn, layout });
	await expect(save({ placements: [placement] })).rejects.toMatchObject({ code: "ENTRY_INVALID" });
	await expect(editor.api.pageLayouts.configure({ siteId, enabled: true })).rejects.toMatchObject({ status: 403 });
	await staff.api.pageLayouts.configure({ siteId, enabled: true });
	await expect(save({ placements: [placement] })).rejects.toMatchObject({ code: "ENTRY_INVALID" });
	await staff.api.pageLayouts.configure({ siteId, allowedComponents: [component.id] });
	state = await save({ placements: [placement] });
	await expect(save({ placements: [] }, "obsolete")).rejects.toMatchObject({ code: "CHANGED_MEANWHILE" });
	await expect(save({ placements: [{ ...placement, children: [] }] })).rejects.toMatchObject({ code: "ENTRY_INVALID" });
	await staff.api.pageLayouts.configure({ siteId, allowedComponents: [] });
	state = await save({ placements: [{ ...placement, hidden: true }] });
	await expect(save({ placements: [placement, { ...placement, id: "copy" }] })).rejects.toMatchObject({
		code: "ENTRY_INVALID",
	});
	state = await staff.api.pageLayouts.save({
		siteId,
		entryId: entry.id,
		basedOn: state.version,
		layout: { placements: [{ ...placement, locked: true }] },
	});
	for (const placements of [[], [{ ...placement, hidden: true, locked: true }], [placement]])
		await expect(save({ placements })).rejects.toMatchObject({ code: "ENTRY_INVALID" });
	const other = (await install.createSite(workspaceId, { slug: "foreign-layout" })).id;
	await expect(editor.api.pageLayouts.get({ siteId: other, entryId: entry.id })).rejects.toMatchObject({
		code: "PAGE_NOT_FOUND",
	});
});

test("Page layout defaults and canonical Props reach both real shared-document editors", async () => {
	const siteId = (await install.createSite(workspaceId, { slug: "canonical-layout" })).id;
	const { postTypes } = await editor.api.postTypes.list({ siteId });
	const pageType = postTypes.find((type) => type.builtIn === "page");
	if (!pageType) throw new Error("Missing Page Post Type");
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: pageType.id, title: "Canonical" });
	const { component } = await staff.api.components.create({
		siteId,
		name: "Counter",
		props: [{ key: "count", label: "Count", type: "number", default: 3 }],
	});
	await staff.api.components.publish({ siteId, componentId: component.id });
	await staff.api.pageLayouts.configure({ siteId, enabled: true, allowedComponents: [component.id] });
	const one = await openDraft(install, editor, siteId, { kind: "entry", id: entry.id });
	const two = await openDraft(install, staff, siteId, { kind: "entry", id: entry.id });
	try {
		one.change((draft) => ({
			...(draft as object),
			layout: { placements: [{ id: "counter", component: component.id, props: component.draft.props, values: {} }] },
		}));
		await one.saved();
		await two.until(() => JSON.stringify(two.draft()).includes('"counter"'), "peer Placement");
		const canonical = { layout: { placements: [{ id: "counter", values: { count: { en: 3 } } }] } };
		expect(one.draft()).toMatchObject(canonical);
		expect(two.draft()).toMatchObject(canonical);
	} finally {
		one.close();
		two.close();
	}
});
