// Entries through the Content API (ADR 0029): a Post Type's published Entries as a list (Field
// filters, one sort Field with a stable tiebreak, cursor pagination), one Entry by id, slug or path,
// Relationships one level deep and the Body field as HTML, Blocks or Markdown. Published content only.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { type Bakery, bakery } from "./support.ts";

let install: TestInstall;
let site: Bakery;

type Item = Record<string, unknown> & { id: string; title: string; fields: Record<string, unknown> };
type List = { items: Item[]; total: number; next: string | null };
type Refusal = { code: string; status: number; data: { problems: { parameter: string; problem: string }[] } };

beforeAll(async () => {
	install = await createTestInstall();
	site = await bakery(install, "bakery");
	const breads = await site.publish(site.categoriesId, "Breads", { fields: { colour: "brown" } });
	const cakes = await site.publish(site.categoriesId, "Cakes", { fields: { colour: "pink" } });
	await site.publish(site.recipesId, "Sourdough", {
		fields: {
			summary: "A slow bread",
			price: 6,
			vegan: true,
			bakedOn: "2026-03-01",
			kind: "bread",
			chef: "ada@bakery.example",
			category: breads,
			body: [
				{ type: "heading", level: 2, text: "Method" },
				{ type: "paragraph", text: "Fold & wait." },
			],
			origin: { city: "Dublin", secret: "starter from 1998" },
			steps: [{ text: "Mix" }, { text: "Bake" }],
		},
	});
	await site.publish(site.recipesId, "Brioche", {
		fields: { price: 4.5, vegan: false, bakedOn: "2026-03-03", kind: "bread", category: breads },
	});
	await site.publish(site.recipesId, "Chocolate cake", {
		fields: { price: 12, bakedOn: "2026-02-20", kind: "cake", category: cakes, chef: "bo@bakery.example" },
	});
	await site.publish(site.recipesId, "Rye bread", { fields: { price: 6, kind: "bread", category: breads } });
	await site.publish(site.recipesId, "Lemon tart", {
		fields: { price: 8, kind: "pastry", pairsWith: [site.ids.Brioche, site.ids["Chocolate cake"]] },
	});
});

afterAll(async () => {
	await install.close();
});

async function list(query = ""): Promise<{ response: Response; body: List }> {
	return site.frontend().json<List>(`/entries/recipes${query}`);
}

async function titles(query = ""): Promise<string[]> {
	const { response, body } = await list(query);
	expect(response.status).toBe(200);
	return body.items.map((item) => item.title);
}

async function refused(path: string): Promise<Refusal> {
	const { response, body } = await site.frontend().json<Refusal>(path);
	expect(response.status).toBe(400);
	expect(body.code).toBe("QUERY_INVALID");
	return body;
}

