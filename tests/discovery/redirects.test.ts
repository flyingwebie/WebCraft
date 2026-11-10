// A path a Redirect rule sends elsewhere has no page for visitors, so the discovery files don't list it
// (spec story 117): not in the sitemaps, not in llms.txt, and it has no Markdown copy. A rule WebCraft
// made when a path changed steps aside where a page answers, so it never hides a listed page.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type redirects from "@webcraft/module-redirects";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { goLive } from "../harness/staging.ts";
import { readSitemap, readSitemapIndex } from "../harness/xml.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

const rules = () => moduleApi<typeof redirects>(editor, "redirects").rules;

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "redirects", version: "1.1.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

async function newSite(languages: string[] = []) {
	const slug = `discovery-redirects-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const origin = await goLive(install, siteId);
	for (const code of languages) await staff.api.languages.add({ siteId, code });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog",
		key: "blog",
		urlPattern: "/blog/{slug}",
	});
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const pagesId =
		(await staff.api.postTypes.list({ siteId })).postTypes.find((each) => each.builtIn === "page")?.id ?? "";
	const publish = async (postTypeId: string, title: string) => {
		const { entry } = await editor.api.entries.create({ siteId, postTypeId, title });
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		return entry.id;
	};
	return { siteId, origin, blogId: postType.id, pagesId, publish };
}

async function listed(origin: string): Promise<string[]> {
	const locs: string[] = [];
	for (const sitemap of readSitemapIndex(await (await install.request(`${origin}/sitemap.xml`)).text())) {
		locs.push(
			...readSitemap(await (await install.request(sitemap.loc)).text()).map((url) => url.loc.slice(origin.length)),
		);
	}
	return locs.sort();
}

describe("paths Redirect rules send elsewhere", () => {
	test("are left out of the sitemaps and llms.txt, and have no Markdown copy", async () => {
		const site = await newSite(["fr"]);
		await site.publish(site.pagesId, "About");
		await site.publish(site.pagesId, "Contact");
		await site.publish(site.blogId, "Fresh bread");
		await site.publish(site.blogId, "Rye");
		expect(await listed(site.origin)).toHaveLength(8);

		await rules().add({ siteId: site.siteId, from: "/about", to: "/contact", status: 301 });
		await rules().add({ siteId: site.siteId, from: "/fr/blog/*", to: "/blog/*", status: 302 });

		expect(await listed(site.origin)).toEqual([
			"/blog/fresh-bread",
			"/blog/rye",
			"/contact",
			"/fr/about",
			"/fr/contact",
		]);
		const llms = await (await install.request(`${site.origin}/llms.txt`)).text();
		expect(llms).not.toContain("/about.md");
		expect(llms).toContain("/contact.md");
		expect((await install.request(`${site.origin}/about.md`)).status).toBe(404);
		expect((await install.request(`${site.origin}/fr/about.md`)).status).toBe(200);
	});

	test("a rule WebCraft added when a path changed steps aside for a page published there again", async () => {
		const site = await newSite();
		const entryId = await site.publish(site.blogId, "Fresh bread");
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId, slug: "crusty-bread" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId });
		expect((await install.drainJobs()).failed).toEqual([]);
		expect((await install.request(`${site.origin}/blog/fresh-bread`)).status).toBe(301);
		await site.publish(site.blogId, "Fresh bread");

		expect(await listed(site.origin)).toEqual(["/blog/crusty-bread", "/blog/fresh-bread"]);
	});
});
