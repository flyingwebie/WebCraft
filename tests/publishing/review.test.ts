// Review (GLOSSARY.md › Review, spec stories 23 and 49): an Author submits a Draft, and an Editor,
// Owner or Staff member publishes it, schedules it or sends it back with a comment. While it waits,
// the item is In review. The Draft stays shared while it waits (ADR 0025): the reviewer acts on the
// Draft as it is then, and sees whether it changed since it was submitted.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { approveAiClient, connectMcp } from "../harness/mcp.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	// Emails go through the fake mail server, so a test counts every one.
	await (await install.superadmin()).api.install.smtp.update({
		host: "smtp.agency.example",
		port: 587,
		security: "starttls",
		username: null,
		fromAddress: "noreply@agency.example",
		replyTo: null,
	});
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId], name: "Ada Staff" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type Person = { browser: TestBrowser; email: string; personId: string; name: string };

type TestSite = {
	siteId: string;
	postTypeId: string;
	author: Person;
	editor: Person;
};

/** A Site with a Blog Post Type (`/blog/{slug}`) and its published Entry template, an Author and an Editor. */
async function newSite(): Promise<TestSite> {
	const number = ++sites;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: `review-${number}` })).id;
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
	const member = async (role: "author" | "editor", name: string): Promise<Person> => {
		const created = await install.createMember({ workspaceId, role, sites: [siteId], name });
		return { browser: created.browser, email: created.account.email, personId: created.personId, name };
	};
	return {
		siteId,
		postTypeId: postType.id,
		author: await member("author", `Ann Author ${number}`),
		editor: await member("editor", `Eve Editor ${number}`),
	};
}

async function draftEntry(site: TestSite, title: string) {
	const { entry } = await site.author.browser.api.entries.create({
		siteId: site.siteId,
		postTypeId: site.postTypeId,
		title,
	});
	return entry;
}

describe("submitting", () => {
	test("an Author submits an Entry with a note: it shows In review to everyone who sees the Site", async () => {
		const site = await newSite();
		const entry = await draftEntry(site, "Spring menu");

		const { reviews } = await site.author.browser.api.reviews.submit({
			siteId: site.siteId,
			items: [{ kind: "entry", id: entry.id }],
			note: "Ready for Friday's newsletter.",
		});
		expect(reviews).toMatchObject([
			{
				item: { kind: "entry", id: entry.id },
				name: "Spring menu",
				status: "inReview",
				submittedBy: { id: site.author.personId, name: site.author.name, via: null },
				note: "Ready for Friday's newsletter.",
				changedSinceSubmitted: false,
				canAct: false,
				canWithdraw: true,
			},
		]);

		const seen = await site.editor.browser.api.entries.get({ siteId: site.siteId, entryId: entry.id });
		expect(seen.entry.review).toMatchObject({
			status: "inReview",
			submittedBy: { id: site.author.personId },
			note: "Ready for Friday's newsletter.",
			canAct: true,
			canWithdraw: false,
		});
		const listed = await site.editor.browser.api.entries.list({ siteId: site.siteId, postTypeId: site.postTypeId });
		expect(listed.entries.map((each) => each.review?.status)).toEqual(["inReview"]);
		const waiting = await staff.api.reviews.list({ siteId: site.siteId });
		expect(waiting.reviews).toMatchObject([
			{ item: { kind: "entry", id: entry.id }, name: "Spring menu", canAct: true, canWithdraw: false },
		]);
	});
});