describe("a list", () => {
	test("lists a Post Type's published Entries, newest first, each with its built-in values, SEO fields and Fields", async () => {
		const { body } = await list();

		expect(body.items.map((item) => item.title)).toEqual([
			"Lemon tart",
			"Rye bread",
			"Chocolate cake",
			"Brioche",
			"Sourdough",
		]);
		expect(body.total).toBe(5);
		expect(body.next).toBeNull();
		const sourdough = body.items.find((item) => item.title === "Sourdough");
		expect(sourdough).toMatchObject({
			id: site.ids.Sourdough,
			postType: "recipes",
			language: "en",
			slug: "sourdough",
			path: "/recipes/sourdough",
			url: `${site.origin}/recipes/sourdough`,
			seo: { title: null, description: null, canonical: null, image: null, noindex: false },
			fallbacks: {},
		});
		expect(typeof sourdough?.publishedAt).toBe("string");
		expect(sourdough?.fields).toMatchObject({
			summary: "A slow bread",
			price: 6,
			vegan: true,
			bakedOn: "2026-03-01",
			kind: "bread",
			chef: "ada@bakery.example",
			category: site.ids.Breads,
			pairsWith: [],
			photo: null,
			origin: { city: "Dublin", secret: "starter from 1998" },
			steps: [{ text: "Mix" }, { text: "Bake" }],
		});
	});

	test("Drafts never show: an Entry never published isn't listed, and a published one shows what is published, not its Draft", async () => {
		const { entry } = await site.staff.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.recipesId,
			title: "Secret scone",
		});
		await site.staff.api.entries.saveDraft({
			siteId: site.siteId,
			entryId: site.ids.Brioche ?? "",
			title: "Brioche (new)",
			fields: { price: 99 },
		});
		await site.staff.api.publishing.schedule({
			siteId: site.siteId,
			item: { kind: "entry", id: entry.id },
			at: new Date(install.clock.now().getTime() + 3_600_000).toISOString(),
		});

		const items = (await list()).body.items;
		expect(items.map((item) => item.title)).not.toContain("Secret scone");
		expect(items.find((item) => item.id === site.ids.Brioche)).toMatchObject({
			title: "Brioche",
			fields: { price: 4.5 },
		});
		const one = await site.frontend().json(`/entries/recipes/${entry.id}`);
		expect(one.response.status).toBe(404);
		expect(one.body).toMatchObject({ code: "ENTRY_NOT_FOUND" });
	});

	test("an unknown Post Type answers 404 POST_TYPE_NOT_FOUND, an unknown path 404 NOT_FOUND", async () => {
		const unknown = await site.frontend().json("/entries/pies");
		expect(unknown.response.status).toBe(404);
		expect(unknown.body).toMatchObject({ code: "POST_TYPE_NOT_FOUND" });
		const nowhere = await site.frontend().json("/recipes");
		expect(nowhere.response.status).toBe(404);
		expect(nowhere.body).toMatchObject({ code: "NOT_FOUND" });
	});

	test("a parameter the path doesn't take, or one given twice, is refused with each problem named", async () => {
		const body = await refused("/entries/recipes?page=2&sort=title&sort=-title");

		expect(body.data.problems).toEqual([
			expect.objectContaining({ parameter: "page", problem: "parameterUnknown" }),
			expect.objectContaining({ parameter: "sort", problem: "parameterRepeated" }),
		]);
	});
});

describe("pages of a list", () => {
	test("20 at a time unless limit asks for 1 to 100; next is a cursor for the rest, in the same order", async () => {
		const first = (await list("?limit=2")).body;
		expect(first.items.map((item) => item.title)).toEqual(["Lemon tart", "Rye bread"]);
		expect(first.total).toBe(5);
		expect(first.next).toEqual(expect.any(String));

		const second = (await list(`?limit=2&cursor=${encodeURIComponent(first.next ?? "")}`)).body;
		expect(second.items.map((item) => item.title)).toEqual(["Chocolate cake", "Brioche"]);
		const third = (await list(`?limit=2&cursor=${encodeURIComponent(second.next ?? "")}`)).body;
		expect(third.items.map((item) => item.title)).toEqual(["Sourdough"]);
		expect(third.next).toBeNull();

		for (const limit of ["0", "101", "ten"]) {
			expect((await refused(`/entries/recipes?limit=${limit}`)).data.problems).toEqual([
				expect.objectContaining({ parameter: "limit", problem: "limitInvalid" }),
			]);
		}
	});

	test("a page past the cursor never repeats or skips an item when values tie: the id breaks ties", async () => {
		const seen: string[] = [];
		let cursor: string | null = "";
		while (cursor !== null) {
			const page: List = (await list(`?sort=price&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`))
				.body;
			seen.push(...page.items.map((item) => item.title));
			cursor = page.next;
		}
		expect(seen.slice(0, 1)).toEqual(["Brioche"]);
		expect(seen.slice(1, 3).sort()).toEqual(["Rye bread", "Sourdough"]);
		expect(seen.slice(3)).toEqual(["Lemon tart", "Chocolate cake"]);
	});

	test("a cursor is tamper-proof and bound to its query: changed, made up, or sent with another query, it is refused", async () => {
		const { next } = (await list("?limit=1&sort=price")).body;
		const cursor = next ?? "";
		const [payload = "", signature = ""] = cursor.split(".");
		const changed = `${Buffer.from(
			Buffer.from(payload, "base64url")
				.toString()
				.replace(/"value":"[^"]*"/, '"value":"0"'),
		).toString("base64url")}.${signature}`;

		for (const sent of [changed, "made-up", `${payload}.AAAA`]) {
			expect(
				(await refused(`/entries/recipes?limit=1&sort=price&cursor=${encodeURIComponent(sent)}`)).data.problems,
			).toEqual([expect.objectContaining({ parameter: "cursor", problem: "cursorInvalid" })]);
		}
		expect(
			(await refused(`/entries/recipes?limit=1&sort=-price&cursor=${encodeURIComponent(cursor)}`)).data.problems,
		).toEqual([expect.objectContaining({ parameter: "cursor", problem: "cursorInvalid" })]);
	});
});

