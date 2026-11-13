// A Form's emails (its Notifications and its Auto-reply) are Content: Staff, Owners and Editors change
// them in their own Draft and publish them, never Authors, while the Form's fields stay Structure.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let editor: TestBrowser;
let author: TestBrowser;
let siteId: string;
let formId: string;

const NOTIFICATION = {
	recipients: ["orders@acmebakery.example"],
	routing: {
		field: "cake",
		routes: [{ value: "tiered", recipients: ["Tiers@AcmeBakery.example", "chef@acmebakery.example"] }],
	},
	subject: "New cake enquiry",
	intro: "A visitor asked about a cake.",
};

const AUTO_REPLY = {
	enabled: true,
	field: "email",
	subject: { text: "Thanks for your enquiry", translations: { it: "Grazie per la richiesta" } },
	text: { text: "We'll be in touch within a day.", translations: { it: "Ti risponderemo entro un giorno." } },
};

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	const { form } = await staff.api.forms.create({ siteId, name: "Wedding cakes", key: "wedding-cakes" });
	formId = form.id;
	await staff.api.forms.saveDraft({
		siteId,
		formId,
		form: {
			fields: [
				{ key: "name", type: "text", label: "Your name", required: true },
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
			],
		},
	});
	await staff.api.forms.publish({ siteId, formId });
});

afterAll(async () => {
	await install.close();
});

describe("a Form's emails", () => {
	test("a new Form sends nothing: no Notification, the Auto-reply off", async () => {
		const { form } = await staff.api.forms.create({ siteId, name: "Newsletter" });

		expect(form.emails).toEqual({
			draft: {
				notifications: [],
				autoReply: { enabled: false, field: null, subject: { text: "" }, text: { text: "" } },
				attachmentsMaxBytes: 10 * 1024 * 1024,
			},
			published: null,
			status: "draft",
			lastPublishedAt: null,
		});
	});

	test("an Owner saves them to their Draft, then publishes them; the Form's fields stay as published", async () => {
		const saved = await owner.api.forms.saveEmails({
			siteId,
			formId,
			emails: { notifications: [NOTIFICATION], autoReply: AUTO_REPLY },
		});

		expect(saved.form.emails.draft).toEqual({
			notifications: [
				{
					...NOTIFICATION,
					routing: {
						field: "cake",
						routes: [{ value: "tiered", recipients: ["tiers@acmebakery.example", "chef@acmebakery.example"] }],
					},
				},
			],
			autoReply: AUTO_REPLY,
			attachmentsMaxBytes: 10 * 1024 * 1024,
		});
		expect(saved.form.emails.status).toBe("draft");
		expect(saved.form.status).toBe("published");

		const published = await owner.api.forms.publishEmails({ siteId, formId });
		expect(published.form.emails.status).toBe("published");
		expect(published.form.emails.published).toEqual(saved.form.emails.draft);
		expect(published.form.emails.lastPublishedAt).toEqual(install.clock.now());
		expect(published.form.status).toBe("published");

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 1 });
		expect(entries[0]).toMatchObject({
			action: "formEmails.publish",
			siteId,
			details: { formId, key: "wedding-cakes", name: "Wedding cakes" },
		});
	});

	test("an Editor changes them too; a change shows as changed until published", async () => {
		await editor.api.forms.saveEmails({ siteId, formId, emails: { notifications: [] } });

		const { form } = await editor.api.forms.get({ siteId, formId });
		expect(form.emails.status).toBe("changed");
		expect(form.emails.published?.notifications).toHaveLength(1);
		await editor.api.forms.saveEmails({ siteId, formId, emails: { notifications: [NOTIFICATION] } });
	});

	test("Owners and Editors read the Site's Forms, but never change their Structure", async () => {
		expect((await owner.api.forms.list({ siteId })).forms.map((form) => form.key)).toContain("wedding-cakes");
		await expect(owner.api.forms.saveDraft({ siteId, formId, form: { submitLabel: "Go" } })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(owner.api.forms.publish({ siteId, formId })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("Authors neither read Forms nor change their emails", async () => {
		await expect(author.api.forms.list({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(author.api.forms.get({ siteId, formId })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(author.api.forms.saveEmails({ siteId, formId, emails: { notifications: [] } })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(author.api.forms.publishEmails({ siteId, formId })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("what a Form's emails may hold", () => {
	/** The places of the problems a refused change answers. */
	async function problemsOf(emails: Record<string, unknown>): Promise<string[]> {
		try {
			await owner.api.forms.saveEmails({ siteId, formId, emails });
		} catch (error) {
			const { code, data } = error as { code: string; data: { problems: { at: string }[] } };
			expect(code).toBe("FORM_INVALID");
			return data.problems.map((problem) => problem.at);
		}
		throw new Error("The change was saved.");
	}

	test("each recipient is one email address", async () => {
		expect(
			await problemsOf({
				notifications: [
					{ ...NOTIFICATION, recipients: ["orders@acmebakery.example", "not an address", "a@b.example, c@d.example"] },
				],
			}),
		).toEqual(["notifications[0].recipients[1]", "notifications[0].recipients[2]"]);
	});

	test("a Notification goes to someone, to at most 20 addresses a list", async () => {
		expect(await problemsOf({ notifications: [{ ...NOTIFICATION, recipients: [], routing: null }] })).toEqual([
			"notifications[0].recipients",
		]);
		const many = Array.from({ length: 21 }, (_, n) => `baker${n}@acmebakery.example`);
		expect(await problemsOf({ notifications: [{ ...NOTIFICATION, recipients: many }] })).toEqual([
			"notifications[0].recipients",
		]);
	});

	test("routing reads a select or radio field, by its options", async () => {
		expect(await problemsOf({ notifications: [{ ...NOTIFICATION, routing: { field: "name", routes: [] } }] })).toEqual([
			"notifications[0].routing.field",
		]);
		expect(
			await problemsOf({
				notifications: [
					{ ...NOTIFICATION, routing: { field: "cake", routes: [{ value: "cupcakes", recipients: [] }] } },
				],
			}),
		).toEqual(["notifications[0].routing.routes[0].value"]);
	});

	test("a subject is one line", async () => {
		expect(
			await problemsOf({ notifications: [{ ...NOTIFICATION, subject: "Hello\r\nBcc: everyone@example.com" }] }),
		).toEqual(["notifications[0].subject"]);
		expect(await problemsOf({ autoReply: { ...AUTO_REPLY, subject: { text: "Thanks\nBcc: x@example.com" } } })).toEqual(
			["autoReply.subject"],
		);
	});

	test("the Auto-reply goes to an email field of the Form, with a subject and a text", async () => {
		expect(await problemsOf({ autoReply: { ...AUTO_REPLY, field: "name" } })).toEqual(["autoReply.field"]);
		expect(await problemsOf({ autoReply: { ...AUTO_REPLY, subject: "", text: "" } })).toEqual([
			"autoReply.subject",
			"autoReply.text",
		]);
	});
});
