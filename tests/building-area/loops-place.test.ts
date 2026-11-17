// The Loops place on the server (ADR 0037, BA-25): from the Site's address Staff read and change a
// Loop as in the admin, and read what its Draft lists (`loops.result`: its items, how many in all, and
// the published pages showing it); a Member is refused, Loops being Structure.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openBuildingArea } from "../harness/building-area.ts";
import { type BuildingAreaApi, buildingAreaApi } from "../harness/building-area-api.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { rejection } from "../harness/settled.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let blogId: string;
let area: BuildingAreaApi;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-04-01T09:00:00Z") });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		key: "blog",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "summary", label: "Summary", type: "text" }],
	});
	blogId = postType.id;
	for (const title of ["Rye", "Spelt", "Brioche", "Focaccia", "Bagels"]) {
		const { entry } = await staff.api.entries.create({ siteId, postTypeId: blogId, title, fields: { summary: title } });
		if (title !== "Bagels") await staff.api.entries.publish({ siteId, entryId: entry.id });
	}
	area = buildingAreaApi(install, await openBuildingArea(install, staff, siteId));
});

afterAll(async () => {
	await install.close();
});

describe("a Loop's result from the Site's address", () => {
	test("a query Loop lists its Draft's items up to its limit, after its offset, and counts them all", async () => {
		const { loop } = await area.api.loops.create({
			siteId,
			name: "latest-posts",
			source: "query",
			query: { postTypes: ["blog"], sort: [{ by: "title", direction: "asc" }], limit: 3 },
		});

		const first = await area.api.loops.result({ siteId, loopId: loop.id });
		// The Data tab's reading: the Drafts of the Site's Entries, never-published ones too.
		expect(first.total).toBe(5);
		expect(first.items.map((item) => item.label)).toEqual(["Bagels", "Brioche", "Focaccia"]);
		expect(first.items[0]?.values).toMatchObject({ title: "Bagels", summary: "Bagels" });
		expect(first.pages).toBe(0);

		await area.api.loops.saveDraft({ siteId, loopId: loop.id, query: { ...loop.draft.query, limit: 2, offset: 1 } });
		const narrower = await area.api.loops.result({ siteId, loopId: loop.id });
		expect(narrower.items.map((item) => item.label)).toEqual(["Brioche", "Focaccia"]);
		expect(narrower.total).toBe(5);

		// Past the last match the count still holds.
		await area.api.loops.saveDraft({ siteId, loopId: loop.id, query: { ...loop.draft.query, offset: 10 } });
		const past = await area.api.loops.result({ siteId, loopId: loop.id });
		expect(past).toMatchObject({ items: [], total: 5 });
	});

	test("a Loop of its own items lists every one, in order", async () => {
		const { loop } = await area.api.loops.create({
			siteId,
			name: "opening-hours",
			source: "items",
			fields: [
				{ key: "day", label: "Day", type: "text" },
				{ key: "hours", label: "Hours", type: "text" },
			],
		});
		await area.api.loops.saveItems({
			siteId,
			loopId: loop.id,
			items: [
				{ day: "Monday", hours: "8–18" },
				{ day: "Tuesday", hours: "8–18" },
			],
		});

		const result = await area.api.loops.result({ siteId, loopId: loop.id });
		expect(result.total).toBe(2);
		expect(result.items).toEqual([
			{ label: "Monday", values: { day: "Monday", hours: "8–18" } },
			{ label: "Tuesday", values: { day: "Tuesday", hours: "8–18" } },
		]);
	});

	test("counts the published pages that show the Loop through published Templates", async () => {
		const { loop } = await area.api.loops.create({
			siteId,
			name: "more-posts",
			source: "query",
			query: { postTypes: ["blog"], limit: 2, excludeCurrent: true },
		});
		await area.api.loops.publish({ siteId, loopId: loop.id });
		const template = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: blogId,
			markup: "<article><h1>{{ title }}</h1>{{@loop more-posts as post}}<p>{{ post.title }}</p>{{/loop}}</article>",
		});
		expect((await area.api.loops.result({ siteId, loopId: loop.id })).pages).toBe(0);

		await staff.api.templates.publish({ siteId, templateId: template.template.id });
		// Every published Blog post shows it: the never-published one has no page.
		expect((await area.api.loops.result({ siteId, loopId: loop.id })).pages).toBe(4);
	});

	test("a Member is refused: Loops are Structure", async () => {
		const { loops } = await area.api.loops.list({ siteId });
		const loopId = loops[0]?.id ?? "";
		const member = buildingAreaApi(install, await openBuildingArea(install, editor, siteId));
		for (const call of [
			() => member.api.loops.list({ siteId }),
			() => member.api.loops.result({ siteId, loopId }),
			() => member.api.loops.saveDraft({ siteId, loopId, query: { limit: 1 } }),
		]) {
			expect(await rejection(call())).toMatchObject({ code: "FORBIDDEN", data: { permission: "structure.edit" } });
		}
	});
});