describe("filters", () => {
	test("equality on text, numbers, true/false, choices, email addresses and days", async () => {
		expect(await titles("?filter.summary=A%20slow%20bread")).toEqual(["Sourdough"]);
		expect(await titles("?filter.price=6")).toEqual(["Rye bread", "Sourdough"]);
		expect(await titles("?filter.vegan=true")).toEqual(["Sourdough"]);
		expect(await titles("?filter.vegan=false")).toEqual(["Lemon tart", "Rye bread", "Chocolate cake", "Brioche"]);
		expect(await titles("?filter.kind=pastry")).toEqual(["Lemon tart"]);
		expect(await titles("?filter.chef=bo@bakery.example")).toEqual(["Chocolate cake"]);
		expect(await titles("?filter.bakedOn=2026-03-03")).toEqual(["Brioche"]);
	});

	test("in: one of several values", async () => {
		expect(await titles("?filter.kind.in=cake,pastry")).toEqual(["Lemon tart", "Chocolate cake"]);
		expect(await titles("?filter.price.in=4.5,12")).toEqual(["Chocolate cake", "Brioche"]);
	});

	test("ranges of numbers and of days (and of publishing times), combined with each other", async () => {
		expect(await titles("?filter.price.gte=6&filter.price.lt=12")).toEqual(["Lemon tart", "Rye bread", "Sourdough"]);
		expect(await titles("?filter.price.gt=6")).toEqual(["Lemon tart", "Chocolate cake"]);
		expect(await titles("?filter.bakedOn.gte=2026-03-01&filter.bakedOn.lte=2026-03-03")).toEqual([
			"Brioche",
			"Sourdough",
		]);
		expect(await titles("?filter.bakedOn.lt=2026-03-01")).toEqual(["Chocolate cake"]);
		const { body } = await list();
		const brioche = body.items.find((item) => item.title === "Brioche");
		expect(await titles(`?filter.publishedAt.lte=${encodeURIComponent(String(brioche?.publishedAt))}`)).toEqual([
			"Brioche",
			"Sourdough",
		]);
	});

	test("a Relationship by the id of what it points at", async () => {
		expect(await titles(`?filter.category=${site.ids.Cakes}`)).toEqual(["Chocolate cake"]);
		expect(await titles(`?filter.category.in=${site.ids.Cakes},${site.ids.Breads}`)).toEqual([
			"Rye bread",
			"Chocolate cake",
			"Brioche",
			"Sourdough",
		]);
		expect(await titles(`?filter.pairsWith=${site.ids.Brioche}`)).toEqual(["Lemon tart"]);
	});

	test("filters are checked: an unknown Field, an operator its type doesn't take and a value of the wrong kind are refused with clear problems", async () => {
		const body = await refused(
			"/entries/recipes?filter.flavour=sweet&filter.notes=hi&filter.price.gte=cheap&filter.bakedOn=yesterday&filter.vegan=yes&filter.kind.gt=a&filter.category=nope",
		);

		expect(body.data.problems.map(({ parameter, problem }) => ({ parameter, problem }))).toEqual([
			{ parameter: "filter.flavour", problem: "fieldUnknown" },
			{ parameter: "filter.notes", problem: "filterUnsupported" },
			{ parameter: "filter.price.gte", problem: "valueInvalid" },
			{ parameter: "filter.bakedOn", problem: "valueInvalid" },
			{ parameter: "filter.vegan", problem: "valueInvalid" },
			{ parameter: "filter.kind.gt", problem: "filterUnsupported" },
			{ parameter: "filter.category", problem: "valueInvalid" },
		]);
	});
});

