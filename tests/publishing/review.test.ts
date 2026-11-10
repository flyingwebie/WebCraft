// Review (GLOSSARY.md › Review, spec stories 23 and 49): an Author submits a Draft, and an Editor,
// Owner or Staff member publishes it, schedules it or sends it back with a comment. While it waits,
// the item is In review. The Draft stays shared while it waits (ADR 0025): the reviewer acts on the
// Draft as it is then, and sees whether it changed since it was submitted.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

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
