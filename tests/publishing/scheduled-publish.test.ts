// Scheduled publish (GLOSSARY.md › Scheduled publish, spec story 46): a publish set to happen at a
// later time. It publishes each item's Draft as it was when it was scheduled, every language, through
// the same publish as now (its Revision, Webhooks, the page cache, Automatic translation); later edits
// stay in the Draft and show "Changed since scheduled". Whoever may publish an item may schedule it.
// The worker looks every minute; a run that can't publish everything publishes nothing and emails the
// person who scheduled it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { scheduledPublishesDue } from "@webcraft/core";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { approveAiClient, connectMcp } from "../harness/mcp.ts";
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

type TestSite = {
	siteId: string;
	postTypeId: string;
	pagesId: string;
	live: string;
	editor: TestBrowser;
	editorEmail: string;
};

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
	return {
		siteId,
		postTypeId: postType.id,
		pagesId,
		live: await goLive(install, siteId),
		editor: editor.browser,
		editorEmail: editor.account.email,
	};
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

	test("a Webhook receiving `unpublish` hears which Entry went and where it was", async () => {
		const site = await newSite();
		const url = "https://hooks.agency.example/gone";
		install.dns.answer("hooks.agency.example", ["93.184.216.34"]);
		install.http.respond("POST", url, { status: 204 });
		await staff.api.webhooks.add({ siteId: site.siteId, url, events: ["unpublish"] });
		const { entry } = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Offer",
		});
		await site.editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
		await install.drainJobs();
		expect(install.http.requests.filter((request) => request.url === url)).toEqual([]);

		const { scheduled } = await site.editor.api.publishing.scheduleUnpublish({
			siteId: site.siteId,
			entryId: entry.id,
			at: inMinutes(2),
		});
		await waitMinutes(2);
		await install.drainJobs();
		const deliveries = install.http.requests.filter((request) => request.url === url);
		expect(deliveries.map((request) => JSON.parse(request.body))).toMatchObject([
			{
				type: "unpublish",
				data: {
					item: { kind: "entry", id: entry.id, postTypeId: site.postTypeId },
					paths: [{ language: "en", path: "/blog/offer" }],
					by: { id: scheduled.createdBy?.id, name: "Eve Editor" },
					via: "scheduledPublish",
				},
			},
		]);
	});

	test("an Entry deleted before its unpublish has nothing left to unpublish: nobody is emailed", async () => {
		const site = await newSite();
		const { entry } = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Brief",
		});
		await site.editor.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
		await site.editor.api.publishing.scheduleUnpublish({ siteId: site.siteId, entryId: entry.id, at: inMinutes(5) });
		const deletion = await staff.api.entries.delete({ siteId: site.siteId, entryId: entry.id });
		await staff.api.entries.delete({
			siteId: site.siteId,
			entryId: entry.id,
			confirmation: (deletion as { confirmation: { id: string } }).confirmation.id,
		});
		const sentBefore = install.mail.sent.length;

		await waitMinutes(5);
		expect(install.mail.sent.length).toBe(sentBefore);
		expect((await auditOf(site.siteId)).find((each) => each.action === "scheduledPublish.run")).toMatchObject({
			details: { action: "unpublish" },
		});
		expect((await site.editor.api.publishing.scheduled({ siteId: site.siteId })).scheduled).toEqual([]);
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

/** "Publish all at…"'s two calls, as the admin makes them: the preview, then its confirmation. */
async function scheduleAll(browser: TestBrowser, siteId: string, items: { kind: string; id?: string }[], at: Date) {
	const preview = await browser.api.publishing.scheduleAll({ siteId, items: items as never, at });
	if (!("confirmation" in preview)) throw new Error("Publish all at… scheduled without a confirmation.");
	const done = await browser.api.publishing.scheduleAll({
		siteId,
		items: items as never,
		at,
		confirmation: preview.confirmation.id,
	});
	if (!("scheduled" in done) || done.scheduled === false) throw new Error("Nothing was scheduled.");
	return done.scheduled;
}

