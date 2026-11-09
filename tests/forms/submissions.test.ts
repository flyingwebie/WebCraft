// Working through Submissions (spec story 102), in the Forms Module: the inbox and the Spam folder,
// search, read and unread, each Submission with its delivery log, Not spam (which sends what a kept
// Submission sends), deleting in two steps, CSV export, and how long each Form keeps them. Authors
// never see them.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import forms from "@webcraft/module-forms";

import { formVisitor } from "../harness/forms.ts";
import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { confirmed } from "../webhooks/support.ts";

const DAY = 24 * 60 * 60 * 1000;
const PAGE = "https://bakery.sites.test/contact/form";

let install: TestInstall;
let staff: TestBrowser;
let staffAccount: TestAccount;
let owner: TestBrowser;
let ownerAccount: TestAccount;
let editor: TestBrowser;
let author: TestBrowser;
let siteId: string;
let formId: string;

/** The Forms Module's procedures, as a person calls them. */
const submissions = (browser: TestBrowser) => moduleApi<typeof forms>(browser, "forms");

/** Sends the Form from its page as a visitor, and runs the jobs that follow. */
async function submit(
	fields: Record<string, string | readonly string[]>,
	options: { url?: string; spam?: boolean } = {},
): Promise<void> {
	const visitor = formVisitor(install);
	const page = await visitor.open(options.url ?? PAGE);
	await install.clock.advance(5_000);
	const sent = await visitor.send(
		page,
		{ consent: "yes", ...fields },
		{
			hidden: options.spam ? { "wc-website": "https://spam.example" } : {},
		},
	);
	expect(sent.status).toBe(303);
	await install.drainJobs();
}

/** The fields of every Form here. */
const FIELDS = [
	{ key: "name", type: "text", label: "Your name", required: true },
	{ key: "email", type: "email", label: "Email", required: true },
	{ key: "message", type: "textarea", label: "Message" },
	{ key: "consent", type: "consent", label: "I agree to be contacted", required: true },
];

/** The emails of every Form here: a Notification to the bakery, and an Auto-reply. */
const EMAILS = {
	notifications: [{ recipients: ["orders@acmebakery.example"], routing: null, subject: "", intro: "" }],
	autoReply: { enabled: true, field: null, subject: "Thanks", text: "We'll be in touch." },
};

/**
 * A new published Form with these fields and emails, keyed `key`, placed on a page of its own:
 * `/<key>/form` (and `/it/<key>/form`).
 */
async function newForm(name: string, key: string): Promise<{ formId: string; page: string }> {
	const { form } = await staff.api.forms.create({ siteId, name, key });
	await staff.api.forms.saveDraft({ siteId, formId: form.id, form: { fields: FIELDS } });
	await staff.api.forms.publish({ siteId, formId: form.id });
	await owner.api.forms.saveEmails({ siteId, formId: form.id, emails: EMAILS });
	await owner.api.forms.publishEmails({ siteId, formId: form.id });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: `Pages of ${name}`,
		urlPattern: `/${key}/{slug}`,
	});
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<section data-wc-id="s1">{{@form ${key}}}</section>`,
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: name, slug: "form" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	return { formId: form.id, page: `https://bakery.sites.test/${key}/form` };
}

beforeAll(async () => {
	install = await createTestInstall();
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "forms", version: forms.manifest.version });
	await admin.api.install.smtp.update({
		host: "smtp.agency.example",
		port: 587,
		security: "starttls",
		username: null,
		fromAddress: "noreply@agency.example",
		replyTo: null,
	});
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const created = await install.createStaff({ workspaces: [workspaceId] });
	staff = created.browser;
	staffAccount = created.account;
	const createdOwner = await install.createMember({ workspaceId, role: "owner" });
	owner = createdOwner.browser;
	ownerAccount = createdOwner.account;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	await staff.api.languages.add({ siteId, code: "it" });
	formId = (await newForm("Contact", "contact")).formId;
});

afterAll(async () => {
	await install.close();
});

beforeEach(() => {
	install.mail.clear();
	install.mail.accept();
});

