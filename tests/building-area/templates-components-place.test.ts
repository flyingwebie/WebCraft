// The Templates and Components places on the server (ADR 0037, BA-23): what the shell calls on the
// Site's address. Deleting a placed Component removes its Placements from Templates, Components and
// Page layouts, Draft and published (the pages change at once), after a first call that says where it
// is placed; a Popup still refuses it. "Allowed for Members" is the Site's Allowed components. Revert
// to published saves the published tree as the Draft. A Member gets none of it (Structure).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { buildingAreaApi } from "../harness/building-area-api.ts";
import { openBuildingArea, shellConfigIn } from "../harness/building-area.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { rejection } from "../harness/settled.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let origin: string;
let pagesId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	origin = await goLive(install, siteId);
	pagesId = (await staff.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id ?? "";
});

afterAll(async () => {
	await install.close();
});

/** A published Component with one text Prop, rendering `<p data-part="…">` with its value. */
async function component(name: string) {
	const { component: made } = await staff.api.components.create({
		siteId,
		name,
		props: [{ key: "words", label: "Words", type: "text" }],
	});
	await staff.api.components.saveMarkup({
		siteId,
		componentId: made.id,
		markup: `<p data-part="${name.toLowerCase()}">{{ props.words }}</p>`,
	});
	await staff.api.components.publish({ siteId, componentId: made.id });
	return (await staff.api.components.get({ siteId, componentId: made.id })).component;
}

/** A published Page whose layout places `componentId` once. */
async function pagePlacing(title: string, slug: string, componentId: string, props: unknown) {
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: pagesId, title, slug });
	const state = await staff.api.pageLayouts.get({ siteId, entryId: entry.id });
	await staff.api.pageLayouts.save({
		siteId,
		entryId: entry.id,
		basedOn: state.version,
		layout: { placements: [{ id: "one", component: componentId, props, values: { words: { en: "Fresh bread" } } }] },
	});
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	return entry.id;
}

describe("Components from the Site's address", () => {
	test("deleting a placed Component names where it is and removes every Placement, Draft and published", async () => {
		const hero = await component("HeroBanner");
		const wrapper = await component("PageIntro");
		// Placed in the Site template (published), in another Component (Draft and published) and on a Page.
		const site = await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: `<header><HeroBanner words="Welcome" /></header><main>{{@outlet}}</main>`,
		});
		await staff.api.templates.publish({ siteId, templateId: site.template.id });
		await staff.api.components.saveMarkup({
			siteId,
			componentId: wrapper.id,
			markup: `<section><HeroBanner words="Inside" /><p>{{ props.words }}</p></section>`,
		});
		await staff.api.components.publish({ siteId, componentId: wrapper.id });
		const pageId = await pagePlacing("Order a cake", "order-a-cake", hero.id, hero.draft.props);
		await install.drainJobs();
		expect(await (await install.request(`${origin}/order-a-cake`)).text()).toContain('data-part="herobanner"');

		const area = buildingAreaApi(install, await openBuildingArea(install, staff, siteId));
		// Without asking for its Placements to go, it is refused as in the admin.
		expect(await rejection(area.api.components.delete({ siteId, componentId: hero.id }))).toMatchObject({
			code: "COMPONENT_IN_USE",
		});
		const first = await area.api.components.delete({ siteId, componentId: hero.id, placements: "remove" });
		if (first.deleted) throw new Error("deleted on the first call");
		expect(first.usage?.pages).toBeGreaterThan(0);
		expect(first.usage?.usedIn.map((use) => `${use.kind}:${use.id}`).sort()).toEqual(
			[`template:${site.template.id}`, `component:${wrapper.id}`, `entry:${pageId}`].sort(),
		);
		// The confirmation is for removing them: without `placements` it is another request.
		expect(
			await rejection(
				area.api.components.delete({ siteId, componentId: hero.id, confirmation: first.confirmation.id }),
			),
		).toMatchObject({ code: "COMPONENT_IN_USE" });
		expect(
			await area.api.components.delete({
				siteId,
				componentId: hero.id,
				confirmation: first.confirmation.id,
				placements: "remove",
			}),
		).toEqual({ deleted: true });

		expect(await rejection(staff.api.components.get({ siteId, componentId: hero.id }))).toMatchObject({
			code: "COMPONENT_NOT_FOUND",
		});
		const template = (await staff.api.templates.getSiteTemplateMarkup({ siteId })).markup;
		expect(template?.draft).not.toContain("HeroBanner");
		expect(template?.published).not.toContain("HeroBanner");
		expect(template?.draft).toContain("{{@outlet}}");
		const inner = await staff.api.components.getMarkup({ siteId, componentId: wrapper.id });
		expect(inner.markup.draft).not.toContain("HeroBanner");
		expect(inner.markup.published).not.toContain("HeroBanner");
		expect(inner.markup.draft).toContain("{{ props.words }}");
		expect((await staff.api.pageLayouts.get({ siteId, entryId: pageId })).placements).toEqual([]);
		// What visitors see changed at once: the page cache was cleared.
		const page = await (await install.request(`${origin}/order-a-cake`)).text();
		expect(page).not.toContain('data-part="herobanner"');
		expect(page).not.toContain("Welcome");
		const logged = (await (await install.superadmin()).api.audit.list({ limit: 20 })).entries.find(
			(entry) => entry.action === "component.delete",
		);
		expect(logged?.details).toMatchObject({ componentId: hero.id, name: "HeroBanner", placementsRemoved: 3 });
	});

	test("a confirmation no longer holds once the Component is placed somewhere else", async () => {
		const card = await component("PriceCard");
		const area = buildingAreaApi(install, await openBuildingArea(install, staff, siteId));
		const first = await area.api.components.delete({ siteId, componentId: card.id, placements: "remove" });
		if (first.deleted) throw new Error("deleted on the first call");
		expect(first.usage).toEqual({ pages: 0, usedIn: [] });
		await pagePlacing("Prices", "prices", card.id, card.draft.props);
		expect(
			await rejection(
				area.api.components.delete({
					siteId,
					componentId: card.id,
					confirmation: first.confirmation.id,
					placements: "remove",
				}),
			),
		).toMatchObject({ code: "CONFIRMATION_INVALID" });
		expect((await staff.api.components.get({ siteId, componentId: card.id })).component.name).toBe("PriceCard");
	});

	test("a Popup showing the Component still refuses it", async () => {
		const { popup } = await staff.api.popups.create({ siteId, name: "Offer", key: "offer" });
		const area = buildingAreaApi(install, await openBuildingArea(install, staff, siteId));
		const error = await area.api.components
			.delete({ siteId, componentId: popup.componentId, placements: "remove" })
			.then(
				() => null,
				(failure: { code?: string; data?: { usedIn?: { kind: string }[] } }) => failure,
			);
		expect(error?.code).toBe("COMPONENT_IN_USE");
		expect(error?.data?.usedIn?.map((use) => use.kind)).toEqual(["popup"]);
	});

	test("Allowed for Members is the Site's Allowed components, and Staff's alone", async () => {
		const quote = await component("CustomerQuote");
		const area = buildingAreaApi(install, await openBuildingArea(install, staff, siteId));
		const before = await area.api.pageLayouts.settings({ siteId });
		const after = await area.api.pageLayouts.configure({
			siteId,
			allowedComponents: [...before.allowedComponents, quote.id],
		});
		expect(after.allowedComponents).toContain(quote.id);
		expect((await staff.api.pageLayouts.settings({ siteId })).allowedComponents).toContain(quote.id);

		const member = buildingAreaApi(install, await openBuildingArea(install, editor, siteId));
		expect(await rejection(member.api.pageLayouts.configure({ siteId, allowedComponents: [] }))).toMatchObject({
			code: "FORBIDDEN",
		});
		expect(
			await rejection(member.api.components.delete({ siteId, componentId: quote.id, placements: "remove" })),
		).toMatchObject({ code: "FORBIDDEN" });
		expect(await rejection(member.api.templates.list({ siteId }))).toMatchObject({ code: "FORBIDDEN" });
		expect((await staff.api.pageLayouts.settings({ siteId })).allowedComponents).toContain(quote.id);
	});
});