describe("Publish all at…", () => {
	test("schedules the ticked Drafts as one Scheduled publish, which publishes them together at its time", async () => {
		const site = await newSite();
		const post = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Launch",
		});
		const about = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "About",
		});
		const designSystem = await staff.api.designSystem.saveDraft({
			siteId: site.siteId,
			customCss: "main { margin: 0; }",
		});
		expect(designSystem).toBeTruthy();
		const at = inMinutes(120);

		const preview = await staff.api.publishing.scheduleAll({
			siteId: site.siteId,
			items: [{ kind: "entry", id: post.entry.id }, { kind: "designSystem" }, { kind: "entry", id: about.entry.id }],
			at,
		});
		expect(preview).toMatchObject({
			scheduled: false,
			preview: {
				at,
				items: [
					{ item: { kind: "designSystem" }, status: "new" },
					{ item: { kind: "entry", id: about.entry.id }, name: "About", status: "new" },
					{ item: { kind: "entry", id: post.entry.id }, name: "Launch", status: "new" },
				],
			},
		});
		const scheduled = await scheduleAll(
			staff,
			site.siteId,
			[{ kind: "entry", id: post.entry.id }, { kind: "designSystem" }, { kind: "entry", id: about.entry.id }],
			at,
		);
		expect(scheduled).toMatchObject({ action: "publish", kind: "set", at, createdBy: { name: "Ada Staff" } });
		expect(scheduled.items.map((each) => each.item.kind)).toEqual(["designSystem", "entry", "entry"]);
		// The Editor sees it, but may not change it: it holds the Design system, Staff's to publish.
		const asEditor = await site.editor.api.publishing.scheduled({ siteId: site.siteId });
		expect(asEditor.scheduled.map((each) => ({ id: each.id, canChange: each.canChange }))).toEqual([
			{ id: scheduled.id, canChange: false },
		]);
		await expect(
			site.editor.api.publishing.cancelScheduled({ siteId: site.siteId, scheduleId: scheduled.id }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		await waitMinutes(120);
		expect(await visit(site.live, "/blog/launch")).toEqual({ status: 200, heading: "Launch" });
		expect((await install.request(`${site.live}/about`)).status).toBe(200);
		expect((await staff.api.publishing.drafts({ siteId: site.siteId })).drafts).toEqual([]);
	});

	test("a Scheduled publish is cancelled, its time changed (keeping what it froze), or given the current Drafts", async () => {
		const site = await newSite();
		const post = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "First",
		});
		const scheduled = await scheduleAll(
			site.editor,
			site.siteId,
			[{ kind: "entry", id: post.entry.id }],
			inMinutes(60),
		);
		await site.editor.api.entries.saveDraft({ siteId: site.siteId, entryId: post.entry.id, title: "Second" });

		const later = inMinutes(90);
		const moved = await site.editor.api.publishing.reschedule({
			siteId: site.siteId,
			scheduleId: scheduled.id,
			at: later,
		});
		expect(moved.scheduled).toMatchObject({ at: later, items: [{ changedSinceScheduled: true }] });
		await expect(
			site.editor.api.publishing.reschedule({ siteId: site.siteId, scheduleId: scheduled.id, at: inMinutes(-1) }),
		).rejects.toMatchObject({ code: "SCHEDULE_INVALID", data: { reason: "past" } });
		await waitMinutes(60);
		expect((await install.request(`${site.live}/blog/first`)).status).toBe(404);

		const taken = await site.editor.api.publishing.updateScheduled({ siteId: site.siteId, scheduleId: scheduled.id });
		expect(taken.scheduled).toMatchObject({ at: later, items: [{ name: "Second", changedSinceScheduled: false }] });
		await waitMinutes(30);
		expect(await visit(site.live, "/blog/first")).toEqual({ status: 200, heading: "Second" });

		const other = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Other",
		});
		const cancelled = await site.editor.api.publishing.schedule({
			siteId: site.siteId,
			item: { kind: "entry", id: other.entry.id },
			at: inMinutes(10),
		});
		await site.editor.api.publishing.cancelScheduled({ siteId: site.siteId, scheduleId: cancelled.scheduled.id });
		await waitMinutes(10);
		expect((await install.request(`${site.live}/blog/other`)).status).toBe(404);
		await expect(
			site.editor.api.publishing.cancelScheduled({ siteId: site.siteId, scheduleId: cancelled.scheduled.id }),
		).rejects.toMatchObject({ code: "SCHEDULED_PUBLISH_NOT_FOUND" });
	});

	test("an item published now leaves the Scheduled publish it waited in, so its newer version stays live", async () => {
		const site = await newSite();
		const one = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "One",
		});
		const two = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Two",
		});
		const scheduled = await scheduleAll(
			site.editor,
			site.siteId,
			[
				{ kind: "entry", id: one.entry.id },
				{ kind: "entry", id: two.entry.id },
			],
			inMinutes(30),
		);
		await site.editor.api.entries.saveDraft({ siteId: site.siteId, entryId: one.entry.id, title: "One, now" });
		await site.editor.api.entries.publish({ siteId: site.siteId, entryId: one.entry.id });

		const { scheduled: left } = await site.editor.api.publishing.scheduled({ siteId: site.siteId });
		expect(left.map((each) => ({ id: each.id, items: each.items.map((item) => item.name) }))).toEqual([
			{ id: scheduled.id, items: ["Two"] },
		]);
		await waitMinutes(30);
		expect(await visit(site.live, "/blog/one")).toEqual({ status: 200, heading: "One, now" });
		expect(await visit(site.live, "/blog/two")).toEqual({ status: 200, heading: "Two" });
	});
});