describe("sorting", () => {
	test("one sort Field, ascending or descending (-), then the id", async () => {
		expect(await titles("?sort=title")).toEqual(["Brioche", "Chocolate cake", "Lemon tart", "Rye bread", "Sourdough"]);
		expect(await titles("?sort=-price&limit=3")).toEqual(["Chocolate cake", "Lemon tart", expect.any(String)]);
		expect(await titles("?sort=publishedAt")).toEqual([
			"Sourdough",
			"Brioche",
			"Chocolate cake",
			"Rye bread",
			"Lemon tart",
		]);
	});

	test("Entries without a value come last, either way", async () => {
		expect((await titles("?sort=bakedOn")).at(-1)).toMatch(/Rye bread|Lemon tart/);
		expect(await titles("?sort=-bakedOn&limit=3")).toEqual(["Brioche", "Sourdough", "Chocolate cake"]);
	});

	test("an unknown Field or one that can't be sorted by is refused", async () => {
		expect((await refused("/entries/recipes?sort=flavour")).data.problems).toEqual([
			expect.objectContaining({ parameter: "sort", problem: "fieldUnknown" }),
		]);
		expect((await refused("/entries/recipes?sort=-body")).data.problems).toEqual([
			expect.objectContaining({ parameter: "sort", problem: "sortUnsupported" }),
		]);
	});
});

describe("one Entry", () => {
	test("by id, by slug in a language, and by its path on the Site", async () => {
		const byId = await site.frontend().json<{ entry: Item }>(`/entries/recipes/${site.ids.Brioche}`);
		expect(byId.response.status).toBe(200);
		expect(byId.body.entry).toMatchObject({ id: site.ids.Brioche, title: "Brioche", path: "/recipes/brioche" });

		const bySlug = await site.frontend().json<{ entry: Item }>("/entries/recipes/slug/brioche");
		expect(bySlug.body.entry.id).toBe(site.ids.Brioche as string);

		const byPath = await site.frontend().json<{ entry: Item }>("/entry?path=/recipes/brioche");
		expect(byPath.body.entry.id).toBe(site.ids.Brioche as string);
	});

	test("an id of another Post Type, an unknown slug or path, and a path with no Entry answer 404 ENTRY_NOT_FOUND", async () => {
		for (const path of [
			`/entries/categories/${site.ids.Brioche}`,
			"/entries/recipes/not-an-id",
			"/entries/recipes/slug/nothing",
			"/entry?path=/recipes/nothing",
		]) {
			const { response, body } = await site.frontend().json(path);
			expect(response.status).toBe(404);
			expect(body).toMatchObject({ code: "ENTRY_NOT_FOUND" });
		}
	});

	test("a Page by its path, the home page at /; Pages aren't found by slug", async () => {
		const { postTypes } = await site.staff.api.postTypes.list({ siteId: site.siteId });
		const pagesId = postTypes.find((postType) => postType.builtIn === "page")?.id ?? "";
		const about = await site.publish(pagesId, "About");
		const team = await site.publish(pagesId, "Team", { parentId: about });
		await site.staff.api.pages.setHomePage({ siteId: site.siteId, pageId: about });

		const home = await site.frontend().json<{ entry: Item }>("/entry?path=/");
		expect(home.body.entry).toMatchObject({ id: about, path: "/" });
		const page = await site.frontend().json<{ entry: Item }>("/entry?path=/about/team");
		expect(page.body.entry).toMatchObject({ id: team, postType: "page", parent: about });
		expect((await refused("/entries/page/slug/team")).data.problems).toEqual([
			expect.objectContaining({ problem: "notForPages" }),
		]);
	});

	test("an Entry unpublished since answers 410 ENTRY_GONE by id, slug and path, and leaves lists", async () => {
		const id = await site.publish(site.recipesId, "Old scone");
		await site.staff.api.publishing.scheduleUnpublish({
			siteId: site.siteId,
			entryId: id,
			at: new Date(install.clock.now().getTime() + 120_000).toISOString(),
		});
		await install.clock.advance(180_000);
		await install.drainJobs();

		for (const path of [
			`/entries/recipes/${id}`,
			"/entries/recipes/slug/old-scone",
			"/entry?path=/recipes/old-scone",
		]) {
			const { response, body } = await site.frontend().json(path);
			expect(response.status).toBe(410);
			expect(body).toMatchObject({ code: "ENTRY_GONE" });
		}
		expect(await titles()).not.toContain("Old scone");
	});
});

