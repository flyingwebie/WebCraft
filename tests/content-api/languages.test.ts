// Languages through the Content API (ADRs 0003, 0010): `?lang=` reads one language, and a value it
// has none of falls back one Field at a time, through `fallback` (the Default language unless given;
// `none` for none), each value read elsewhere named in `fallbacks`. An Entry hidden in the language
// never appears there. The Site's languages have an endpoint of their own.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { type Bakery, bakery, contentClient } from "./support.ts";

let install: TestInstall;
let site: Bakery;

type Item = Record<string, unknown> & { id: string; title: string; fields: Record<string, unknown> };
type List = { items: Item[] };

beforeAll(async () => {
	install = await createTestInstall();
	site = await bakery(install, "bakery");
	await site.staff.api.languages.add({ siteId: site.siteId, code: "de" });
	const breads = await site.publish(site.categoriesId, "Breads");
	const { entry } = await site.staff.api.entries.create({
		siteId: site.siteId,
		postTypeId: site.recipesId,
		title: "Fresh bread",
		fields: {
			summary: "Crusty",
			kind: "bread",
			price: 3,
			category: breads,
			origin: { city: "Dublin" },
			steps: [{ text: "Mix" }, { text: "Bake" }],
			body: [{ type: "paragraph", text: "Knead well." }],
		},
	});
	site.ids["Fresh bread"] = entry.id;
	const rows = (await site.staff.api.entries.get({ siteId: site.siteId, entryId: entry.id })).entry.draft.fields
		.steps as { id: string }[];
	await site.staff.api.entries.saveDraft({
		siteId: site.siteId,
		entryId: entry.id,
		language: "fr",
		title: "Pain frais",
		slug: "pain-frais",
		fields: { origin: { city: "Dublin (FR)" }, steps: [{ id: rows[0]?.id, text: "Mélanger" }, { id: rows[1]?.id }] },
	});
	await site.staff.api.entries.saveDraft({
		siteId: site.siteId,
		entryId: entry.id,
		language: "de",
		title: "Frisches Brot",
		fields: { summary: "Knusprig" },
	});
	await site.staff.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	await install.clock.advance(60_000);
	await site.publish(site.recipesId, "English muffin", { hiddenLanguages: ["fr"], fields: { kind: "bread" } });
});

afterAll(async () => {
	await install.close();
});

async function bread(query: string): Promise<Item> {
	const { response, body } = await site
		.frontend()
		.json<{ entry: Item }>(`/entries/recipes/${site.ids["Fresh bread"]}${query}`);
	expect(response.status).toBe(200);
	return body.entry;
}