/** The Audit log entries of a Site, newest first, as the Superadmin reads them. */
async function auditOf(siteId: string) {
	const { entries } = await (await install.superadmin()).api.audit.list({ limit: 200 });
	return entries.filter((entry) => entry.siteId === siteId);
}

describe("a Scheduled publish that can't go through", () => {
	test("publishes none of its items, is removed, and emails the person who scheduled it", async () => {
		const site = await newSite();
		const kept = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Kept",
		});
		const doomed = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Doomed",
		});
		const scheduled = await scheduleAll(
			site.editor,
			site.siteId,
			[
				{ kind: "entry", id: kept.entry.id },
				{ kind: "entry", id: doomed.entry.id },
			],
			inMinutes(15),
		);
		const deletion = await staff.api.entries.delete({ siteId: site.siteId, entryId: doomed.entry.id });
		await staff.api.entries.delete({
			siteId: site.siteId,
			entryId: doomed.entry.id,
			confirmation: (deletion as { confirmation: { id: string } }).confirmation.id,
		});
		expect((await site.editor.api.publishing.scheduled({ siteId: site.siteId })).scheduled[0]?.items).toMatchObject([
			{ name: "Kept", missing: false },
			{ missing: true },
		]);

		const drained = await waitMinutes(15);
		expect(drained.failed).toEqual([]);
		expect((await install.request(`${site.live}/blog/kept`)).status).toBe(404);
		expect((await site.editor.api.entries.get({ siteId: site.siteId, entryId: kept.entry.id })).entry.status).toBe(
			"draft",
		);
		expect((await site.editor.api.publishing.scheduled({ siteId: site.siteId })).scheduled).toEqual([]);
		const email = await install.lastEmailTo(site.editorEmail);
		expect(email.subject).toBe("2 items weren't published as scheduled");
		expect(email.text).toContain("none of them was published");
		expect(email.text).toContain("“Doomed” was deleted after it was scheduled.");
		expect((await auditOf(site.siteId)).find((entry) => entry.action === "scheduledPublish.fail")).toMatchObject({
			via: { kind: "scheduledPublish" },
			details: { scheduleId: scheduled.id, reason: "deleted", item: { kind: "entry", id: doomed.entry.id } },
		});
	});

	test("says why in the person's Admin language: a required Field added since leaves the frozen Entry incomplete", async () => {
		const site = await newSite();
		await site.editor.api.me.updatePreferences({ adminLanguage: "it" });
		const pie = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Pie",
		});
		await site.editor.api.publishing.schedule({
			siteId: site.siteId,
			item: { kind: "entry", id: pie.entry.id },
			at: inMinutes(5),
		});
		await staff.api.postTypes.update({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			fields: [{ key: "summary", label: "Summary", type: "text", required: true }],
		});

		await waitMinutes(5);
		expect((await install.request(`${site.live}/blog/pie`)).status).toBe(404);
		const email = await install.lastEmailTo(site.editorEmail);
		expect(email.subject).toBe("“Pie” non è stato pubblicato come programmato");
		expect(email.text).toContain("valori obbligatori vuoti");
		expect(email.text).toContain(`/sites/${site.siteId}/entries/${site.postTypeId}/${pie.entry.id}`);
	});

	test("is refused when scheduled if it couldn't be published now: Authors may not, and the time must be ahead", async () => {
		const site = await newSite();
		const author = await install.createMember({ workspaceId, role: "author", sites: [site.siteId] });
		const { entry } = await author.browser.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Mine",
		});
		const item = { kind: "entry" as const, id: entry.id };
		await expect(
			author.browser.api.publishing.schedule({ siteId: site.siteId, item, at: inMinutes(5) }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			author.browser.api.publishing.scheduleUnpublish({ siteId: site.siteId, entryId: entry.id, at: inMinutes(5) }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			author.browser.api.publishing.scheduleAll({ siteId: site.siteId, items: [item], at: inMinutes(5) }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			site.editor.api.publishing.schedule({ siteId: site.siteId, item, at: inMinutes(0) }),
		).rejects.toMatchObject({
			code: "SCHEDULE_INVALID",
			data: { reason: "past" },
		});
		await expect(
			site.editor.api.publishing.schedule({ siteId: site.siteId, item, at: inMinutes(11 * 365 * 24 * 60) }),
		).rejects.toMatchObject({ code: "SCHEDULE_INVALID", data: { reason: "tooFar" } });

		// What it needs must be published first, or scheduled with it ("Publish all at…").
		const parent = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Menus",
		});
		const child = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.pagesId,
			title: "Spring",
			parentId: parent.entry.id,
		});
		await expect(
			site.editor.api.publishing.schedule({
				siteId: site.siteId,
				item: { kind: "entry", id: child.entry.id },
				at: inMinutes(5),
			}),
		).rejects.toMatchObject({ code: "PAGE_PARENT_UNPUBLISHED" });
		const together = await scheduleAll(
			site.editor,
			site.siteId,
			[
				{ kind: "entry", id: child.entry.id },
				{ kind: "entry", id: parent.entry.id },
			],
			inMinutes(5),
		);
		expect(together.items.map((each) => each.name)).toEqual(["Menus", "Spring"]);

		const first = await site.editor.api.publishing.schedule({ siteId: site.siteId, item, at: inMinutes(5) });
		await expect(
			site.editor.api.publishing.schedule({ siteId: site.siteId, item, at: inMinutes(9) }),
		).rejects.toMatchObject({
			code: "ALREADY_SCHEDULED",
			data: { scheduleId: first.scheduled.id },
		});
		expect((await auditOf(site.siteId)).map((entry) => entry.action)).toContain("scheduledPublish.create");
	});
});