describe("Relationships", () => {
	test("are the ids of published Entries they point at; fields=<relationship>.<field> gives those Entries with chosen Fields, one level deep", async () => {
		const plain = (await site.frontend().json<{ entry: Item }>(`/entries/recipes/${site.ids["Lemon tart"]}`)).body
			.entry;
		expect(plain.fields.pairsWith).toEqual([site.ids.Brioche, site.ids["Chocolate cake"]]);

		const { body } = await site
			.frontend()
			.json<{ entry: Item }>(
				`/entries/recipes/${site.ids["Lemon tart"]}?fields=title,price,pairsWith.title,pairsWith.category`,
			);
		expect(Object.keys(body.entry.fields)).toEqual(["price", "pairsWith"]);
		const pairs = body.entry.fields.pairsWith as Item[];
		expect(pairs.map((pair) => pair.title)).toEqual(["Brioche", "Chocolate cake"]);
		expect(pairs[0]).toMatchObject({
			id: site.ids.Brioche,
			postType: "recipes",
			slug: "brioche",
			path: "/recipes/brioche",
			fields: { category: site.ids.Breads },
		});
		expect(Object.keys(pairs[0]?.fields ?? {})).toEqual(["category"]);
	});

	test("a Relationship to an Entry no longer published shows nothing of it", async () => {
		const scone = await site.publish(site.recipesId, "Plum scone");
		const crumble = await site.publish(site.recipesId, "Crumble", { fields: { pairsWith: [scone, site.ids.Brioche] } });
		await site.staff.api.publishing.scheduleUnpublish({
			siteId: site.siteId,
			entryId: scone,
			at: new Date(install.clock.now().getTime() + 120_000).toISOString(),
		});
		await install.clock.advance(180_000);
		await install.drainJobs();

		const { body } = await site.frontend().json<{ entry: Item }>(`/entries/recipes/${crumble}?fields=pairsWith.title`);
		expect((body.entry.fields.pairsWith as Item[]).map((pair) => pair.title)).toEqual(["Brioche"]);
	});

	test("fields are checked: two levels, unknown Fields and fields of what isn't a Relationship are refused", async () => {
		const body = await refused(
			"/entries/recipes?fields=pairsWith.category.title,flavour,price.amount,pairsWith.flavour",
		);

		expect(body.data.problems.map(({ problem }) => problem)).toEqual([
			"tooDeep",
			"fieldUnknown",
			"fieldNotRelationship",
			"fieldUnknown",
		]);
	});
});

describe("the Body field", () => {
	test("is HTML unless asked: the Blocks as semantic HTML, every text escaped", async () => {
		const { body } = await site.frontend().json<{ entry: Item }>(`/entries/recipes/${site.ids.Sourdough}?fields=body`);

		expect(body.entry.fields.body).toBe('<h2 id="method">Method</h2><p>Fold &amp; wait.</p>');
	});

	test("body=blocks gives the Blocks with their ids, as stored, without translation records", async () => {
		const { body } = await site
			.frontend()
			.json<{ entry: Item }>(`/entries/recipes/${site.ids.Sourdough}?fields=body&body=blocks`);

		expect(body.entry.fields.body).toEqual([
			{ id: expect.any(String), type: "heading", level: 2, text: [{ text: "Method" }] },
			{ id: expect.any(String), type: "paragraph", text: [{ text: "Fold & wait." }] },
		]);
	});

	test("body=markdown gives Markdown worked out from the Blocks, text escaped so it reads as written", async () => {
		const { body } = await site
			.frontend()
			.json<{ entry: Item }>(`/entries/recipes/${site.ids.Sourdough}?fields=body&body=markdown`);

		expect(body.entry.fields.body).toBe("## Method\n\nFold \\& wait.");
	});

	test("any other format is refused", async () => {
		expect((await refused("/entries/recipes?body=pdf")).data.problems).toEqual([
			expect.objectContaining({ parameter: "body", problem: "bodyFormat" }),
		]);
	});
});

