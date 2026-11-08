// Pages: Entries of the built-in Page Post Type every Site has. A Page nests under a parent Page and
// is found by its full path (`/about/team`); the home page is a Page too. Pages are arranged with a
// Page layout rather than an Entry template, so until Page layouts arrive their content is empty and
// a page shows its title and the Site template around it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { BUILT_IN_FIELDS } from "@webcraft/core";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

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

type TestSite = { siteId: string; pagesId: string; origin: string };

/** A new Site, its Page Post Type and its Staging address. */
async function newSite(): Promise<TestSite> {
	const slug = `pages-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const { postTypes } = await editor.api.postTypes.list({ siteId });
	const pages = postTypes.find((postType) => postType.builtIn === "page");
	return { siteId, pagesId: pages?.id ?? "", origin: `https://${slug}.sites.test` };
}

/** Creates a Page (under `parentId` when given) and publishes it; answers its id. */
async function publishPage(site: TestSite, title: string, parentId?: string): Promise<string> {
	const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId: site.pagesId, title, parentId });
	await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
	return entry.id;
}

/** The title of the page at `path`, or the status when it isn't a page. */
async function titleAt(site: TestSite, path: string): Promise<string | number> {
	const response = await install.request(`${site.origin}${path}`);
	if (response.status !== 200) return response.status;
	return /<title>(.*) · Acme Bakery<\/title>/.exec(await response.text())?.[1] ?? "";
}

describe("the Page Post Type", () => {
	test("every Site has it, built in: Pages are found by their parent Page and slug", async () => {
		const { siteId } = await newSite();

		const { postTypes } = await staff.api.postTypes.list({ siteId });

		expect(postTypes).toEqual([
			{
				id: expect.any(String),
				siteId,
				key: "page",
				name: "Pages",
				builtIn: "page",
				urlPattern: "/{path}",
				fields: [],
				builtInFields: [...BUILT_IN_FIELDS, "parent"],
				createdAt: install.clock.now(),
				updatedAt: install.clock.now(),
			},
		]);
	});
});

describe("the Page Post Type's rules", () => {
	test("Pages are arranged with a Page layout, not an Entry template", async () => {
		const site = await newSite();

		for (const save of [
			() => staff.api.templates.saveEntryTemplateMarkup({ ...ids(site), markup: "<h1>{{ title }}</h1>" }),
			() => staff.api.templates.saveEntryTemplate({ ...ids(site), tree: { version: 1, nodes: [] } }),
		]) {
			await expect(save()).rejects.toMatchObject({ code: "PAGES_HAVE_NO_ENTRY_TEMPLATE", status: 400 });
		}
		expect(await staff.api.templates.getEntryTemplate(ids(site))).toEqual({ template: null });
	});

	test("Staff may rename it and give it Fields; its URL pattern stays /{path}", async () => {
		const site = await newSite();

		const { postType } = await staff.api.postTypes.update({
			...ids(site),
			name: "Site pages",
			fields: [{ key: "summary", label: "Summary", type: "text" }],
		});
		expect(postType).toMatchObject({ name: "Site pages", urlPattern: "/{path}", fields: [{ key: "summary" }] });

		await expect(staff.api.postTypes.update({ ...ids(site), urlPattern: "/pages/{slug}" })).rejects.toMatchObject({
			code: "POST_TYPE_INVALID",
			data: { problems: [{ at: "urlPattern" }] },
		});
		await expect(
			staff.api.postTypes.update({ ...ids(site), fields: [{ key: "parent", label: "Parent", type: "text" }] }),
		).rejects.toMatchObject({ code: "POST_TYPE_INVALID", data: { problems: [{ at: "fields[0].key" }] } });
		// Staff can't make another one: its key and its pattern are taken, and /{path} is no URL pattern.
		await expect(
			staff.api.postTypes.create({ siteId: site.siteId, name: "Pages", key: "page", urlPattern: "/p/{slug}" }),
		).rejects.toMatchObject({ code: "POST_TYPE_TAKEN" });
		await expect(
			staff.api.postTypes.create({ siteId: site.siteId, name: "More pages", urlPattern: "/{path}" }),
		).rejects.toMatchObject({ code: "POST_TYPE_INVALID" });
	});
});

/** A Site's id and its Page Post Type's id, as procedures take them. */
function ids(site: TestSite) {
	return { siteId: site.siteId, postTypeId: site.pagesId };
}

