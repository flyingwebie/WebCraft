// How many new Submissions wait: for each Form, those in its inbox (never the Spam folder) nobody has
// opened yet, and their sum for the Site. The Forms list carries each Form's, and the Site the admin
// loads for every page carries the sum, so the shell can show "5 new". Only people who may read the
// Submissions get a number; it follows every way a Submission comes, is read, moves or goes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import forms from "@webcraft/module-forms";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { formVisitor } from "../harness/forms.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let editor: TestBrowser;
let author: TestBrowser;
let workspaceId: string;
let siteId: string;

/** The Forms Module's procedures, as a person calls them. */
const submissions = (browser: TestBrowser) => moduleApi<typeof forms>(browser, "forms");

const FIELDS = [
	{ key: "name", type: "text", label: "Your name", required: true },
	{ key: "message", type: "textarea", label: "Message" },
];

type PlacedForm = { formId: string; page: string; templateId: string; postTypeId: string };

/** A published Form placed on a page of its own, `/<key>/form`, by its Post Type's Entry template. */
async function newForm(name: string, key: string): Promise<PlacedForm> {
	const { form } = await staff.api.forms.create({ siteId, name, key });
	await staff.api.forms.saveDraft({ siteId, formId: form.id, form: { fields: FIELDS } });
	await staff.api.forms.publish({ siteId, formId: form.id });
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
	return {
		formId: form.id,
		page: `https://bakery.live.test/${key}/form`,
		templateId: template.id,
		postTypeId: postType.id,
	};
}

/** Sends a Form from its page as a visitor (spam: through the honeypot), and runs the jobs that follow. */
async function send(page: string, name: string, options: { spam?: boolean } = {}): Promise<void> {
	const visitor = formVisitor(install);
	const opened = await visitor.open(page);
	await install.clock.advance(5_000);
	const sent = await visitor.send(
		opened,
		{ name },
		{ hidden: options.spam ? { "wc-website": "https://spam.example" } : {} },
	);
	expect(sent.status).toBe(303);
	await install.drainJobs();
}

/** The new Submissions of each Form, by id, as the Forms list carries them. */
async function newByForm(browser: TestBrowser = staff): Promise<Record<string, number | null>> {
	const { forms: listed } = await browser.api.forms.list({ siteId });
	return Object.fromEntries(listed.map((form) => [form.id, form.newSubmissions]));
}

/** The Site's new Submissions, as the Site the admin loads carries them. */
async function newOnSite(browser: TestBrowser = staff): Promise<number | null> {
	return (await browser.api.sites.get({ siteId })).newSubmissions;
}

/** The ids of a Form's Submissions in a folder, newest first. */
async function idsOf(formId: string, folder: "inbox" | "spam" = "inbox"): Promise<string[]> {
	const listed = await submissions(staff).submissions.list({ siteId, formId, folder });
	return listed.submissions.map((submission) => submission.id);
}

let contact: PlacedForm;
let orders: PlacedForm;
let quiet: PlacedForm;

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "forms", version: forms.manifest.version });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
	contact = await newForm("Contact", "contact");
	orders = await newForm("Orders", "orders");
	quiet = await newForm("Quiet", "quiet");
});

afterAll(async () => {
	await install.close();
});