describe("the inbox", () => {
	test("lists a Form's Submissions newest first, each unread until someone marks it read", async () => {
		const form = await newForm("Inbox", "inbox");
		const visitor = formVisitor(install);
		for (const name of ["Siobhán", "Luca", "Hannah"]) {
			const page = await visitor.open(form.page);
			await install.clock.advance(5_000);
			await visitor.send(page, { name, email: `${name.toLowerCase()}@example.ie`, consent: "yes" });
		}

		const listed = await submissions(owner).submissions.list({ siteId, formId: form.formId });
		expect(listed.submissions.map((one) => one.values[0]?.value)).toEqual(["Hannah", "Luca", "Siobhán"]);
		expect(listed.submissions.every((one) => one.read === false)).toBe(true);
		expect(listed).toMatchObject({ total: 3, counts: { inbox: 3, spam: 0, unread: 3 }, keepDays: null });

		const [newest] = listed.submissions;
		if (!newest) throw new Error("Nothing was kept.");
		await submissions(owner).submissions.setRead({ siteId, ids: [newest.id], read: true });
		const after = await submissions(owner).submissions.list({ siteId, formId: form.formId, read: "unread" });
		expect(after.submissions.map((one) => one.values[0]?.value)).toEqual(["Luca", "Siobhán"]);
		expect(after.counts.unread).toBe(2);
		const read = await submissions(owner).submissions.list({ siteId, formId: form.formId, read: "read" });
		expect(read.submissions.map((one) => one.id)).toEqual([newest.id]);
	});

	test("search finds Submissions by what was sent, in any case; its wildcards are plain text", async () => {
		const form = await newForm("Search", "search");
		const visitor = formVisitor(install);
		for (const message of ["Lemon and elderflower", "Chocolate, 100% cocoa", "Plain sponge"]) {
			const page = await visitor.open(form.page);
			await install.clock.advance(5_000);
			await visitor.send(page, { name: "Ada", email: "ada@example.ie", message, consent: "yes" });
		}
		const search = (text: string) =>
			submissions(editor).submissions.list({ siteId, formId: form.formId, search: text });

		expect((await search("LEMON")).submissions.map((one) => one.values[2]?.value)).toEqual(["Lemon and elderflower"]);
		expect((await search("100%")).total).toBe(1);
		expect((await search("%")).total).toBe(1);
		expect((await search("_")).total).toBe(0);
		expect((await search("ada@example")).total).toBe(3);
	});

	test("pages: a few at a time, with how many there are in all", async () => {
		const form = await newForm("Pages", "pages");
		for (let n = 1; n <= 5; n++) {
			const visitor = formVisitor(install);
			const page = await visitor.open(form.page);
			await install.clock.advance(5_000);
			await visitor.send(page, { name: `Visitor ${n}`, email: `v${n}@example.ie`, consent: "yes" });
		}

		const second = await submissions(owner).submissions.list({ siteId, formId: form.formId, limit: 2, offset: 2 });
		expect(second.total).toBe(5);
		expect(second.submissions.map((one) => one.values[0]?.value)).toEqual(["Visitor 3", "Visitor 2"]);
	});

	test("filters by the language the visitor used", async () => {
		const form = await newForm("Languages", "languages");
		const visitor = formVisitor(install);
		const english = await visitor.open(form.page);
		await install.clock.advance(5_000);
		await visitor.send(english, { name: "Emma", email: "emma@example.ie", consent: "yes" });
		const italian = await visitor.open(form.page.replace("bakery.sites.test/", "bakery.sites.test/it/"));
		await install.clock.advance(5_000);
		await visitor.send(italian, { name: "Giorgia", email: "giorgia@example.it", consent: "yes" });

		const listed = await submissions(owner).submissions.list({ siteId, formId: form.formId, language: "it" });
		expect(listed.submissions.map((one) => [one.values[0]?.value, one.language])).toEqual([["Giorgia", "it"]]);
	});

	test("Authors never see Submissions; the admin learns who may from the Site's Module Permissions", async () => {
		await expect(submissions(author).submissions.list({ siteId, formId })).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect((await author.api.sites.get({ siteId })).modulePermissions).toEqual([]);
		expect((await editor.api.sites.get({ siteId })).modulePermissions).toEqual([
			"forms.submissions.view",
			"forms.submissions.manage",
		]);
	});
});

