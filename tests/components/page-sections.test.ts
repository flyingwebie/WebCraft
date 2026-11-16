// Page sections (GLOSSARY.md, ADR 0038): a Section inserted on a Page is a Component that Page owns.
// It is placed only there, listed nowhere, published and deleted with its Page, until Staff choose
// "Make reusable Component".
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { exportedArchive, importArchive, rowsIn } from "../harness/site-transfer.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

/** A live Site with one Page, its Page Post Type's id and the Page's id. */
async function siteWithPage(slug: string, title = "About") {
	const siteId = (await install.createSite(workspaceId, { slug })).id;
	await goLive(install, siteId);
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	const pageType = postTypes.find((postType) => postType.builtIn === "page");
	if (!pageType) throw new Error("No Page Post Type.");
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: pageType.id, title });
	return { siteId, pageTypeId: pageType.id, pageId: entry.id };
}

/** Makes a Section on a Page, its tree `markup`, and places it at the end of the Page's layout. */
async function addSection(siteId: string, pageId: string, markup: string) {
	const { component } = await staff.api.components.create({ siteId, pageId });
	await staff.api.components.saveMarkup({ siteId, componentId: component.id, markup });
	const current = await staff.api.pageLayouts.get({ siteId, entryId: pageId });
	const placementId = `section-${component.id.slice(0, 8)}`;
	await staff.api.pageLayouts.save({
		siteId,
		entryId: pageId,
		basedOn: current.version,
		layout: {
			placements: [...current.layout.placements, { id: placementId, component: component.id, props: [], values: {} }],
		},
	});
	return { componentId: component.id, placementId };
}

async function layoutWithout(siteId: string, pageId: string, placementId: string) {
	const current = await staff.api.pageLayouts.get({ siteId, entryId: pageId });
	return staff.api.pageLayouts.save({
		siteId,
		entryId: pageId,
		basedOn: current.version,
		layout: { placements: current.layout.placements.filter((placement) => placement.id !== placementId) },
	});
}

