// What a kept Submission sets off (spec stories 99 and 135): a Notification to each recipient, in the
// Site's Default language, with the Submission's values in a plain layout; the Auto-reply, in the
// visitor's language; and the "Form submitted" Webhooks. All are retried jobs, sent as the Site's
// mail: through the Site's own SMTP when it has one, else the Install SMTP under the Site's name.
// Spam sets off nothing.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import forms from "@webcraft/module-forms";

import type { SentEmail } from "../harness/fake-mailer.ts";
import { type FormVisitor, formVisitor } from "../harness/forms.ts";
import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { confirmed, receiverAccepts } from "../webhooks/support.ts";

let install: TestInstall;
let staff: TestBrowser;
let staffAccount: TestAccount;
let owner: TestBrowser;
let ownerAccount: TestAccount;
let siteId: string;
let formId: string;

const PAGE = "https://bakery.sites.test/visit/contact";
const ITALIAN_PAGE = "https://bakery.sites.test/it/visit/contact";

const NOTIFICATIONS = [
	{
		recipients: ["orders@acmebakery.example"],
		routing: {
			field: "cake",
			routes: [{ value: "tiered", recipients: ["tiers@acmebakery.example", "chef@acmebakery.example"] }],
		},
		subject: "New cake enquiry",
		intro: "A visitor asked about a cake.\n\nAnswer within a day, please.",
	},
];

const AUTO_REPLY = {
	enabled: true,
	field: null,
	subject: { text: "Thanks for your enquiry", translations: { it: "Grazie per la richiesta" } },
	text: {
		text: "We'll be in touch within a day.\n\nAcme Bakery",
		translations: { it: "Ti risponderemo entro un giorno.\n\nAcme Bakery" },
	},
};

/** What a visitor fills in, unless a test says otherwise. */
const FILLED = {
	name: "Siobhán Murphy",
	email: "Siobhan@Example.ie",
	cake: "single",
	extras: ["candles", "topper"],
	message: "<b>Lemon</b> & elderflower,\nwith fresh flowers.",
	consent: "yes",
};

/** Sends the Form from a page, as a visitor does, and runs the jobs that follow. */
async function submit(
	fields: Record<string, string | readonly string[]> = FILLED,
	options: { url?: string; visitor?: FormVisitor; hidden?: Record<string, string | null> } = {},
) {
	const visitor = options.visitor ?? formVisitor(install);
	const page = await visitor.open(options.url ?? PAGE);
	await install.clock.advance(5_000);
	const response = await visitor.send(page, fields, { hidden: options.hidden });
	expect(response.status).toBe(303);
	const { failed } = await install.drainJobs();
	expect(failed).toEqual([]);
	return response;
}

/** The emails the server took for an address. */
function emailsTo(address: string): SentEmail[] {
	return install.mail.sent.filter((email) => email.to === address);
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
		replyTo: "help@agency.example",
	});
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const createdStaff = await install.createStaff({ workspaces: [workspaceId] });
	staff = createdStaff.browser;
	staffAccount = createdStaff.account;
	const createdOwner = await install.createMember({ workspaceId, role: "owner" });
	owner = createdOwner.browser;
	ownerAccount = createdOwner.account;
	await staff.api.languages.add({ siteId, code: "it" });
	const { form } = await staff.api.forms.create({ siteId, name: "Wedding cakes", key: "wedding-cakes" });
	formId = form.id;
	await staff.api.forms.saveDraft({
		siteId,
		formId,
		form: {
			fields: [
				{
					key: "name",
					type: "text",
					label: { text: "Your name", translations: { it: "Il tuo nome" } },
					required: true,
				},
				{ key: "email", type: "email", label: "Email", required: true },
				{
					key: "cake",
					type: "select",
					label: "Cake",
					options: [
						{ value: "single", label: "Single tier" },
						{ value: "tiered", label: "Tiered" },
					],
				},
				{
					key: "extras",
					type: "checkboxes",
					label: "Extras",
					options: [
						{ value: "candles", label: "Candles" },
						{ value: "topper", label: "Topper" },
					],
				},
				{ key: "message", type: "textarea", label: "Message" },
				{ key: "guests", type: "number", label: "Guests" },
				{ key: "consent", type: "consent", label: "I agree to be contacted", required: true },
			],
		},
	});
	await staff.api.forms.publish({ siteId, formId });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Visits", urlPattern: "/visit/{slug}" });
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<section data-wc-id="s1">{{@form wedding-cakes}}</section>',
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Contact",
		slug: "contact",
	});
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	await owner.api.forms.saveEmails({ siteId, formId, emails: { notifications: NOTIFICATIONS, autoReply: AUTO_REPLY } });
	await owner.api.forms.publishEmails({ siteId, formId });
});

