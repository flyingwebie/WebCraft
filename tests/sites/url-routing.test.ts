// How a path finds its page: each Post Type's URL pattern routes to its Entries through its Entry
// template, and Pages live outside every pattern, so a path never belongs to both. A pattern owns
// every path it matches (`/blog/{slug}` owns `/blog/<anything>`, not `/blog` itself); publishing a
// Page into one, or a pattern over a published Page, is refused. Paths the Install keeps stay
// outside both.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let admin: TestBrowser;
let staff: TestBrowser;
let editor: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	admin = await install.superadmin();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type TestSite = { siteId: string; pagesId: string; origin: string };

async function newSite(): Promise<TestSite> {
	const slug = `routes-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const { postTypes } = await editor.api.postTypes.list({ siteId });
	return {
		siteId,
		pagesId: postTypes.find((postType) => postType.builtIn === "page")?.id ?? "",
		origin: `https://${slug}.sites.test`,
	};
}

/** A Post Type at `urlPattern` whose published Entry template shows `<h1>` and the Post Type's name. */
async function postTypeAt(site: TestSite, name: string, urlPattern: string): Promise<string> {
	const { postType } = await staff.api.postTypes.create({ siteId: site.siteId, name, urlPattern });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId: site.siteId,
		postTypeId: postType.id,
		markup: `<article><p>${name}</p><h1>{{ title }}</h1></article>`,
	});
	await staff.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });
	return postType.id;
}

async function publishEntry(site: TestSite, postTypeId: string, title: string, parentId?: string): Promise<string> {
	const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId, title, parentId });
	await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	return entry.id;
}

/** What the page at `path` is: `<Post Type>: <title>` for an Entry, `Page: <title>` for a Page, or its status. */
async function pageAt(site: TestSite, path: string): Promise<string | number> {
	const response = await install.request(`${site.origin}${path}`);
	if (response.status !== 200) return response.status;
	const html = await response.text();
	const title = /<title>(.*) · Acme Bakery<\/title>/.exec(html)?.[1] ?? "";
	const postType = /<article><p>(.*?)<\/p>/.exec(html)?.[1];
	return `${postType ?? "Page"}: ${title}`;
}

describe("URL patterns", () => {
	test("each Post Type's pattern routes to its Entries through its own Entry template", async () => {
		const site = await newSite();
		const blog = await postTypeAt(site, "Blog posts", "/blog/{slug}");
		const team = await postTypeAt(site, "Team members", "/team/{slug}");
		const products = await postTypeAt(site, "Products", "/shop/{slug}/details");
		await publishEntry(site, blog, "Fresh bread");
		await publishEntry(site, team, "Aoife");
		await publishEntry(site, products, "Sourdough loaf");

		expect(await pageAt(site, "/blog/fresh-bread")).toBe("Blog posts: Fresh bread");
		expect(await pageAt(site, "/team/aoife")).toBe("Team members: Aoife");
		expect(await pageAt(site, "/shop/sourdough-loaf/details")).toBe("Products: Sourdough loaf");
		expect(await pageAt(site, "/team/fresh-bread")).toBe(404);
		expect(await pageAt(site, "/shop/sourdough-loaf")).toBe(404);
	});

	test("a Page can sit where a pattern's fixed part is, such as /blog above /blog/{slug}", async () => {
		const site = await newSite();
		const blog = await postTypeAt(site, "Blog posts", "/blog/{slug}");
		await publishEntry(site, blog, "Fresh bread");
		await publishEntry(site, site.pagesId, "Blog");

		expect(await pageAt(site, "/blog")).toBe("Page: Blog");
		expect(await pageAt(site, "/blog/fresh-bread")).toBe("Blog posts: Fresh bread");
	});
});