describe("the worker", () => {
	test("two workers looking at once publish a Scheduled publish once", async () => {
		const site = await newSite();
		const url = "https://hooks.agency.example/once";
		install.dns.answer("hooks.agency.example", ["93.184.216.34"]);
		install.http.respond("POST", url, { status: 204 });
		await staff.api.webhooks.add({ siteId: site.siteId, url, events: ["publish"] });
		const { entry } = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Once",
		});
		await site.editor.api.publishing.schedule({
			siteId: site.siteId,
			item: { kind: "entry", id: entry.id },
			at: inMinutes(3),
		});
		await install.clock.advance(3 * MINUTE);

		// Each worker runs the minute's look; the drains share the queue's jobs as two workers do.
		await install.jobs.send(scheduledPublishesDue, {});
		await install.jobs.send(scheduledPublishesDue, {});
		const [one, two] = await Promise.all([
			install.drainJobs({ only: ["publishing.scheduled-due"], batchSize: 1 }),
			install.drainJobs({ only: ["publishing.scheduled-due"], batchSize: 1 }),
		]);
		expect([...one.failed, ...two.failed]).toEqual([]);
		expect(one.completed.length + two.completed.length).toBeGreaterThanOrEqual(2);
		await install.drainJobs();

		expect(await visit(site.live, "/blog/once")).toEqual({ status: 200, heading: "Once" });
		const actions = (await auditOf(site.siteId)).map((each) => each.action);
		expect(actions.filter((action) => action === "entry.publish")).toHaveLength(1);
		expect(actions.filter((action) => action === "scheduledPublish.run")).toHaveLength(1);
		const history = await site.editor.api.history.list({ siteId: site.siteId, item: { kind: "entry", id: entry.id } });
		expect(history.copies.filter((copy) => copy.type === "revision")).toHaveLength(1);
		expect(install.http.requests.filter((request) => request.url === url)).toHaveLength(1);
	});

	test("publishes on behalf of the person who scheduled it: the Audit log, the Revision and the Webhook say so", async () => {
		const site = await newSite();
		const url = "https://hooks.agency.example/behalf";
		install.dns.answer("hooks.agency.example", ["93.184.216.34"]);
		install.http.respond("POST", url, { status: 204 });
		await staff.api.webhooks.add({ siteId: site.siteId, url, events: ["publish"] });
		const { entry } = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "On behalf",
		});
		const { scheduled } = await site.editor.api.publishing.schedule({
			siteId: site.siteId,
			item: { kind: "entry", id: entry.id },
			at: inMinutes(1),
		});
		const editorId = scheduled.createdBy?.id;

		await waitMinutes(1);
		await install.drainJobs();
		const entries = await auditOf(site.siteId);
		expect(entries.find((each) => each.action === "entry.publish")).toMatchObject({
			personId: editorId,
			via: { kind: "scheduledPublish" },
			details: { entryId: entry.id, path: "/blog/on-behalf" },
		});
		expect(entries.find((each) => each.action === "scheduledPublish.run")).toMatchObject({
			personId: editorId,
			via: { kind: "scheduledPublish" },
			details: { scheduleId: scheduled.id, late: false, count: 1 },
		});
		const { copies } = await site.editor.api.history.list({
			siteId: site.siteId,
			item: { kind: "entry", id: entry.id },
		});
		expect(copies[0]).toMatchObject({
			type: "revision",
			by: { person: { id: editorId, name: "Eve Editor" }, via: { kind: "scheduledPublish" } },
		});
		const delivery = install.http.requests.find((request) => request.url === url);
		expect(JSON.parse(delivery?.body ?? "{}")).toMatchObject({
			type: "publish",
			data: {
				item: { kind: "entry", id: entry.id },
				by: { id: editorId, name: "Eve Editor" },
				via: "scheduledPublish",
			},
		});
	});

	test("a Scheduled publish missed while the worker was down runs when it is back, and says it was late", async () => {
		const site = await newSite();
		const { entry } = await site.editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Late",
		});
		const { scheduled } = await site.editor.api.publishing.schedule({
			siteId: site.siteId,
			item: { kind: "entry", id: entry.id },
			at: inMinutes(10),
		});
		// The worker is down: nothing runs while the clock passes the time.
		await install.clock.advance(50 * MINUTE);
		expect((await install.request(`${site.live}/blog/late`)).status).toBe(404);

		await install.drainJobs();
		expect(await visit(site.live, "/blog/late")).toEqual({ status: 200, heading: "Late" });
		expect((await auditOf(site.siteId)).find((each) => each.action === "scheduledPublish.run")).toMatchObject({
			details: { scheduleId: scheduled.id, late: true, lateByMinutes: 40 },
		});
		expect(
			install.logs.some(
				(line) => line.level === "warn" && line.msg.includes("ran late") && line.scheduleId === scheduled.id,
			),
		).toBe(true);
	});
});