describe("finding a Page by its path", () => {
	test("a published Page renders at /<slug> in the Site template, with its title", async () => {
		const site = await newSite();
		await publishPage(site, "About us");

		const response = await install.request(`${site.origin}/about-us`);

		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("<title>About us · Acme Bakery</title>");
		// The Page's layout goes in <main>; Page layouts arrive with Components.
		expect(html).toContain('<main id="wc-main" tabindex="-1"></main>');
	});

	test("a Page under a parent Page is found by its full path, and only there", async () => {
		const site = await newSite();
		const about = await publishPage(site, "About");
		await publishPage(site, "Team", about);

		expect(await titleAt(site, "/about/team")).toBe("Team");
		expect(await titleAt(site, "/about/team/")).toBe("Team");
		expect(await titleAt(site, "/team")).toBe(404);
		expect(await titleAt(site, "/about/team/more")).toBe(404);
	});
});

describe("moving a Page", () => {
	test("publishing a new parent moves the Page and every Page under it; the Draft alone changes nothing", async () => {
		const site = await newSite();
		const about = await publishPage(site, "About");
		const company = await publishPage(site, "Company");
		const team = await publishPage(site, "Team", about);
		await publishPage(site, "Bakers", team);

		const { entry } = await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: team, parentId: company });
		expect(entry.draft.parentId).toBe(company);
		expect(entry.published?.parentId).toBe(about);
		expect(await titleAt(site, "/about/team/bakers")).toBe("Bakers");

		await editor.api.entries.publish({ siteId: site.siteId, entryId: team });

		expect(await titleAt(site, "/company/team")).toBe("Team");
		expect(await titleAt(site, "/company/team/bakers")).toBe("Bakers");
		expect(await titleAt(site, "/about/team")).toBe(404);
		expect(await titleAt(site, "/about/team/bakers")).toBe(404);
	});

	test("to the top level, with a null parent", async () => {
		const site = await newSite();
		const about = await publishPage(site, "About");
		const team = await publishPage(site, "Team", about);

		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: team, parentId: null });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: team });

		expect(await titleAt(site, "/team")).toBe("Team");
		expect(await titleAt(site, "/about/team")).toBe(404);
	});
});

describe("slugs and parents", () => {
	test("Pages share a slug only under different parents", async () => {
		const site = await newSite();
		const about = await publishPage(site, "About");
		const careers = await publishPage(site, "Careers");
		await publishPage(site, "Team", about);
		await publishPage(site, "Team", careers);

		expect(await titleAt(site, "/about/team")).toBe("Team");
		expect(await titleAt(site, "/careers/team")).toBe("Team");
		await expect(
			editor.api.entries.create({
				siteId: site.siteId,
				postTypeId: site.pagesId,
				title: "Our team",
				slug: "team",
				parentId: about,
			}),
		).rejects.toMatchObject({
			code: "ENTRY_SLUG_TAKEN",
			data: { slug: "team" },
			message: "Another Page under the same parent already has the slug team.",
		});
		// A slug WebCraft makes is unique among the Pages under the parent.
		const made = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Team",
			parentId: about,
		});
		expect(made.entry.draft.slug).toBe("team-2");
	});

	test("moving a Page under a parent that already has its slug is refused", async () => {
		const site = await newSite();
		const about = await publishPage(site, "About");
		await publishPage(site, "Team", about);
		const team = await publishPage(site, "Team");

		await expect(
			editor.api.entries.saveDraft({ siteId: site.siteId, entryId: team, parentId: about }),
		).rejects.toMatchObject({ code: "ENTRY_SLUG_TAKEN", data: { slug: "team" } });
	});

	test("a parent is another Page of the Site, never the Page itself or a Page under it", async () => {
		const site = await newSite();
		const about = await publishPage(site, "About");
		const team = await publishPage(site, "Team", about);
		const other = await newSite();
		const elsewhere = await publishPage(other, "Elsewhere");
		const { postType } = await staff.api.postTypes.create({
			siteId: site.siteId,
			name: "Blog posts",
			urlPattern: "/blog/{slug}",
		});
		const post = await editor.api.entries.create({ siteId: site.siteId, postTypeId: postType.id, title: "Hello" });

		const refusals: [string, string | null, string][] = [
			[about, about, "A Page can't be its own parent."],
			[about, team, "A Page can't go under one of its own child Pages."],
			[team, post.entry.id, "There is no such Page on this Site."],
			[team, elsewhere, "There is no such Page on this Site."],
			[post.entry.id, about, "Only Pages have a parent Page."],
		];
		for (const [entryId, parentId, message] of refusals) {
			await expect(editor.api.entries.saveDraft({ siteId: site.siteId, entryId, parentId })).rejects.toMatchObject({
				code: "ENTRY_INVALID",
				data: { problems: [{ at: "parentId", message }] },
			});
		}
		expect(await titleAt(site, "/about/team")).toBe("Team");
	});

	test("Pages nest at most 10 deep", async () => {
		const site = await newSite();
		let parent: string | undefined;
		for (let depth = 1; depth <= 10; depth++) parent = await publishPage(site, `Level ${depth}`, parent);

		expect(await titleAt(site, `/${Array.from({ length: 10 }, (_, index) => `level-${index + 1}`).join("/")}`)).toBe(
			"Level 10",
		);
		await expect(
			editor.api.entries.create({ siteId: site.siteId, postTypeId: site.pagesId, title: "Level 11", parentId: parent }),
		).rejects.toMatchObject({ code: "ENTRY_INVALID", data: { problems: [{ at: "parentId" }] } });
	});

	test("a Page is published only under a published parent Page", async () => {
		const site = await newSite();
		const { entry: about } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "About",
		});
		const { entry: team } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Team",
			parentId: about.id,
		});

		await expect(editor.api.entries.publish({ siteId: site.siteId, entryId: team.id })).rejects.toMatchObject({
			code: "PAGE_PARENT_UNPUBLISHED",
			status: 409,
		});
		expect(await titleAt(site, "/about/team")).toBe(404);

		await editor.api.entries.publish({ siteId: site.siteId, entryId: about.id });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: team.id });
		expect(await titleAt(site, "/about/team")).toBe("Team");
	});

	test("a published Page can't end up under one of its own child Pages, whatever the Drafts say", async () => {
		const site = await newSite();
		const a = await publishPage(site, "A");
		const b = await publishPage(site, "B", a);
		// B's Draft leaves A, so A's Draft may go under B; publishing A first would make a loop.
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: b, parentId: null });
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: a, parentId: b });

		await expect(editor.api.entries.publish({ siteId: site.siteId, entryId: a })).rejects.toMatchObject({
			code: "ENTRY_INVALID",
			data: { problems: [{ at: "parentId", message: "A Page can't go under one of its own child Pages." }] },
		});

		await editor.api.entries.publish({ siteId: site.siteId, entryId: b });
		await editor.api.entries.publish({ siteId: site.siteId, entryId: a });
		expect(await titleAt(site, "/b/a")).toBe("A");
	});
});

