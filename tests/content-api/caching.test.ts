// Caching the Content API: every answer carries a strong ETag and may be kept by browsers and CDNs
// as long as they check it each time (`public, max-age=0, must-revalidate`); `If-None-Match` gets
// 304. Answers are kept in the page cache under the Site's page cache generation, so whatever changes
// what the API shows (a publish, Publish all, a Scheduled publish or unpublish, AI translation's
// publishes, the Content API's own settings) gives new answers at once.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { taggedTranslation } from "../harness/fake-ai.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { freshBread, translatedSite } from "../translation/support.ts";
import { type Bakery, bakery, contentClient } from "./support.ts";

let install: TestInstall;
let site: Bakery;

beforeAll(async () => {
	install = await createTestInstall();
	site = await bakery(install, "bakery");
	await site.publish(site.recipesId, "Sourdough", { fields: { price: 6 } });
});

afterAll(async () => {
	await install.close();
});

/** The ETag of the recipes list now, checking it is a strong one. */
async function etag(path = "/entries/recipes"): Promise<string> {
	const response = await site.frontend().get(path);
	expect(response.status).toBe(200);
	const value = response.headers.get("etag") ?? "";
	expect(value).toMatch(/^"[A-Za-z0-9_-]{43}"$/);
	return value;
}

describe("ETags", () => {
	test("an answer may be kept by browsers and CDNs if checked each time, varies by origin and key, and is never indexed", async () => {
		const response = await site.frontend().get("/entries/recipes");

		expect(response.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
		expect(response.headers.get("vary")).toBe("Origin, Authorization");
		expect(response.headers.get("x-robots-tag")).toBe("noindex");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	});

	test("If-None-Match with the answer's ETag gets 304 and no body; HEAD gets the headers alone", async () => {
		const tag = await etag();

		const unchanged = await site.frontend().get("/entries/recipes", { headers: { "if-none-match": tag } });
		expect(unchanged.status).toBe(304);
		expect(await unchanged.text()).toBe("");
		expect(unchanged.headers.get("etag")).toBe(tag);

		const head = await site.frontend().get("/entries/recipes", { method: "HEAD" });
		expect(head.status).toBe(200);
		expect(head.headers.get("etag")).toBe(tag);
		expect(await head.text()).toBe("");
	});

	test("the same question is answered from the page cache, whatever the order of its parameters", async () => {
		const first = await site.frontend().get("/entries/recipes?sort=title&limit=5");
		const again = await site.frontend().get("/entries/recipes?limit=5&sort=title");

		expect(first.headers.get("x-cache")).toBe("MISS");
		expect(again.headers.get("x-cache")).toBe("HIT");
		expect(again.headers.get("etag")).toBe(first.headers.get("etag") as string);
	});

	test("a 304 still needs a working key: an ETag opens nothing", async () => {
		const tag = await etag();
		const { key, secret } = await site.staff.api.contentApi.keys.create({ siteId: site.siteId, name: "Short-lived" });
		await site.staff.api.contentApi.keys.revoke({ siteId: site.siteId, keyId: key.id });

		const response = await contentClient(install, site.origin, secret).get("/entries/recipes", {
			headers: { "if-none-match": tag },
		});
		expect(response.status).toBe(401);
	});

	test("refusals are never kept and carry no ETag", async () => {
		const response = await site.frontend().get("/entries/pies");

		expect(response.status).toBe(404);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("etag")).toBeNull();
	});
});

describe("what changes them", () => {
	test("publishing an Entry gives new answers at once, and the old ETag no longer matches", async () => {
		const before = await etag();
		await site.staff.api.entries.saveDraft({
			siteId: site.siteId,
			entryId: site.ids.Sourdough ?? "",
			fields: { price: 7 },
		});
		expect(await etag()).toBe(before);

		await site.staff.api.entries.publish({ siteId: site.siteId, entryId: site.ids.Sourdough ?? "" });

		const after = await site.frontend().get("/entries/recipes", { headers: { "if-none-match": before } });
		expect(after.status).toBe(200);
		expect(after.headers.get("x-cache")).toBe("MISS");
		expect(((await after.json()) as { items: { fields: { price: number } }[] }).items[0]?.fields.price).toBe(7);
	});

	test("Publish all", async () => {
		const before = await etag();
		await site.staff.api.entries.saveDraft({
			siteId: site.siteId,
			entryId: site.ids.Sourdough ?? "",
			fields: { price: 8 },
		});
		const items = [{ kind: "entry" as const, id: site.ids.Sourdough ?? "" }];
		const preview = await site.staff.api.publishing.publishAll({ siteId: site.siteId, items });
		const confirmation = (preview as { confirmation?: { id: string } }).confirmation?.id;
		await site.staff.api.publishing.publishAll({ siteId: site.siteId, items, confirmation });

		expect(await etag()).not.toBe(before);
	});

	test("a Scheduled publish at its time, and a scheduled unpublish at its", async () => {
		const before = await etag();
		const { entry } = await site.staff.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.recipesId,
			title: "Bagel",
		});
		await site.staff.api.publishing.schedule({
			siteId: site.siteId,
			item: { kind: "entry", id: entry.id },
			at: new Date(install.clock.now().getTime() + 120_000).toISOString(),
		});
		expect(await etag()).toBe(before);
		await install.clock.advance(180_000);
		await install.drainJobs();
		const published = await etag();
		expect(published).not.toBe(before);

		await site.staff.api.publishing.scheduleUnpublish({
			siteId: site.siteId,
			entryId: entry.id,
			at: new Date(install.clock.now().getTime() + 120_000).toISOString(),
		});
		await install.clock.advance(180_000);
		await install.drainJobs();
		expect(await etag()).toBe(before);
	});

	test("the Content API's own settings: hiding a Field changes what lists answer", async () => {
		const before = await etag();
		await site.staff.api.contentApi.update({
			siteId: site.siteId,
			hidden: { fields: { [site.recipesId]: ["price"] } },
		});

		expect(await etag()).not.toBe(before);
		await site.staff.api.contentApi.update({ siteId: site.siteId, hidden: { fields: {} } });
	});

	test("AI translation publishing the values it translated", async () => {
		const translated = await translatedSite(install, { de: "automatic" });
		await translated.staff.api.contentApi.update({ siteId: translated.siteId, enabled: true });
		const { secret } = await translated.staff.api.contentApi.keys.create({ siteId: translated.siteId, name: "App" });
		const frontend = contentClient(install, translated.origin, secret);
		install.ai.fail("unavailable");
		const entryId = await freshBread(translated);
		await translated.owner.api.entries.publish({ siteId: translated.siteId, entryId });
		await install.drainJobs();
		const { postTypes } = await translated.staff.api.postTypes.list({ siteId: translated.siteId });
		const key = postTypes.find((postType) => postType.id === translated.postTypeId)?.key;
		const path = `/entries/${key}/${entryId}?lang=de&fields=summary`;
		const before = await frontend.get(path);
		expect(((await before.json()) as { entry: { fields: { summary: string } } }).entry.fields.summary).toBe(
			"Crusty sourdough",
		);

		install.ai.translateWith(taggedTranslation);
		await translated.owner.api.translations.translateNow({ siteId: translated.siteId });
		await install.drainJobs();

		const after = await frontend.get(path, { headers: { "if-none-match": before.headers.get("etag") ?? "" } });
		expect(after.status).toBe(200);
		expect(((await after.json()) as { entry: { fields: { summary: string } } }).entry.fields.summary).toBe(
			"[de] Crusty sourdough",
		);
	});
});
