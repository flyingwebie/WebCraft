// Publish in the building area's bottom bar (ADR 0037 › 1.5, BA-12) on the server: what `publish/items`
// lists for the open document (the page's Content changes; for Staff the Templates, Components, Loops,
// scripts and Design system it shows; what the shell names besides) and that publishing exactly those
// items through Publish all's two calls on the Site's address makes visitors see them. Members get
// Content only; Authors publish nothing. Publish later is Publish all's schedule (`scheduleAll`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { DocumentPublish } from "@webcraft/core";

import { buildingAreaApi, refusalOf } from "../harness/building-area-api.ts";
import { type BuildingAreaBrowser, openBuildingArea } from "../harness/building-area.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let author: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId], name: "Sam Staff" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor", name: "Erin Editor" })).browser;
	author = (await install.createMember({ workspaceId, role: "author", name: "Aidan Author" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type Bakery = {
	siteId: string;
	origin: string;
	slug: string;
	postTypeId: string;
	entryId: string;
	templateId: string;
	siteTemplateId: string;
	badgeId: string;
	loopId: string;
};

/**
 * A live Site: a Site template placing a Badge Component, a Blog Post Type whose Entry template shows
 * a Loop of its own items, and one published post at /blog/fresh-bread. Everything is published.
 */
async function bakery(): Promise<Bakery> {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const origin = await goLive(install, siteId);
	const { component: badge } = await staff.api.components.create({ siteId, name: "Badge", props: [] });
	await staff.api.components.saveMarkup({ siteId, componentId: badge.id, markup: `<p data-part="badge">Fresh</p>` });
	await staff.api.components.publish({ siteId, componentId: badge.id });
	const site = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><Badge /></header><main>{{@outlet}}</main>",
	});
	await staff.api.templates.publish({ siteId, templateId: site.template.id });
	const { loop } = await staff.api.loops.create({ siteId, name: "specials", source: "items" });
	await staff.api.loops.publish({ siteId, loopId: loop.id });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "subtitle", label: "Subtitle", type: "text" }],
	});
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<article><h1>{{ title }}</h1><p data-part="subtitle">{{ subtitle }}</p>{{@loop specials}}{{/loop}}</article>`,
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven" },
	});
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	return {
		siteId,
		origin,
		slug,
		postTypeId: postType.id,
		entryId: entry.id,
		templateId: template.template.id,
		siteTemplateId: site.template.id,
		badgeId: badge.id,
		loopId: loop.id,
	};
}

const PATH = "/blog/fresh-bread";

async function publishItems(
	area: BuildingAreaBrowser,
	input: { path: string | null; sources?: unknown[] },
): Promise<DocumentPublish> {
	const response = await area.edit("publish/items", { sources: [], ...input });
	expect(response.status).toBe(200);
	return (await response.json()) as DocumentPublish;
}

/** The page as a visitor on the Site's live domain reads it. */
async function visitorPage(site: Bakery): Promise<string> {
	const response = await install.request(new Request(`${site.origin}${PATH}`));
	expect(response.status).toBe(200);
	return response.text();
}

describe("what Publish lists for a page", () => {
	let site: Bakery;
	let area: BuildingAreaBrowser;

	beforeAll(async () => {
		site = await bakery();
		area = await openBuildingArea(install, staff, site.siteId, { path: PATH });
	});

	test("a page with nothing changed lists nothing, and says where its live page is", async () => {
		const answer = await publishItems(area, { path: PATH });

		expect(answer).toMatchObject({
			canPublish: true,
			canCode: true,
			page: { title: "Fresh bread", path: PATH },
			changes: [],
			drafts: [],
			items: [],
			otherDrafts: 0,
		});
		// The building area is on the live domain here: the live page is on the Staging address.
		expect(answer.live).toBe(`https://${site.slug}.sites.test${PATH}`);
		expect(answer.publishAll).toContain(`/sites/${site.siteId}?publishAll=1`);
	});

	test("Staff get the page's Content changes and the Structure it shows: its Templates, the Components they place, its Loops, the Design system", async () => {
		await area.edit("save", { item: `entry:${site.entryId}`, field: "subtitle", value: "Still warm" });
		await staff.api.templates.saveEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			markup: `<article><h1>{{ title }}</h1><p data-part="subtitle">{{ subtitle }}</p><p data-part="new">New line</p>{{@loop specials}}{{/loop}}</article>`,
		});
		await staff.api.components.saveMarkup({
			siteId: site.siteId,
			componentId: site.badgeId,
			markup: `<p data-part="badge">Hot</p>`,
		});
		await staff.api.loops.saveDraft({
			siteId: site.siteId,
			loopId: site.loopId,
			fields: [{ key: "dish", label: "Dish", type: "text" }],
		});
		await staff.api.designSystem.saveDraft({ siteId: site.siteId, customCss: ".note { color: red; }" });

		const answer = await publishItems(area, { path: PATH });

		expect(answer.changes).toEqual([
			expect.objectContaining({
				item: `entry:${site.entryId}`,
				key: "subtitle",
				label: "Subtitle",
				by: { name: "Sam Staff", you: true },
			}),
		]);
		expect(answer.changes[0]?.at).toBeTruthy();
		const listed = answer.drafts.map((draft) => draft.item);
		expect(listed).toContainEqual({ kind: "template", id: site.templateId });
		expect(listed).toContainEqual({ kind: "component", id: site.badgeId });
		expect(listed).toContainEqual({ kind: "designSystem" });
		expect(listed).toContainEqual({ kind: "loop", id: site.loopId });
		// The Site template didn't change: it isn't listed.
		expect(listed).not.toContainEqual({ kind: "template", id: site.siteTemplateId });
		expect(answer.drafts.every((draft) => draft.group === "structure" && draft.canPublish)).toBe(true);
		expect(answer.items).toContainEqual({ kind: "entry", id: site.entryId });
		expect(answer.items).toContainEqual({ kind: "template", id: site.templateId });
		expect(answer.items).toContainEqual({ kind: "component", id: site.badgeId });
	});

	test("an Editor gets the page's Content only; an Author gets it and may publish none of it", async () => {
		const asEditor = await openBuildingArea(install, editor, site.siteId, { path: PATH });
		const editorAnswer = await publishItems(asEditor, { path: PATH, sources: [{ kind: "designSystem" }] });
		expect(editorAnswer).toMatchObject({ canPublish: true, canCode: false, drafts: [] });
		expect(editorAnswer.items).toEqual([{ kind: "entry", id: site.entryId }]);
		expect(editorAnswer.changes.map((change) => change.key)).toEqual(["subtitle"]);

		const asAuthor = await openBuildingArea(install, author, site.siteId, { path: PATH });
		const authorAnswer = await publishItems(asAuthor, { path: PATH });
		expect(authorAnswer).toMatchObject({ canPublish: false, canCode: false, drafts: [], items: [], otherDrafts: 0 });
		expect(authorAnswer.changes.map((change) => change.key)).toEqual(["subtitle"]);
	});

	test("Staff publish the page's Entry and its changed Template together through Publish all; visitors see both", async () => {
		const answer = await publishItems(area, { path: PATH });
		const { api } = buildingAreaApi(install, area);

		const first = await api.publishing.publishAll({ siteId: site.siteId, items: answer.items });
		expect(first.published).toBe(false);
		if (first.published) throw new Error("The first call published.");
		const done = await api.publishing.publishAll({
			siteId: site.siteId,
			items: answer.items,
			confirmation: first.confirmation.id,
		});
		expect(done.published).toBe(true);

		const html = await visitorPage(site);
		expect(html).toContain("Still warm");
		expect(html).toContain('data-part="new"');
		expect(html).toContain("Hot");
		expect(await publishItems(area, { path: PATH })).toMatchObject({ changes: [], drafts: [], items: [] });
	});
});

