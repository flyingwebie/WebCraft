// What a flood of Form posts costs the Install: nothing past fixed bounds. From one address, a Form
// keeps ten times its limits (what is over the limits themselves as spam) and refuses the rest; the
// Spam folder holds a Site's newest 1,000; a post larger than a Form takes is refused, never kept;
// and a post's body is read only once its Form is known, and only as far as that Form takes.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type forms from "@webcraft/module-forms";

import { fromAddress } from "../harness/browser.ts";
import { type FormVisitor, formVisitor, type LoadedPage } from "../harness/forms.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { expectSiteHeaders } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;

const DAY = 24 * 60 * 60 * 1000;
const GOOD = { email: "ada@example.com" };
const PDF = `%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n${"x".repeat(3000)}\n%%EOF\n`;

type Limits = { perMinute: number; perHour: number };

/** A live Site of its own with one published Form on `/visit/contact`, taking `limits` from one address. */
async function siteWithForm(slug: string, limits: Limits, fields: Record<string, unknown>[] = []) {
	const siteId = (await install.createSite(workspaceId, { name: slug, slug })).id;
	const origin = await goLive(install, siteId);
	const { form } = await staff.api.forms.create({ siteId, name: "Contact", key: "contact" });
	await staff.api.forms.saveDraft({
		siteId,
		formId: form.id,
		form: {
			fields: [{ key: "email", type: "email", label: "Email", required: true }, ...fields],
			spam: { minFillSeconds: 3, ...limits },
		},
	});
	await staff.api.forms.publish({ siteId, formId: form.id });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Visits",
		key: "visits",
		urlPattern: "/visit/{slug}",
		fields: [],
	});
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "{{@form contact}}",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Contact",
		slug: "contact",
		fields: {},
	});
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	const kept = (folder: "inbox" | "spam", search?: string) =>
		moduleApi<typeof forms>(staff, "forms").submissions.list({ siteId, formId: form.id, folder, search, limit: 1 });
	return { siteId, formId: form.id, origin, page: `${origin}/visit/contact`, kept };
}

/** A page loaded long enough ago for a person to have filled its Form in. */
async function loaded(visitor: FormVisitor, url: string): Promise<LoadedPage> {
	const page = await visitor.open(url);
	await install.clock.advance(5000);
	return page;
}

/** What a bot posts: the Form's fields with no token of the page. */
const BOT = { hidden: { "wc-t": null } };

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "forms", version: "1.2.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

test("from one address, ten times a Form's limit a minute is kept; the rest is refused and never kept", async () => {
	const site = await siteWithForm("minute", { perMinute: 2, perHour: 1000 });
	const bot = formVisitor(install);
	const page = await loaded(bot, site.page);

	for (let sent = 0; sent < 20; sent++) expect((await bot.send(page, GOOD, BOT)).status).toBe(303);
	const refused = await bot.send(page, GOOD, BOT);

	expect(refused.status).toBe(429);
	expectSiteHeaders(refused);
	expect(refused.headers.get("cache-control")).toBe("no-store");
	expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
	expect(Number(refused.headers.get("retry-after"))).toBeLessThanOrEqual(60);
	expect((await site.kept("spam")).total).toBe(20);
	// A post that would pass every check is refused from that address too, and one with errors
	// isn't rendered again.
	expect((await bot.send(page, GOOD)).status).toBe(429);
	expect((await bot.send(page, { email: "nope" })).status).toBe(429);
	expect((await site.kept("inbox")).total).toBe(0);
	// Another address is counted on its own, and a minute on the first one sends again.
	const person = formVisitor(install);
	expect((await person.send(await loaded(person, site.page), GOOD)).status).toBe(303);
	expect((await site.kept("inbox")).total).toBe(1);
	await install.clock.advance(60_000);
	expect((await bot.send(page, GOOD)).status).toBe(303);
	expect((await site.kept("inbox")).total).toBe(2);
});

