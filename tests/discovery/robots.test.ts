// robots.txt (spec story 119): each of a Site's domains answers one, pointing search engines at the
// sitemap on that domain, with the Site's AI crawler setting and Staff's own lines. The Staging
// address asks every crawler to stay away.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSiteHeaders } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

async function newSite(): Promise<{ siteId: string; slug: string; origin: string }> {
	const slug = `robots-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	return { siteId, slug, origin: await goLive(install, siteId) };
}

describe("on the Site's domains", () => {
	test("lets every crawler in and names the sitemap at its absolute address", async () => {
		const site = await newSite();

		const response = await install.request(`${site.origin}/robots.txt`);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expectSiteHeaders(response);
		const text = await response.text();
		expect(text).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${site.origin}/sitemap.xml\n`);
		expect(response.headers.get("x-robots-tag")).toBeNull();
	});

	test("is kept in the page cache and answers 304 while its ETag holds", async () => {
		const site = await newSite();

		const first = await install.request(`${site.origin}/robots.txt`);
		const second = await install.request(`${site.origin}/robots.txt`);
		const etag = second.headers.get("etag") ?? "";

		expect(first.headers.get("x-cache")).toBe("MISS");
		expect(second.headers.get("x-cache")).toBe("HIT");
		expect(second.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
		const again = await install.request(`${site.origin}/robots.txt`, { headers: { "if-none-match": etag } });
		expect(again.status).toBe(304);
	});
});

describe("on the Staging address", () => {
	test("asks every crawler to stay away, whoever asks", async () => {
		const site = await newSite();

		const response = await install.request(`https://${site.slug}.sites.test/robots.txt`);

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("User-agent: *\nDisallow: /\n");
		expect(response.headers.get("x-robots-tag")).toBe("noindex");
		expectSiteHeaders(response);
	});
});
