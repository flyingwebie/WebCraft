// Discovery files are built on request and kept in the page cache (spec story 117): every publish
// clears them, whichever way it comes (one item, Publish all, AI translation's publishes), and so does
// a change to a setting. Restoring a Revision publishes nothing, so they stay as they were.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";
import { readSitemap } from "../harness/xml.ts";

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

async function newSite(): Promise<{ siteId: string; blogId: string; origin: string }> {
	const slug = `discovery-cache-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const origin = await goLive(install, siteId);
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
	return { siteId, blogId: postType.id, origin };
}

/** The blog's sitemap as a crawler reads it: where the answer came from, and the addresses it lists. */
async function blogSitemap(origin: string): Promise<{ cache: string | null; locs: string[] }> {
	const response = await install.request(`${origin}/sitemaps/blog-1.xml`);
	if (response.status === 404) return { cache: null, locs: [] };
	expect(response.status).toBe(200);
	const locs = readSitemap(await response.text()).map((url) => url.loc.slice(origin.length));
	return { cache: response.headers.get("x-cache"), locs: locs.sort() };
}

describe("cleared", () => {
	test("by publishing one item", async () => {
		const site = await newSite();
		const { entry } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.blogId,
			title: "Fresh bread",
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
		expect(await blogSitemap(site.origin)).toEqual({ cache: "MISS", locs: ["/blog/fresh-bread"] });
		expect(await blogSitemap(site.origin)).toEqual({ cache: "HIT", locs: ["/blog/fresh-bread"] });

		const { entry: rye } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.blogId,
			title: "Rye loaves",
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: rye.id });

		expect(await blogSitemap(site.origin)).toEqual({ cache: "MISS", locs: ["/blog/fresh-bread", "/blog/rye-loaves"] });
	});

	test("by Publish all", async () => {
		const site = await newSite();
		const { entry } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.blogId,
			title: "Fresh bread",
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
		await blogSitemap(site.origin);
		const { entry: rye } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.blogId,
			title: "Rye loaves",
		});
		const items = [{ kind: "entry" as const, id: rye.id }];

		const preview = await editor.api.publishing.publishAll({ siteId: site.siteId, items });
		const confirmation = (preview as { confirmation?: { id: string } }).confirmation?.id;
		await editor.api.publishing.publishAll({ siteId: site.siteId, items, confirmation });

		expect(await blogSitemap(site.origin)).toEqual({ cache: "MISS", locs: ["/blog/fresh-bread", "/blog/rye-loaves"] });
	});

	test("by a change to a Post Type, which applies at once", async () => {
		const site = await newSite();
		const { entry } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.blogId,
			title: "Fresh bread",
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
		await blogSitemap(site.origin);

		await staff.api.postTypes.update({ siteId: site.siteId, postTypeId: site.blogId, urlPattern: "/news/{slug}" });

		expect(await blogSitemap(site.origin)).toEqual({ cache: "MISS", locs: ["/news/fresh-bread"] });
	});
});

describe("kept", () => {
	test("when a Revision is restored into the Draft: nothing is published", async () => {
		const site = await newSite();
		const { entry } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.blogId,
			title: "Fresh bread",
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
		const item = { kind: "entry" as const, id: entry.id };
		const { copies } = await editor.api.history.list({ siteId: site.siteId, item });
		await blogSitemap(site.origin);

		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: entry.id, title: "Something else" });
		await editor.api.history.restore({
			siteId: site.siteId,
			item,
			copy: { type: "revision", id: copies[0]?.id ?? "" },
		});

		expect(await blogSitemap(site.origin)).toEqual({ cache: "HIT", locs: ["/blog/fresh-bread"] });
	});
});