test("from one address, ten times a Form's limit an hour is kept; the rest is refused until the hour ends", async () => {
	const site = await siteWithForm("hour", { perMinute: 1000, perHour: 3 });
	const bot = formVisitor(install);
	const page = await loaded(bot, site.page);

	for (let sent = 0; sent < 30; sent++) expect((await bot.send(page, GOOD, BOT)).status).toBe(303);
	const refused = await bot.send(page, GOOD, BOT);

	expect(refused.status).toBe(429);
	expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(60);
	expect(Number(refused.headers.get("retry-after"))).toBeLessThanOrEqual(3600);
	await install.clock.advance(60_000);
	expect((await bot.send(page, GOOD, BOT)).status).toBe(429);
	expect((await site.kept("spam")).total).toBe(30);
});

test("posts with errors count towards what an address may send, so the page isn't rendered again without end", async () => {
	const site = await siteWithForm("errors", { perMinute: 1, perHour: 1000 });
	const bot = formVisitor(install);
	const page = await loaded(bot, site.page);

	for (let sent = 0; sent < 10; sent++) expect((await bot.send(page, { email: "nope" })).status).toBe(422);

	expect((await bot.send(page, { email: "nope" })).status).toBe(429);
	expect((await site.kept("spam")).total).toBe(0);
});

test("a post larger than a Form takes is refused, and nothing of it is kept", async () => {
	const site = await siteWithForm("large", { perMinute: 5, perHour: 30 });
	const visitor = formVisitor(install);
	const page = await loaded(visitor, site.page);

	const answer = await visitor.send(page, { email: "a".repeat(600 * 1024) });

	expect(answer.status).toBe(413);
	expectSiteHeaders(answer);
	expect((await site.kept("spam")).total).toBe(0);
	expect((await site.kept("inbox")).total).toBe(0);
});

test("a Form that takes no files takes no more in a post with files than in one without", async () => {
	const site = await siteWithForm("no-files", { perMinute: 5, perHour: 30 });
	const visitor = formVisitor(install);
	const page = await loaded(visitor, site.page);

	const answer = await visitor.send(page, GOOD, {
		files: { cv: [{ name: "cv.pdf", type: "application/pdf", bytes: PDF + "x".repeat(600 * 1024) }] },
	});

	expect(answer.status).toBe(413);
	expect((await site.kept("inbox")).total).toBe(0);
	expect((await site.kept("spam")).total).toBe(0);
	// A small one is still taken, the file it has no field for left out.
	const small = await visitor.send(page, GOOD, { files: { cv: [{ name: "cv.pdf", bytes: PDF }] } });
	expect(small.status).toBe(303);
	expect((await site.kept("inbox")).submissions[0]?.values).toEqual([
		{ key: "email", label: "Email", type: "email", value: "ada@example.com" },
	]);
});

test("a Form with a file field still takes its files", async () => {
	const site = await siteWithForm("files", { perMinute: 5, perHour: 30 }, [
		{ key: "cv", type: "file", label: "CV", accept: ["pdf"] },
	]);
	const visitor = formVisitor(install);
	const page = await loaded(visitor, site.page);

	const answer = await visitor.send(page, GOOD, {
		files: { cv: [{ name: "cv.pdf", type: "application/pdf", bytes: PDF + "x".repeat(600 * 1024) }] },
	});

	expect(answer.status).toBe(303);
	expect((await site.kept("inbox")).total).toBe(1);
});

/** A post whose body says when the web process starts reading it. */
function watchedPost(url: string, address: string) {
	let read = false;
	// Nothing is asked of the stream ahead of its reader (`highWaterMark: 0`).
	const body = new ReadableStream<Uint8Array>(
		{
			pull(controller) {
				read = true;
				controller.enqueue(new TextEncoder().encode("email=ada%40example.com"));
				controller.close();
			},
		},
		{ highWaterMark: 0 },
	);
	const request = new Request(url, {
		method: "POST",
		headers: {
			"content-type": "application/x-www-form-urlencoded",
			origin: new URL(url).origin,
			"sec-fetch-site": "same-origin",
		},
		body,
		duplex: "half",
	} as RequestInit);
	return { request: fromAddress(request, address), wasRead: () => read };
}

