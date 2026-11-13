// What Staff hide from the Content API: whole Post Types and single Fields (of Post Types, inside
// Groups and Repeaters too, and of the Globals). Hidden ones never appear anywhere: lists, single
// Entries, Relationships, filters, sorts, `fields`, search and the schema, and can't be told apart
// from what doesn't exist.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { type Bakery, bakery } from "./support.ts";

let install: TestInstall;
let site: Bakery;

type Item = Record<string, unknown> & { id: string; title: string; fields: Record<string, unknown> };
type Problems = { code: string; data: { problems: { parameter: string; problem: string }[] } };

beforeAll(async () => {
	install = await createTestInstall();
	site = await bakery(install, "bakery");
	await site.staff.api.globals.setFields({
		siteId: site.siteId,
		fields: [
			{ key: "phone", label: "Phone", type: "text" },
			{ key: "wifi", label: "Wi-Fi password", type: "text" },
		],
	});
	await site.staff.api.globals.saveDraft({ siteId: site.siteId, fields: { phone: "01 234", wifi: "croissant" } });
	await site.staff.api.globals.publish({ siteId: site.siteId });
	const breads = await site.publish(site.categoriesId, "Breads", { fields: { colour: "brown" } });
	await site.publish(site.recipesId, "Sourdough", {
		fields: {
			summary: "Tangy",
			price: 6,
			category: breads,
			origin: { city: "Dublin", secret: "starter from 1998" },
			body: [{ type: "paragraph", text: "Stretch and fold" }],
		},
	});
	const { postTypes } = await site.staff.api.postTypes.list({ siteId: site.siteId });
	const recipes = postTypes.find((postType) => postType.key === "recipes");
	await site.staff.api.postTypes.update({
		siteId: site.siteId,
		postTypeId: site.recipesId,
		searchable: true,
		searchedFields: [
			{ field: "title", weight: "A" },
			{ field: "body", weight: "B" },
		],
	});
	expect(recipes).toBeDefined();
	await site.staff.api.contentApi.update({
		siteId: site.siteId,
		hidden: {
			postTypes: [site.categoriesId],
			fields: { [site.recipesId]: ["price", "origin.secret"] },
			globals: ["wifi"],
		},
	});
});

afterAll(async () => {
	await install.close();
});

describe("hidden Post Types", () => {
	test("aren't listed, and their Entries aren't found: answered as if they didn't exist", async () => {
		const list = await site.frontend().json("/entries/categories");
		expect(list.response.status).toBe(404);
		expect(list.body).toMatchObject({ code: "POST_TYPE_NOT_FOUND" });

		const one = await site.frontend().json(`/entries/categories/${site.ids.Breads}`);
		expect(one.response.status).toBe(404);
		expect(one.body).toMatchObject({ code: "POST_TYPE_NOT_FOUND" });
		const byPath = await site.frontend().json("/entry?path=/categories/breads");
		expect(byPath.response.status).toBe(404);
		expect(byPath.body).toMatchObject({ code: "ENTRY_NOT_FOUND" });
	});

	test("a Relationship that points only at a hidden Post Type is left out with it, from Entries and the schema", async () => {
		const { body } = await site.frontend().json<{ entry: Item }>(`/entries/recipes/${site.ids.Sourdough}`);
		expect(Object.keys(body.entry.fields)).not.toContain("category");

		const schema = (await site.frontend().json<{ postTypes: { key: string; fields: { key: string }[] }[] }>("/schema"))
			.body;
		expect(schema.postTypes.map((postType) => postType.key)).toEqual(["page", "recipes"]);
		expect(schema.postTypes[1]?.fields.map((field) => field.key)).not.toContain("category");
	});

	test("filtering by a Relationship left out is refused like an unknown Field", async () => {
		const { response, body } = await site
			.frontend()
			.json<Problems>(`/entries/recipes?filter.category=${site.ids.Breads}`);
		expect(response.status).toBe(400);
		expect(body.data.problems).toEqual([
			expect.objectContaining({ parameter: "filter.category", problem: "fieldUnknown" }),
		]);
	});
});

