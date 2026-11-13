// A Site on its own domains (ADR 0015, ADR 0010): a verified Primary domain serves the Site, Redirect
// domains send visitors to the same path on it, and a language's verified domain serves that language
// without a prefix. hreflang and the Language switcher use those addresses; the Staging address keeps
// working, prefixes and all, and stays out of search engines.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { openStaging } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type TestSite = { siteId: string; staging: string };

/**
 * A Site with a blog post, "Fresh bread" (`pain-frais` in French when the Site has French), a home
 * page, and a Site template showing the Language switcher.
 */
async function newSite(languages: string[] = []): Promise<TestSite> {
	const slug = `serving-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	for (const code of languages) await staff.api.languages.add({ siteId, code });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const entryTemplate = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId, templateId: entryTemplate.template.id });
	const siteTemplate = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header>{{@languageSwitcher}}</header><main>{{@outlet}}</main>",
	});
	await staff.api.templates.publish({ siteId, templateId: siteTemplate.template.id });
	const { entry } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	if (languages.includes("fr")) {
		await editor.api.entries.saveDraft({ siteId, entryId: entry.id, language: "fr", title: "Pain frais" });
		await editor.api.entries.saveDraft({ siteId, entryId: entry.id, language: "fr", slug: "pain-frais" });
	}
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	const pages = (await staff.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	const home = await editor.api.entries.create({ siteId, postTypeId: pages?.id ?? "", title: "Welcome" });
	await editor.api.entries.publish({ siteId, entryId: home.entry.id });
	await staff.api.pages.setHomePage({ siteId, pageId: home.entry.id });
	return { siteId, staging: `https://${slug}.sites.test` };
}

/** Adds domains to a Site, points them at the Install and lets the worker verify them. */
async function connect(siteId: string, names: string[], options: { withPartner?: boolean } = {}): Promise<void> {
	for (const name of names) {
		await staff.api.domains.add({ siteId, name, withPartner: options.withPartner ?? false });
	}
	await verify(names);
}

/** Points domains (already on a Site) at the Install, and runs the checks that come due. */
async function verify(names: string[]): Promise<void> {
	for (const name of names) install.connectDomain(name);
	await install.clock.advance(60_000);
	expect((await install.drainJobs()).failed).toEqual([]);
}

/** The `hreflang` alternates in a page's `<head>`, as `[hreflang, href]`. */
function alternatesIn(html: string): string[][] {
	return [...html.matchAll(/<link rel="alternate" hreflang="([^"]*)" href="([^"]*)">/g)].map((match) => [
		match[1] ?? "",
		match[2] ?? "",
	]);
}

/** The Language switcher's links, as `[hreflang, href]`. */
function switcherLinksIn(html: string): string[][] {
	const nav = /<nav class="wc-language-switcher"[\s\S]*?<\/nav>/.exec(html)?.[0] ?? "";
	return [...nav.matchAll(/<a href="([^"]*)" hreflang="([^"]*)"/g)].map((match) => [match[2] ?? "", match[1] ?? ""]);
}

async function page(url: string): Promise<{ response: Response; html: string }> {
	const response = await install.request(url);
	return { response, html: await response.text() };
}

/** A page of a Site's Staging address, as Staff reviewing it see it. */
async function stagingPage(site: TestSite, path: string): Promise<{ response: Response; html: string }> {
	const response = await (await openStaging(install, staff, site.siteId)).page(path);
	return { response, html: await response.text() };
}

describe("the Primary domain", () => {
	test("serves the Site once verified, and nothing before", async () => {
		const site = await newSite();
		await staff.api.domains.add({ siteId: site.siteId, name: "primary-bakery.example" });

		const before = await page("https://primary-bakery.example/blog/fresh-bread");
		expect(before.response.status).toBe(404);
		expect(before.html).toBe("Not Found");

		await verify(["primary-bakery.example"]);

		const after = await page("https://primary-bakery.example/blog/fresh-bread");
		expect(after.response.status).toBe(200);
		expect(after.html).toContain("<h1>Fresh bread</h1>");
		expect(after.response.headers.get("x-robots-tag")).toBeNull();
		expect((await page("https://primary-bakery.example/")).html).toContain("<title>Welcome · Acme Bakery</title>");
		expect((await page("https://primary-bakery.example/no-such-page")).response.status).toBe(404);
	});

	test("the Staging address keeps working, and stays out of search engines", async () => {
		const site = await newSite();
		await connect(site.siteId, ["staged-bakery.example"]);

		const staging = await stagingPage(site, "/blog/fresh-bread");

		expect(staging.response.status).toBe(200);
		expect(staging.response.headers.get("x-robots-tag")).toBe("noindex");
	});

	test("a hostname that is no Site's domain gets the unbranded 404", async () => {
		const response = await install.request("https://never-added.example/blog/fresh-bread");
		expect(response.status).toBe(404);
	});
});

describe("Redirect domains", () => {
	test("answer 301 to the same path and query on the Primary domain", async () => {
		const site = await newSite();
		await connect(site.siteId, ["redirect-bakery.example", "www.redirect-bakery.example", "old-bakery.example"]);

		for (const from of ["https://www.redirect-bakery.example", "http://old-bakery.example"]) {
			const response = await install.request(`${from}/blog/fresh-bread?ref=flyer&lang=x`);
			expect(response.status).toBe(301);
			expect(response.headers.get("location")).toBe(
				"https://redirect-bakery.example/blog/fresh-bread?ref=flyer&lang=x",
			);
		}
	});

	test("answer nothing while the Site has no verified Primary domain", async () => {
		const site = await newSite();
		await staff.api.domains.add({ siteId: site.siteId, name: "waiting-primary.example" });
		await staff.api.domains.add({ siteId: site.siteId, name: "ready-redirect.example" });
		await verify(["ready-redirect.example"]);

		const response = await install.request("https://ready-redirect.example/blog/fresh-bread");

		expect(response.status).toBe(404);
	});
});