describe("making a Section on a Page", () => {
	test("is a Component the Page owns, with no name of its own, listed nowhere", async () => {
		const { siteId, pageId } = await siteWithPage("sections-made");
		const { component } = await staff.api.components.create({ siteId, pageId });
		expect(component).toMatchObject({ pageId, status: "draft", draft: { props: [], tree: { nodes: [] } } });
		// Its name is made for it: the Site's names stay unique and free for Staff.
		expect(component.name).toMatch(/^PageSection[0-9a-f]{32}$/);

		const { component: library } = await staff.api.components.create({ siteId, name: "Section1" });
		expect(library.pageId).toBeNull();
		const listed = (await staff.api.components.list({ siteId })).components.map((each) => each.id);
		expect(listed).toContain(library.id);
		expect(listed).not.toContain(component.id);

		// It is read and edited by its id, as any Component.
		expect((await staff.api.components.get({ siteId, componentId: component.id })).component.pageId).toBe(pageId);
		await staff.api.components.saveMarkup({
			siteId,
			componentId: component.id,
			markup: "<section><p>Hi</p></section>",
		});
		const { markup } = await staff.api.components.getMarkup({ siteId, componentId: component.id });
		expect(markup.draft).toContain(">Hi</p>");
	});

	test("only for a Page of the Site", async () => {
		const { siteId } = await siteWithPage("sections-owner");
		const { postTypes } = await staff.api.postTypes.list({ siteId });
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Recipes", urlPattern: "/recipes/{slug}" });
		const { entry: recipe } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Scones" });
		await expect(staff.api.components.create({ siteId, pageId: recipe.id })).rejects.toMatchObject({
			code: "PAGE_NOT_FOUND",
		});
		const other = await siteWithPage("sections-owner-other");
		await expect(staff.api.components.create({ siteId, pageId: other.pageId })).rejects.toMatchObject({
			code: "PAGE_NOT_FOUND",
		});
		expect(postTypes.length).toBeGreaterThan(0);
		// Members never make one: Sections are Structure.
		await expect(
			editor.api.components.create({ siteId, pageId: (await siteWithPage("sections-member")).pageId }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("is placed only on its own Page, once", async () => {
		const { siteId, pageId, pageTypeId } = await siteWithPage("sections-placed");
		const { componentId, placementId } = await addSection(siteId, pageId, "<section><p>Ours</p></section>");
		const layout = await staff.api.pageLayouts.get({ siteId, entryId: pageId });
		expect(layout.placements).toMatchObject([{ id: placementId, componentName: "Section", pageSection: true }]);
		// Never offered as a Component to place.
		expect(layout.components.map((each) => each.id)).not.toContain(componentId);

		// Twice on its Page: duplicating makes another Section instead.
		await expect(
			staff.api.pageLayouts.save({
				siteId,
				entryId: pageId,
				basedOn: layout.version,
				layout: {
					placements: [...layout.layout.placements, { id: "again", component: componentId, props: [], values: {} }],
				},
			}),
		).rejects.toMatchObject({ code: "ENTRY_INVALID" });

		// On another Page.
		const { entry: other } = await staff.api.entries.create({ siteId, postTypeId: pageTypeId, title: "Team" });
		const otherLayout = await staff.api.pageLayouts.get({ siteId, entryId: other.id });
		await expect(
			staff.api.pageLayouts.save({
				siteId,
				entryId: other.id,
				basedOn: otherLayout.version,
				layout: { placements: [{ id: "stolen", component: componentId, props: [], values: {} }] },
			}),
		).rejects.toMatchObject({ code: "ENTRY_INVALID" });

		// In a Template or a Component.
		const { component } = await staff.api.components.get({ siteId, componentId });
		await expect(
			staff.api.templates.saveSiteTemplateMarkup({
				siteId,
				markup: `<header><${component.name} /></header><main>{{@outlet}}</main>`,
			}),
		).rejects.toMatchObject({ code: "TEMPLATE_MARKUP_INVALID" });
		const { component: card } = await staff.api.components.create({ siteId, name: "Card" });
		await expect(
			staff.api.components.saveMarkup({ siteId, componentId: card.id, markup: `<div><${component.name} /></div>` }),
		).rejects.toMatchObject({ code: "TEMPLATE_MARKUP_INVALID" });

		// As an Allowed component, or renamed.
		await expect(staff.api.pageLayouts.configure({ siteId, allowedComponents: [componentId] })).rejects.toMatchObject({
			code: "ENTRY_INVALID",
		});
		await expect(staff.api.components.rename({ siteId, componentId, name: "Hero" })).rejects.toMatchObject({
			code: "COMPONENT_INVALID",
		});
	});
});

describe("Make reusable Component", () => {
	test("names the Section and lists it; its Placement stays", async () => {
		const { siteId, pageId } = await siteWithPage("sections-reusable");
		const { componentId, placementId } = await addSection(siteId, pageId, "<section><p>Hours</p></section>");
		const before = await staff.api.pageLayouts.get({ siteId, entryId: pageId });

		const { component } = await staff.api.components.makeReusable({ siteId, componentId, name: "OpeningHours" });
		expect(component).toMatchObject({ id: componentId, name: "OpeningHours", pageId: null });
		expect((await staff.api.components.list({ siteId })).components.map((each) => each.name)).toContain("OpeningHours");
		const after = await staff.api.pageLayouts.get({ siteId, entryId: pageId });
		expect(after.layout).toEqual(before.layout);
		expect(after.placements).toMatchObject([{ id: placementId, componentName: "OpeningHours", pageSection: false }]);

		// Placed anywhere now.
		await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: "<header><OpeningHours /></header><main>{{@outlet}}</main>",
		});
		// Once only.
		await expect(staff.api.components.makeReusable({ siteId, componentId, name: "Hours" })).rejects.toMatchObject({
			code: "COMPONENT_NOT_PAGE_SECTION",
		});
	});

	test("is undone while only its Page places it", async () => {
		const { siteId, pageId } = await siteWithPage("sections-undo-reusable");
		const { componentId } = await addSection(siteId, pageId, "<section><p>Back</p></section>");
		const { component: section } = await staff.api.components.get({ siteId, componentId });
		await staff.api.components.makeReusable({ siteId, componentId, name: "Back" });

		const { component } = await staff.api.components.makePageSection({ siteId, componentId, pageId });
		expect(component).toMatchObject({ id: componentId, pageId, name: section.name });
		expect((await staff.api.components.list({ siteId })).components.map((each) => each.id)).not.toContain(componentId);

		// Placed elsewhere since, it stays reusable.
		await staff.api.components.makeReusable({ siteId, componentId, name: "Back" });
		await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: "<header><Back /></header><main>{{@outlet}}</main>",
		});
		await expect(staff.api.components.makePageSection({ siteId, componentId, pageId })).rejects.toMatchObject({
			code: "COMPONENT_IN_USE",
		});
	});

	test("asks for a free, well-formed name", async () => {
		const { siteId, pageId } = await siteWithPage("sections-names");
		const { componentId } = await addSection(siteId, pageId, "<section></section>");
		await staff.api.components.create({ siteId, name: "Hero" });
		await expect(staff.api.components.makeReusable({ siteId, componentId, name: "Hero" })).rejects.toMatchObject({
			code: "COMPONENT_NAME_TAKEN",
		});
		await expect(staff.api.components.makeReusable({ siteId, componentId, name: "hero" })).rejects.toMatchObject({
			code: "COMPONENT_INVALID",
		});
		expect((await staff.api.components.get({ siteId, componentId })).component.pageId).toBe(pageId);
	});
});