test("Body formats keep published Components and their Props", async () => {
	const siteId = site.siteId;
	const { component } = await site.staff.api.components.create({
		siteId,
		name: "Note",
		props: [{ key: "text", label: "Text", type: "text" }],
	});
	await site.staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<aside>{{ props.text }}</aside>",
	});
	await site.staff.api.components.publish({ siteId, componentId: component.id });
	const { postTypes } = await site.staff.api.postTypes.list({ siteId });
	const postType = postTypes.find((each) => each.key === "recipes");
	if (!postType) throw new Error("Recipes missing");
	await site.staff.api.postTypes.update({
		siteId,
		postTypeId: postType.id,
		fields: postType.fields.map((field) => (field.type === "body" ? { ...field, components: [component.id] } : field)),
	});
	const { entry } = await site.staff.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Note",
		fields: { body: [{ type: "component", component: component.id, props: [{ name: "text", value: "Fresh bread" }] }] },
	});
	await site.staff.api.entries.publish({ siteId, entryId: entry.id });
	const { response, body } = await site.frontend().json<{ entry: Item }>(`/entries/recipes/${entry.id}?body=markdown`);
	expect(response.status).toBe(200);
	expect(body.entry.fields.body).toBe('<Note text="Fresh bread" />');
	await site.staff.api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<p>Unpublished Component change</p>",
	});
	const html = await site.frontend().json<{ entry: Item }>(`/entries/recipes/${entry.id}?body=html`);
	expect(html.response.status).toBe(200);
	expect(html.body.entry.fields.body).toBe("<aside>Fresh bread</aside>");
});

test("Component Blocks respect hidden Globals and Relationship Fields in HTML", async () => {
	const siteId = site.siteId;
	const api = site.staff.api;
	await api.globals.setFields({
		siteId,
		fields: [{ key: "wifi", label: "Wi-Fi", type: "text" }],
	});
	await api.globals.saveDraft({ siteId, fields: { wifi: "Secret password" } });
	await api.globals.publish({ siteId });
	const categoryId = await site.publish(site.categoriesId, "Pastries", { fields: { colour: "Gold" } });
	const { component } = await api.components.create({
		siteId,
		name: "CategoryNote",
		props: [{ key: "category", label: "Category", type: "relationship", postTypes: ["categories"] }],
	});
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: "<aside>{{ props.category.title }}|{{ props.category.colour }}|{{ site.wifi }}</aside>",
	});
	await api.components.publish({ siteId, componentId: component.id });
	const { postTypes } = await api.postTypes.list({ siteId });
	const postType = postTypes.find((each) => each.id === site.recipesId);
	if (!postType) throw new Error("Recipes missing");
	await api.postTypes.update({
		siteId,
		postTypeId: postType.id,
		fields: postType.fields.map((field) =>
			field.type === "body" ? { ...field, components: [...field.components, component.id] } : field,
		),
	});
	const entryId = await site.publish(site.recipesId, "Pastry note", {
		fields: {
			body: [{ type: "component", component: component.id, props: [{ name: "category", value: categoryId }] }],
		},
	});
	const read = () => site.frontend().json<{ entry: Item }>(`/entries/recipes/${entryId}?body=html`);
	expect((await read()).body.entry.fields.body).toBe("<aside>Pastries|Gold|Secret password</aside>");
	await api.contentApi.update({
		siteId,
		hidden: { fields: { [site.categoriesId]: ["colour"] }, globals: ["wifi"] },
	});
	expect((await read()).body.entry.fields.body).toBe("<aside>Pastries||</aside>");
	await api.contentApi.update({ siteId, hidden: { postTypes: [site.categoriesId], globals: ["wifi"] } });
	expect((await read()).body.entry.fields.body).toBe("<aside>||</aside>");
});
