// Form uploads (GLOSSARY.md, spec stories 97 and 103, ADR 0026): files visitors attach to a Form.
// Each file field takes the formats, the size and the number of files Staff chose, never SVG, judged
// by the bytes and not only the name. Files are private: they never enter the Media library and have
// no address on the Site; people who may read the Form's Submissions download them through the
// admin, and each download is in the Audit log. They go with their Submission, however it goes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import forms from "@webcraft/module-forms";
import { type FormVisitor, formVisitor, type TestFile } from "../harness/forms.ts";
import { pdf, upload } from "../harness/images.ts";
import {
	createFakeS3,
	createTestInstall,
	TEST_PASSWORD,
	type TestAccount,
	type TestBrowser,
	type TestInstall,
} from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let ownerAccount: TestAccount;
let author: TestBrowser;
let workspaceId: string;
let siteId: string;
let otherSiteId: string;
let formId: string;
const PAGE = "https://bakery.live.test/visit/apply";
const DAY = 24 * 60 * 60 * 1000;

const PDF = `%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n${"x".repeat(3000)}\n%%EOF\n`;
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1]);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

const cv = (name = "cv.pdf", bytes: TestFile["bytes"] = PDF): TestFile => ({ name, type: "application/pdf", bytes });

function submissions(browser: TestBrowser) {
	return moduleApi<typeof forms>(browser, "forms");
}

/** Sends the Form with `files` from its page, as a browser does. */
async function send(
	files: Record<string, readonly TestFile[]>,
	fields: Record<string, string> = { name: "Siobhán Murphy" },
	options: { visitor?: FormVisitor; hidden?: Record<string, string | null> } = {},
) {
	const visitor = options.visitor ?? formVisitor(install);
	const page = await visitor.open(PAGE);
	await install.clock.advance(5_000);
	return visitor.send(page, fields, { files, hidden: options.hidden });
}

/** The newest Submission of the Form in a folder. */
async function newest(folder: "inbox" | "spam" = "inbox") {
	const [submission] = (await submissions(owner).submissions.list({ siteId, formId, folder, limit: 1 })).submissions;
	if (!submission) throw new Error(`Nothing in the ${folder}.`);
	return submission;
}

type FileValue = { uploadId: string | null; name: string; size: number; contentType: string; url?: string };

/** The files a Submission holds for a field. */
function filesOf(submission: { values: { key: string; value: unknown }[] }, key: string): FileValue[] {
	return (submission.values.find((value) => value.key === key)?.value ?? []) as FileValue[];
}

