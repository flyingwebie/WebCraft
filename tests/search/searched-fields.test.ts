// Searched fields (ADR 0021): each Post Type sets once which of its Fields Site search (and every
// Filter's search box) looks in, each with a weight from A (counts most) to D, and whether it shows in
// Site search at all. They are Structure, set with the Post Type.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { FieldInput } from "@webcraft/core";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
});

afterAll(async () => {
	await install.close();
});

const RECIPE_FIELDS: FieldInput[] = [
	{ key: "summary", label: "Summary", type: "text" },
	{ key: "body", label: "Body", type: "body" },
	{ key: "intro", label: "Intro", type: "richText" },
	{ key: "minutes", label: "Minutes", type: "number" },
	{
		key: "difficulty",
		label: "Difficulty",
		type: "select",
		options: [
			{ value: "easy", label: "Easy" },
			{ value: "hard", label: "Hard" },
		],
	},
	{ key: "source", label: "Source", type: "link" },
	{ key: "contact", label: "Contact", type: "email" },
	{ key: "photo", label: "Photo", type: "media" },
	{ key: "origin", label: "Origin", type: "group", fields: [{ key: "city", label: "City", type: "text" }] },
	{
		key: "steps",
		label: "Steps",
		type: "repeater",
		fields: [
			{ key: "text", label: "Text", type: "text" },
			{ key: "seconds", label: "Seconds", type: "number" },
		],
	},
];

let created = 0;

async function recipes(extra: Record<string, unknown> = {}) {
	created++;
	return (
		await staff.api.postTypes.create({
			siteId,
			name: `Recipes ${created}`,
			urlPattern: `/recipes-${created}/{slug}`,
			fields: RECIPE_FIELDS,
			...extra,
		})
	).postType;
}

describe("a new Post Type", () => {
	test("is searchable, searching its title (A) and its Body field (B) until Staff choose", async () => {
		const postType = await recipes();

		expect(postType.searchable).toBe(true);
		expect(postType.searchedFields).toEqual([
			{ field: "title", weight: "A" },
			{ field: "body", weight: "B" },
		]);
	});

	test("without a Body field, searches its title alone", async () => {
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Team", urlPattern: "/team/{slug}" });

		expect(postType.searchedFields).toEqual([{ field: "title", weight: "A" }]);
	});

	test("the Page Post Type is searchable, by its title", async () => {
		const { postTypes } = await staff.api.postTypes.list({ siteId });
		const pages = postTypes.find((postType) => postType.builtIn === "page");

		expect(pages?.searchable).toBe(true);
		expect(pages?.searchedFields).toEqual([{ field: "title", weight: "A" }]);
	});

	test("Staff choose its Searched fields and weights, and whether Site search shows it", async () => {
		const postType = await recipes({
			searchable: false,
			searchedFields: [
				{ field: "title", weight: "A" },
				{ field: "summary", weight: "B" },
				{ field: "intro", weight: "C" },
				{ field: "difficulty", weight: "D" },
				{ field: "source", weight: "D" },
				{ field: "contact", weight: "D" },
				{ field: "origin.city", weight: "C" },
				{ field: "steps.text", weight: "D" },
			],
		});

		expect(postType.searchable).toBe(false);
		expect(postType.searchedFields.map(({ field }) => field)).toEqual([
			"title",
			"summary",
			"intro",
			"difficulty",
			"source",
			"contact",
			"origin.city",
			"steps.text",
		]);
		expect((await staff.api.postTypes.get({ siteId, postTypeId: postType.id })).postType).toEqual(postType);
	});
});

describe("changing them", () => {
	test("Staff change the weights and turn Site search off and on again", async () => {
		const postType = await recipes();

		const { postType: changed } = await staff.api.postTypes.update({
			siteId,
			postTypeId: postType.id,
			searchable: false,
			searchedFields: [
				{ field: "summary", weight: "A" },
				{ field: "title", weight: "B" },
			],
		});

		expect(changed.searchable).toBe(false);
		expect(changed.searchedFields).toEqual([
			{ field: "summary", weight: "A" },
			{ field: "title", weight: "B" },
		]);
		const { postType: again } = await staff.api.postTypes.update({ siteId, postTypeId: postType.id, searchable: true });
		expect(again.searchable).toBe(true);
		expect(again.searchedFields).toEqual(changed.searchedFields);
	});

	test("a Field removed from the Post Type leaves its Searched fields", async () => {
		const postType = await recipes({
			searchedFields: [
				{ field: "title", weight: "A" },
				{ field: "summary", weight: "B" },
				{ field: "origin.city", weight: "C" },
			],
		});

		const { postType: changed } = await staff.api.postTypes.update({
			siteId,
			postTypeId: postType.id,
			fields: RECIPE_FIELDS.filter((field) => field.key !== "summary" && field.key !== "origin"),
		});

		expect(changed.searchedFields).toEqual([{ field: "title", weight: "A" }]);
	});

	test("Members can't change them", async () => {
		const postType = await recipes();

		await expect(
			owner.api.postTypes.update({ siteId, postTypeId: postType.id, searchable: false }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("a change is recorded in the Audit log with what changed", async () => {
		const postType = await recipes();
		await staff.api.postTypes.update({
			siteId,
			postTypeId: postType.id,
			searchedFields: [{ field: "title", weight: "A" }],
		});

		const admin = await install.superadmin();
		const { entries } = await admin.api.audit.list({ limit: 1 });
		expect(entries[0]).toMatchObject({
			action: "postType.update",
			details: { postTypeId: postType.id, changed: ["searchedFields"] },
		});
	});
});

describe("refused Searched fields", () => {
	for (const [what, searchedFields, at, rule] of [
		[
			"a Field the Post Type doesn't have",
			[{ field: "price", weight: "A" }],
			"searchedFields[0].field",
			"searchedFieldUnknown",
		],
		["a number", [{ field: "minutes", weight: "A" }], "searchedFields[0].field", "searchedFieldType"],
		["a Media Field", [{ field: "photo", weight: "B" }], "searchedFields[0].field", "searchedFieldType"],
		["a Group itself", [{ field: "origin", weight: "B" }], "searchedFields[0].field", "searchedFieldType"],
		["a Repeater's number", [{ field: "steps.seconds", weight: "B" }], "searchedFields[0].field", "searchedFieldType"],
		["a built-in date", [{ field: "publishedAt", weight: "B" }], "searchedFields[0].field", "searchedFieldUnknown"],
		[
			"one Field twice",
			[
				{ field: "summary", weight: "A" },
				{ field: "summary", weight: "B" },
			],
			"searchedFields[1].field",
			"searchedFieldTwice",
		],
	] as const) {
		test(`${what} is refused where it is`, async () => {
			await expect(recipes({ searchedFields })).rejects.toMatchObject({
				code: "POST_TYPE_INVALID",
				data: { problems: [{ at, rule }] },
			});
		});
	}

	test("a weight other than A, B, C or D is refused", async () => {
		await expect(recipes({ searchedFields: [{ field: "title", weight: "E" }] })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
	});

	test("an update naming a Field the same update removes is refused", async () => {
		const postType = await recipes();

		await expect(
			staff.api.postTypes.update({
				siteId,
				postTypeId: postType.id,
				fields: [{ key: "summary", label: "Summary", type: "text" }],
				searchedFields: [{ field: "body", weight: "B" }],
			}),
		).rejects.toMatchObject({
			code: "POST_TYPE_INVALID",
			data: { problems: [{ at: "searchedFields[0].field", rule: "searchedFieldUnknown" }] },
		});
	});
});