afterAll(async () => {
	await install.close();
});

beforeEach(async () => {
	await install.drainJobs();
	install.mail.clear();
	install.mail.accept();
});

describe("Notifications", () => {
	test("each recipient gets one, under the Site's name, replies going to the visitor, with every value", async () => {
		await submit();

		const [email, ...more] = emailsTo("orders@acmebakery.example");
		expect(more).toEqual([]);
		expect(email).toMatchObject({
			from: { name: "Acme Bakery", address: "noreply@agency.example" },
			replyTo: "siobhan@example.ie",
			subject: "New cake enquiry",
			smtp: { host: "smtp.agency.example" },
			headers: { "Auto-Submitted": "auto-generated" },
		});
		const text = email?.text ?? "";
		expect(text).toContain("A visitor asked about a cake.\n\nAnswer within a day, please.");
		expect(text).toContain("Your name:\n  Siobhán Murphy");
		expect(text).toContain("Email:\n  siobhan@example.ie");
		// Choices show their labels, a consent Yes, a value left empty a dash.
		expect(text).toContain("Cake:\n  Single tier");
		expect(text).toContain("Extras:\n  Candles, Topper");
		expect(text).toContain("I agree to be contacted:\n  Yes");
		expect(text).toContain("Guests:\n  —");
		expect(text).toContain("Message:\n  <b>Lemon</b> & elderflower,\n  with fresh flowers.");
		expect(text).toContain("Page:\n  /visit/contact");
		expect(text).toContain(`/sites/${siteId}/forms/${formId}?tab=submissions&submission=`);
	});

	test("what the visitor typed is text: no markup of theirs reaches the email", async () => {
		await submit({ ...FILLED, message: '<img src=x onerror="alert(1)"><a href="https://evil.example">Click</a>' });

		const html = emailsTo("orders@acmebakery.example")[0]?.html ?? "";
		expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
		expect(html).not.toContain("<img");
		expect(html).not.toContain('href="https://evil.example"');
	});

	test("line breaks a visitor sends never reach a header: no recipient is added, the subject stays", async () => {
		await submit({ ...FILLED, name: "Eve\r\nBcc: victim@example.com\r\nSubject: Hi" });

		expect(install.mail.sent.map((email) => email.to)).not.toContain("victim@example.com");
		const email = emailsTo("orders@acmebakery.example")[0];
		expect(email?.subject).toBe("New cake enquiry");
		expect(email?.replyTo).toBe("siobhan@example.ie");
	});

	test("routing: a value with a route goes to its addresses, and only there", async () => {
		await submit({ ...FILLED, cake: "tiered" });

		expect(emailsTo("tiers@acmebakery.example")).toHaveLength(1);
		expect(emailsTo("chef@acmebakery.example")).toHaveLength(1);
		expect(emailsTo("orders@acmebakery.example")).toEqual([]);
	});

	test("they are written in the Site's Default language, whatever language the visitor used", async () => {
		await submit(FILLED, { url: ITALIAN_PAGE });

		const text = emailsTo("orders@acmebakery.example")[0]?.text ?? "";
		expect(text).toContain("Your name:\n  Siobhán Murphy");
		expect(text).toContain("Language:\n  it");
	});

	test("each is in the Email log with its Site and its Submission, never its body", async () => {
		await submit();

		const { lines } = await (await install.superadmin()).api.install.emailLog.list({ limit: 5 });
		const notification = lines.find((line) => line.recipient === "orders@acmebakery.example");
		expect(notification).toMatchObject({
			type: "form-notification",
			subject: "New cake enquiry",
			smtp: "install",
			status: "sent",
			related: { kind: "submission" },
		});
		expect(JSON.stringify(lines)).not.toContain("Siobhán");
	});

	test("a Form whose emails were never published sends none", async () => {
		const { form } = await staff.api.forms.create({ siteId, name: "Quiet" });
		await owner.api.forms.saveEmails({
			siteId,
			formId: form.id,
			emails: { notifications: [{ ...NOTIFICATIONS[0], routing: null }] },
		});

		const { form: read } = await owner.api.forms.get({ siteId, formId: form.id });
		expect(read.emails.published).toBeNull();
	});

	test("spam sets off nothing, and its sender is never told", async () => {
		await submit(FILLED, { hidden: { "wc-website": "https://spam.example" } });

		expect(install.mail.sent).toEqual([]);
	});
});