/** An upload's address in the admin. */
function downloadPath(uploadId: string | null, site = siteId) {
	return install.adminUrl(`/api/forms/uploads/${site}/${uploadId}`);
}

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "forms", version: forms.manifest.version });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	otherSiteId = (await install.createSite(workspaceId, { name: "Acme Café", slug: "cafe" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const createdOwner = await install.createMember({ workspaceId, role: "owner" });
	owner = createdOwner.browser;
	ownerAccount = createdOwner.account;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	const { form } = await staff.api.forms.create({ siteId, name: "Job application", key: "apply" });
	formId = form.id;
	await staff.api.forms.saveDraft({
		siteId,
		formId,
		form: {
			fields: [
				{ key: "name", type: "text", label: "Your name", required: true },
				{
					key: "cv",
					type: "file",
					label: "Your CV",
					required: true,
					accept: ["pdf", "docx"],
					maxFileBytes: 8 * 1024,
					maxFiles: 2,
				},
				{ key: "photo", type: "file", label: "A photo of your bakes", accept: ["png", "jpeg"] },
			],
		},
	});
	await staff.api.forms.publish({ siteId, formId });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Visits", urlPattern: "/visit/{slug}" });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<section data-wc-id="s1"><h1 data-wc-id="h1">{{ title }}</h1>{{@form apply}}</section>',
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Apply", slug: "apply" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
});

afterAll(async () => {
	await install.close();
});

describe("building a file field", () => {
	test("Staff choose its formats, largest file and how many; SVG is never one of them", async () => {
		const { form } = await staff.api.forms.get({ siteId, formId });
		expect(form.draft.fields[1]).toMatchObject({
			type: "file",
			accept: ["pdf", "docx"],
			maxFileBytes: 8 * 1024,
			maxFiles: 2,
		});

		const { form: other } = await staff.api.forms.create({ siteId, name: "Logos" });
		const refused = staff.api.forms.saveDraft({
			siteId,
			formId: other.id,
			form: {
				fields: [
					{ key: "logo", type: "file", label: "Logo", accept: ["svg"] },
					{ key: "none", type: "file", label: "Nothing", accept: [] },
					{ key: "huge", type: "file", label: "Huge", accept: ["pdf"], maxFileBytes: 1024 * 1024 * 1024, maxFiles: 50 },
				],
			},
		});
		await expect(refused).rejects.toMatchObject({ code: "FORM_INVALID" });
		const problems = ((await refused.catch((error) => error)) as { data: { problems: { at: string }[] } }).data
			.problems;
		expect(problems.map((problem) => problem.at)).toEqual([
			"fields[0].accept",
			"fields[1].accept",
			"fields[2].maxFileBytes",
			"fields[2].maxFiles",
		]);
	});

	test("the page's Form sends files, and says what each file field takes", async () => {
		const page = await formVisitor(install).open(PAGE);

		expect(page.html).toContain('enctype="multipart/form-data" novalidate');
		expect(page.html).toContain(
			'<p class="wc-form-limits" id="wc-form-1-cv-limits">Accepted: .pdf, .docx. Up to 2 files, each at most 8 KB.</p>',
		);
		expect(page.html).toContain(
			'<input type="file" id="wc-form-1-cv" name="cv" accept=".pdf,.docx" multiple required aria-describedby="wc-form-1-cv-limits">',
		);
		expect(page.html).toContain(
			'<input type="file" id="wc-form-1-photo" name="photo" accept=".png,.jpg,.jpeg" aria-describedby="wc-form-1-photo-limits">',
		);
	});
});

describe("sending files", () => {
	test("a file of a format the field takes is kept with the Submission, privately", async () => {
		const response = await send({ cv: [cv("Siobhán CV.pdf")], photo: [] });

		expect(response.status).toBe(303);
		const submission = await newest();
		const [file] = filesOf(submission, "cv");
		expect(file).toMatchObject({ name: "Siobhán CV.pdf", size: PDF.length, contentType: "application/pdf" });
		expect(file?.uploadId).toMatch(/^[0-9a-f-]{36}$/);
		expect(filesOf(submission, "photo")).toEqual([]);
		// Never in the Media library, and nowhere on the Site.
		expect((await staff.api.media.list({ siteId })).total).toBe(0);
		const onSite = await install.request(`https://bakery.live.test/_media/${file?.uploadId}`);
		expect(onSite.status).toBe(404);
	});

	test("the Management API reads files as links into the admin, never their bytes", async () => {
		await send({ cv: [cv()] });
		const { submission } = await submissions(owner).submissions.get({ siteId, id: (await newest()).id });
		const [file] = filesOf(submission, "cv");

		expect(file?.url).toBe(downloadPath(file?.uploadId ?? null));
		expect(JSON.stringify(submission)).not.toContain("%PDF");
	});

	test("a file that isn't one of the field's formats is refused, by its bytes as well as its name", async () => {
		const notes = await send({ cv: [{ name: "cv.pdf", type: "application/pdf", bytes: "Just some notes" }] });
		expect(notes.status).toBe(422);
		expect(await notes.text()).toContain(
			'<a href="#wc-form-1-cv">Your CV: Choose a file of one of these types: .pdf, .docx.</a>',
		);

		const photo = await send({ cv: [cv()], photo: [{ name: "cake.gif", type: "image/gif", bytes: PNG }] });
		expect(photo.status).toBe(422);
	});

	test("an SVG is never taken, whatever it is called", async () => {
		for (const name of ["cake.png", "cake.svg"]) {
			const response = await send({ cv: [cv()], photo: [{ name, type: "image/png", bytes: SVG }] });
			expect(response.status, name).toBe(422);
			expect(await response.text(), name).toContain(
				'<a href="#wc-form-1-photo">A photo of your bakes: Choose a file of one of these types: .png, .jpg, .jpeg.</a>',
			);
		}
	});

	test("a namespaced SVG cannot be disguised as plain text", async () => {
		const { form } = await staff.api.forms.get({ siteId, formId });
		await staff.api.forms.saveDraft({
			siteId,
			formId,
			form: {
				fields: [...form.draft.fields, { key: "notes_file", type: "file", label: "Notes file", accept: ["txt"] }],
			},
		});
		await staff.api.forms.publish({ siteId, formId });
		const response = await send({
			cv: [cv()],
			notes_file: [{ name: "notes.txt", bytes: '<s:svg xmlns:s="http://www.w3.org/2000/svg"/>' }],
		});
		expect(response.status).toBe(422);
		await staff.api.forms.saveDraft({ siteId, formId, form: { fields: form.draft.fields } });
		await staff.api.forms.publish({ siteId, formId });
	});

	test("a file larger than the field takes, or more files than it takes, is refused", async () => {
		const large = await send({ cv: [cv("big.pdf", `%PDF-1.4\n${"x".repeat(9 * 1024)}`)] });
		expect(large.status).toBe(422);
		expect(await large.text()).toContain('<a href="#wc-form-1-cv">Your CV: Choose a file of 8 KB or less.</a>');

		const many = await send({ cv: [cv("1.pdf"), cv("2.pdf"), cv("3.pdf")] });
		expect(many.status).toBe(422);
		expect(await many.text()).toContain('<a href="#wc-form-1-cv">Your CV: Choose 2 files or fewer.</a>');

		const none = await send({ cv: [] });
		expect(none.status).toBe(422);
		expect(await none.text()).toContain('<a href="#wc-form-1-cv">Your CV: Choose a file.</a>');
	});

	test("a post larger than any Form takes is answered 413 and kept as spam, its files never kept", async () => {
		const before = (await submissions(owner).submissions.list({ siteId, formId, folder: "spam" })).total;
		const huge = new Uint8Array(33 * 1024 * 1024);
		huge.set(new TextEncoder().encode("%PDF-1.4\n"));

		const response = await send({ cv: [cv("huge.pdf", huge)] });

		expect(response.status).toBe(413);
		const spam = await submissions(owner).submissions.list({ siteId, formId, folder: "spam" });
		expect(spam.total).toBe(before + 1);
		expect(spam.submissions[0]).toMatchObject({ spamReason: "size", values: [] });
	});

	test("multipart text has the same byte cap as a post without files, including UTF-8", async () => {
		const response = await send({ cv: [cv()] }, { name: "é".repeat(270_000) });
		expect(response.status).toBe(413);
		expect(await newest("spam")).toMatchObject({ spamReason: "size", values: [] });
	});

	test("spam keeps a file's name and size, never its bytes", async () => {
		const response = await send({ cv: [cv("bot.pdf")] }, { name: "Bot" }, { hidden: { "wc-website": "spam.example" } });

		expect(response.status).toBe(303);
		const [file] = filesOf(await newest("spam"), "cv");
		expect(file).toMatchObject({ uploadId: null, name: "bot.pdf", size: PDF.length });
	});
});

describe("downloading through the admin", () => {
	test("people who may read the Submissions download a file; each download is in the Audit log", async () => {
		await send({ cv: [cv("Order notes.pdf")] });
		const [file] = filesOf(await newest(), "cv");

		const response = await owner.request(downloadPath(file?.uploadId ?? null));

		expect(response.status).toBe(200);
		expect(new Uint8Array(await response.arrayBuffer())).toEqual(new TextEncoder().encode(PDF));
		expect(response.headers.get("content-type")).toBe("application/pdf");
		expect(response.headers.get("content-disposition")).toBe(
			"attachment; filename=\"Order notes.pdf\"; filename*=UTF-8''Order%20notes.pdf",
		);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("cache-control")).toBe("private, no-store");
		expect(response.headers.get("content-security-policy")).toContain("sandbox");
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 1 });
		expect(entries[0]).toMatchObject({
			action: "formUpload.download",
			siteId,
			details: { uploadId: file?.uploadId, formId, name: "Order notes.pdf" },
		});
	});

	test("another Workspace cannot download or delete this Submission's files", async () => {
		await send({ cv: [cv()] });
		const submission = await newest();
		const [file] = filesOf(submission, "cv");
		const otherWorkspace = await install.createWorkspace("Other client");
		const otherSite = await install.createSite(otherWorkspace.id, { slug: "other-client" });
		const other = (await install.createMember({ workspaceId: otherWorkspace.id, role: "owner" })).browser;
		expect((await other.request(downloadPath(file?.uploadId ?? null))).status).toBe(404);
		expect((await other.request(downloadPath(file?.uploadId ?? null, otherSite.id))).status).toBe(404);
		const asked = await submissions(other).submissions.delete({ siteId: otherSite.id, ids: [submission.id] });
		if (asked.deleted) throw new Error("It deleted at once.");
		expect(asked.preview.count).toBe(0);
		await submissions(other).submissions.delete({
			siteId: otherSite.id,
			ids: [submission.id],
			confirmation: asked.confirmation.id,
		});
		expect((await owner.request(downloadPath(file?.uploadId ?? null))).status).toBe(200);
	});

	test("nobody else gets it: not an Author, not another Site's address, not a visitor", async () => {
		await send({ cv: [cv()] });
		const [file] = filesOf(await newest(), "cv");
		const uploadId = file?.uploadId ?? null;

		expect((await author.request(downloadPath(uploadId))).status).toBe(404);
		expect((await owner.request(downloadPath(uploadId, otherSiteId))).status).toBe(404);
		expect((await install.request(downloadPath(uploadId))).status).toBe(404);
	});
});

