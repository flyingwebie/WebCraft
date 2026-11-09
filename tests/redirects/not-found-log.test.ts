// The 404 log (GLOSSARY.md): the paths visitors asked for that have no page, with how often, when
// first and last, the language and the host of the page that linked there. The Site pipeline hands
// each miss to the Redirects Module in the background, so a 404 never waits for the log; robots,
// files and the Install's own paths stay out. One click adds a Redirect rule, another ignores a path,
// and the log keeps only so many paths, for so long.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type redirects from "@webcraft/module-redirects";

import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let editorAccount: Parameters<TestInstall["signIn"]>[0];
let workspaceId: string;

/** A person's browser, as its user agent says. */
const BROWSER =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";

const api = (browser: TestBrowser = editor) => moduleApi<typeof redirects>(browser, "redirects");

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "redirects", version: "1.0.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const member = await install.createMember({ workspaceId, role: "editor" });
	editor = member.browser;
	editorAccount = member.account;
});

/** Moves the clock on by days, signing the Editor in again: sessions end after 7 days unused. */
async function daysLater(days: number) {
	await install.clock.advance(days * 24 * 60 * 60_000);
	editor = await install.signIn(editorAccount);
}

afterAll(async () => {
	await install.close();
});

let sites = 0;

async function newSite(): Promise<{ siteId: string; origin: string }> {
	const slug = `missing-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	return { siteId, origin: `https://${slug}.live.test` };
}

/** A visitor's browser asking for a page. */
function visit(url: string, headers: Record<string, string> = {}, method = "GET") {
	return install.request(new Request(url, { method, headers: { "user-agent": BROWSER, ...headers } }));
}

async function logged(siteId: string, ignored = false) {
	expect((await install.drainJobs()).failed).toEqual([]);
	return (await api().notFound.list({ siteId, ignored })).misses;
}

describe("the 404 log", () => {
	test("counts each path visitors' browsers missed, with its language, when, and the host that linked there", async () => {
		const site = await newSite();
		await staff.api.languages.add({ siteId: site.siteId, code: "fr" });
		const first = install.clock.now();

		const missed = await visit(`${site.origin}/old-menu`, { referer: "https://News.example.org/story?id=7" });
		expect(missed.status).toBe(404);
		await install.clock.advance(60_000);
		await visit(`${site.origin}/old-menu/?email=someone@example.org`);
		await visit(`${site.origin}/fr/ancien-menu`);

		const misses = await logged(site.siteId);
		expect(misses).toEqual([
			{
				id: expect.any(String),
				path: "/old-menu",
				language: "en",
				hits: 2,
				firstSeen: first,
				lastSeen: new Date(first.getTime() + 60_000),
				referrerHost: "news.example.org",
				ignored: false,
			},
			expect.objectContaining({ path: "/fr/ancien-menu", language: "fr", hits: 1, referrerHost: null }),
		]);
		// The query string, which may hold personal data, is never kept.
		expect(JSON.stringify(misses)).not.toContain("someone@example.org");
	});

	test("robots, HEAD requests, prefetches, files, the Install's own paths and Edit mode stay out", async () => {
		const site = await newSite();
		await visit(`${site.origin}/robot-miss`, { "user-agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" });
		await install.request(`${site.origin}/no-agent-miss`);
		await visit(`${site.origin}/curl-miss`, { "user-agent": "curl/8.7.1" });
		await visit(`${site.origin}/head-miss`, {}, "HEAD");
		await visit(`${site.origin}/prefetch-miss`, { "sec-purpose": "prefetch" });
		await visit(`${site.origin}/favicon.ico`);
		await visit(`${site.origin}/wp-login.php`);
		await visit(`${site.origin}/_media/gone.png`);
		await visit(`${site.origin}/?page=abc`);
		const editing = await openEditMode(install, staff, site.siteId, "/");
		const cookie = Array.from(editing.browser.cookies, ([name, value]) => `${name}=${value}`).join("; ");
		expect((await visit(`${site.origin}/edit-miss`, { cookie })).status).toBe(404);

		expect(await logged(site.siteId)).toEqual([]);
	});

	test("a language's own domain logs its paths as the Site writes them, under its prefix", async () => {
		const site = await newSite();
		await staff.api.languages.add({ siteId: site.siteId, code: "fr" });
		await staff.api.languages.update({ siteId: site.siteId, code: "fr", domain: "missing-bakery.fr" });
		install.connectDomain("missing-bakery.fr");
		await install.clock.advance(60_000);
		await install.drainJobs();

		expect((await visit("https://missing-bakery.fr/ancienne-page")).status).toBe(404);

		expect(await logged(site.siteId)).toEqual([
			expect.objectContaining({ path: "/fr/ancienne-page", language: "fr", hits: 1 }),
		]);
	});

	test("where the Module is off, the 404 page answers as ever and nothing is kept", async () => {
		const site = await newSite();
		await staff.api.modules.setOnSite({ siteId: site.siteId, moduleId: "redirects", on: false });
		expect((await visit(`${site.origin}/while-off`)).status).toBe(404);
		expect((await install.drainJobs()).failed).toEqual([]);
		await staff.api.modules.setOnSite({ siteId: site.siteId, moduleId: "redirects", on: true });

		expect(await logged(site.siteId)).toEqual([]);
	});
});