describe("what the shell names besides the page", () => {
	let site: Bakery;
	let area: BuildingAreaBrowser;

	beforeAll(async () => {
		site = await bakery();
		area = await openBuildingArea(install, staff, site.siteId, { path: PATH });
	});

	test("a Template open on a stand-in lists it and the Components it places; a place's Loop and the Design system are listed too", async () => {
		await staff.api.components.saveMarkup({
			siteId: site.siteId,
			componentId: site.badgeId,
			markup: `<p data-part="badge">Hot</p>`,
		});
		await staff.api.templates.saveSiteTemplateMarkup({
			siteId: site.siteId,
			markup: "<header><Badge /><p>Open daily</p></header><main>{{@outlet}}</main>",
		});
		await staff.api.loops.saveDraft({
			siteId: site.siteId,
			loopId: site.loopId,
			fields: [{ key: "dish", label: "Dish", type: "text" }],
		});

		const answer = await publishItems(area, {
			path: null,
			sources: [{ kind: "siteTemplate" }, { kind: "loop", id: site.loopId }],
		});

		expect(answer.page).toBeNull();
		expect(answer.changes).toEqual([]);
		const listed = answer.drafts.map((draft) => draft.item);
		expect(listed).toContainEqual({ kind: "template", id: site.siteTemplateId });
		expect(listed).toContainEqual({ kind: "component", id: site.badgeId });
		expect(listed).toContainEqual({ kind: "loop", id: site.loopId });
		expect(listed).not.toContainEqual({ kind: "designSystem" });
		expect(answer.items).toEqual(expect.arrayContaining(listed));
		expect(answer.live).toBeNull();
	});

	test("names that aren't the Site's are refused", async () => {
		const response = await area.edit("publish/items", { path: null, sources: [{ kind: "page", id: "x" }] });
		expect(response.status).toBe(400);
	});
});