describe("a Submission's files go with it", () => {
	test("deleting the Submission deletes its files", async () => {
		await send({ cv: [cv("delete-me.pdf")] });
		const submission = await newest();
		const [file] = filesOf(submission, "cv");
		const asked = await submissions(owner).submissions.delete({ siteId, ids: [submission.id] });
		if (asked.deleted) throw new Error("It deleted at once.");

		await submissions(owner).submissions.delete({ siteId, ids: [submission.id], confirmation: asked.confirmation.id });

		expect((await owner.request(downloadPath(file?.uploadId ?? null))).status).toBe(404);
		expect(existsSync(join(install.storageDir, workspaceId, siteId, "form-uploads", file?.uploadId ?? ""))).toBe(false);
	});

	test("Form uploads stay outside the Media quota, even when its Media library is full", async () => {
		const bytes = new Uint8Array(1024 * 1024);
		bytes.set(pdf("Quota filler"));
		await staff.api.workspaces.setQuota({ workspaceId, quotaBytes: bytes.length });
		await staff.api.media.upload({ siteId, file: upload(bytes, "quota.pdf") });
		const before = await staff.api.workspaces.storage({ workspaceId });
		expect(before).toMatchObject({ usedBytes: bytes.length, full: true });
		expect((await send({ cv: [cv()] })).status).toBe(303);
		expect(await staff.api.workspaces.storage({ workspaceId })).toEqual(before);
		await staff.api.workspaces.setQuota({ workspaceId, quotaBytes: null });
	});

	test("so does the Form's retention, when the daily purge deletes the Submission", async () => {
		const { form } = await staff.api.forms.get({ siteId, formId });
		expect(form.id).toBe(formId);
		await submissions(owner).retention.set({ siteId, formId, keepDays: 30 });
		await send({ cv: [cv("old.pdf")] });
		const [file] = filesOf(await newest(), "cv");

		await install.clock.advance(31 * DAY);
		await install.drainJobs();

		const reader = await install.signIn(ownerAccount);
		expect((await reader.request(downloadPath(file?.uploadId ?? null))).status).toBe(404);
		await submissions(reader).retention.set({ siteId, formId, keepDays: null });
	});
});

