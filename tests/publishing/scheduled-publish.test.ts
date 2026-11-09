// Scheduled publish (GLOSSARY.md › Scheduled publish, spec story 46): a publish set to happen at a
// later time. It publishes each item's Draft as it was when it was scheduled, every language, through
// the same publish as now (its Revision, Webhooks, the page cache, Automatic translation); later edits
// stay in the Draft and show "Changed since scheduled". Whoever may publish an item may schedule it.
// The worker looks every minute; a run that can't publish everything publishes nothing and emails the
// person who scheduled it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId], name: "Ada Staff" })).browser;
});

afterAll(async () => {
	await install.close();
});

const MINUTE = 60_000;

let sites = 0;

type TestSite = { siteId: string; postTypeId: string; pagesId: string; live: string; editor: TestBrowser };

/** A live Site with a Blog Post Type (`/blog/{slug}`), its published Entry template, and an Editor. */
async function newSite(): Promise<TestSite> {
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: `scheduled-${++sites}` })).id;
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		key: "posts",
		urlPattern: "/blog/{slug}",
	});
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const pagesId = (await staff.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")
		?.id as string;
	const editor = await install.createMember({ workspaceId, role: "editor", sites: [siteId], name: "Eve Editor" });
	return { siteId, postTypeId: postType.id, pagesId, live: await goLive(install, siteId), editor: editor.browser };
}

/** A time `minutes` from now by the Install's clock. */
function inMinutes(minutes: number): Date {
	return new Date(install.clock.now().getTime() + minutes * MINUTE);
}

/** Moves the clock on and lets the worker look, as it does every minute. */
async function waitMinutes(minutes: number) {
	await install.clock.advance(minutes * MINUTE);
	return install.drainJobs();
}

/** What a visitor gets at a path of the live Site: the status and the page's heading, if any. */
async function visit(live: string, path: string): Promise<{ status: number; heading: string | null }> {
	const response = await install.request(`${live}${path}`);
	const html = await response.text();
	return { status: response.status, heading: /<h1>([^<]*)<\/h1>/.exec(html)?.[1] ?? null };
}

describe("one item", () => {
	test("publishes the version the Entry had when it was scheduled; later edits stay in its Draft", async () => {
		const site = await newSite();
		const { entry } = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Spring menu",
		});
		const at = inMinutes(60);

		const { scheduled } = await site.editor.api.publishing.schedule({
			siteId: site.siteId,
			item: { kind: "entry", id: entry.id },
			at,
		});
		expect(scheduled).toMatchObject({
			action: "publish",
			kind: "item",
			at,
			items: [{ item: { kind: "entry", id: entry.id }, name: "Spring menu", changedSinceScheduled: false }],
			createdBy: { name: "Eve Editor", via: null },
			canChange: true,
		});

		await site.editor.api.entries.saveDraft({ siteId: site.siteId, entryId: entry.id, title: "Spring menu, revised" });
		const before = await site.editor.api.entries.get({ siteId: site.siteId, entryId: entry.id });
		expect(before.entry.scheduled).toEqual({
			publish: { id: scheduled.id, at, kind: "item", changedSinceScheduled: true },
			unpublish: null,
		});
		const listed = await site.editor.api.publishing.scheduled({ siteId: site.siteId });
		expect(listed.scheduled.map((each) => each.items[0]?.changedSinceScheduled)).toEqual([true]);

		await waitMinutes(59);
		expect((await visit(site.live, "/blog/spring-menu")).status).toBe(404);

		await waitMinutes(1);
		expect(await visit(site.live, "/blog/spring-menu")).toEqual({ status: 200, heading: "Spring menu" });
		const after = await site.editor.api.entries.get({ siteId: site.siteId, entryId: entry.id });
		expect(after.entry).toMatchObject({
			status: "changed",
			draft: { title: "Spring menu, revised" },
			published: { title: "Spring menu" },
			scheduled: { publish: null, unpublish: null },
		});
		expect((await site.editor.api.publishing.scheduled({ siteId: site.siteId })).scheduled).toEqual([]);
	});
});