describe("the Auto-reply", () => {
	test("goes back to the visitor in the language they used, with the Form's words only", async () => {
		await submit(
			{ ...FILLED, email: "luca@example.it", message: "Visit https://spam.example now!" },
			{ url: ITALIAN_PAGE },
		);

		const [reply, ...more] = emailsTo("luca@example.it");
		expect(more).toEqual([]);
		expect(reply).toMatchObject({ subject: "Grazie per la richiesta", from: { name: "Acme Bakery" } });
		expect(reply?.text).toContain("Ti risponderemo entro un giorno.\n\nAcme Bakery");
		expect(reply?.text).toContain("questo indirizzo è stato indicato in un modulo su Acme Bakery");
		// Nothing the visitor typed is sent back.
		expect(reply?.text).not.toContain("spam.example");
		expect(reply?.text).not.toContain("Siobhán");
		// The agency's own reply-to address is never given to the Site's mail.
		expect(reply?.replyTo).toBeUndefined();
	});

	test("goes in the Form's text as written for a language it has none for", async () => {
		await submit({ ...FILLED, email: "hannah@example.de" });

		expect(emailsTo("hannah@example.de")[0]?.subject).toBe("Thanks for your enquiry");
	});

	test("goes nowhere while it is off", async () => {
		await owner.api.forms.saveEmails({ siteId, formId, emails: { autoReply: { ...AUTO_REPLY, enabled: false } } });
		await owner.api.forms.publishEmails({ siteId, formId });
		try {
			await submit({ ...FILLED, email: "conor@example.ie" });

			expect(emailsTo("conor@example.ie")).toEqual([]);
			expect(emailsTo("orders@acmebakery.example")).toHaveLength(1);
		} finally {
			await owner.api.forms.saveEmails({ siteId, formId, emails: { autoReply: AUTO_REPLY } });
			await owner.api.forms.publishEmails({ siteId, formId });
		}
	});
});