describe("Notifications", () => {
	const RECIPIENT = "jobs@acmebakery.example";

	beforeAll(async () => {
		// The retention test moved the clock on a month: the Owner signs in again.
		owner = await install.signIn(ownerAccount);
		await (await install.superadmin()).api.install.smtp.update({
			host: "smtp.agency.example",
			port: 587,
			security: "starttls",
			username: null,
			fromAddress: "noreply@agency.example",
			replyTo: null,
		});
		await owner.api.forms.saveEmails({
			siteId,
			formId,
			emails: { notifications: [{ recipients: [RECIPIENT], routing: null, subject: "", intro: "" }] },
		});
		await owner.api.forms.publishEmails({ siteId, formId });
	});

	/** The Notification the recipient got for the newest Submission, once its jobs ran. */
	async function notification() {
		const { failed } = await install.drainJobs();
		expect(failed).toEqual([]);
		const email = install.mail.sent.findLast((sent) => sent.to === RECIPIENT);
		if (!email) throw new Error("No Notification went out.");
		return email;
	}

	test("attach the Submission's files while they come to 10 MB, and always link to the Submission", async () => {
		install.mail.clear();
		await send({
			cv: [cv("Siobhán CV.pdf"), cv("References.pdf")],
			photo: [{ name: "cake.png", type: "image/png", bytes: PNG }],
		});
		const submission = await newest();

		const email = await notification();

		expect(email.attachments?.map((file) => [file.filename, file.contentType, file.content.byteLength])).toEqual([
			["Siobhán CV.pdf", "application/pdf", PDF.length],
			["References.pdf", "application/pdf", PDF.length],
			["cake.png", "image/png", PNG.length],
		]);
		expect(new TextDecoder().decode(email.attachments?.[0]?.content)).toBe(PDF);
		expect(email.text).toContain(
			install.adminUrl(`/sites/${siteId}/forms/${formId}?tab=submissions&submission=${submission.id}`),
		);
		expect(email.text).toContain("Siobhán CV.pdf (3 KB)");
	});

	test("the default 10 MB cap attaches one of two 6 MB files and links the other", async () => {
		const admin = await install.superadmin();
		const { form } = await admin.api.forms.get({ siteId, formId });
		await admin.api.forms.saveDraft({
			siteId,
			formId,
			form: {
				fields: form.draft.fields.map((field) =>
					field.key === "cv" ? { ...field, maxFileBytes: 8 * 1024 * 1024 } : field,
				),
			},
		});
		await admin.api.forms.publish({ siteId, formId });
		const bytes = new Uint8Array(6 * 1024 * 1024);
		bytes.set(new TextEncoder().encode(PDF));
		install.mail.clear();
		await send({ cv: [cv("first-large.pdf", bytes), cv("second-large.pdf", bytes)] });
		const [, second] = filesOf(await newest(), "cv");
		const email = await notification();
		expect(email.attachments?.map((file) => [file.filename, file.content.byteLength])).toEqual([
			["first-large.pdf", bytes.length],
		]);
		expect(email.text).toContain(downloadPath(second?.uploadId ?? null));
		await admin.api.forms.saveDraft({ siteId, formId, form: { fields: form.draft.fields } });
		await admin.api.forms.publish({ siteId, formId });
	});

	test("past the Form's limit, each file is a link to download it in the admin instead", async () => {
		await owner.api.forms.saveEmails({ siteId, formId, emails: { attachmentsMaxBytes: 4 * 1024 } });
		await owner.api.forms.publishEmails({ siteId, formId });
		install.mail.clear();
		await send({ cv: [cv("First.pdf"), cv("Second.pdf")] });
		const [first, second] = filesOf(await newest(), "cv");

		const email = await notification();

		expect(email.attachments?.map((file) => file.filename)).toEqual(["First.pdf"]);
		expect(email.text).toContain(`Second.pdf: ${downloadPath(second?.uploadId ?? null)}`);
		expect(email.text).not.toContain(downloadPath(first?.uploadId ?? null));
		expect(email.html).toContain(`<a href="${downloadPath(second?.uploadId ?? null)}"`);
	});

	test("a Notification whose attachment was deleted does not send incomplete mail or expose its contents in logs", async () => {
		install.mail.clear();
		await send({ cv: [cv("private-attachment.pdf")] });
		const submission = await newest();
		const asked = await submissions(owner).submissions.delete({ siteId, ids: [submission.id] });
		if (asked.deleted) throw new Error("It deleted at once.");
		await submissions(owner).submissions.delete({ siteId, ids: [submission.id], confirmation: asked.confirmation.id });
		await install.drainJobs();
		expect(install.mail.sent.filter((email) => email.to === RECIPIENT)).toEqual([]);
		expect(JSON.stringify(install.logs)).not.toContain(PDF);
	});

	test("a Form may attach nothing: every file is then a link", async () => {
		await owner.api.forms.saveEmails({ siteId, formId, emails: { attachmentsMaxBytes: 0 } });
		await owner.api.forms.publishEmails({ siteId, formId });
		install.mail.clear();
		await send({ cv: [cv("Only.pdf")] });
		const [file] = filesOf(await newest(), "cv");

		const email = await notification();

		expect(email.attachments ?? []).toEqual([]);
		expect(email.text).toContain(`Only.pdf: ${downloadPath(file?.uploadId ?? null)}`);
		await expect(
			owner.api.forms.saveEmails({ siteId, formId, emails: { attachmentsMaxBytes: 26 * 1024 * 1024 } }),
		).rejects.toMatchObject({ code: "FORM_INVALID", data: { problems: [{ at: "attachmentsMaxBytes" }] } });
	});
});