describe("Templates from the Site's address", () => {
	test("Revert to published puts the published tree back as the Draft", async () => {
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
		const area = buildingAreaApi(install, await openBuildingArea(install, staff, siteId));
		const saved = await area.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: "<article><h1>{{ title }}</h1></article>",
		});
		await staff.api.templates.publish({ siteId, templateId: saved.template.id });
		await area.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: "<article><h2>{{ title }}</h2></article>",
		});
		const changed = await area.api.templates.getEntryTemplate({ siteId, postTypeId: postType.id });
		expect(changed.template?.status).toBe("changed");

		const reverted = await area.api.templates.saveEntryTemplate({
			siteId,
			postTypeId: postType.id,
			tree: changed.template?.published,
		});
		expect(reverted.template.status).toBe("published");
		const listed = (await area.api.templates.list({ siteId })).templates.find(
			(each) => each.kind === "entry" && each.postType?.id === postType.id,
		);
		expect(listed?.template?.status).toBe("published");
	});

	test("an Archive template made with an empty Draft is a Template the place lists", async () => {
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Events", urlPattern: "/events/{slug}" });
		const area = buildingAreaApi(install, await openBuildingArea(install, staff, siteId));
		const { template } = await area.api.templates.saveArchiveTemplate({
			siteId,
			postTypeId: postType.id,
			tree: { version: 1, nodes: [] },
		});
		expect(template.status).toBe("draft");
		const listed = (await area.api.templates.list({ siteId })).templates.find(
			(each) => each.kind === "archive" && each.postType?.id === postType.id,
		);
		expect(listed?.template?.id).toBe(template.id);
	});

	test("the Templates and Components places are addresses of the shell", async () => {
		const building = await openBuildingArea(install, staff, siteId);
		for (const [place, view] of [
			["templates", null],
			["components", "filter=allowed&q=hero"],
		] as const) {
			const response = await building.shell(
				`/_webcraft/build/page/?wc-place=${place}${view ? `&wc-view=${encodeURIComponent(view)}` : ""}`,
			);
			expect(response.status).toBe(200);
			expect(shellConfigIn(await response.text())?.page).toBe("/");
		}
	});
});
