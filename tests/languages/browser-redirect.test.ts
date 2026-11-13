// The browser-language redirect (ADR 0010): a per-Site setting, off by default. When on, a visitor's
// first request to the home page, with no language chosen yet, goes on (302) to the home page in the
// language their browser prefers among those it is shown in. Never for crawlers or deep links, and a
// language chosen with the Language switcher always wins. It needs no JavaScript.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let admin: TestBrowser;
let staff: TestBrowser;
let owner: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

const SAFARI =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

let sites = 0;

type TestSite = { siteId: string; homeId: string; origin: string };

/** A Site in English, French and German with a published home page, the redirect on unless `off`. */
async function newSite(options: { off?: boolean } = {}): Promise<TestSite> {
	const slug = `redirect-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	for (const code of ["fr", "de"]) await staff.api.languages.add({ siteId, code });
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	const pagesId = postTypes.find((candidate) => candidate.builtIn === "page")?.id ?? "";
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: pagesId, title: "Home" });
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.pages.setHomePage({ siteId, pageId: entry.id });
	await editor.api.entries
		.create({ siteId, postTypeId: pagesId, title: "About" })
		.then(({ entry: about }) => editor.api.entries.publish({ siteId, entryId: about.id }));
	if (!options.off) await staff.api.languages.setBrowserRedirect({ siteId, browserLanguageRedirect: true });
	return { siteId, homeId: entry.id, origin: `https://${slug}.live.test` };
}

function visit(site: TestSite, path: string, headers: Record<string, string>) {
	return install.request(`${site.origin}${path}`, { headers: { "user-agent": SAFARI, ...headers } });
}

describe("the browser-language redirect", () => {
	test("is off by default; Staff turn it on, and it is recorded", async () => {
		const site = await newSite({ off: true });
		expect((await staff.api.languages.list({ siteId: site.siteId })).settings.browserLanguageRedirect).toBe(false);
		expect((await visit(site, "/", { "accept-language": "fr" })).status).toBe(200);

		await expect(
			owner.api.languages.setBrowserRedirect({ siteId: site.siteId, browserLanguageRedirect: true }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const { settings } = await staff.api.languages.setBrowserRedirect({
			siteId: site.siteId,
			browserLanguageRedirect: true,
		});

		expect(settings.browserLanguageRedirect).toBe(true);
		const [entry] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(entry).toMatchObject({ action: "browserLanguageRedirect.change", details: { on: true } });
	});

	test("on, a first request to the home page goes on to the home page in the browser's language", async () => {
		const site = await newSite();

		const response = await visit(site, "/", { "accept-language": "fr-CA,fr;q=0.9,en;q=0.8" });

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("/fr");
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(response.headers.get("set-cookie")).toStartWith("__Host-webcraft.language=fr;");
		expect((await visit(site, "/", { "accept-language": "de-AT, en;q=0.5" })).headers.get("location")).toBe("/de");
	});

	test("stays when the browser prefers the Default language or none of the Site's", async () => {
		const site = await newSite();

		for (const preferred of ["en-GB,fr;q=0.8", "ja, zh;q=0.8", "*", "fr;q=0"]) {
			const response = await visit(site, "/", { "accept-language": preferred });
			expect(response.status).toBe(200);
			expect(response.headers.get("vary")).toBe("Accept-Language, Cookie");
		}
	});

	test("never for crawlers, deep links, a language already chosen or a visitor already on the Site", async () => {
		const site = await newSite();
		const french = { "accept-language": "fr" };

		expect((await visit(site, "/", { ...french, "user-agent": GOOGLEBOT })).status).toBe(200);
		expect((await visit(site, "/about", french)).status).toBe(200);
		expect((await visit(site, "/", { ...french, cookie: "__Host-webcraft.language=en" })).status).toBe(200);
		expect((await visit(site, "/", { ...french, referer: `${site.origin}/about` })).status).toBe(200);
		expect((await visit(site, "/", { "user-agent": SAFARI })).status).toBe(200);
	});

	test("goes only to a language the home page is shown in", async () => {
		const site = await newSite();
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: site.homeId, hiddenLanguages: ["fr"] });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: site.homeId });

		const response = await visit(site, "/", { "accept-language": "fr, de;q=0.9" });

		expect(response.headers.get("location")).toBe("/de");
	});
});
