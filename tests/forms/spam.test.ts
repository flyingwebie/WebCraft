// Spam rules: a honeypot, a minimum fill time (the time trap) and per-address limits (5 a minute, 30
// an hour per Form; Staff change them). A post failing one is kept in the Spam folder, answered as if
// it went through, and deleted after 30 days. What bounds a flood of them is in `flood.test.ts`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type forms from "@webcraft/module-forms";

import { formVisitor } from "../harness/forms.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let editorAccount: Parameters<TestInstall["signIn"]>[0];
let siteId: string;
let workspaceId: string;
let formId: string;
const PAGE = "https://bakery.live.test/visit/contact";
const GOOD = { email: "ada@example.com" };

async function folder(name: "inbox" | "spam") {
	return (await moduleApi<typeof forms>(editor, "forms").submissions.list({ siteId, formId, folder: name }))
		.submissions;
}

/** Loads the page, waits as a person would, and sends the Form. */
async function sendAfter(seconds: number, fields: Record<string, string>, visitor = formVisitor(install)) {
	const page = await visitor.open(PAGE);
	await install.clock.advance(seconds * 1000);
	return { visitor, page, answer: await visitor.send(page, fields) };
}

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "forms", version: "1.2.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const member = await install.createMember({ workspaceId, role: "editor" });
	editor = member.browser;
	editorAccount = member.account;
	const { form } = await staff.api.forms.create({ siteId, name: "Contact", key: "contact" });
	formId = form.id;
	await staff.api.forms.saveDraft({
		siteId,
		formId,
		form: { fields: [{ key: "email", type: "email", label: "Email", required: true }] },
	});
	await staff.api.forms.publish({ siteId, formId });
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
});

afterAll(async () => {
	await install.close();
});

describe("spam goes to the Spam folder, and looks sent to whoever sent it", () => {
	test("the honeypot filled in", async () => {
		const { answer } = await sendAfter(5, { ...GOOD, "wc-website": "https://cheap.example" });

		expect(answer.status).toBe(303);
		expect(answer.headers.get("location")).toBe("/visit/contact?wc-sent=1#wc-form-1");
		expect((await folder("spam"))[0]).toMatchObject({ folder: "spam", spamReason: "honeypot", page: "/visit/contact" });
		expect((await folder("spam"))[0]?.values).toEqual([
			{ key: "email", label: "Email", type: "email", value: "ada@example.com" },
		]);
	});

	test("sent sooner after the page loaded than a person could fill it in", async () => {
		const { answer } = await sendAfter(1, GOOD);

		expect(answer.status).toBe(303);
		expect((await folder("spam"))[0]?.spamReason).toBe("too-fast");
	});

	test("sent without the page's token, or with one this Install didn't make", async () => {
		const visitor = formVisitor(install);
		const page = await visitor.open(PAGE);
		await install.clock.advance(5000);

		await visitor.send(page, GOOD, { hidden: { "wc-t": null } });
		expect((await folder("spam"))[0]?.spamReason).toBe("token");
		await visitor.send(page, GOOD, { hidden: { "wc-t": `tb9l01.${"A".repeat(43)}` } });
		expect((await folder("spam"))[0]?.spamReason).toBe("token");
	});

	test("spam that breaks the Form's rules is kept as it was sent", async () => {
		const { answer } = await sendAfter(5, { email: "not an email", "wc-website": "x" });

		expect(answer.status).toBe(303);
		expect((await folder("spam"))[0]?.values).toEqual([
			{ key: "email", label: "Email", type: "email", value: "not an email" },
		]);
	});
});

describe("per-address limits", () => {
	test("from one address, 5 a minute and 30 an hour go to the inbox; the rest to the Spam folder", async () => {
		const visitor = formVisitor(install);
		const inbox = (await folder("inbox")).length;
		for (let sent = 0; sent < 6; sent++) await sendAfter(5, GOOD, visitor);

		expect((await folder("inbox")).length).toBe(inbox + 5);
		expect((await folder("spam"))[0]?.spamReason).toBe("rate-limit");
		// Another address is counted on its own.
		await sendAfter(5, GOOD);
		expect((await folder("inbox")).length).toBe(inbox + 6);
		// A minute on, the address sends again, until its hour is used up: every post kept counts,
		// spam too, so 24 more make its 30.
		for (let minute = 0; minute < 5; minute++) {
			await install.clock.advance(60_000);
			for (let sent = 0; sent < (minute < 4 ? 5 : 4); sent++) await sendAfter(5, GOOD, visitor);
		}
		expect((await folder("inbox")).length).toBe(inbox + 6 + 24);
		await install.clock.advance(60_000);
		await sendAfter(5, GOOD, visitor);
		expect((await folder("inbox")).length).toBe(inbox + 6 + 24);
		expect((await folder("spam"))[0]?.spamReason).toBe("rate-limit");
	});

	test("posts with errors don't count: a person fixing what they typed is never put in the Spam folder", async () => {
		const visitor = formVisitor(install);
		const inbox = (await folder("inbox")).length;
		for (let tried = 0; tried < 8; tried++) {
			expect((await sendAfter(5, { email: "nope" }, visitor)).answer.status).toBe(422);
		}

		await sendAfter(5, GOOD, visitor);

		expect((await folder("inbox")).length).toBe(inbox + 1);
	});

	test("Staff change the limits", async () => {
		await staff.api.forms.saveDraft({
			siteId,
			formId,
			form: { spam: { perMinute: 2, perHour: 30, minFillSeconds: 3 } },
		});
		await staff.api.forms.publish({ siteId, formId });
		const visitor = formVisitor(install);
		const inbox = (await folder("inbox")).length;

		for (let sent = 0; sent < 3; sent++) await sendAfter(5, GOOD, visitor);

		expect((await folder("inbox")).length).toBe(inbox + 2);
		expect((await folder("spam"))[0]?.spamReason).toBe("rate-limit");
	});
});

describe("the Spam folder", () => {
	test("keeps spam 30 days, then deletes it; the inbox stays", async () => {
		const spam = (await folder("spam")).length;
		const inbox = (await folder("inbox")).length;
		expect(spam).toBeGreaterThan(0);

		await install.clock.advance(29 * 24 * 60 * 60 * 1000);
		await install.drainJobs();
		// Weeks on, the editor signs in again.
		editor = await install.signIn(editorAccount);
		expect((await folder("spam")).length).toBe(spam);
		await install.clock.advance(2 * 24 * 60 * 60 * 1000);
		const { failed } = await install.drainJobs();

		expect(failed).toEqual([]);
		expect(await folder("spam")).toEqual([]);
		expect((await folder("inbox")).length).toBe(inbox);
	});

	test("Authors can't read Submissions", async () => {
		const author = (await install.createMember({ workspaceId, role: "author" })).browser;

		await expect(
			moduleApi<typeof forms>(author, "forms").submissions.list({ siteId, formId, folder: "inbox" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
