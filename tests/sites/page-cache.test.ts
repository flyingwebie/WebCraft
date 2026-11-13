// The page cache (ADR 0004): rendered pages are kept per Site by normalised URL, and any publish
// on a Site clears that Site's whole cache. Browsers revalidate with the ETag.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";
import { element, tree, value } from "../harness/trees.ts";

let install: TestInstall;
let admin: TestBrowser;
let bakery: { siteId: string; postTypeId: string };
let careers: { siteId: string; postTypeId: string };

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	bakery = await siteWithPages(workspaceId, "bakery");
	careers = await siteWithPages(workspaceId, "careers");
});

afterAll(async () => {
	await install.close();
});

/** A Site with a "Pages" Post Type at /{slug} and a published Entry template. */
async function siteWithPages(workspaceId: string, slug: string): Promise<{ siteId: string; postTypeId: string }> {
	const siteId = (await install.createSite(workspaceId, { slug })).id;
	await goLive(install, siteId);
	const { postType } = await admin.api.postTypes.create({ siteId, name: "Pages", urlPattern: "/{slug}" });
	const { template } = await admin.api.templates.saveEntryTemplate({
		siteId,
		postTypeId: postType.id,
		tree: tree(element("h1", [value("title")])),
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	return { siteId, postTypeId: postType.id };
}

async function publishPage(site: { siteId: string; postTypeId: string }, title: string): Promise<string> {
	const { entry } = await admin.api.entries.create({ ...site, title });
	await admin.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	return entry.id;
}

const get = (url: string, headers: Record<string, string> = {}) => install.request(url, { headers });

describe("the page cache", () => {
	test("keeps a page by its normalised URL: a trailing slash and query parameters don't make a new one", async () => {
		await publishPage(bakery, "Opening hours");

		const first = await get("https://bakery.live.test/opening-hours");
		const variants = [
			"https://bakery.live.test/opening-hours/",
			"https://bakery.live.test/opening-hours?utm_source=newsletter",
			"https://bakery.live.test/opening%2Dhours?b=2&a=1",
		];

		expect(first.headers.get("x-cache")).toBe("MISS");
		for (const url of variants) {
			const response = await get(url);
			expect(response.headers.get("x-cache")).toBe("HIT");
			expect(response.headers.get("etag")).toBe(first.headers.get("etag"));
		}
	});

	test("answers 304 Not Modified while the browser's copy is current", async () => {
		const page = await get("https://bakery.live.test/opening-hours");
		const etag = page.headers.get("etag") ?? "";

		const revalidated = await get("https://bakery.live.test/opening-hours", { "if-none-match": etag });
		const weak = await get("https://bakery.live.test/opening-hours", { "if-none-match": `"other", W/${etag}` });
		const stale = await get("https://bakery.live.test/opening-hours", { "if-none-match": '"something-else"' });

		expect(revalidated.status).toBe(304);
		expect(await revalidated.text()).toBe("");
		expect(revalidated.headers.get("etag")).toBe(etag);
		expect(revalidated.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
		expect(weak.status).toBe(304);
		expect(stale.status).toBe(200);
	});

	test("a publish clears the whole Site's cache, not only the page it published", async () => {
		await get("https://bakery.live.test/opening-hours");
		expect((await get("https://bakery.live.test/opening-hours")).headers.get("x-cache")).toBe("HIT");

		await publishPage(bakery, "Wholesale");

		const unrelated = await get("https://bakery.live.test/opening-hours");
		expect(unrelated.headers.get("x-cache")).toBe("MISS");
		expect(await unrelated.text()).toContain("<h1>Opening hours</h1>");
	});

	test("publishing a Template clears it too", async () => {
		await get("https://bakery.live.test/opening-hours");
		const { template } = await admin.api.templates.saveEntryTemplate({
			siteId: bakery.siteId,
			postTypeId: bakery.postTypeId,
			tree: tree(element("h1", [value("title")]), element("p", [value("slug")])),
		});

		await admin.api.templates.publish({ siteId: bakery.siteId, templateId: template.id });

		const page = await get("https://bakery.live.test/opening-hours");
		expect(page.headers.get("x-cache")).toBe("MISS");
		expect(await page.text()).toContain("<h1>Opening hours</h1><p>opening-hours</p>");
	});

	test("another Site's cache is left alone", async () => {
		await publishPage(careers, "Jobs");
		await get("https://careers.live.test/jobs");
		expect((await get("https://careers.live.test/jobs")).headers.get("x-cache")).toBe("HIT");

		await publishPage(bakery, "Catering");

		expect((await get("https://careers.live.test/jobs")).headers.get("x-cache")).toBe("HIT");
	});

	test("saving a Draft or failing to publish leaves the cache as it is", async () => {
		const entryId = await publishPage(bakery, "Gift cards");
		await get("https://bakery.live.test/gift-cards");

		await admin.api.entries.saveDraft({ siteId: bakery.siteId, entryId, title: "Gift vouchers", slug: "" });
		await admin.api.entries.publish({ siteId: bakery.siteId, entryId }).catch(() => undefined);

		const page = await get("https://bakery.live.test/gift-cards");
		expect(page.headers.get("x-cache")).toBe("HIT");
		expect(await page.text()).toContain("<h1>Gift cards</h1>");
	});

	test("a path with no page isn't kept: it renders once published", async () => {
		expect((await get("https://bakery.live.test/seasonal")).status).toBe(404);

		await publishPage(bakery, "Seasonal");

		const page = await get("https://bakery.live.test/seasonal");
		expect(page.status).toBe(200);
		expect(page.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
	});
});