describe("Form submitted Webhooks", () => {
	test("each Webhook that receives formSubmitted gets the Submission, signed, from the worker; spam sends none", async () => {
		install.dns.answer("hooks.crm.example", ["93.184.216.34"]);
		const url = "https://hooks.crm.example/leads";
		install.http.respond("POST", url, { status: 204 });
		const { secret } = await confirmed(staff, staffAccount, () =>
			staff.api.webhooks.add({ siteId, url, events: ["formSubmitted"] }),
		);
		const before = install.http.requests.length;

		await submit({ ...FILLED, cake: "tiered" });

		const [request, ...more] = install.http.requests.slice(before).filter((sent) => sent.url === url);
		expect(more).toEqual([]);
		if (!request || !secret) throw new Error("No Webhook was sent.");
		expect(request.headers.get("webcraft-event")).toBe("formSubmitted");
		expect(receiverAccepts(request, secret, install.clock.now())).toBe(true);
		const body = JSON.parse(request.body);
		expect(body).toMatchObject({
			type: "formSubmitted",
			site: { id: siteId, name: "Acme Bakery" },
			data: {
				form: { id: formId, key: "wedding-cakes", name: "Wedding cakes" },
				submission: { language: "en", page: "/visit/contact" },
			},
		});
		expect(body.data.submission.values).toContainEqual({ key: "cake", label: "Cake", type: "select", value: "tiered" });
		expect(typeof body.data.submission.id).toBe("string");

		const sent = install.http.requests.length;
		await submit(FILLED, { hidden: { "wc-website": "https://spam.example" } });
		expect(install.http.requests.slice(sent).filter((call) => call.url === url)).toEqual([]);
	});
});

describe("through the Site's own SMTP", () => {
	const SITE_SERVER = {
		host: "smtp.acmebakery.example",
		port: 465,
		security: "tls",
		username: "mailer@acmebakery.example",
		fromAddress: "hello@acmebakery.example",
		password: "the bakery's smtp password",
	} as const;

	test("the Site's mail goes through it, from its address, under the sender name it gives", async () => {
		await confirmed(staff, staffAccount, () =>
			staff.api.siteSmtp.update({ siteId, fromName: "Acme Bakery orders", replyTo: null, server: SITE_SERVER }),
		);

		await submit();

		expect(emailsTo("orders@acmebakery.example")[0]).toMatchObject({
			from: { name: "Acme Bakery orders", address: "hello@acmebakery.example" },
			smtp: { host: "smtp.acmebakery.example", port: 465, password: "the bakery's smtp password" },
		});
		const { lines } = await (await install.superadmin()).api.install.emailLog.list({ limit: 1 });
		expect(lines[0]).toMatchObject({ smtp: "site" });
	});

	test("when it fails, its mail never goes through the Install SMTP; once Failing, the Site's Owners and Staff are told", async () => {
		install.mail.fail("421 4.7.0 Try again later");
		// One Submission, three Notifications (the route's two and the Auto-reply), three failures in a row.
		const visitor = formVisitor(install);
		const page = await visitor.open(PAGE);
		await install.clock.advance(5_000);
		await visitor.send(page, { ...FILLED, cake: "tiered" });
		await install.drainJobs();

		const attempts = install.mail.attempts.filter((email) => email.subject !== "The SMTP of Acme Bakery is failing");
		expect(attempts.length).toBeGreaterThanOrEqual(3);
		expect(attempts.every((email) => email.smtp.host === "smtp.acmebakery.example")).toBe(true);
		expect((await staff.api.siteSmtp.get({ siteId })).health).toMatchObject({ state: "failing", failuresInARow: 3 });

		install.mail.accept();
		await install.clock.advance(5 * 60_000);
		const told = await install.lastEmailTo(ownerAccount.email);
		expect(told.subject).toBe("The SMTP of Acme Bakery is failing");
		expect(told.text).toContain("421 4.7.0 Try again later");
		expect((await install.lastEmailTo(staffAccount.email)).subject).toBe("The SMTP of Acme Bakery is failing");
		// Told once, through the Install SMTP; the retried Notifications went through the Site's server.
		expect(install.mail.sent.filter((email) => email.subject === "The SMTP of Acme Bakery is failing")).toHaveLength(2);
		expect(
			install.mail.sent
				.filter((email) => email.subject === "The SMTP of Acme Bakery is failing")
				.every((email) => email.smtp.host === "smtp.agency.example"),
		).toBe(true);
		expect(emailsTo("tiers@acmebakery.example")[0]?.smtp.host).toBe("smtp.acmebakery.example");
	});
});
