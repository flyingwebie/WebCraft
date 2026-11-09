// robots.txt (spec story 119): each of a Site's domains answers one, pointing search engines at the
// sitemap on that domain, with the Site's AI crawler setting and Staff's own lines. The Staging
// address asks every crawler to stay away.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { AI_CRAWLERS } from "@webcraft/core";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSiteHeaders } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
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

const training = AI_CRAWLERS.filter((crawler) => crawler.purpose === "training").map((crawler) => crawler.agent);
const search = AI_CRAWLERS.filter((crawler) => crawler.purpose === "search").map((crawler) => crawler.agent);

async function robotsOf(origin: string): Promise<string> {
	const response = await install.request(`${origin}/robots.txt`);
	expect(response.status).toBe(200);
	return response.text();
}

describe("the AI crawler setting", () => {
	test("names every AI crawler once, each as training or search", () => {
		const agents = AI_CRAWLERS.map((crawler) => crawler.agent.toLowerCase());
		expect(new Set(agents).size).toBe(agents.length);
		expect(training.length).toBeGreaterThan(0);
		expect(search.length).toBeGreaterThan(0);
		for (const crawler of AI_CRAWLERS) expect(["training", "search"]).toContain(crawler.purpose);
	});

	test("allow search but block training keeps the training crawlers out, and lets AI search in", async () => {
		const site = await newSite();

		await owner.api.seoSettings.setAiCrawlers({ siteId: site.siteId, aiCrawlers: "allowSearch" });

		const text = await robotsOf(site.origin);
		expect(text).toBe(
			`${training.map((agent) => `User-agent: ${agent}`).join("\n")}\nDisallow: /\n\nUser-agent: *\nAllow: /\n\nSitemap: ${site.origin}/sitemap.xml\n`,
		);
		for (const agent of search) expect(text).not.toContain(agent);
	});

	test("block all keeps every AI crawler out; search engines stay welcome", async () => {
		const site = await newSite();

		await owner.api.seoSettings.setAiCrawlers({ siteId: site.siteId, aiCrawlers: "blockAll" });

		const text = await robotsOf(site.origin);
		const group = text.split("\n\n")[0] ?? "";
		expect(group.split("\n")).toEqual([
			...[...training, ...search].map((agent) => `User-agent: ${agent}`),
			"Disallow: /",
		]);
		expect(text).toContain("User-agent: *\nAllow: /\n");
	});

	test("Owners and Staff change it, at once and logged; Editors and Authors don't; everyone who sees the Site reads it", async () => {
		const site = await newSite();
		await robotsOf(site.origin);

		await staff.api.seoSettings.setAiCrawlers({ siteId: site.siteId, aiCrawlers: "blockAll" });
		const changed = await owner.api.seoSettings.setAiCrawlers({ siteId: site.siteId, aiCrawlers: "allowSearch" });

		expect(changed.settings.aiCrawlers).toBe("allowSearch");
		expect((await editor.api.seoSettings.get({ siteId: site.siteId })).settings.aiCrawlers).toBe("allowSearch");
		const response = await install.request(`${site.origin}/robots.txt`);
		expect(response.headers.get("x-cache")).toBe("MISS");
		expect(await response.text()).toContain(`User-agent: ${training[0]}`);
		await expect(
			editor.api.seoSettings.setAiCrawlers({ siteId: site.siteId, aiCrawlers: "allowAll" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const { entries } = await (await install.superadmin()).api.audit.list({});
		expect(entries.find((logged) => logged.action === "aiCrawlers.change")).toMatchObject({
			siteId: site.siteId,
			details: { from: "blockAll", to: "allowSearch" },
		});
	});
});

describe("Staff's own lines", () => {
	test("come after WebCraft's groups and before the sitemap, which they can't change", async () => {
		const site = await newSite();
		const lines =
			"# Our rules\r\nUser-agent: Googlebot\nDisallow: /drafts\n\nUser-agent: *\nDisallow: /private\nCrawl-delay: 2";

		const { settings } = await staff.api.seoSettings.update({ siteId: site.siteId, robotsLines: lines });

		expect(settings.robotsLines).toBe(
			"# Our rules\nUser-agent: Googlebot\nDisallow: /drafts\n\nUser-agent: *\nDisallow: /private\nCrawl-delay: 2",
		);
		expect(await robotsOf(site.origin)).toBe(
			`User-agent: *\nAllow: /\n\n${settings.robotsLines}\n\nSitemap: ${site.origin}/sitemap.xml\n`,
		);
	});

	test("are checked line by line, and limited in size", async () => {
		const site = await newSite();
		const refused = (robotsLines: string) =>
			staff.api.seoSettings.update({ siteId: site.siteId, robotsLines }).catch((error: unknown) => error);

		expect(await refused("Disallow: /x")).toMatchObject({
			code: "SEO_SETTINGS_INVALID",
			data: { problems: [{ at: "robotsLines", rule: "robotsRuleWithoutAgent", params: { line: 1 } }] },
		});
		expect(await refused("User-agent: *\nNoindex: /x")).toMatchObject({
			data: { problems: [{ at: "robotsLines", rule: "robotsLine", params: { line: 2 } }] },
		});
		expect(await refused("User-agent: *\nDisallow: private")).toMatchObject({
			data: { problems: [{ at: "robotsLines", rule: "robotsLine", params: { line: 2 } }] },
		});
		expect(await refused("User-agent: *\u0000\nDisallow: /")).toMatchObject({
			data: { problems: [{ at: "robotsLines", rule: "robotsLine", params: { line: 1 } }] },
		});
		expect(await refused("Sitemap: /elsewhere.xml")).toMatchObject({
			data: { problems: [{ at: "robotsLines", rule: "robotsLine", params: { line: 1 } }] },
		});
		expect(await refused(`User-agent: ${training[0]?.toLowerCase()}\nAllow: /`)).toMatchObject({
			data: { problems: [{ at: "robotsLines", rule: "robotsAiCrawler", params: { line: 1 } }] },
		});
		expect(await refused(`User-agent: *\n${"Disallow: /x\n".repeat(600)}`)).toMatchObject({
			data: { problems: [{ at: "robotsLines", rule: "robotsLinesLength" }] },
		});
	});

	test("only Staff change them; clearing them leaves WebCraft's own", async () => {
		const site = await newSite();
		await staff.api.seoSettings.update({ siteId: site.siteId, robotsLines: "User-agent: *\nDisallow: /x" });

		await expect(
			owner.api.seoSettings.update({ siteId: site.siteId, robotsLines: "User-agent: *\nDisallow: /y" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await staff.api.seoSettings.update({ siteId: site.siteId, robotsLines: "" });

		expect(await robotsOf(site.origin)).toBe(`User-agent: *\nAllow: /\n\nSitemap: ${site.origin}/sitemap.xml\n`);
	});
});
