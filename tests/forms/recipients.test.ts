// Who receives a Form's Submissions is decided by a person, in the admin, who just proved who they
// are: changing a Notification's recipients or routing is a Sensitive action, recorded in the Audit
// log, and never open to an API token or AI client, which could otherwise send every later Submission
// to an address of its own. What is left of a Form's emails for API clients (their words, publishing
// them) needs the Submissions Toolset, the same opt-in as reading Submissions.
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { formVisitor } from "../harness/forms.ts";
import { createTestInstall, TEST_PASSWORD, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let superadmin: TestBrowser;
let workspaceId: string;

const MINUTE = 60_000;
const OWNERS = { recipients: ["orders@acmebakery.example"], subject: "New enquiry", intro: "" };
const THEIRS = "collector@elsewhere.example";

/** A live Site of its own with a published Form on `/visit/contact`, its Notifications going to the bakery. */
async function siteWithForm(slug: string) {
	const siteId = (await install.createSite(workspaceId, { name: slug, slug })).id;
	const origin = await goLive(install, siteId);
	const editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	const { form } = await superadmin.api.forms.create({ siteId, name: "Contact", key: "contact" });
	const formId = form.id;
	await superadmin.api.forms.saveDraft({
		siteId,
		formId,
		form: {
			fields: [
				{ key: "email", type: "email", label: "Email", required: true },
				{
					key: "topic",
					type: "select",
					label: "Topic",
					options: [
						{ value: "order", label: "An order" },
						{ value: "press", label: "Press" },
					],
				},
			],
		},
	});
	await superadmin.api.forms.publish({ siteId, formId });
	const { postType } = await superadmin.api.postTypes.create({
		siteId,
		name: "Visits",
		key: "visits",
		urlPattern: "/visit/{slug}",
		fields: [],
	});
	const saved = await superadmin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "{{@form contact}}",
	});
	await superadmin.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry } = await superadmin.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Contact",
		slug: "contact",
		fields: {},
	});
	await superadmin.api.entries.publish({ siteId, entryId: entry.id });
	await editor.api.forms.saveEmails({ siteId, formId, emails: { notifications: [OWNERS] } });
	await editor.api.forms.publishEmails({ siteId, formId });
	/** A visitor sends the Form; answers who its Notifications went to. */
	const notified = async () => {
		install.mail.clear();
		const visitor = formVisitor(install);
		const page = await visitor.open(`${origin}/visit/contact`);
		await install.clock.advance(5000);
		expect((await visitor.send(page, { email: "ada@example.com" })).status).toBe(303);
		await install.drainJobs();
		return install.mail.sent.map((email) => email.to).sort();
	};
	return { siteId, formId, editor, notified };
}

/** The newest Audit log entries of an action on a Site. */
async function logged(siteId: string, action: string) {
	return (await superadmin.api.audit.list({ workspaceId, siteId, action })).entries;
}

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.superadmin();
	await superadmin.api.modules.approve({ moduleId: "forms", version: "1.2.0" });
	await superadmin.api.install.smtp.update({
		host: "smtp.agency.example",
		port: 587,
		security: "starttls",
		username: null,
		fromAddress: "noreply@agency.example",
		replyTo: null,
	});
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
});

afterAll(async () => {
	await install.close();
});

test("an API token never changes who receives a Form's Submissions, whatever its Toolsets", async () => {
	const { siteId, formId, editor, notified } = await siteWithForm("token");
	const { secret } = await createApiToken(editor, {
		workspaceId,
		name: "Everything",
		toolsets: ["forms", "submissions", "publishing"],
	});
	const script = tokenClient(install, secret).api;

	await expect(
		script.forms.saveEmails({ siteId, formId, emails: { notifications: [{ ...OWNERS, recipients: [THEIRS] }] } }),
	).rejects.toMatchObject({ code: "SENSITIVE_ACTION_REFUSED" });
	// Nor through routing, which sends some Submissions elsewhere.
	await expect(
		script.forms.saveEmails({
			siteId,
			formId,
			emails: {
				notifications: [{ ...OWNERS, routing: { field: "topic", routes: [{ value: "order", recipients: [THEIRS] }] } }],
			},
		}),
	).rejects.toMatchObject({ code: "SENSITIVE_ACTION_REFUSED" });
	// Nor by adding a Notification of its own.
	await expect(
		script.forms.saveEmails({
			siteId,
			formId,
			emails: { notifications: [OWNERS, { recipients: [THEIRS], subject: "", intro: "" }] },
		}),
	).rejects.toMatchObject({ code: "SENSITIVE_ACTION_REFUSED" });

	// A token publishes in two steps: the first call answers a confirmation, the second gives it back.
	const asked: unknown = await script.forms.publishEmails({ siteId, formId });
	const { confirmation } = asked as { confirmation: { id: string } };
	await script.forms.publishEmails({ siteId, formId, confirmation: confirmation.id });
	expect(await notified()).toEqual(["orders@acmebakery.example"]);
	expect(await logged(siteId, "formRecipients.change")).toHaveLength(1);
});

