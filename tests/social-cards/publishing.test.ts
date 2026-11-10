import { afterAll, beforeAll, expect, test } from "bun:test";
import { createTestInstall, type TestInstall } from "../harness/index.ts";
import { metaName, metaProperty } from "../harness/seo.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
beforeAll(async () => {
	install = await createTestInstall();
});
afterAll(async () => {
	await install.close();
});

test("publishing renders a cached Social card in the worker and serves it as the social fallback", async () => {
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const { api } = await install.superadmin();
	const origin = await goLive(install, site.id);
	const { postTypes } = await api.postTypes.list({ siteId: site.id });
	const pages = postTypes.find((p) => p.builtIn === "page");
	const { entry } = await api.entries.create({ siteId: site.id, postTypeId: pages?.id ?? "", title: "Fresh bread" });
	await api.entries.publish({ siteId: site.id, entryId: entry.id });
	const page = async () => (await install.request(`${origin}/fresh-bread`)).text();
	expect(metaProperty(await page(), "og:image")).toBeUndefined();
	expect((await install.drainJobs()).failed).toEqual([]);
	const html = await page();
	const url = metaProperty(html, "og:image");
	expect(url).toMatch(new RegExp(`^${origin}/_wc/social/[0-9a-f-]+/en/[0-9a-f]{64}.png$`));
	expect(metaName(html, "twitter:image")).toBe(url);
	expect(metaProperty(html, "og:image:width")).toBe("1200");
	expect(metaProperty(html, "og:image:height")).toBe("630");
	expect(metaProperty(html, "og:image:alt")).toBe("Fresh bread");
	const response = await install.request(url ?? "");
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toBe("image/png");
	const bytes = new Uint8Array(await response.arrayBuffer());
	expect([...bytes.slice(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
	const etag = response.headers.get("etag") ?? "";
	expect((await install.request(url ?? "", { headers: { "if-none-match": etag } })).status).toBe(304);
	await api.entries.saveDraft({ siteId: site.id, entryId: entry.id, title: "Secret Draft" });
	expect(metaProperty(await page(), "og:image")).toBe(url);
	await api.entries.publish({ siteId: site.id, entryId: entry.id });
	expect(metaProperty(await page(), "og:image")).toBeUndefined();
	await install.drainJobs();
	expect(metaProperty(await page(), "og:image")).not.toBe(url);
});
