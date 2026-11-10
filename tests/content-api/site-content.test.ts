// The rest of what the Content API answers (ADR 0029): the Globals' published values, Media details
// (variants' addresses, alt text in the language), search through Site search, and the schema the
// Site exposes (its Post Types and their Fields, with how lists filter and sort by them).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { type Bakery, bakery, contentClient } from "./support.ts";

let install: TestInstall;
let site: Bakery;
let imageId: string;

type Media = {
	id: string;
	url: string;
	alt: string | null;
	variants: { type: string; width: number; url: string }[];
} & Record<string, unknown>;
type Item = Record<string, unknown> & { id: string; title: string; fields: Record<string, unknown> };

beforeAll(async () => {
	install = await createTestInstall();
	site = await bakery(install, "bakery");
	const { media } = await site.staff.api.media.upload({
		siteId: site.siteId,
		file: upload(await photo({ width: 700, height: 400 }), "sourdough.jpg"),
	});
	imageId = media.id;
	expect((await install.drainJobs()).failed).toEqual([]);
	await site.staff.api.media.update({ siteId: site.siteId, mediaId: imageId, alt: "A round loaf", title: "Sourdough" });
	await site.staff.api.media.update({ siteId: site.siteId, mediaId: imageId, language: "fr", alt: "Une miche ronde" });
});

afterAll(async () => {
	await install.close();
});

describe("the Globals", () => {
	test("answer their published values only, in the language with its fallbacks; never-published Globals answer none", async () => {
		await site.staff.api.globals.setFields({
			siteId: site.siteId,
			fields: [
				{ key: "tagline", label: "Tagline", type: "text" },
				{ key: "logo", label: "Logo", type: "media" },
			],
		});
		expect((await site.frontend().json("/globals")).body).toMatchObject({
			fields: { tagline: null, logo: null },
			publishedAt: null,
		});

		await site.staff.api.globals.saveDraft({ siteId: site.siteId, fields: { tagline: "Baked daily", logo: imageId } });
		await site.staff.api.globals.publish({ siteId: site.siteId });
		await site.staff.api.globals.saveDraft({ siteId: site.siteId, fields: { tagline: "Draft words" } });

		const english = (await site.frontend().json<{ fields: { tagline: string; logo: Media } }>("/globals")).body;
		expect(english.fields.tagline).toBe("Baked daily");
		expect(english.fields.logo).toMatchObject({ id: imageId, alt: "A round loaf" });
		const french = (await site.frontend().json("/globals?lang=fr")).body;
		expect(french).toMatchObject({ language: "fr", fields: { tagline: "Baked daily" }, fallbacks: { tagline: "en" } });
		expect((await site.frontend().json("/globals?fields=tagline")).body).toMatchObject({
			fields: { tagline: "Baked daily" },
		});
		expect(
			Object.keys(((await site.frontend().json("/globals?fields=tagline")).body as { fields: object }).fields),
		).toEqual(["tagline"]);
	});
});

describe("Media", () => {
	test("/media/<id>: its details, every variant's address on the Site's domain, and its texts in the language", async () => {
		const { response, body } = await site.frontend().json<{ media: Media }>(`/media/${imageId}`);

		expect(response.status).toBe(200);
		expect(body.media).toMatchObject({
			id: imageId,
			kind: "image",
			contentType: "image/jpeg",
			fileName: "sourdough.jpg",
			width: 700,
			height: 400,
			alt: "A round loaf",
			title: "Sourdough",
			caption: null,
			focalPoint: null,
		});
		expect(body.media.url).toMatch(new RegExp(`^${site.origin}/_media/[0-9a-f]{16}-sourdough\\.jpg$`));
		expect(body.media.variants.map((variant) => `${variant.type} ${variant.width}`)).toEqual([
			"image/avif 320",
			"image/webp 320",
			"image/avif 640",
			"image/webp 640",
		]);
		for (const variant of body.media.variants) {
			expect(variant.url.startsWith(`${site.origin}/_media/`)).toBe(true);
			expect((await install.request(variant.url)).status).toBe(200);
		}
		expect((await site.frontend().json<{ media: Media }>(`/media/${imageId}?lang=fr`)).body.media.alt).toBe(
			"Une miche ronde",
		);
	});

	test("a media Field answers the same details, and a body's image renders with addresses on the Site's domain", async () => {
		const id = await site.publish(site.recipesId, "Loaf", {
			fields: { photo: imageId, body: [{ type: "image", media: imageId }] },
		});
		const { body } = await site.frontend().json<{ entry: Item }>(`/entries/recipes/${id}?fields=photo,body`);

		expect(body.entry.fields.photo).toMatchObject({ id: imageId, alt: "A round loaf" });
		expect(body.entry.fields.body).toContain(`src="${site.origin}/_media/`);
		expect(body.entry.fields.body).toContain('alt="A round loaf"');
		const markdown = (await site.frontend().json<{ entry: Item }>(`/entries/recipes/${id}?fields=body&body=markdown`))
			.body;
		expect(markdown.entry.fields.body).toMatch(
			new RegExp(`^!\\[A round loaf\\]\\(${site.origin}/_media/[0-9a-f]{16}-sourdough\\.jpg\\)$`),
		);
	});

	test("one in the Trash, another Site's, or no Media at all answers 404 MEDIA_NOT_FOUND", async () => {
		const other = await bakery(install, "other-bakery");
		const { media } = await other.staff.api.media.upload({
			siteId: other.siteId,
			file: upload(await photo({ width: 20, height: 20 }), "x.jpg"),
		});
		await install.drainJobs();
		const { media: binned } = await site.staff.api.media.upload({
			siteId: site.siteId,
			file: upload(await photo({ width: 20, height: 20 }), "bin.jpg"),
		});
		await install.drainJobs();
		const asked = await site.staff.api.media.delete({ siteId: site.siteId, mediaId: binned.id });
		await site.staff.api.media.delete({
			siteId: site.siteId,
			mediaId: binned.id,
			confirmation: asked.trashed ? undefined : asked.confirmation.id,
		});

		for (const id of [binned.id, media.id, crypto.randomUUID(), "nope"]) {
			const { response, body } = await site.frontend().json(`/media/${id}`);
			expect(response.status).toBe(404);
			expect(body).toMatchObject({ code: "MEDIA_NOT_FOUND" });
		}
	});
});