describe("Pages and URL patterns never share a path", () => {
	test("publishing a Page at a path a pattern owns is refused, naming the Post Type", async () => {
		const site = await newSite();
		await postTypeAt(site, "Blog posts", "/blog/{slug}");
		const blog = await publishEntry(site, site.pagesId, "Blog");
		const { entry } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Archive",
			parentId: blog,
		});

		await expect(editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id })).rejects.toMatchObject({
			code: "PATH_TAKEN",
			status: 409,
			data: { path: "/blog/archive", by: { kind: "postType", name: "Blog posts", urlPattern: "/blog/{slug}" } },
		});
		expect(await pageAt(site, "/blog/archive")).toBe(404);
	});

	test("moving a Page is refused when a Page under it would land on a pattern's path", async () => {
		const site = await newSite();
		await postTypeAt(site, "Blog posts", "/blog/{slug}");
		const blog = await publishEntry(site, site.pagesId, "Blog");
		const archive = await publishEntry(site, site.pagesId, "Archive");
		await publishEntry(site, site.pagesId, "Old", archive);

		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: blog, slug: "news" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: blog });
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: archive, slug: "blog" });

		await expect(editor.api.entries.publish({ siteId: site.siteId, entryId: archive })).rejects.toMatchObject({
			code: "PATH_TAKEN",
			data: { path: "/blog/old", by: { kind: "postType", name: "Blog posts" } },
		});
		expect(await pageAt(site, "/archive/old")).toBe("Page: Old");
	});

	test("a pattern that would own a published Page's path is refused, naming the Page", async () => {
		const site = await newSite();
		const about = await publishEntry(site, site.pagesId, "About");
		await publishEntry(site, site.pagesId, "Team", about);

		for (const urlPattern of ["/{slug}", "/about/{slug}", "/{slug}/team"]) {
			await expect(
				staff.api.postTypes.create({ siteId: site.siteId, name: "Posts", urlPattern }),
			).rejects.toMatchObject({ code: "PATH_TAKEN", data: { by: { kind: "page", id: expect.any(String) } } });
		}
		const posts = await postTypeAt(site, "Posts", "/posts/{slug}");
		await expect(
			staff.api.postTypes.update({ siteId: site.siteId, postTypeId: posts, urlPattern: "/{slug}" }),
		).rejects.toMatchObject({ code: "PATH_TAKEN", data: { path: "/about", by: { kind: "page", title: "About" } } });
		// Draft Pages hold no path yet: they are checked when they are published.
		await editor.api.entries.create({ siteId: site.siteId, postTypeId: site.pagesId, title: "Contact" });
		await staff.api.postTypes.update({ siteId: site.siteId, postTypeId: posts, urlPattern: "/contact/{slug}" });
	});

	test("Pages under a moved Page still nest at most 10 deep", async () => {
		const site = await newSite();
		let parent: string | undefined;
		for (let depth = 1; depth <= 8; depth++) parent = await publishEntry(site, site.pagesId, `Level ${depth}`, parent);
		const branch = await publishEntry(site, site.pagesId, "Branch");
		await publishEntry(site, site.pagesId, "Leaf", await publishEntry(site, site.pagesId, "Twig", branch));

		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: branch, parentId: parent });

		await expect(editor.api.entries.publish({ siteId: site.siteId, entryId: branch })).rejects.toMatchObject({
			code: "ENTRY_INVALID",
			data: { problems: [{ at: "parentId", message: "Pages nest at most 10 deep." }] },
		});
	});
});

describe("published paths that change", () => {
	test("are recorded with the publish, for every Page that moved, so Redirect rules can follow them", async () => {
		const site = await newSite();
		const about = await publishEntry(site, site.pagesId, "About");
		const company = await publishEntry(site, site.pagesId, "Company");
		const team = await publishEntry(site, site.pagesId, "Team", about);
		const bakers = await publishEntry(site, site.pagesId, "Bakers", team);

		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: team, parentId: company, slug: "people" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: team });

		const [entry] = (await admin.api.audit.list({ limit: 1 })).entries;
		expect(entry).toMatchObject({
			action: "entry.publish",
			details: {
				entryId: team,
				path: "/company/people",
				pathChanges: [
					{ entryId: team, from: "/about/team", to: "/company/people" },
					{ entryId: bakers, from: "/about/team/bakers", to: "/company/people/bakers" },
				],
			},
		});
	});

	test("an Entry's new slug changes its path too; a first publish changes none", async () => {
		const site = await newSite();
		const blog = await postTypeAt(site, "Blog posts", "/blog/{slug}");
		const post = await publishEntry(site, blog, "Fresh bread");
		expect((await admin.api.audit.list({ limit: 1 })).entries[0]?.details).toMatchObject({
			path: "/blog/fresh-bread",
			pathChanges: [],
		});

		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: post, slug: "daily-bread" });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: post });

		expect((await admin.api.audit.list({ limit: 1 })).entries[0]?.details).toMatchObject({
			path: "/blog/daily-bread",
			pathChanges: [{ entryId: post, from: "/blog/fresh-bread", to: "/blog/daily-bread" }],
		});
		expect((await editor.api.entries.get({ siteId: site.siteId, entryId: post })).entry.path).toBe("/blog/daily-bread");
	});

	test("every Entry tells where visitors find it once published", async () => {
		const site = await newSite();
		const about = await publishEntry(site, site.pagesId, "About");
		const team = await publishEntry(site, site.pagesId, "Team", about);
		const { entry: draft } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Draft",
		});

		const { entries } = await editor.api.entries.list({ siteId: site.siteId, postTypeId: site.pagesId });
		expect(Object.fromEntries(entries.map((entry) => [entry.id, entry.path]))).toEqual({
			[about]: "/about",
			[team]: "/about/team",
			[draft.id]: null,
		});
	});
});