describe("a language", () => {
	test("the Default language unless lang asks for another: values, title, slug, path and address in it", async () => {
		expect(await bread("")).toMatchObject({ language: "en", title: "Fresh bread", path: "/recipes/fresh-bread" });

		const french = await bread("?lang=fr");
		expect(french).toMatchObject({
			language: "fr",
			title: "Pain frais",
			slug: "pain-frais",
			path: "/fr/recipes/pain-frais",
			url: `${site.origin}/fr/recipes/pain-frais`,
		});
		expect(french.fields).toMatchObject({
			origin: { city: "Dublin (FR)" },
			steps: [{ text: "Mélanger" }, { text: "Bake" }],
		});
	});

	test("a value with none of its own falls back to the Default language one Field at a time, and fallbacks says which", async () => {
		const french = await bread("?lang=fr");

		expect(french.fields).toMatchObject({ summary: "Crusty", kind: "bread", price: 3 });
		expect(french.fallbacks).toEqual({ summary: "en", body: "en", "steps[1].text": "en" });
	});

	test("fallback lists the languages to fall back through, in order; none (or empty) falls back to none", async () => {
		const through = await bread("?lang=fr&fallback=de,en");
		expect(through.fields).toMatchObject({ summary: "Knusprig", body: "<p>Knead well.</p>" });
		expect(through.fallbacks).toEqual({ summary: "de", body: "en", "steps[1].text": "en" });

		const alone = await bread("?lang=fr&fallback=none");
		expect(alone).toMatchObject({ title: "Pain frais" });
		expect(alone.fields).toMatchObject({ summary: null, body: "", steps: [{ text: "Mélanger" }, { text: null }] });
		expect(alone.fallbacks).toEqual({});
		expect((await bread("?lang=fr&fallback=")).fields).toMatchObject({ summary: null });
	});

	test("shared values (not translatable) are the same in every language, whatever the fallbacks", async () => {
		expect((await bread("?lang=de&fallback=none")).fields).toMatchObject({ price: 3, kind: "bread" });
	});

	test("filters and sorts read the same values the answer shows, in the language and its fallbacks", async () => {
		const titles = async (query: string) =>
			(await site.frontend().json<List>(`/entries/recipes${query}`)).body.items.map((item) => item.title);

		expect(await titles("?lang=fr&filter.summary=Crusty")).toEqual(["Pain frais"]);
		expect(await titles("?lang=fr&fallback=de,en&filter.summary=Knusprig")).toEqual(["Pain frais"]);
		expect(await titles("?lang=fr&fallback=none&filter.summary=Crusty")).toEqual([]);
	});

	test("an Entry hidden in a language never appears there: not listed, not found, not by slug or path", async () => {
		const id = site.ids["English muffin"];
		const list = async (lang: string) =>
			(await site.frontend().json<List>(`/entries/recipes?lang=${lang}`)).body.items.map((item) => item.title);
		expect(await list("en")).toContain("English muffin");
		expect(await list("fr")).not.toContain("English muffin");

		for (const path of [
			`/entries/recipes/${id}?lang=fr`,
			"/entries/recipes/slug/english-muffin?lang=fr",
			"/entry?path=/fr/recipes/english-muffin",
		]) {
			const { response, body } = await site.frontend().json(path);
			expect(response.status).toBe(404);
			expect(body).toMatchObject({ code: "ENTRY_NOT_FOUND" });
		}
	});

	test("a Relationship to an Entry hidden in the language shows nothing of it there", async () => {
		const tart = await site.publish(site.recipesId, "Tart", {
			fields: { pairsWith: [site.ids["English muffin"], site.ids["Fresh bread"]] },
		});

		expect(
			(await site.frontend().json<{ entry: Item }>(`/entries/recipes/${tart}`)).body.entry.fields.pairsWith,
		).toEqual([site.ids["English muffin"], site.ids["Fresh bread"]]);
		expect(
			(await site.frontend().json<{ entry: Item }>(`/entries/recipes/${tart}?lang=fr`)).body.entry.fields.pairsWith,
		).toEqual([site.ids["Fresh bread"]]);
	});

	test("a language the Site doesn't have is refused, in lang and in fallback", async () => {
		const { response, body } = await site
			.frontend()
			.json<{ data: { problems: { parameter: string; problem: string }[] } }>(
				"/entries/recipes?lang=es&fallback=en,it",
			);

		expect(response.status).toBe(400);
		expect(body.data.problems.map(({ parameter, problem }) => ({ parameter, problem }))).toEqual([
			{ parameter: "lang", problem: "languageUnknown" },
			{ parameter: "fallback", problem: "languageUnknown" },
		]);
	});

	test("lang is read in any case and form of the tag", async () => {
		expect((await bread("?lang=FR")).language).toBe("fr");
	});
});

describe("the Site's languages", () => {
	test("/languages lists them, the Default language first, each with its name, direction and home page's address", async () => {
		const { response, body } = await site.frontend().json("/languages");

		expect(response.status).toBe(200);
		expect(body).toEqual({
			defaultLanguage: "en",
			languages: [
				{ code: "en", name: "English", direction: "ltr", default: true, url: `${site.origin}/` },
				{ code: "fr", name: "Français", direction: "ltr", default: false, url: `${site.origin}/fr` },
				{ code: "de", name: "Deutsch", direction: "ltr", default: false, url: `${site.origin}/de` },
			],
		});
	});

	test("on a language's own domain, that language is read unless lang asks for another, and addresses are on its domain", async () => {
		await site.staff.api.languages.update({ siteId: site.siteId, code: "fr", domain: "bakery-api.fr" });
		install.connectDomain("bakery-api.fr");
		await install.clock.advance(60_000);
		expect((await install.drainJobs()).failed).toEqual([]);
		const french = contentClient(install, "https://bakery-api.fr", site.key);

		const { body } = await french.json<{ entry: Item }>(`/entries/recipes/${site.ids["Fresh bread"]}`);
		expect(body.entry).toMatchObject({
			language: "fr",
			title: "Pain frais",
			path: "/fr/recipes/pain-frais",
			url: "https://bakery-api.fr/recipes/pain-frais",
		});
		expect(
			(await french.json<{ entry: Item }>(`/entries/recipes/${site.ids["Fresh bread"]}?lang=en`)).body.entry.language,
		).toBe("en");
	});
});