describe("search", () => {
	beforeAll(async () => {
		await site.staff.api.postTypes.update({ siteId: site.siteId, postTypeId: site.recipesId, searchable: true });
		await site.staff.api.postTypes.update({ siteId: site.siteId, postTypeId: site.categoriesId, searchable: false });
		await site.publish(site.recipesId, "Rye bread", {
			fields: { body: [{ type: "paragraph", text: "A dark bread with caraway." }] },
		});
		await site.publish(site.recipesId, "Bread pudding", { fields: { body: [{ type: "paragraph", text: "Sweet." }] } });
		await site.publish(site.recipesId, "Brown bread", { seo: { noindex: true } });
		await site.publish(site.recipesId, "Soda bread", { hiddenLanguages: ["fr"] });
		await site.publish(site.categoriesId, "Breads");
	});

	test("finds published Entries of searchable Post Types, best first (title before body), each with its snippet, as Site search does", async () => {
		const { response, body } = await site
			.frontend()
			.json<{ items: (Item & { snippet: string })[]; total: number; next: string | null }>("/search?q=bread");

		expect(response.status).toBe(200);
		expect(body.items.map((item) => item.title)).toEqual(["Rye bread", "Soda bread", "Bread pudding"]);
		expect(body.total).toBe(3);
		expect(body.items[0]).toMatchObject({ postType: "recipes", path: "/recipes/rye-bread" });
		expect(body.items[0]?.snippet).toContain("<mark>bread</mark>");
		expect(body.items[0]).not.toHaveProperty("fields");
	});

	test("in a language, leaving out what is hidden there; postType narrows; cursors page through", async () => {
		const french = (await site.frontend().json<{ items: Item[] }>("/search?q=bread&lang=fr")).body;
		expect(french.items.map((item) => item.title)).not.toContain("Soda bread");

		const first = (await site.frontend().json<{ items: Item[]; next: string }>("/search?q=bread&limit=2")).body;
		const second = (
			await site
				.frontend()
				.json<{ items: Item[]; next: string | null }>(
					`/search?q=bread&limit=2&cursor=${encodeURIComponent(first.next)}`,
				)
		).body;
		expect([...first.items, ...second.items].map((item) => item.title)).toEqual([
			"Rye bread",
			"Soda bread",
			"Bread pudding",
		]);
		expect(second.next).toBeNull();
		expect((await site.frontend().json("/search?q=bread&postType=categories")).response.status).toBe(400);
	});

	test("needs words to search for, and is never kept in the page cache", async () => {
		expect((await site.frontend().json("/search")).response.status).toBe(400);
		const response = await site.frontend().get("/search?q=bread");
		expect(response.headers.get("x-cache")).toBe("MISS");
		expect((await site.frontend().get("/search?q=bread")).headers.get("x-cache")).toBe("MISS");
	});
});

describe("the schema", () => {
	test("lists the languages, the built-in values and each exposed Post Type with its Fields, how lists filter and sort by them", async () => {
		const { body } = await contentClient(install, site.origin, site.key).json<{
			defaultLanguage: string;
			languages: string[];
			postTypes: { key: string; fields: Record<string, unknown>[] }[];
		}>("/schema");

		expect(body.defaultLanguage).toBe("en");
		expect(body.languages).toEqual(["en", "fr"]);
		const recipes = body.postTypes.find((postType) => postType.key === "recipes");
		expect(recipes).toMatchObject({ name: "Recipes", pages: false, urlPattern: "/recipes/{slug}", searchable: true });
		const field = (key: string) => recipes?.fields.find((candidate) => candidate.key === key);
		expect(field("price")).toMatchObject({
			type: "number",
			translatable: false,
			filters: ["eq", "in", "gt", "gte", "lt", "lte"],
			sortable: true,
		});
		expect(field("summary")).toMatchObject({ type: "text", translatable: true, filters: ["eq", "in"], sortable: true });
		expect(field("kind")).toMatchObject({
			type: "select",
			options: [
				{ value: "bread", label: "Bread" },
				{ value: "pastry", label: "Pastry" },
				{ value: "cake", label: "Cake" },
			],
			multiple: false,
		});
		expect(field("category")).toMatchObject({
			type: "relationship",
			postTypes: ["categories"],
			filters: ["eq", "in"],
			sortable: false,
		});
		expect(field("body")).toMatchObject({ type: "body", filters: [], sortable: false });
		expect(field("origin")).toMatchObject({
			type: "group",
			fields: [expect.objectContaining({ key: "city" }), expect.objectContaining({ key: "secret" })],
		});
	});
});