describe("Publish later from the Site's address", () => {
	let site: Bakery;

	beforeAll(async () => {
		site = await bakery();
	});

	test("an Editor schedules the page's items in Publish all's two calls; an Author's call is FORBIDDEN", async () => {
		const asEditor = await openBuildingArea(install, editor, site.siteId, { path: PATH });
		await asEditor.edit("save", { item: `entry:${site.entryId}`, field: "subtitle", value: "Tomorrow's bake" });
		const answer = await publishItems(asEditor, { path: PATH });
		const at = new Date(Date.now() + 24 * 60 * 60 * 1000);
		const { api } = buildingAreaApi(install, asEditor);

		const first = await api.publishing.scheduleAll({ siteId: site.siteId, items: answer.items, at });
		expect(first.scheduled).toBe(false);
		if (first.scheduled) throw new Error("The first call scheduled.");
		const done = await api.publishing.scheduleAll({
			siteId: site.siteId,
			items: answer.items,
			at,
			confirmation: first.confirmation.id,
		});
		expect(done.scheduled).toMatchObject({ action: "publish" });
		const { scheduled } = await api.publishing.scheduled({ siteId: site.siteId });
		expect(scheduled).toHaveLength(1);
		expect(scheduled[0]?.items.map((each) => each.item)).toEqual([{ kind: "entry", id: site.entryId }]);
		// Nothing went live yet.
		expect(await visitorPage(site)).toContain("Out of the oven");

		const asAuthor = await openBuildingArea(install, author, site.siteId, { path: PATH });
		const refused = await buildingAreaApi(install, asAuthor).call("publishing.scheduleAll", {
			siteId: site.siteId,
			items: [{ kind: "entry", id: site.entryId }],
			at: at.toISOString(),
		});
		expect(await refusalOf(refused)).toMatchObject({ status: 403, code: "FORBIDDEN" });
	});
});