describe("unpublishing an Entry", () => {
	test("at its time the Entry's page answers 410 Gone and it leaves Loops and Site search; its Draft and Revisions stay, and it can be published again", async () => {
		const site = await newSite();
		const loop = await staff.api.loops.create({
			siteId: site.siteId,
			name: "latest",
			source: "query",
			query: { postTypes: ["posts"] },
		});
		await staff.api.loops.publish({ siteId: site.siteId, loopId: loop.loop.id });
		const siteTemplate = await staff.api.templates.saveSiteTemplateMarkup({
			siteId: site.siteId,
			markup: "<main>{{@outlet}}</main><aside>{{@loop latest as p}}[{{ p.title }}]{{/loop}}</aside>",
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: siteTemplate.template.id });
		const search = await staff.api.entries.create({ siteId: site.siteId, postTypeId: site.pagesId, title: "Search" });
		await staff.api.entries.publish({ siteId: site.siteId, entryId: search.entry.id });
		await staff.api.pages.setSearchPage({ siteId: site.siteId, pageId: search.entry.id });
		const spring = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Spring menu",
		});
		await site.editor.api.entries.publish({ siteId: site.siteId, entryId: spring.entry.id });
		await install.clock.advance(MINUTE);
		const winter = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Winter menu",
		});
		await site.editor.api.entries.publish({ siteId: site.siteId, entryId: winter.entry.id });
		const aside = async () =>
			/<aside>(.*)<\/aside>/.exec(await (await install.request(`${site.live}/blog/winter-menu`)).text())?.[1];
		const found = async (query: string) =>
			[
				...(await (await install.request(`${site.live}/search?q=${query}`)).text()).matchAll(
					/<h2><a href="[^"]*">([^<]*)<\/a><\/h2>/g,
				),
			].map(([, title]) => title);
		expect(await aside()).toBe("[Winter menu][Spring menu]");
		expect(await found("spring")).toEqual(["Spring menu"]);

		const at = inMinutes(30);
		const { scheduled } = await site.editor.api.publishing.scheduleUnpublish({
			siteId: site.siteId,
			entryId: spring.entry.id,
			at,
		});
		expect(scheduled).toMatchObject({
			action: "unpublish",
			at,
			items: [{ item: { kind: "entry", id: spring.entry.id } }],
		});
		expect(
			(await site.editor.api.entries.get({ siteId: site.siteId, entryId: spring.entry.id })).entry.scheduled,
		).toEqual({
			publish: null,
			unpublish: { id: scheduled.id, at },
		});

		await waitMinutes(30);
		const gone = await install.request(`${site.live}/blog/spring-menu`);
		expect(gone.status).toBe(410);
		expect(gone.headers.get("x-robots-tag")).toBe("noindex");
		expect(gone.headers.get("cache-control")).toBe("no-store");
		const goneHeading = /<h1>([^<]*)<\/h1>/.exec(await gone.text())?.[1];
		const missingHeading = /<h1>([^<]*)<\/h1>/.exec(
			await (await install.request(`${site.live}/blog/nothing`)).text(),
		)?.[1];
		expect(goneHeading).toBe(missingHeading as string);
		expect((await install.request(`${site.live}/blog/nothing`)).status).toBe(404);
		expect(await aside()).toBe("[Winter menu]");
		expect(await found("spring")).toEqual([]);
		const unpublished = await site.editor.api.entries.get({ siteId: site.siteId, entryId: spring.entry.id });
		expect(unpublished.entry).toMatchObject({
			status: "draft",
			unpublishedAt: at,
			published: null,
			path: null,
			draft: { title: "Spring menu" },
			scheduled: { publish: null, unpublish: null },
		});
		const history = await site.editor.api.history.list({
			siteId: site.siteId,
			item: { kind: "entry", id: spring.entry.id },
		});
		expect(history.copies.filter((copy) => copy.type === "revision")).toHaveLength(1);

		await site.editor.api.entries.publish({ siteId: site.siteId, entryId: spring.entry.id });
		expect(await visit(site.live, "/blog/spring-menu")).toEqual({ status: 200, heading: "Spring menu" });
		expect(
			(await site.editor.api.entries.get({ siteId: site.siteId, entryId: spring.entry.id })).entry.unpublishedAt,
		).toBeNull();
		expect(await found("spring")).toEqual(["Spring menu"]);
	});

	test("a Page takes the Pages under it along; the home page can't be unpublished", async () => {
		const site = await newSite();
		const page = async (title: string, parentId?: string) => {
			const { entry } = await site.editor.api.entries.create({
				siteId: site.siteId,
				postTypeId: site.pagesId,
				title,
				...(parentId ? { parentId } : {}),
			});
			await site.editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
			return entry.id;
		};
		const home = await page("Home");
		await staff.api.pages.setHomePage({ siteId: site.siteId, pageId: home });
		const about = await page("About");
		await page("Team", about);
		await page("Contact");

		await expect(
			site.editor.api.publishing.scheduleUnpublish({ siteId: site.siteId, entryId: home, at: inMinutes(5) }),
		).rejects.toMatchObject({ code: "HOME_PAGE_UNPUBLISH" });
		await site.editor.api.publishing.scheduleUnpublish({ siteId: site.siteId, entryId: about, at: inMinutes(5) });
		await waitMinutes(5);

		expect((await install.request(`${site.live}/about`)).status).toBe(410);
		expect((await install.request(`${site.live}/about/team`)).status).toBe(410);
		expect((await install.request(`${site.live}/contact`)).status).toBe(200);
		expect((await install.request(`${site.live}/`)).status).toBe(200);
	});
});