describe("hidden Fields", () => {
	test("never appear in an Entry, a list or a Group's values", async () => {
		const { body } = await site.frontend().json<{ items: Item[] }>("/entries/recipes");
		const sourdough = body.items[0];
		expect(sourdough?.fields).not.toHaveProperty("price");
		expect(sourdough?.fields.origin).toEqual({ city: "Dublin" });
		expect(JSON.stringify(body)).not.toContain("starter from 1998");
	});

	test("filtering, sorting and choosing by a hidden Field is refused exactly as by one that doesn't exist", async () => {
		const ask = async (query: string) => (await site.frontend().json<Problems>(`/entries/recipes${query}`)).body;
		const hidden = await ask("?filter.price=6&sort=price&fields=price");
		const missing = await ask("?filter.flavour=6&sort=flavour&fields=flavour");

		expect(hidden.data.problems.map(({ problem }) => problem)).toEqual(
			missing.data.problems.map(({ problem }) => problem),
		);
		expect(hidden.data.problems.map(({ problem }) => problem)).toEqual([
			"fieldUnknown",
			"fieldUnknown",
			"fieldUnknown",
		]);
	});

	test("the schema leaves them out", async () => {
		const schema = (
			await site.frontend().json<{
				postTypes: { key: string; fields: { key: string; fields?: { key: string }[] }[] }[];
				globals: { fields: { key: string }[] };
			}>("/schema")
		).body;
		const recipes = schema.postTypes.find((postType) => postType.key === "recipes");
		expect(recipes?.fields.map((field) => field.key)).not.toContain("price");
		expect(recipes?.fields.find((field) => field.key === "origin")?.fields?.map((field) => field.key)).toEqual([
			"city",
		]);
		expect(schema.globals.fields.map((field) => field.key)).toEqual(["phone"]);
	});

	test("a hidden Global isn't answered", async () => {
		const { body } = await site.frontend().json<{ fields: Record<string, unknown> }>("/globals");
		expect(body.fields).toEqual({ phone: "01 234" });
	});

	test("search leaves out a Post Type whose Searched fields include a hidden Field, so no hit or snippet shows it", async () => {
		const found = async () =>
			(await site.frontend().json<{ items: Item[] }>("/search?q=stretch")).body.items.map((item) => item.title);
		expect(await found()).toEqual(["Sourdough"]);

		await site.staff.api.contentApi.update({
			siteId: site.siteId,
			hidden: { fields: { [site.recipesId]: ["price", "origin.secret", "body"] } },
		});
		expect(await found()).toEqual([]);
		const schema = (await site.frontend().json<{ postTypes: { key: string; searchable: boolean }[] }>("/schema")).body;
		expect(schema.postTypes.find((postType) => postType.key === "recipes")?.searchable).toBe(false);
	});

	test("Staff see what is hidden, and an unknown Post Type or Field is refused when hiding", async () => {
		const { hidden } = await site.staff.api.contentApi.get({ siteId: site.siteId });
		expect(hidden).toEqual({
			postTypes: [site.categoriesId],
			fields: { [site.recipesId]: ["price", "origin.secret", "body"] },
			globals: ["wifi"],
		});

		const refusal = await site.staff.api.contentApi
			.update({ siteId: site.siteId, hidden: { fields: { [site.recipesId]: ["flavour"] }, globals: ["fax"] } })
			.catch((error: { code: string; data: { problems: { at: string }[] } }) => error);
		expect(refusal).toMatchObject({ code: "CONTENT_API_INVALID" });
		expect((refusal as { data: { problems: { at: string }[] } }).data.problems.map((problem) => problem.at)).toEqual([
			`hidden.fields.${site.recipesId}[0]`,
			"hidden.globals[0]",
		]);
	});
});
