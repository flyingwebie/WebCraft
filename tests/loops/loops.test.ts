// Loops (GLOSSARY.md) as Structure: Staff define a Loop's name and where its items come from (a query
// over Entries, or the Loop's own Loop items), save it as a Draft and publish it like a Template.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	await staff.api.postTypes.create({
		siteId,
		name: "Recipes",
		key: "recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "minutes", label: "Minutes", type: "number" },
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "vegan", label: "Vegan", type: "boolean" },
			{ key: "cookedOn", label: "Cooked on", type: "date" },
			{ key: "photo", label: "Photo", type: "media" },
			{
				key: "difficulty",
				label: "Difficulty",
				type: "select",
				options: [
					{ value: "easy", label: "Easy" },
					{ value: "hard", label: "Hard" },
				],
			},
			{ key: "address", label: "Address", type: "group", fields: [{ key: "city", label: "City", type: "text" }] },
		],
	});
	await staff.api.postTypes.create({ siteId, name: "Chefs", key: "chefs", urlPattern: "/chefs/{slug}" });
});

afterAll(async () => {
	await install.close();
});

describe("creating a Loop", () => {
	test("Staff name a query Loop; it starts as a Draft listing nothing until it has Post Types", async () => {
		const { loop } = await staff.api.loops.create({ siteId, name: "latest-recipes", source: "query" });

		expect(loop).toMatchObject({
			siteId,
			name: "latest-recipes",
			status: "draft",
			published: null,
			publishedAt: null,
			draft: {
				source: "query",
				query: {
					postTypes: [],
					match: "all",
					filters: [],
					sort: [],
					limit: 10,
					offset: 0,
					paginate: false,
					excludeCurrent: false,
				},
				fields: [],
				items: [],
			},
		});
		expect((await staff.api.loops.get({ siteId, loopId: loop.id })).loop).toEqual(loop);
		const { loops } = await staff.api.loops.list({ siteId });
		expect(loops.map((listed) => [listed.name, listed.status])).toContainEqual(["latest-recipes", "draft"]);
	});

	test("a Loop's name is lower-case words joined by dashes, unique on the Site", async () => {
		for (const name of ["Latest", "latest_posts", "-posts", "posts-", "1posts", "site", "title", ""]) {
			await expect(staff.api.loops.create({ siteId, name, source: "query" })).rejects.toMatchObject({
				code: "LOOP_INVALID",
				data: { problems: [{ at: "name" }] },
			});
		}
		await staff.api.loops.create({ siteId, name: "chefs-list", source: "query" });
		await expect(staff.api.loops.create({ siteId, name: "chefs-list", source: "items" })).rejects.toMatchObject({
			code: "LOOP_NAME_TAKEN",
			status: 409,
		});
	});

	test("Members never see or change Loops: they are Structure", async () => {
		await expect(editor.api.loops.list({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(editor.api.loops.create({ siteId, name: "mine", source: "query" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});

describe("a query", () => {
	test("Post Types, Field filters, Relationship, status and date filters, sort, limit, offset and exclude current", async () => {
		const { loop } = await staff.api.loops.create({ siteId, name: "quick-recipes", source: "query" });
		const query = {
			postTypes: ["recipes"],
			match: "any" as const,
			filters: [
				{ type: "field" as const, field: "minutes", operator: "atMost" as const, value: 30 },
				{ type: "field" as const, field: "vegan", operator: "equals" as const, value: true },
				{ type: "field" as const, field: "address.city", operator: "contains" as const, value: "Cork" },
				{ type: "field" as const, field: "photo", operator: "notEmpty" as const },
				{ type: "status" as const, statuses: ["published" as const, "changed" as const] },
				{ type: "date" as const, field: "publishedAt", window: "last" as const, amount: 12, unit: "months" as const },
				{ type: "date" as const, field: "cookedOn", window: "between" as const, from: "2026-01-01", to: null },
			],
			sort: [
				{ by: "minutes", direction: "asc" as const },
				{ by: "title", direction: "asc" as const },
			],
			limit: 12,
			offset: 2,
			paginate: true,
			excludeCurrent: true,
		};
		const { loop: saved } = await staff.api.loops.saveDraft({ siteId, loopId: loop.id, query });

		expect(saved.draft.query).toEqual({
			...query,
			filters: [
				{ type: "field", field: "minutes", operator: "atMost", value: 30 },
				{ type: "field", field: "vegan", operator: "equals", value: true },
				{ type: "field", field: "address.city", operator: "contains", value: "Cork" },
				{ type: "field", field: "photo", operator: "notEmpty", value: null },
				{ type: "status", statuses: ["published", "changed"] },
				{ type: "date", field: "publishedAt", window: "last", amount: 12, unit: "months", from: null, to: null },
				{ type: "date", field: "cookedOn", window: "between", amount: null, unit: null, from: "2026-01-01", to: null },
			],
		});
	});

	test("a query is refused with each problem where it is", async () => {
		const { loop } = await staff.api.loops.create({ siteId, name: "broken", source: "query" });

		await expect(
			staff.api.loops.saveDraft({
				siteId,
				loopId: loop.id,
				query: {
					postTypes: ["recipes", "events"],
					filters: [
						{ type: "field", field: "colour", operator: "equals", value: "red" },
						{ type: "field", field: "minutes", operator: "contains", value: "3" },
						{ type: "field", field: "minutes", operator: "atLeast", value: "three" },
						{ type: "relationship", field: "summary", to: "current" },
						{ type: "date", field: "summary", window: "past" },
					],
					sort: [{ by: "photo", direction: "asc" }],
					limit: 500,
					offset: -1,
				},
			}),
		).rejects.toMatchObject({
			code: "LOOP_INVALID",
			data: {
				problems: [
					{ at: "query.postTypes[1]" },
					{ at: "query.filters[0].field" },
					{ at: "query.filters[1].operator" },
					{ at: "query.filters[2].value" },
					{ at: "query.filters[3].field" },
					{ at: "query.filters[4].field" },
					{ at: "query.sort[0].by" },
					{ at: "query.limit" },
					{ at: "query.offset" },
				],
			},
		});
	});

	test("a query Loop with no Post Type can't be published", async () => {
		const { loop } = await staff.api.loops.create({ siteId, name: "unfinished", source: "query" });

		await expect(staff.api.loops.publish({ siteId, loopId: loop.id })).rejects.toMatchObject({
			code: "LOOP_INVALID",
			data: { problems: [{ at: "query.postTypes" }] },
		});
	});
});

describe("Loop items", () => {
	test("a Loop of its own items: Staff define its Fields, the items have values per language", async () => {
		await staff.api.languages.add({ siteId, code: "fr" });
		const { loop } = await staff.api.loops.create({
			siteId,
			name: "opening-hours",
			source: "items",
			fields: [
				{ key: "day", label: "Day", type: "text", required: true },
				{ key: "hours", label: "Hours", type: "text" },
				{ key: "closed", label: "Closed", type: "boolean" },
			],
		});
		const { loop: withItems } = await staff.api.loops.saveItems({
			siteId,
			loopId: loop.id,
			items: [
				{ day: "Monday", hours: "7:30 – 18:00" },
				{ day: "Sunday", closed: true },
			],
		});
		const [monday, sunday] = withItems.draft.items;
		expect(withItems.draft.items).toEqual([
			{ id: expect.any(String), day: "Monday", hours: "7:30 – 18:00", closed: false },
			{ id: expect.any(String), day: "Sunday", hours: null, closed: true },
		]);

		await staff.api.loops.saveItems({
			siteId,
			loopId: loop.id,
			language: "fr",
			items: [
				{ id: monday?.id, day: "Lundi" },
				{ id: sunday?.id, day: "Dimanche" },
			],
		});
		const { loop: inFrench } = await staff.api.loops.get({ siteId, loopId: loop.id, language: "fr" });
		expect(inFrench.draft.items.map((item) => [item.day, item.hours])).toEqual([
			["Lundi", "7:30 – 18:00"],
			["Dimanche", null],
		]);
		const { loop: inEnglish } = await staff.api.loops.get({ siteId, loopId: loop.id });
		expect(inEnglish.draft.items.map((item) => item.day)).toEqual(["Monday", "Sunday"]);
	});

	test("an item's values are checked as Fields' are: the wrong kind is refused, required ones block publishing", async () => {
		const { loop } = await staff.api.loops.create({
			siteId,
			name: "team",
			source: "items",
			fields: [{ key: "name", label: "Name", type: "text", required: true }],
		});

		await expect(staff.api.loops.saveItems({ siteId, loopId: loop.id, items: [{ name: 42 }] })).rejects.toMatchObject({
			code: "LOOP_INVALID",
			data: { problems: [{ at: "items[0].name" }] },
		});
		await staff.api.loops.saveItems({ siteId, loopId: loop.id, items: [{ name: "" }] });
		await expect(staff.api.loops.publish({ siteId, loopId: loop.id })).rejects.toMatchObject({
			code: "LOOP_INCOMPLETE",
			data: { missing: ["items[0].name"] },
		});
	});

	test("Loop items hold no Body field and no Relationship", async () => {
		await expect(
			staff.api.loops.create({
				siteId,
				name: "odd-fields",
				source: "items",
				fields: [
					{ key: "text", label: "Text", type: "body" },
					{ key: "chef", label: "Chef", type: "relationship", postTypes: ["chefs"] },
				],
			}),
		).rejects.toMatchObject({
			code: "LOOP_INVALID",
			data: { problems: [{ at: "fields[0].type" }, { at: "fields[1].type" }] },
		});
	});
});

describe("publishing a Loop", () => {
	test("its Draft becomes what visitors see; a later change shows as changed until published again", async () => {
		const { loop } = await staff.api.loops.create({ siteId, name: "all-recipes", source: "query" });
		await staff.api.loops.saveDraft({ siteId, loopId: loop.id, query: { postTypes: ["recipes"] } });

		const { loop: published } = await staff.api.loops.publish({ siteId, loopId: loop.id });
		expect(published.status).toBe("published");
		expect(published.published?.query.postTypes).toEqual(["recipes"]);
		expect(published.publishedAt).not.toBeNull();

		const { loop: changed } = await staff.api.loops.saveDraft({
			siteId,
			loopId: loop.id,
			query: { postTypes: ["recipes", "chefs"] },
		});
		expect(changed.status).toBe("changed");
		expect(changed.published?.query.postTypes).toEqual(["recipes"]);

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 50 });
		expect(entries.map((entry) => entry.action)).toEqual(expect.arrayContaining(["loop.create", "loop.publish"]));
	});
});