describe("a Submission", () => {
	test("shows its values and its delivery log: each email and Webhook call, and why one failed", async () => {
		install.dns.answer("hooks.crm.example", ["93.184.216.34"]);
		const url = "https://hooks.crm.example/leads";
		install.http.respond("POST", url, { status: 503, body: "Down for maintenance" });
		const { webhook } = await confirmed(staff, staffAccount, () =>
			staff.api.webhooks.add({ siteId, url, name: "CRM", events: ["formSubmitted"] }),
		);
		try {
			await submit({ name: "Niamh", email: "niamh@example.ie", message: "Hello" });

			const [kept] = (await submissions(owner).submissions.list({ siteId, formId, limit: 1 })).submissions;
			if (!kept) throw new Error("Nothing was kept.");
			const { submission, deliveries } = await submissions(owner).submissions.get({ siteId, id: kept.id });
			expect(submission).toMatchObject({ formId, formName: "Contact", language: "en", page: "/contact/form" });
			expect(submission.values).toContainEqual({ key: "message", label: "Message", type: "textarea", value: "Hello" });
			expect(deliveries).toEqual([
				expect.objectContaining({
					kind: "notification",
					to: "orders@acmebakery.example",
					status: "sent",
					problem: null,
				}),
				expect.objectContaining({ kind: "autoReply", to: "niamh@example.ie", status: "sent" }),
				expect.objectContaining({
					kind: "webhook",
					to: "CRM",
					status: "retrying",
					attempts: 1,
					problem: "503",
					nextAttemptAt: new Date(install.clock.now().getTime() + 60_000),
				}),
			]);
		} finally {
			await confirmed(staff, staffAccount, () =>
				staff.api.webhooks.setEnabled({ siteId, webhookId: webhook.id, enabled: false }),
			);
		}
	});

	test("a Submission of another Site is never found", async () => {
		await expect(
			submissions(owner).submissions.get({ siteId, id: "00000000-0000-4000-8000-000000000000" }),
		).rejects.toMatchObject({ code: "MODULE_ERROR", data: { code: "submission-not-found" } });
	});
});

describe("the Spam folder", () => {
	test("Not spam moves it to the inbox and sends what a kept Submission sends; it is logged", async () => {
		await submit({ name: "Paul", email: "paul@example.de", message: "Not a robot" }, { spam: true });
		expect(install.mail.sent).toEqual([]);
		const [spam] = (await submissions(owner).submissions.list({ siteId, formId, folder: "spam" })).submissions;
		if (!spam) throw new Error("Nothing went to the Spam folder.");
		expect(spam).toMatchObject({ folder: "spam", spamReason: "honeypot" });

		const { submission } = await submissions(owner).submissions.notSpam({ siteId, id: spam.id });
		await install.drainJobs();

		expect(submission).toMatchObject({ id: spam.id, folder: "inbox", spamReason: null, read: false });
		expect(install.mail.sent.map((email) => email.to).sort()).toEqual(["orders@acmebakery.example", "paul@example.de"]);
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 1 });
		expect(entries[0]).toMatchObject({
			action: "forms.submissions.notSpam",
			siteId,
			via: { kind: "admin" },
			details: { submissionId: spam.id, formId },
		});
	});

	test("taken out a day later, its Notifications go but its Auto-reply doesn't: the visitor isn't thanked late", async () => {
		await submit({ name: "Late", email: "late@example.ie" }, { spam: true });
		const [spam] = (await submissions(owner).submissions.list({ siteId, formId, folder: "spam" })).submissions;
		if (!spam) throw new Error("Nothing went to the Spam folder.");
		await install.clock.advance(DAY + 1_000);

		await submissions(owner).submissions.notSpam({ siteId, id: spam.id });
		await install.drainJobs();

		expect(install.mail.sent.map((email) => email.to)).toEqual(["orders@acmebakery.example"]);
	});

	test("a Submission in the inbox isn't spam already", async () => {
		await submit({ name: "Kept", email: "kept@example.ie" });
		const [kept] = (await submissions(owner).submissions.list({ siteId, formId, limit: 1 })).submissions;

		await expect(submissions(owner).submissions.notSpam({ siteId, id: kept?.id ?? "" })).rejects.toMatchObject({
			code: "MODULE_ERROR",
			data: { code: "not-spam" },
		});
	});
});