test("an API token with the Submissions Toolset still changes a Notification's words", async () => {
	const { siteId, formId, editor } = await siteWithForm("words");
	const { secret } = await createApiToken(editor, { workspaceId, name: "Inbox", toolsets: ["submissions"] });
	const script = tokenClient(install, secret).api;

	const { form } = await script.forms.saveEmails({
		siteId,
		formId,
		emails: { notifications: [{ ...OWNERS, subject: "A new enquiry from the site" }] },
	});

	expect(form.emails.draft.notifications[0]).toMatchObject({
		recipients: ["orders@acmebakery.example"],
		subject: "A new enquiry from the site",
	});
});

test("without the Submissions Toolset, an API token neither changes nor publishes a Form's emails", async () => {
	const { siteId, formId, editor } = await siteWithForm("toolset");
	const { secret } = await createApiToken(editor, {
		workspaceId,
		name: "Forms only",
		toolsets: ["forms", "content", "publishing"],
	});
	const script = tokenClient(install, secret).api;

	await expect(
		script.forms.saveEmails({ siteId, formId, emails: { notifications: [{ ...OWNERS, subject: "Changed" }] } }),
	).rejects.toMatchObject({ code: "TOOLSET_OFF", data: { toolsets: ["submissions"] } });
	await expect(script.forms.publishEmails({ siteId, formId })).rejects.toMatchObject({
		code: "TOOLSET_OFF",
		data: { toolsets: ["submissions"] },
	});
});

test("in the admin, changing who receives Submissions needs a recent identity check and is in the Audit log", async () => {
	const { siteId, formId, editor, notified } = await siteWithForm("in-admin");
	await install.clock.advance(11 * MINUTE);
	const change = () =>
		editor.api.forms.saveEmails({
			siteId,
			formId,
			emails: { notifications: [{ ...OWNERS, recipients: ["orders@acmebakery.example", "chef@acmebakery.example"] }] },
		});

	await expect(change()).rejects.toMatchObject({
		code: "IDENTITY_CHECK_REQUIRED",
		data: { action: "formRecipients.change" },
	});
	// Their words stay a plain change.
	await editor.api.forms.saveEmails({
		siteId,
		formId,
		emails: { notifications: [{ ...OWNERS, subject: "An enquiry" }], attachmentsMaxBytes: 0 },
	});
	await editor.api.session.confirmIdentity({ password: TEST_PASSWORD });
	await change();
	await editor.api.forms.publishEmails({ siteId, formId });

	expect(await notified()).toEqual(["chef@acmebakery.example", "orders@acmebakery.example"]);
	const [entry] = await logged(siteId, "formRecipients.change");
	expect(entry).toMatchObject({
		via: { kind: "admin" },
		details: { formId, key: "contact", name: "Contact", added: ["chef@acmebakery.example"], removed: [] },
	});
});

test("restoring a Form's earlier emails with other recipients is a Sensitive action too", async () => {
	const { siteId, formId, editor } = await siteWithForm("restore");
	const item = { kind: "formEmails", id: formId } as const;
	await install.clock.advance(MINUTE);
	await editor.api.forms.saveEmails({
		siteId,
		formId,
		emails: { notifications: [{ ...OWNERS, recipients: ["new@acmebakery.example"] }] },
	});
	await editor.api.forms.publishEmails({ siteId, formId });
	const { copies } = await editor.api.history.list({ siteId, item });
	const earliest = copies.filter((each) => each.type === "revision").at(-1);
	if (!earliest) throw new Error("The Form's emails have no Revision.");
	const copy = { type: "revision", id: earliest.id } as const;
	const { secret } = await createApiToken(editor, {
		workspaceId,
		name: "History",
		toolsets: ["content", "structure", "submissions"],
	});

	await expect(tokenClient(install, secret).api.history.restore({ siteId, item, copy })).rejects.toMatchObject({
		code: "SENSITIVE_ACTION_REFUSED",
	});
	await install.clock.advance(11 * MINUTE);
	await expect(editor.api.history.restore({ siteId, item, copy })).rejects.toMatchObject({
		code: "IDENTITY_CHECK_REQUIRED",
		data: { action: "formRecipients.change" },
	});

	const { form } = await editor.api.forms.get({ siteId, formId });
	expect(form.emails.draft.notifications[0]?.recipients).toEqual(["new@acmebakery.example"]);
});