describe("storage failures", () => {
	test("a bucket write failure refuses the post without keeping a Submission or leaking file contents", async () => {
		const settings = {
			endpoint: "https://s3.storage.test",
			bucket: "failed-form-files",
			region: "eu-west-1",
			accessKeyId: "AKIAWEBCRAFTTEST",
			secretAccessKey: "a-test-key-for-form-uploads-0123456789",
		};
		const bucket = createFakeS3(install.http, settings);
		const admin = await install.superadmin();
		await admin.api.session.confirmIdentity({ password: TEST_PASSWORD });
		await admin.api.install.storage.update({ kind: "s3", ...settings, prefix: "", pathStyle: true });
		const before = await submissions(owner).submissions.list({ siteId, formId });
		bucket.fail("PUT", 503);
		expect((await send({ cv: [cv("private-write.pdf")] })).status).toBe(500);
		expect((await submissions(owner).submissions.list({ siteId, formId })).total).toBe(before.total);
		expect(bucket.objects.size).toBe(0);
		expect(JSON.stringify(install.logs)).not.toContain(PDF);
		bucket.recover();
		expect((await send({ cv: [cv("recovered.pdf")] })).status).toBe(303);
		const [file] = filesOf(await newest(), "cv");
		const response = await owner.request(downloadPath(file?.uploadId ?? null));
		expect(response.status).toBe(200);
		expect(await response.text()).toBe(PDF);
		await admin.api.install.storage.update({ kind: "disk" });
	});

	test("a failed bucket deletion is retried without making a deleted Submission's file downloadable", async () => {
		const settings = {
			endpoint: "https://s3.storage.test",
			bucket: "form-files",
			region: "eu-west-1",
			accessKeyId: "AKIAWEBCRAFTTEST",
			secretAccessKey: "a-test-key-for-form-uploads-0123456789",
		};
		const bucket = createFakeS3(install.http, settings);
		await (await install.superadmin()).api.session.confirmIdentity({ password: TEST_PASSWORD });
		await (await install.superadmin()).api.install.storage.update({
			kind: "s3",
			...settings,
			prefix: "",
			pathStyle: true,
		});
		await send({ cv: [cv("remove-from-bucket.pdf")] });
		const submission = await newest();
		const [file] = filesOf(submission, "cv");
		expect(bucket.objects.size).toBe(1);
		bucket.fail("DELETE", 503);
		const firstLog = install.logs.length;
		const asked = await submissions(owner).submissions.delete({ siteId, ids: [submission.id] });
		if (asked.deleted) throw new Error("It deleted at once.");
		await submissions(owner).submissions.delete({ siteId, ids: [submission.id], confirmation: asked.confirmation.id });
		expect((await owner.request(downloadPath(file?.uploadId ?? null))).status).toBe(404);
		expect(bucket.objects.size).toBe(1);
		expect(
			install.logs
				.slice(firstLog)
				.filter((line) => line.msg === "A Form upload's file couldn't be deleted")
				.map((line) => line.level),
		).toEqual(["warn"]);

		bucket.recover();
		await install.clock.advance(2 * DAY);
		await install.drainJobs();
		expect(bucket.objects.size).toBe(0);
		await (await install.superadmin()).api.session.confirmIdentity({ password: TEST_PASSWORD });
		await (await install.superadmin()).api.install.storage.update({ kind: "disk" });
	});
});

test("removing the Forms Module's Site data also removes its private uploads", async () => {
	await send({ cv: [cv("module-data.pdf")] });
	const [file] = filesOf(await newest(), "cv");
	const path = join(install.storageDir, workspaceId, siteId, "form-uploads", file?.uploadId ?? "");
	expect(existsSync(path)).toBe(true);
	const admin = await install.superadmin();
	const asked = await admin.api.modules.removeSiteData({ siteId, moduleId: "forms" });
	if (asked.removed) throw new Error("It removed data at once.");
	await admin.api.modules.removeSiteData({ siteId, moduleId: "forms", confirmation: asked.confirmation.id });
	expect(existsSync(path)).toBe(false);
	await admin.api.modules.setOnSite({ siteId, moduleId: "forms", on: true });
	expect((await owner.request(downloadPath(file?.uploadId ?? null))).status).toBe(404);
});