test("a post's body is read only once its Form is known to take posts from that address", async () => {
	const site = await siteWithForm("unread", { perMinute: 1, perHour: 1000 });
	const bot = formVisitor(install);

	// No such Form on the Site.
	const unknown = watchedPost(`${site.origin}/_webcraft/forms/00000000-0000-4000-8000-000000000000`, bot.address);
	expect((await install.request(unknown.request)).status).toBe(404);
	expect(unknown.wasRead()).toBe(false);
	// A Form that takes posts: read.
	const known = watchedPost(`${site.origin}/_webcraft/forms/${site.formId}`, bot.address);
	expect((await install.request(known.request)).status).toBe(303);
	expect(known.wasRead()).toBe(true);
	// The address past what the Form takes from it: refused unread.
	const page = await loaded(bot, site.page);
	for (let sent = 0; sent < 9; sent++) await bot.send(page, GOOD, BOT);
	const over = watchedPost(`${site.origin}/_webcraft/forms/${site.formId}`, bot.address);
	expect((await install.request(over.request)).status).toBe(429);
	expect(over.wasRead()).toBe(false);
});

test("a page's token passes the time trap for a day: a post with an older one is kept as spam", async () => {
	const site = await siteWithForm("stale", { perMinute: 5, perHour: 30 });
	const visitor = formVisitor(install);
	const page = await visitor.open(site.page);

	await install.clock.advance(23 * 60 * 60 * 1000);
	expect((await visitor.send(page, GOOD)).status).toBe(303);
	expect((await site.kept("inbox")).total).toBe(1);

	// A bot keeps the token it once copied from a page.
	await install.clock.advance(2 * 60 * 60 * 1000);
	expect((await visitor.send(page, GOOD)).status).toBe(303);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	expect((await site.kept("inbox")).total).toBe(1);
	expect((await site.kept("spam")).submissions[0]).toMatchObject({ spamReason: "token" });
	// The page loaded again gives a new one.
	const again = await visitor.open(site.page);
	await install.clock.advance(5000);
	expect((await visitor.send(again, GOOD)).status).toBe(303);
	expect((await site.kept("inbox")).total).toBe(2);
});

test("the Spam folder keeps a Site's newest 1,000, and the daily purge empties a full one after 30 days", async () => {
	const site = await siteWithForm("capped", { perMinute: 1000, perHour: 10_000 });
	const bot = formVisitor(install);
	const page = await loaded(bot, site.page);

	await bot.send(page, { email: "first@example.com" }, BOT);
	await install.clock.advance(1000);
	for (let sent = 0; sent < 1100; sent++) await bot.send(page, GOOD, BOT);
	await install.clock.advance(1000);
	await bot.send(page, { email: "last@example.com" }, BOT);

	expect((await site.kept("spam")).total).toBeLessThanOrEqual(1100);
	expect((await site.kept("spam")).total).toBeGreaterThanOrEqual(1000);
	expect((await site.kept("spam", "first@example.com")).total).toBe(0);
	expect((await site.kept("spam", "last@example.com")).total).toBe(1);
	// A person's Submission in the inbox is no part of that count.
	const person = formVisitor(install);
	await person.send(await loaded(person, site.page), GOOD);
	expect((await site.kept("inbox")).total).toBe(1);

	await install.clock.advance(31 * DAY);
	const { failed } = await install.drainJobs();
	// Weeks on, Staff sign in again.
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;

	expect(failed).toEqual([]);
	expect((await site.kept("spam")).total).toBe(0);
	expect((await site.kept("inbox")).total).toBe(1);
}, 120_000);

test("a Form's retention deletes more Submissions than one batch holds, each batch in the Audit log", async () => {
	const site = await siteWithForm("retention", { perMinute: 1000, perHour: 10_000 });
	const person = formVisitor(install);
	const page = await loaded(person, site.page);
	for (let sent = 0; sent < 520; sent++) await person.send(page, GOOD);
	expect((await site.kept("inbox")).total).toBe(520);
	await moduleApi<typeof forms>(staff, "forms").retention.set({
		siteId: site.siteId,
		formId: site.formId,
		keepDays: 30,
	});

	await install.clock.advance(31 * DAY);
	const { failed } = await install.drainJobs();
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;

	expect(failed).toEqual([]);
	expect((await site.kept("inbox")).total).toBe(0);
	const { entries } = await (await install.superadmin()).api.audit.list({
		workspaceId,
		siteId: site.siteId,
		action: "forms.submissions.purge",
	});
	expect(entries.map((entry) => (entry.details as { deleted: number }).deleted).sort((a, b) => a - b)).toEqual([
		20, 500,
	]);
}, 120_000);