describe("new Submissions", () => {
	test("none yet: every Form and the Site say 0", async () => {
		expect(await newByForm()).toEqual({ [contact.formId]: 0, [orders.formId]: 0, [quiet.formId]: 0 });
		expect(await newOnSite()).toBe(0);
	});

	test("each one that arrives counts for its Form and the Site; spam never does", async () => {
		await send(contact.page, "Siobhán");
		await send(contact.page, "Luca");
		await send(orders.page, "Hannah");
		await send(contact.page, "Bot", { spam: true });

		expect(await newByForm()).toEqual({ [contact.formId]: 2, [orders.formId]: 1, [quiet.formId]: 0 });
		expect(await newOnSite()).toBe(3);
		// The Spam folder holds one, which no count includes.
		expect(await idsOf(contact.formId, "spam")).toHaveLength(1);
	});

	test("opening one makes it read, for everyone; marking it unread makes it new again", async () => {
		const [newest] = await idsOf(contact.formId);
		if (!newest) throw new Error("The inbox is empty.");

		// The admin marks a Submission read as it opens it.
		await submissions(owner).submissions.setRead({ siteId, ids: [newest], read: true });
		expect((await newByForm())[contact.formId]).toBe(1);
		expect(await newOnSite()).toBe(2);
		// Read for everyone: one inbox per Site.
		expect((await newByForm(editor))[contact.formId]).toBe(1);
		expect(await newOnSite(editor)).toBe(2);

		await submissions(editor).submissions.setRead({ siteId, ids: [newest], read: false });
		expect((await newByForm())[contact.formId]).toBe(2);
		expect(await newOnSite()).toBe(3);
	});

	test("Not spam brings one to the inbox, unread: it is new", async () => {
		const [caught] = await idsOf(contact.formId, "spam");
		if (!caught) throw new Error("The Spam folder is empty.");

		await submissions(staff).submissions.notSpam({ siteId, id: caught });

		expect((await newByForm())[contact.formId]).toBe(3);
		expect(await newOnSite()).toBe(4);
	});

	test("deleting takes the new ones it deletes off; a read one deleted changes nothing", async () => {
		const ids = await idsOf(contact.formId);
		await submissions(staff).submissions.setRead({ siteId, ids: ids.slice(0, 1), read: true });
		expect((await newByForm())[contact.formId]).toBe(2);

		const asked = await submissions(staff).submissions.delete({ siteId, ids: ids.slice(0, 2) });
		if (asked.deleted) throw new Error("Deleting took one step.");
		await submissions(staff).submissions.delete({ siteId, ids: ids.slice(0, 2), confirmation: asked.confirmation.id });

		// One read and one new went: one new is left of the Contact Form's.
		expect(await newByForm()).toEqual({ [contact.formId]: 1, [orders.formId]: 1, [quiet.formId]: 0 });
		expect(await newOnSite()).toBe(2);
	});

	test("Staff, Owners and Editors get the numbers; Authors, who never read Submissions, get none", async () => {
		for (const browser of [staff, owner, editor]) {
			expect(await newOnSite(browser)).toBe(2);
			expect((await newByForm(browser))[orders.formId]).toBe(1);
		}
		expect(await newOnSite(author)).toBeNull();
	});

	test("an API token gets them only with the Submissions Toolset switched on", async () => {
		const plain = tokenClient(install, (await createApiToken(staff, { workspaceId, name: "Plain" })).secret);
		const reading = tokenClient(
			install,
			(await createApiToken(staff, { workspaceId, name: "Reading", toolsets: ["forms", "submissions"] })).secret,
		);

		expect((await plain.api.forms.list({ siteId })).forms.map((form) => form.newSubmissions)).toEqual([
			null,
			null,
			null,
		]);
		expect((await plain.api.sites.get({ siteId })).newSubmissions).toBeNull();
		const listed = await reading.api.forms.list({ siteId });
		expect(listed.forms.find((form) => form.id === orders.formId)?.newSubmissions).toBe(1);
		expect((await reading.api.sites.get({ siteId })).newSubmissions).toBe(2);
	});

	test("a deleted Form's Submissions, which no Form shows, count for the Site no more", async () => {
		await send(quiet.page, "Aoife");
		expect(await newOnSite()).toBe(3);
		// Nothing places it any more, so it can go.
		await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: quiet.postTypeId,
			markup: '<section data-wc-id="s1"><p>Closed.</p></section>',
		});
		await staff.api.templates.publish({ siteId, templateId: quiet.templateId });
		const asked = await staff.api.forms.delete({ siteId, formId: quiet.formId });
		if (asked.deleted) throw new Error("Deleting took one step.");
		await staff.api.forms.delete({ siteId, formId: quiet.formId, confirmation: asked.confirmation.id });

		expect(await newByForm()).toEqual({ [contact.formId]: 1, [orders.formId]: 1 });
		expect(await newOnSite()).toBe(2);
	});

	test("where the Forms Module is off, there is no number", async () => {
		await staff.api.modules.setOnSite({ siteId, moduleId: "forms", on: false });
		try {
			expect(await newOnSite()).toBeNull();
			expect(Object.values(await newByForm())).toEqual([null, null]);
		} finally {
			await staff.api.modules.setOnSite({ siteId, moduleId: "forms", on: true });
		}
		expect(await newOnSite()).toBe(2);
	});
});

describe("another Site", () => {
	test("counts its own Submissions only", async () => {
		const otherId = (await install.createSite(workspaceId, { name: "Acme Café", slug: "cafe" })).id;

		expect((await staff.api.sites.get({ siteId: otherId })).newSubmissions).toBe(0);
		expect((await staff.api.forms.list({ siteId: otherId })).forms).toEqual([]);
		expect(await newOnSite()).toBe(2);
	});
});

describe("a Module that can't count", () => {
	test("gives no number, says why in the Module log, and never keeps the Site from loading", async () => {
		let answer: () => Promise<unknown> = async () => {
			throw new Error("The count failed.");
		};
		const receiver = forms.formSubmissions;
		if (!receiver) throw new Error("The Forms Module keeps no Submissions.");
		const failing = {
			...forms,
			formSubmissions: { ...receiver, unread: () => answer() as Promise<Record<string, number>> },
		};
		const other = await createTestInstall({ modules: [failing] });
		try {
			const admin = await other.superadmin();
			await admin.api.modules.approve({ moduleId: "forms", version: forms.manifest.version });
			const otherWorkspace = (await other.createWorkspace("Acme Ltd")).id;
			const otherSite = (await other.createSite(otherWorkspace, { name: "Acme Bakery", slug: "bakery" })).id;
			const person = (await other.createStaff({ workspaces: [otherWorkspace] })).browser;
			await person.api.forms.create({ siteId: otherSite, name: "Contact", key: "contact" });

			expect((await person.api.sites.get({ siteId: otherSite })).newSubmissions).toBeNull();
			expect((await person.api.forms.list({ siteId: otherSite })).forms.map((form) => form.newSubmissions)).toEqual([
				null,
			]);
			const { lines } = await admin.api.modules.log({ moduleId: "forms" });
			expect(lines[0]).toMatchObject({
				level: "warn",
				message: "It couldn't count the new Form Submissions.",
				details: { error: { message: "The count failed." } },
			});

			// An answer that isn't counts by Form is no number either.
			answer = async () => ["3"];
			expect((await person.api.sites.get({ siteId: otherSite })).newSubmissions).toBeNull();
			expect((await admin.api.modules.log({ moduleId: "forms" })).lines[0]?.message).toBe(
				"Its count of new Form Submissions isn't counts by Form.",
			);
		} finally {
			await other.close();
		}
	});
});