describe("from the log", () => {
	test("Add redirect: a rule for a missed path takes it out of the log, and visitors go on", async () => {
		const site = await newSite();
		await visit(`${site.origin}/old-cakes`);
		await visit(`${site.origin}/old-cakes/lemon`);
		await visit(`${site.origin}/old-bread`);
		expect((await logged(site.siteId)).map((miss) => miss.path).sort()).toEqual([
			"/old-bread",
			"/old-cakes",
			"/old-cakes/lemon",
		]);

		await api().rules.add({ siteId: site.siteId, from: "/old-cakes/*", to: "/cakes", status: 301 });

		expect((await logged(site.siteId)).map((miss) => miss.path)).toEqual(["/old-bread"]);
		expect((await visit(`${site.origin}/old-cakes/lemon`)).headers.get("location")).toBe("/cakes");
	});

	test("Ignore: the path leaves the list, keeps being counted, and can be shown again", async () => {
		const site = await newSite();
		await visit(`${site.origin}/apple-touch-icon-precomposed`);
		const [miss] = await logged(site.siteId);
		if (!miss) throw new Error("The miss should be logged.");

		await api().notFound.ignore({ siteId: site.siteId, missId: miss.id });
		await visit(`${site.origin}/apple-touch-icon-precomposed`);

		expect(await logged(site.siteId)).toEqual([]);
		const [ignored] = await logged(site.siteId, true);
		expect(ignored).toMatchObject({ path: "/apple-touch-icon-precomposed", hits: 2, ignored: true });
		await api().notFound.ignore({ siteId: site.siteId, missId: miss.id, ignored: false });
		expect((await logged(site.siteId)).map((each) => each.path)).toEqual(["/apple-touch-icon-precomposed"]);
	});

	test("only Editors, Owners and Staff read it", async () => {
		const site = await newSite();
		const author = (await install.createMember({ workspaceId, role: "author" })).browser;
		await expect(api(author).notFound.list({ siteId: site.siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("the log stays bounded", () => {
	test("a path nobody asked for in 90 days is forgotten", async () => {
		const site = await newSite();
		await visit(`${site.origin}/long-ago`);
		await logged(site.siteId);
		await daysLater(60);
		await visit(`${site.origin}/lately`);
		await logged(site.siteId);

		await daysLater(31);

		expect((await logged(site.siteId)).map((miss) => miss.path)).toEqual(["/lately"]);
	});

	test("past 1,000 paths, those seen longest ago go", async () => {
		const site = await newSite();
		await visit(`${site.origin}/oldest`);
		await logged(site.siteId);
		await install.clock.advance(1000);
		for (let start = 0; start < 1100; start += 50) {
			await Promise.all(Array.from({ length: 50 }, (_, index) => visit(`${site.origin}/flood/${start + index}`)));
		}
		expect((await install.drainJobs()).failed).toEqual([]);

		const kept = await api().notFound.list({ siteId: site.siteId, limit: 2000 });
		expect(kept.total).toBeLessThanOrEqual(1100);
		expect(kept.misses.map((miss) => miss.path)).not.toContain("/oldest");
	}, 60_000);
});