describe("API clients", () => {
	test("a script with an API token schedules in two steps: a preview with a confirmation id, then the id", async () => {
		const site = await newSite();
		const { entry } = await staff.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Scripted",
		});
		const { secret } = await createApiToken(staff, { workspaceId, name: "Release script" });
		const script = tokenClient(install, secret);
		const item = { kind: "entry" as const, id: entry.id };
		const at = inMinutes(20);

		const first = (await script.api.publishing.schedule({ siteId: site.siteId, item, at })) as unknown as {
			confirmation: { id: string };
			preview: Record<string, unknown>;
		};
		expect(first.preview).toMatchObject({ at: at.toISOString(), item, name: "Scripted", firstPublish: true });
		expect((await staff.api.publishing.scheduled({ siteId: site.siteId })).scheduled).toEqual([]);

		const second = await script.api.publishing.schedule({
			siteId: site.siteId,
			item,
			at,
			confirmation: first.confirmation.id,
		});
		expect(second).toMatchObject({ scheduled: { createdBy: { name: "Ada Staff", via: "Release script" } } });
		await waitMinutes(20);
		expect(await visit(site.live, "/blog/scripted")).toEqual({ status: 200, heading: "Scripted" });
	});

	test("an AI client schedules only when its person let it publish", async () => {
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const names = async (token: string) => {
			const client = await connectMcp(install, token);
			const { tools } = await client.listTools();
			await client.close();
			return tools.map((tool) => tool.name);
		};
		const scheduling = [
			"publishing_schedule",
			"publishing_schedule_all",
			"publishing_schedule_unpublish",
			"publishing_reschedule",
			"publishing_update_scheduled",
		];
		const writer = await approveAiClient(install, owner.browser, { workspaceId, mayPublish: false });
		const writerTools = await names(writer.accessToken);
		expect(writerTools).toEqual(expect.arrayContaining(["publishing_scheduled", "publishing_cancel_scheduled"]));
		expect(scheduling.filter((name) => writerTools.includes(name))).toEqual([]);
		const publisher = await approveAiClient(install, owner.browser, { workspaceId, mayPublish: true });
		expect(await names(publisher.accessToken)).toEqual(expect.arrayContaining(scheduling));
	});
});