describe("who hears of it", () => {
	test("the Editors and Owners who reach the Site get one email each, in their Admin language, linking to the item", async () => {
		const site = await newSite();
		const owner = await install.createMember({ workspaceId, role: "owner", name: "Olga Owner" });
		await owner.browser.api.me.updatePreferences({ adminLanguage: "it" });
		const otherSite = (await install.createSite(workspaceId, { name: "Other", slug: `review-other-${sites}` })).id;
		const elsewhere = await install.createMember({ workspaceId, role: "editor", sites: [otherSite] });
		const anotherAuthor = await install.createMember({ workspaceId, role: "author", sites: [site.siteId] });
		const entry = await draftEntry(site, "Spring menu");
		install.mail.clear();

		await site.author.browser.api.reviews.submit({
			siteId: site.siteId,
			items: [{ kind: "entry", id: entry.id }],
			note: "Please check the prices.",
		});
		await install.drainJobs();

		const editorEmail = install.mail.sent.filter((email) => email.to === site.editor.email);
		expect(editorEmail).toHaveLength(1);
		expect(editorEmail[0]?.subject).toBe(`${site.author.name} submitted “Spring menu” for review`);
		expect(editorEmail[0]?.text).toContain("Please check the prices.");
		expect(editorEmail[0]?.text).toContain(`/sites/${site.siteId}/entries/${site.postTypeId}/${entry.id}`);
		const ownerEmail = install.mail.sent.filter((email) => email.to === owner.account.email);
		expect(ownerEmail.map((email) => email.subject)).toEqual([
			`${site.author.name} ha inviato “Spring menu” in revisione`,
		]);
		const told = install.mail.sent.map((email) => email.to);
		for (const left of [site.author.email, elsewhere.account.email, anotherAuthor.account.email]) {
			expect(told).not.toContain(left);
		}
		// The agency isn't emailed while the client has people who may publish; it sees the list.
		expect(told.filter((address) => address.endsWith("@agency.example"))).toEqual([]);

		expect(await site.editor.browser.api.reviews.count({ siteId: site.siteId })).toEqual({ count: 1 });
		expect(await staff.api.reviews.count({ siteId: site.siteId })).toEqual({ count: 1 });
		expect(await site.author.browser.api.reviews.count({ siteId: site.siteId })).toEqual({ count: 0 });
		expect((await site.author.browser.api.reviews.list({ siteId: site.siteId })).reviews).toHaveLength(1);
	});

	test("on a Site where no Member may publish, the Staff who reach it are emailed", async () => {
		const quietWorkspace = (await install.createWorkspace("Quiet Ltd")).id;
		const siteId = (await install.createSite(quietWorkspace, { name: "Quiet", slug: `review-quiet-${++sites}` })).id;
		const agency = await install.createStaff({ workspaces: [quietWorkspace], name: "Sam Staff" });
		const author = await install.createMember({
			workspaceId: quietWorkspace,
			role: "author",
			sites: [siteId],
			name: "Al Author",
		});
		const pagesId = (await agency.browser.api.postTypes.list({ siteId })).postTypes.find(
			(type) => type.builtIn === "page",
		)?.id as string;
		const { entry } = await author.browser.api.entries.create({ siteId, postTypeId: pagesId, title: "About us" });
		install.mail.clear();

		await author.browser.api.reviews.submit({ siteId, items: [{ kind: "entry", id: entry.id }] });
		await install.drainJobs();

		expect(install.mail.sent.map((email) => [email.to, email.subject])).toEqual([
			[agency.account.email, "Al Author submitted “About us” for review"],
		]);
	});
});

const MINUTE = 60_000;

/** The Site's Audit log entries, newest first. */
async function auditOf(siteId: string) {
	const { entries } = await (await install.superadmin()).api.audit.list({ limit: 200 });
	return entries.filter((entry) => entry.siteId === siteId);
}

/** What a visitor gets at a path of a live Site: the status and the page's heading, if any. */
async function visit(live: string, path: string): Promise<{ status: number; heading: string | null }> {
	const response = await install.request(`${live}${path}`);
	const html = await response.text();
	return { status: response.status, heading: /<h1>([^<]*)<\/h1>/.exec(html)?.[1] ?? null };
}

/** An Entry the Author wrote and submitted for Review; answers the Entry and its Review. */
async function submitted(site: TestSite, title: string, note?: string) {
	const entry = await draftEntry(site, title);
	const { reviews } = await site.author.browser.api.reviews.submit({
		siteId: site.siteId,
		items: [{ kind: "entry", id: entry.id }],
		note,
	});
	const [review] = reviews;
	if (!review) throw new Error("Nothing was submitted.");
	return { entry, review };
}