describe("removing a Section, and deleting its Page", () => {
	test("its Placement removed, the Section stays for Undo until the Page is published", async () => {
		const { siteId, pageId } = await siteWithPage("sections-removed");
		const kept = await addSection(siteId, pageId, "<section><p>Stays</p></section>");
		const removed = await addSection(siteId, pageId, "<section><p>Goes</p></section>");
		await editor.api.entries.publish({ siteId, entryId: pageId });

		const withBoth = await staff.api.pageLayouts.get({ siteId, entryId: pageId });
		await layoutWithout(siteId, pageId, removed.placementId);
		// Undo: the Placement comes back, with its Section.
		const undone = await staff.api.pageLayouts.get({ siteId, entryId: pageId });
		await staff.api.pageLayouts.save({
			siteId,
			entryId: pageId,
			basedOn: undone.version,
			layout: withBoth.layout,
		});
		expect((await staff.api.pageLayouts.get({ siteId, entryId: pageId })).layout).toEqual(withBoth.layout);

		// Removed again; the published page shows it until the Page is published.
		await layoutWithout(siteId, pageId, removed.placementId);
		expect(await (await install.request("https://sections-removed.live.test/about")).text()).toContain("Goes");
		await editor.api.entries.publish({ siteId, entryId: pageId });
		const html = await (await install.request("https://sections-removed.live.test/about")).text();
		expect(html).toContain("Stays");
		expect(html).not.toContain("Goes");
		await expect(staff.api.components.get({ siteId, componentId: removed.componentId })).rejects.toMatchObject({
			code: "COMPONENT_NOT_FOUND",
		});
		expect((await staff.api.components.get({ siteId, componentId: kept.componentId })).component.status).toBe(
			"published",
		);
	});

	test("deleting the Page deletes its Sections", async () => {
		const { siteId, pageId } = await siteWithPage("sections-page-deleted");
		const { componentId } = await addSection(siteId, pageId, "<section><p>Gone</p></section>");
		await editor.api.entries.publish({ siteId, entryId: pageId });
		const { confirmation } = await staff.api.entries.delete({ siteId, entryId: pageId });
		await staff.api.entries.delete({ siteId, entryId: pageId, confirmation: confirmation?.id });
		await expect(staff.api.components.get({ siteId, componentId })).rejects.toMatchObject({
			code: "COMPONENT_NOT_FOUND",
		});
	});

	test("a library Component placed in a Section is in use on that Page", async () => {
		const { siteId, pageId } = await siteWithPage("sections-usage");
		const { component: badge } = await staff.api.components.create({ siteId, name: "Badge" });
		await staff.api.components.saveMarkup({ siteId, componentId: badge.id, markup: "<span>New</span>" });
		await addSection(siteId, pageId, "<section><Badge /></section>");
		const { usage } = await staff.api.components.get({ siteId, componentId: badge.id });
		expect(usage.usedIn).toEqual([expect.objectContaining({ kind: "entry", id: pageId, versions: ["draft"] })]);
	});
});