describe("deleting a Page", () => {
	test("is refused while Pages are under it, in their Drafts or published; a home page that goes leaves / without a page", async () => {
		const site = await newSite();
		const about = await publishPage(site, "About");
		const team = await publishPage(site, "Team", about);
		const { entry: draftChild } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Careers",
			parentId: team,
		});
		await staff.api.pages.setHomePage({ siteId: site.siteId, pageId: about });

		for (const entryId of [about, team]) {
			await expect(editor.api.entries.delete({ siteId: site.siteId, entryId })).rejects.toMatchObject({
				code: "PAGE_HAS_CHILDREN",
				status: 409,
				data: { children: 1 },
			});
		}

		const deleteNow = async (entryId: string) => {
			const { confirmation } = await editor.api.entries.delete({ siteId: site.siteId, entryId });
			await editor.api.entries.delete({ siteId: site.siteId, entryId, confirmation: confirmation?.id });
		};
		await deleteNow(draftChild.id);
		await deleteNow(team);
		await deleteNow(about);

		expect(await titleAt(site, "/")).toBe(404);
		expect(await titleAt(site, "/about")).toBe(404);
		expect((await staff.api.pages.settings({ siteId: site.siteId })).settings.homePage).toBeNull();
	});
});

describe("a Relationship that points at a Page", () => {
	test("gives the Page's path as its url", async () => {
		const site = await newSite();
		const about = await publishPage(site, "About");
		const team = await publishPage(site, "Team", about);
		const { postType } = await staff.api.postTypes.create({
			siteId: site.siteId,
			name: "Blog posts",
			urlPattern: "/blog/{slug}",
			fields: [{ key: "seeAlso", label: "See also", type: "relationship", postTypes: ["page"], multiple: false }],
		});
		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId: site.siteId,
			postTypeId: postType.id,
			markup: '<article><a href="{{ seeAlso.url }}">{{ seeAlso.title }}</a></article>',
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });
		const { entry } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: postType.id,
			title: "Meet the bakers",
			fields: { seeAlso: team },
		});
		await editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });

		const html = await (await install.request(`${site.origin}/blog/meet-the-bakers`)).text();
		expect(html).toContain('<article><a href="/about/team">Team</a></article>');
	});
});