/** The emails that went to an address since the mail was last cleared. */
async function emailsTo(address: string) {
	await install.drainJobs();
	return install.mail.sent.filter((email) => email.to === address);
}

describe("acting on it", () => {
	test("an Editor publishes it as they publish anything: it goes live, its Review ends and its Author is emailed", async () => {
		const site = await newSite();
		const live = await goLive(install, site.siteId);
		const { entry, review } = await submitted(site, "Spring menu");
		install.mail.clear();

		await site.editor.browser.api.entries.publish({ siteId: site.siteId, entryId: entry.id });

		expect(await visit(live, "/blog/spring-menu")).toEqual({ status: 200, heading: "Spring menu" });
		const after = await site.author.browser.api.entries.get({ siteId: site.siteId, entryId: entry.id });
		expect(after.entry.review).toBeNull();
		expect((await site.editor.browser.api.reviews.list({ siteId: site.siteId })).reviews).toEqual([]);
		expect(
			(await site.author.browser.api.reviews.get({ siteId: site.siteId, reviewId: review.id })).review,
		).toMatchObject({
			status: "published",
			decidedBy: { id: site.editor.personId, name: site.editor.name },
			canWithdraw: false,
		});
		const [email] = await emailsTo(site.author.email);
		expect(email?.subject).toBe("“Spring menu” was published");
		expect(email?.text).toContain(`${site.editor.name} published “Spring menu” on Acme Bakery.`);
		expect(email?.text).toContain(`/sites/${site.siteId}/entries/${site.postTypeId}/${entry.id}`);
		const actions = (await auditOf(site.siteId)).map((each) => each.action);
		expect(actions.slice(0, 3)).toEqual(["review.publish", "entry.publish", "review.submit"]);
	});

	test("Publish all ends the Reviews of what it publishes, and so does Staff publishing", async () => {
		const site = await newSite();
		const first = await submitted(site, "First");
		const second = await submitted(site, "Second");
		const items = [{ kind: "entry" as const, id: first.entry.id }];
		const preview = await site.editor.browser.api.publishing.publishAll({ siteId: site.siteId, items });
		if (!("confirmation" in preview)) throw new Error("Published without a preview.");
		await site.editor.browser.api.publishing.publishAll({
			siteId: site.siteId,
			items,
			confirmation: preview.confirmation.id,
		});
		await staff.api.entries.publish({ siteId: site.siteId, entryId: second.entry.id });

		const statuses = await Promise.all(
			[first, second].map(
				async ({ review }) => (await staff.api.reviews.get({ siteId: site.siteId, reviewId: review.id })).review.status,
			),
		);
		expect(statuses).toEqual(["published", "published"]);
		expect((await emailsTo(site.author.email)).map((email) => email.subject)).toEqual(
			expect.arrayContaining(["“First” was published", "“Second” was published"]),
		);
	});

	test("an Editor schedules it: its Author is told when it goes live, and it goes live then", async () => {
		const site = await newSite();
		const live = await goLive(install, site.siteId);
		const { entry, review } = await submitted(site, "Summer menu");
		install.mail.clear();
		const at = new Date(install.clock.now().getTime() + 90 * MINUTE);

		await site.editor.browser.api.publishing.schedule({
			siteId: site.siteId,
			item: { kind: "entry", id: entry.id },
			at,
		});

		expect(
			(await site.author.browser.api.reviews.get({ siteId: site.siteId, reviewId: review.id })).review,
		).toMatchObject({ status: "scheduled", scheduledAt: at, decidedBy: { id: site.editor.personId } });
		const [email] = await emailsTo(site.author.email);
		expect(email?.subject).toBe("“Summer menu” is scheduled to be published");
		expect(email?.text).toContain("to be published at 2026-03-02 10:30 UTC");
		await install.clock.advance(90 * MINUTE);
		await install.drainJobs();
		expect(await visit(live, "/blog/summer-menu")).toEqual({ status: 200, heading: "Summer menu" });
		expect(await emailsTo(site.author.email)).toHaveLength(1);
		expect((await auditOf(site.siteId)).map((each) => each.action)).toContain("review.schedule");
	});

	test("sending back needs a comment, which its Author is emailed and sees until they submit it again", async () => {
		const site = await newSite();
		const { entry, review } = await submitted(site, "Autumn menu");
		install.mail.clear();
		await expect(
			site.editor.browser.api.reviews.sendBack({ siteId: site.siteId, reviewId: review.id, comment: "   " }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			site.author.browser.api.reviews.sendBack({ siteId: site.siteId, reviewId: review.id, comment: "Fine." }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const { review: sentBack } = await site.editor.browser.api.reviews.sendBack({
			siteId: site.siteId,
			reviewId: review.id,
			comment: "The prices are last year's.",
		});
		expect(sentBack).toMatchObject({ status: "sentBack", comment: "The prices are last year's." });

		const [email] = await emailsTo(site.author.email);
		expect(email?.subject).toBe("“Autumn menu” was sent back");
		expect(email?.text).toContain("Their comment: The prices are last year's.");
		const shown = await site.author.browser.api.entries.get({ siteId: site.siteId, entryId: entry.id });
		expect(shown.entry.review).toMatchObject({
			status: "sentBack",
			comment: "The prices are last year's.",
			decidedBy: { name: site.editor.name },
		});
		expect(shown.entry.status).toBe("draft");
		await expect(
			site.editor.browser.api.entries
				.publish({ siteId: site.siteId, entryId: entry.id })
				.then(() =>
					site.editor.browser.api.reviews.sendBack({ siteId: site.siteId, reviewId: review.id, comment: "Again." }),
				),
		).rejects.toMatchObject({ code: "REVIEW_DECIDED", data: { status: "sentBack" } });
		// Published since: the comment no longer shows.
		const published = await site.author.browser.api.entries.get({ siteId: site.siteId, entryId: entry.id });
		expect(published.entry.review).toBeNull();
		expect((await auditOf(site.siteId)).find((each) => each.action === "review.sendBack")).toMatchObject({
			personId: site.editor.personId,
			details: { reviewId: review.id, comment: "The prices are last year's." },
		});
	});

	test("submitted again after being sent back, the comment gives way to the new Review", async () => {
		const site = await newSite();
		const { entry, review } = await submitted(site, "Winter menu");
		await site.editor.browser.api.reviews.sendBack({
			siteId: site.siteId,
			reviewId: review.id,
			comment: "Add prices.",
		});
		await site.author.browser.api.entries.saveDraft({
			siteId: site.siteId,
			entryId: entry.id,
			title: "Winter menu, priced",
		});

		const again = await site.author.browser.api.reviews.submit({
			siteId: site.siteId,
			items: [{ kind: "entry", id: entry.id }],
			note: "Prices added.",
		});
		const shown = await site.author.browser.api.entries.get({ siteId: site.siteId, entryId: entry.id });
		expect(shown.entry.review).toMatchObject({
			id: again.reviews[0]?.id,
			status: "inReview",
			comment: null,
			note: "Prices added.",
		});
	});
});

describe("when the Scheduled publish it waited in disappears without publishing it", () => {
	test('cancelling it: the item waits for a reviewer again, not stuck "Scheduled" for a time that will never come', async () => {
		const site = await newSite();
		const { entry, review } = await submitted(site, "Summer menu");
		const at = new Date(install.clock.now().getTime() + 90 * MINUTE);
		const { scheduled } = await site.editor.browser.api.publishing.schedule({
			siteId: site.siteId,
			item: { kind: "entry", id: entry.id },
			at,
		});
		expect(
			(await site.author.browser.api.reviews.get({ siteId: site.siteId, reviewId: review.id })).review,
		).toMatchObject({ status: "scheduled", scheduledAt: at });
		await install.drainJobs();
		install.mail.clear();

		await site.editor.browser.api.publishing.cancelScheduled({ siteId: site.siteId, scheduleId: scheduled.id });

		expect(
			(await site.author.browser.api.reviews.get({ siteId: site.siteId, reviewId: review.id })).review,
		).toMatchObject({
			status: "inReview",
			scheduledAt: null,
			decidedBy: null,
			decidedAt: null,
			canWithdraw: true,
		});
		expect((await site.editor.browser.api.reviews.list({ siteId: site.siteId })).reviews).toMatchObject([
			{ item: { kind: "entry", id: entry.id }, status: "inReview", canAct: true },
		]);
		expect((await auditOf(site.siteId)).find((each) => each.action === "review.reopen")).toMatchObject({
			personId: site.editor.personId,
			details: { reviewId: review.id, scheduleId: scheduled.id, reason: "cancelled" },
		});
		// Nothing was decided: the Author isn't told it is no longer scheduled.
		expect(await emailsTo(site.author.email)).toEqual([]);
	});

	test("a run that fails: nothing of it was published, so its Review waits again too", async () => {
		const site = await newSite();
		const { entry, review } = await submitted(site, "Winter sale");
		const at = new Date(install.clock.now().getTime() + 60 * MINUTE);
		const { scheduled } = await site.editor.browser.api.publishing.schedule({
			siteId: site.siteId,
			item: { kind: "entry", id: entry.id },
			at,
		});
		// Breaks the frozen Draft at run time without touching it: a required Field it never had.
		await staff.api.postTypes.update({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			fields: [{ key: "price", label: "Price", type: "text", required: true }],
		});
		await install.drainJobs();
		install.mail.clear();

		await install.clock.advance(60 * MINUTE);
		await install.drainJobs();

		expect((await site.editor.browser.api.publishing.scheduled({ siteId: site.siteId })).scheduled).toEqual([]);
		expect(
			(await site.author.browser.api.reviews.get({ siteId: site.siteId, reviewId: review.id })).review,
		).toMatchObject({ status: "inReview", scheduledAt: null, decidedBy: null });
		expect((await staff.api.reviews.list({ siteId: site.siteId })).reviews).toMatchObject([
			{ item: { kind: "entry", id: entry.id }, status: "inReview" },
		]);
		expect((await auditOf(site.siteId)).find((each) => each.action === "review.reopen")).toMatchObject({
			details: { reviewId: review.id, scheduleId: scheduled.id, reason: "failed" },
		});
		const [failEmail] = await emailsTo(site.editor.email);
		expect(failEmail?.subject).toContain("wasn't published as scheduled");
	});
});

describe("withdrawing", () => {
	test("its Author withdraws it while it waits; nobody else can, and nobody is emailed", async () => {
		const site = await newSite();
		const { entry, review } = await submitted(site, "Pie");
		const otherAuthor = await install.createMember({ workspaceId, role: "author", sites: [site.siteId] });
		install.mail.clear();
		await expect(
			otherAuthor.browser.api.reviews.withdraw({ siteId: site.siteId, reviewId: review.id }),
		).rejects.toMatchObject({ code: "REVIEW_NOT_YOURS" });
		await expect(
			site.editor.browser.api.reviews.withdraw({ siteId: site.siteId, reviewId: review.id }),
		).rejects.toMatchObject({ code: "REVIEW_NOT_YOURS" });

		const { review: withdrawn } = await site.author.browser.api.reviews.withdraw({
			siteId: site.siteId,
			reviewId: review.id,
		});
		expect(withdrawn).toMatchObject({ status: "withdrawn", decidedBy: { id: site.author.personId } });
		expect(
			(await site.editor.browser.api.entries.get({ siteId: site.siteId, entryId: entry.id })).entry.review,
		).toBeNull();
		expect((await site.editor.browser.api.reviews.list({ siteId: site.siteId })).reviews).toEqual([]);
		await expect(
			site.author.browser.api.reviews.withdraw({ siteId: site.siteId, reviewId: review.id }),
		).rejects.toMatchObject({ code: "REVIEW_DECIDED", data: { status: "withdrawn" } });
		await expect(
			site.editor.browser.api.reviews.sendBack({ siteId: site.siteId, reviewId: review.id, comment: "Late." }),
		).rejects.toMatchObject({ code: "REVIEW_DECIDED" });
		await install.drainJobs();
		expect(install.mail.sent).toEqual([]);
		expect((await auditOf(site.siteId)).find((each) => each.action === "review.withdraw")).toMatchObject({
			personId: site.author.personId,
			details: { reviewId: review.id, item: { kind: "entry", id: entry.id }, name: "Pie" },
		});
	});
});

describe("while it waits", () => {
	test("its Draft stays shared: the reviewer sees it changed since it was submitted, and history keeps what was", async () => {
		const site = await newSite();
		const live = await goLive(install, site.siteId);
		const { entry, review } = await submitted(site, "Bread");
		await site.author.browser.api.entries.saveDraft({
			siteId: site.siteId,
			entryId: entry.id,
			title: "Bread and butter",
		});

		const [waiting] = (await site.editor.browser.api.reviews.list({ siteId: site.siteId })).reviews;
		expect(waiting).toMatchObject({ id: review.id, name: "Bread and butter", changedSinceSubmitted: true });
		const { copies } = await site.editor.browser.api.history.list({
			siteId: site.siteId,
			item: { kind: "entry", id: entry.id },
		});
		const kept = copies.find((copy) => copy.reason === "review");
		expect(kept).toMatchObject({ type: "checkpoint" });
		const { content } = await site.editor.browser.api.history.get({
			siteId: site.siteId,
			item: { kind: "entry", id: entry.id },
			copy: { type: "checkpoint", id: kept?.id as string },
		});
		expect(JSON.stringify(content)).toContain("Bread");
		expect(JSON.stringify(content)).not.toContain("butter");

		// Whoever acts on it publishes the Draft as it is then, what they see.
		await site.editor.browser.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
		expect((await visit(live, "/blog/bread")).heading).toBe("Bread and butter");
	});
});

describe("what can be submitted", () => {
	test("a Draft with changes that could be published, once at a time", async () => {
		const site = await newSite();
		const entry = await draftEntry(site, "Scones");
		const item = { kind: "entry" as const, id: entry.id };
		await site.author.browser.api.reviews.submit({ siteId: site.siteId, items: [item] });
		await expect(site.author.browser.api.reviews.submit({ siteId: site.siteId, items: [item] })).rejects.toMatchObject({
			code: "ALREADY_IN_REVIEW",
			data: { item },
		});
		await site.editor.browser.api.entries.publish({ siteId: site.siteId, entryId: entry.id });
		await expect(site.author.browser.api.reviews.submit({ siteId: site.siteId, items: [item] })).rejects.toMatchObject({
			code: "REVIEW_INVALID",
			data: { reason: "nothingToReview", item },
		});

		await staff.api.postTypes.update({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			fields: [{ key: "price", label: "Price", type: "text", required: true }],
		});
		const unpriced = await draftEntry(site, "Muffins");
		await expect(
			site.author.browser.api.reviews.submit({ siteId: site.siteId, items: [{ kind: "entry", id: unpriced.id }] }),
		).rejects.toMatchObject({ code: "ENTRY_INCOMPLETE", data: { missing: ["price"] } });
		await expect(
			site.author.browser.api.reviews.submit({
				siteId: site.siteId,
				items: [{ kind: "template", id: entry.id } as never],
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect((await site.editor.browser.api.reviews.list({ siteId: site.siteId })).reviews).toEqual([]);
	});

	test("the Globals are reviewed as Entries are", async () => {
		const site = await newSite();
		await staff.api.globals.setFields({
			siteId: site.siteId,
			fields: [{ key: "phone", label: "Phone", type: "text" }],
		});
		await site.author.browser.api.globals.saveDraft({ siteId: site.siteId, fields: { phone: "01 234 5678" } });
		install.mail.clear();

		const { reviews } = await site.author.browser.api.reviews.submit({
			siteId: site.siteId,
			items: [{ kind: "globals" }],
		});
		expect(reviews).toMatchObject([{ item: { kind: "globals" }, name: null, status: "inReview" }]);
		expect((await site.editor.browser.api.globals.get({ siteId: site.siteId })).globals.review).toMatchObject({
			status: "inReview",
			canAct: true,
		});
		const [asked] = await emailsTo(site.editor.email);
		expect(asked?.subject).toBe(`${site.author.name} submitted the Globals for review`);
		expect(asked?.text).toContain(`/sites/${site.siteId}/globals`);

		await site.editor.browser.api.globals.publish({ siteId: site.siteId });
		const [told] = await emailsTo(site.author.email);
		expect(told?.subject).toBe("The Globals were published");
		expect((await site.author.browser.api.globals.get({ siteId: site.siteId })).globals.review).toBeNull();
	});
});

describe("Authors never publish", () => {
	test("not their own item In review, by any way in: the admin, Publish all, scheduling, Edit mode, a token or an AI client", async () => {
		const site = await newSite();
		await goLive(install, site.siteId);
		const { entry } = await submitted(site, "Mine");
		const item = { kind: "entry" as const, id: entry.id };
		const author = site.author.browser.api;
		const forbidden = { code: "FORBIDDEN" };

		await expect(author.entries.publish({ siteId: site.siteId, entryId: entry.id })).rejects.toMatchObject(forbidden);
		await expect(author.publishing.publishAll({ siteId: site.siteId, items: [item] })).rejects.toMatchObject(forbidden);
		const at = new Date(install.clock.now().getTime() + 60 * MINUTE);
		await expect(author.publishing.schedule({ siteId: site.siteId, item, at })).rejects.toMatchObject(forbidden);
		await expect(author.publishing.scheduleAll({ siteId: site.siteId, items: [item], at })).rejects.toMatchObject(
			forbidden,
		);
		await expect(author.globals.publish({ siteId: site.siteId })).rejects.toMatchObject(forbidden);
		const reviewId = (await author.reviews.list({ siteId: site.siteId })).reviews[0]?.id as string;
		await expect(author.reviews.sendBack({ siteId: site.siteId, reviewId, comment: "Mine." })).rejects.toMatchObject(
			forbidden,
		);

		const editing = await openEditMode(install, site.author.browser, site.siteId, "/blog/mine");
		const fromEditMode = await editing.edit("publish", { path: "/blog/mine" });
		expect(fromEditMode.status).toBe(403);

		const { secret } = await createApiToken(site.author.browser, { workspaceId, name: "Author's script" });
		const script = tokenClient(install, secret);
		await expect(script.api.entries.publish({ siteId: site.siteId, entryId: entry.id })).rejects.toMatchObject(
			forbidden,
		);

		const client = await approveAiClient(install, site.author.browser, { workspaceId, mayPublish: true });
		const mcp = await connectMcp(install, client.accessToken);
		const tools = (await mcp.listTools()).tools.map((tool) => tool.name);
		await mcp.close();
		expect(tools).toEqual(expect.arrayContaining(["reviews_submit", "reviews_withdraw", "reviews_list"]));
		for (const publishing of [
			"entries_publish",
			"publishing_publish_all",
			"publishing_schedule",
			"reviews_send_back",
		]) {
			expect(tools).not.toContain(publishing);
		}

		const { entry: after } = await site.editor.browser.api.entries.get({ siteId: site.siteId, entryId: entry.id });
		expect(after).toMatchObject({ status: "draft", published: null, review: { status: "inReview" } });
	});
});

describe("API clients", () => {
	test("a script submits through its token, and the Review says so; an Editor's AI client sends back without May publish", async () => {
		const site = await newSite();
		const entry = await draftEntry(site, "Scripted");
		const { secret } = await createApiToken(site.author.browser, { workspaceId, name: "Import script" });
		const script = tokenClient(install, secret);

		const { reviews } = await script.api.reviews.submit({
			siteId: site.siteId,
			items: [{ kind: "entry", id: entry.id }],
		});
		expect(reviews[0]).toMatchObject({ submittedBy: { id: site.author.personId, via: "Import script" } });

		const client = await approveAiClient(install, site.editor.browser, { workspaceId, mayPublish: false });
		const mcp = await connectMcp(install, client.accessToken);
		const tools = (await mcp.listTools()).tools.map((tool) => tool.name);
		expect(tools).toContain("reviews_send_back");
		expect(tools).not.toContain("entries_publish");
		await mcp.close();
	});
});