describe("language domains", () => {
	test("serve their language without a prefix; the prefix on the Primary domain goes there", async () => {
		const site = await newSite(["fr"]);
		await connect(site.siteId, ["lang-bakery.example"]);
		await staff.api.languages.update({ siteId: site.siteId, code: "fr", domain: "lang-bakery.fr" });
		await verify(["lang-bakery.fr"]);

		const french = await page("https://lang-bakery.fr/blog/pain-frais");
		expect(french.response.status).toBe(200);
		expect(french.html).toContain('<html lang="fr"');
		expect(french.html).toContain("<h1>Pain frais</h1>");
		expect((await page("https://lang-bakery.fr/")).html).toContain('<html lang="fr"');

		const prefixed = await install.request("https://lang-bakery.example/fr/blog/pain-frais?x=1");
		expect(prefixed.status).toBe(301);
		expect(prefixed.headers.get("location")).toBe("https://lang-bakery.fr/blog/pain-frais?x=1");
		const ownPrefix = await install.request("https://lang-bakery.fr/fr/blog/pain-frais");
		expect(ownPrefix.status).toBe(301);
		expect(ownPrefix.headers.get("location")).toBe("https://lang-bakery.fr/blog/pain-frais");
		const defaultPrefix = await install.request("https://lang-bakery.fr/en/blog/fresh-bread");
		expect(defaultPrefix.status).toBe(301);
		expect(defaultPrefix.headers.get("location")).toBe("https://lang-bakery.example/blog/fresh-bread");
	});

	test("hreflang and the Language switcher link each language at its own address", async () => {
		const site = await newSite(["fr", "de"]);
		await connect(site.siteId, ["links-bakery.example"]);
		await staff.api.languages.update({ siteId: site.siteId, code: "fr", domain: "links-bakery.fr" });
		await verify(["links-bakery.fr"]);
		const staging = await stagingPage(site, "/blog/fresh-bread");

		const expected = [
			["en", "https://links-bakery.example/blog/fresh-bread"],
			["fr", "https://links-bakery.fr/blog/pain-frais"],
			["de", "https://links-bakery.example/de/blog/fresh-bread"],
			["x-default", "https://links-bakery.example/blog/fresh-bread"],
		];
		const primary = await page("https://links-bakery.example/blog/fresh-bread");
		const french = await page("https://links-bakery.fr/blog/pain-frais");
		expect(alternatesIn(primary.html)).toEqual(expected);
		expect(alternatesIn(french.html)).toEqual(expected);
		expect(switcherLinksIn(primary.html)).toEqual([
			["en", "/_wc/lang/blog/fresh-bread"],
			["fr", "https://links-bakery.fr/blog/pain-frais"],
			["de", "/_wc/lang/de/blog/fresh-bread"],
		]);
		expect(switcherLinksIn(french.html)).toEqual([
			["en", "https://links-bakery.example/blog/fresh-bread"],
			["fr", "/_wc/lang/blog/pain-frais"],
			["de", "https://links-bakery.example/de/blog/fresh-bread"],
		]);
		// The Staging address keeps every language under its prefix, on itself.
		expect(alternatesIn(staging.html)).toEqual([
			["en", `${site.staging}/blog/fresh-bread`],
			["fr", `${site.staging}/fr/blog/pain-frais`],
			["de", `${site.staging}/de/blog/fresh-bread`],
			["x-default", `${site.staging}/blog/fresh-bread`],
		]);
	});

	test("a language domain waiting for DNS changes nothing yet: the language keeps its prefix", async () => {
		const site = await newSite(["fr"]);
		await connect(site.siteId, ["prefix-bakery.example"]);
		await staff.api.languages.update({ siteId: site.siteId, code: "fr", domain: "prefix-bakery.fr" });

		const french = await page("https://prefix-bakery.example/fr/blog/pain-frais");

		expect(french.response.status).toBe(200);
		expect(alternatesIn(french.html)).toContainEqual(["fr", "https://prefix-bakery.example/fr/blog/pain-frais"]);
		expect((await install.request("https://prefix-bakery.fr/blog/pain-frais")).status).toBe(404);
	});
});

describe("Edit mode on the Primary domain", () => {
	test("Edit on site opens on the Staging address until the Primary domain is verified, then on it", async () => {
		const site = await newSite();
		await staff.api.domains.add({ siteId: site.siteId, name: "edit-bakery.example" });

		const before = await editor.api.editMode.open({ siteId: site.siteId, path: "/blog/fresh-bread" });
		expect(new URL(before.url).origin).toBe(site.staging);

		await verify(["edit-bakery.example"]);
		const editing = await openEditMode(install, editor, site.siteId, "/blog/fresh-bread");

		expect(editing.origin).toBe("https://edit-bakery.example");
		const response = await editing.page("/blog/fresh-bread");
		expect(response.status).toBe(200);
		expect(response.headers.get("cache-control")).toBe("no-store");
		expect(await response.text()).toContain('data-wc-field="title"');
	});
});