describe("publishing a Page with Sections", () => {
	test("publishes its Sections with it, as one item", async () => {
		const { siteId, pageId } = await siteWithPage("sections-published");
		const { componentId } = await addSection(siteId, pageId, "<section><h2>Fresh bread daily</h2></section>");

		const drafts = (await staff.api.publishing.drafts({ siteId })).drafts.map((draft) => draft.item);
		expect(drafts).toContainEqual({ kind: "entry", id: pageId });
		expect(drafts).not.toContainEqual({ kind: "component", id: componentId });

		// An Editor publishes the Page; its Section goes live with it.
		await editor.api.entries.publish({ siteId, entryId: pageId });
		expect((await staff.api.components.get({ siteId, componentId })).component.status).toBe("published");
		expect(await (await install.request("https://sections-published.live.test/about")).text()).toContain(
			"<h2>Fresh bread daily</h2>",
		);

		// A change to the Section alone makes the Page a changed Draft; Publish all publishes both.
		await staff.api.components.saveMarkup({
			siteId,
			componentId,
			markup: "<section><h2>Fresh bread and scones</h2></section>",
		});
		const changed = (await staff.api.publishing.drafts({ siteId })).drafts;
		expect(changed.map((draft) => draft.item)).toEqual([{ kind: "entry", id: pageId }]);
		expect(changed[0]?.status).toBe("changed");
		const items = [{ kind: "entry" as const, id: pageId }];
		const asked = await editor.api.publishing.publishAll({ siteId, items });
		if (asked.published) throw new Error("Publish all asked no confirmation.");
		await editor.api.publishing.publishAll({ siteId, items, confirmation: asked.confirmation.id });
		expect(await (await install.request("https://sections-published.live.test/about")).text()).toContain(
			"<h2>Fresh bread and scones</h2>",
		);
		expect((await staff.api.publishing.drafts({ siteId })).drafts).toEqual([]);
	});
});

describe("a Site export", () => {
	test("carries a Page's Sections, owned by the imported Page", async () => {
		const { siteId, pageId } = await siteWithPage("sections-export");
		const { componentId } = await addSection(siteId, pageId, "<section><p>Exported</p></section>");
		const admin = await install.superadmin();
		const archive = await exportedArchive(install, admin, siteId);
		expect(rowsIn(archive, "public.components").find((row) => row.id === componentId)).toMatchObject({
			page_id: pageId,
		});

		const into = (await install.createWorkspace("Imports")).id;
		const imported = await importArchive(install, admin, into, archive, { name: "Copy", slug: "sections-copy" });
		expect(imported.status).toBe("done");
		const copyId = imported.site?.id ?? "";
		const { postTypes } = await admin.api.postTypes.list({ siteId: copyId });
		const pageType = postTypes.find((postType) => postType.builtIn === "page");
		const { entries } = await admin.api.entries.list({ siteId: copyId, postTypeId: pageType?.id ?? "" });
		const page = entries.find((entry) => entry.draft.title === "About");
		const layout = await admin.api.pageLayouts.get({ siteId: copyId, entryId: page?.id ?? "" });
		expect(layout.placements).toMatchObject([{ componentName: "Section", pageSection: true }]);
		const sectionId = layout.placements[0]?.component ?? "";
		expect(sectionId).not.toBe(componentId);
		expect((await admin.api.components.get({ siteId: copyId, componentId: sectionId })).component.pageId).toBe(
			page?.id,
		);
		expect((await admin.api.components.list({ siteId: copyId })).components).toEqual([]);
	});
});