describe("deleting", () => {
	test("takes two steps: the first says how many would go, the second deletes them; it is logged", async () => {
		const form = await newForm("Deleting", "deleting");
		const visitor = formVisitor(install);
		for (const name of ["One", "Two"]) {
			const page = await visitor.open(form.page);
			await install.clock.advance(5_000);
			await visitor.send(page, { name, email: "x@example.ie", consent: "yes" });
		}
		const ids = (await submissions(editor).submissions.list({ siteId, formId: form.formId })).submissions.map(
			(one) => one.id,
		);

		const asked = await submissions(editor).submissions.delete({ siteId, ids });
		expect(asked).toMatchObject({ deleted: false, preview: { count: 2 } });
		expect((await submissions(editor).submissions.list({ siteId, formId: form.formId })).total).toBe(2);
		if (asked.deleted) throw new Error("It deleted at once.");

		const done = await submissions(editor).submissions.delete({ siteId, ids, confirmation: asked.confirmation.id });
		expect(done).toEqual({ deleted: true, count: 2 });
		expect((await submissions(editor).submissions.list({ siteId, formId: form.formId })).total).toBe(0);
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 1 });
		expect(entries[0]).toMatchObject({
			action: "forms.submissions.delete",
			details: { count: 2, formIds: [form.formId] },
		});
	});

	test("a confirmation works once, and only for what it confirmed", async () => {
		const form = await newForm("Confirming", "confirming");
		await submit({ name: "Once", email: "once@example.ie" }, { url: form.page });
		const ids = (await submissions(owner).submissions.list({ siteId, formId: form.formId })).submissions.map(
			(one) => one.id,
		);
		const asked = await submissions(owner).submissions.delete({ siteId, ids });
		if (asked.deleted) throw new Error("It deleted at once.");

		await expect(
			submissions(owner).submissions.delete({ siteId, ids: [...ids, formId], confirmation: asked.confirmation.id }),
		).rejects.toMatchObject({ code: "CONFIRMATION_INVALID" });
		await expect(
			submissions(editor).submissions.delete({ siteId, ids, confirmation: asked.confirmation.id }),
		).rejects.toMatchObject({ code: "CONFIRMATION_INVALID" });
	});
});

describe("CSV export", () => {
	test("one row per Submission, UTF-8 with a BOM for spreadsheets, cells that could run as formulas made text; logged", async () => {
		const form = await newForm("Export", "export");
		const visitor = formVisitor(install);
		for (const [name, message] of [
			['Siobhán "Shiv" Murphy', '=HYPERLINK("https://evil.example")'],
			["+353 Luca", "Line one\nline two, with a comma"],
		] as const) {
			const page = await visitor.open(form.page);
			await install.clock.advance(5_000);
			await visitor.send(page, { name, email: "x@example.ie", message, consent: "yes" });
		}

		const { filename, csv, count } = await submissions(editor).submissions.export({ siteId, formId: form.formId });

		expect(count).toBe(2);
		expect(filename).toMatch(/^export-submissions-\d{4}-\d{2}-\d{2}\.csv$/);
		expect(csv.startsWith("﻿")).toBe(true);
		const lines = csv.slice(1).split("\r\n");
		expect(lines[0]).toBe('"Received (UTC)","Language","Page","Your name","Email","Message","I agree to be contacted"');
		expect(lines[1]).toContain(`"'+353 Luca","x@example.ie","Line one\nline two, with a comma","Yes"`);
		expect(csv).toContain(`"Siobhán ""Shiv"" Murphy","x@example.ie","'=HYPERLINK(""https://evil.example"")","Yes"`);
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 1 });
		expect(entries[0]).toMatchObject({
			action: "forms.submissions.export",
			details: { formId: form.formId, count: 2, folder: "inbox" },
		});
	});
});

describe("how long Submissions are kept", () => {
	test("only 30, 90 or 365 days, or forever; Authors can't change it", async () => {
		await expect(submissions(owner).retention.set({ siteId, formId, keepDays: 7 as 30 })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(submissions(author).retention.set({ siteId, formId, keepDays: 30 })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	// Last: the clock moves on a month, past everyone's sessions.
	test("forever unless a Form says; with 30 days, the daily purge deletes older ones, and says so in the Audit log", async () => {
		const form = await newForm("Retention", "retention");
		expect(await submissions(owner).retention.get({ siteId, formId: form.formId })).toEqual({ keepDays: null });
		expect(await submissions(owner).retention.set({ siteId, formId: form.formId, keepDays: 30 })).toEqual({
			keepDays: 30,
		});
		await submit({ name: "Old", email: "old@example.ie" }, { url: form.page });
		await install.clock.advance(20 * DAY);
		await submit({ name: "Newer", email: "newer@example.ie" }, { url: form.page });
		await install.clock.advance(11 * DAY);
		await install.drainJobs();

		const reader = await install.signIn(ownerAccount);
		const left = await submissions(reader).submissions.list({ siteId, formId: form.formId });
		expect(left.submissions.map((one) => one.values[0]?.value)).toEqual(["Newer"]);
		expect(left.keepDays).toBe(30);
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 50 });
		expect(entries).toContainEqual(
			expect.objectContaining({
				action: "forms.retention.change",
				details: { formId: form.formId, from: null, to: 30 },
			}),
		);
		expect(entries).toContainEqual(
			expect.objectContaining({
				action: "forms.submissions.purge",
				via: { kind: "module", name: "forms" },
				details: { formId: form.formId, keepDays: 30, deleted: 1 },
			}),
		);
	});
});
