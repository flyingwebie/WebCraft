// The Forms place's other tabs on the server (ADR 0037, BA-27): Settings renames a Form from the Site's
// own address; Translations fills a Form's missing translations with AI into its Draft; Emails saves
// the emails' words and publishes them apart from the fields, while a change to who receives
// Submissions (a Sensitive action) is refused there and stays the admin's, where the password is
// asked again. Deleting a Form and its CAPTCHA stay the admin's.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { emptyField } from "@webcraft/renderer/forms";

import { openBuildingArea } from "../harness/building-area.ts";
import { type BuildingAreaApi, buildingAreaApi, refusalOf } from "../harness/building-area-api.ts";
import { taggedTranslation } from "../harness/fake-ai.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { rejection } from "../harness/settled.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let workspaceId: string;
let siteId: string;
let staffArea: BuildingAreaApi;
let ownerArea: BuildingAreaApi;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await staff.api.languages.add({ siteId, code: "it" });
	staffArea = buildingAreaApi(install, await openBuildingArea(install, staff, siteId));
	ownerArea = buildingAreaApi(install, await openBuildingArea(install, owner, siteId));
});

afterAll(async () => {
	await install.close();
});

/** A published Form with a name and an email field, an option list, and an Italian label already written. */
async function cakeForm(name: string) {
	const { form } = await staff.api.forms.create({ siteId, name });
	await staff.api.forms.saveDraft({
		siteId,
		formId: form.id,
		form: {
			fields: [
				{ ...emptyField("name", "text", { text: "Name", translations: { it: "Nome" } }), required: true },
				{ ...emptyField("email", "email", { text: "Email" }), help: { text: "We'll send your confirmation here." } },
				{
					...emptyField("cake", "select", { text: "Cake" }),
					options: [
						{ value: "wedding", label: { text: "Wedding cake" } },
						{ value: "birthday", label: { text: "Birthday cake" } },
					],
				},
			],
			submitLabel: { text: "Send my order" },
		},
	});
	await staff.api.forms.publish({ siteId, formId: form.id });
	return form.id;
}

describe("Settings", () => {
	test("Staff rename a Form and change its key from the Site's address; a Member may not", async () => {
		const formId = await cakeForm("Order a cake");
		const { form } = await staffArea.api.forms.rename({ siteId, formId, name: "Cake orders", key: "cake-orders" });
		expect(form).toMatchObject({ name: "Cake orders", key: "cake-orders" });
		expect(await rejection(ownerArea.api.forms.rename({ siteId, formId, name: "Mine" }))).toMatchObject({
			code: "FORBIDDEN",
		});
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 200 });
		const logged = entries.find((entry) => entry.siteId === siteId && entry.action === "form.rename");
		expect(logged).toMatchObject({ via: { kind: "editMode" } });
	});
});

describe("Translations", () => {
	test("without the Workspace's AI key nothing is filled, and the Draft stays as it was", async () => {
		const formId = await cakeForm("Contact");
		const refused = staffArea.api.forms.translateMissing({ siteId, formId, language: "it" });
		expect(await rejection(refused)).toMatchObject({ code: "AI_KEY_MISSING" });
		const { form } = await staff.api.forms.get({ siteId, formId });
		expect(form.draft.fields[1]?.label).toEqual({ text: "Email" });
	});

	test("the missing ones are filled in the Draft with AI; those written stay, and nothing goes live", async () => {
		const formId = await cakeForm("Booking request");
		await owner.api.aiKeys.setOwn({
			workspaceId,
			provider: "openai",
			model: "gpt-5-mini",
			endpoint: null,
			key: "sk-forms-tabs-test-key-0123456789",
		});
		install.ai.translateWith(taggedTranslation);

		const { form, filled } = await staffArea.api.forms.translateMissing({ siteId, formId, language: "it" });
		// Email, its help, Cake, two options and the button: the name's label was written by a person.
		expect(filled).toBe(6);
		expect(form.draft.fields[0]?.label).toEqual({ text: "Name", translations: { it: "Nome" } });
		expect(form.draft.fields[1]?.label.translations).toEqual({ it: "[it] Email" });
		expect(form.draft.fields[1]?.help?.translations).toEqual({ it: "[it] We'll send your confirmation here." });
		expect(form.draft.fields[2]?.options.map((option) => option.label.translations?.it)).toEqual([
			"[it] Wedding cake",
			"[it] Birthday cake",
		]);
		expect(form.draft.submitLabel.translations).toEqual({ it: "[it] Send my order" });
		expect(form.published?.submitLabel.translations).toBeUndefined();

		// Asked again, there is nothing missing: nothing is sent.
		const sent = install.ai.translations().length;
		expect((await staffArea.api.forms.translateMissing({ siteId, formId, language: "it" })).filled).toBe(0);
		expect(install.ai.translations().length).toBe(sent);

		// The Default language has nothing to fill, and a Member may not ask.
		expect(await rejection(staffArea.api.forms.translateMissing({ siteId, formId, language: "en" }))).toMatchObject({
			code: "TRANSLATION_LANGUAGE_INVALID",
		});
		expect(await rejection(ownerArea.api.forms.translateMissing({ siteId, formId, language: "it" }))).toMatchObject({
			code: "FORBIDDEN",
		});
	});
});

describe("Emails", () => {
	test("their words are saved and published apart from the fields; who receives them stays the admin's", async () => {
		const formId = await cakeForm("Job application");
		// Who receives them is set in the admin, where the identity check is.
		await owner.api.forms.saveEmails({
			siteId,
			formId,
			emails: { notifications: [{ recipients: ["bakery@acme.example"], routing: null, subject: "", intro: "" }] },
		});

		const words = {
			notifications: [
				{ recipients: ["bakery@acme.example"], routing: null, subject: "A new order", intro: "Someone ordered." },
			],
			autoReply: { enabled: true, field: "email", subject: { text: "Thanks" }, text: { text: "We'll be in touch." } },
		};
		const { form: saved } = await ownerArea.api.forms.saveEmails({ siteId, formId, emails: words });
		expect(saved.emails.draft.notifications[0]?.subject).toBe("A new order");
		expect(saved.emails.status).toBe("draft");

		// Another address, or one more Notification, is a Sensitive action: refused on the Site's address.
		for (const notifications of [
			[{ recipients: ["thief@elsewhere.example"], routing: null, subject: "", intro: "" }],
			[...words.notifications, { recipients: ["thief@elsewhere.example"], routing: null, subject: "", intro: "" }],
		]) {
			const refused = ownerArea.api.forms.saveEmails({ siteId, formId, emails: { notifications } });
			expect(await rejection(refused)).toMatchObject({ code: "SENSITIVE_ACTION_REFUSED" });
		}
		const kept = (await staff.api.forms.get({ siteId, formId })).form;
		expect(kept.emails.draft.notifications.map((each) => each.recipients)).toEqual([["bakery@acme.example"]]);

		const { form } = await staffArea.api.forms.publishEmails({ siteId, formId });
		expect(form.emails.status).toBe("published");
		expect(form.emails.published?.autoReply).toMatchObject({ enabled: true, subject: { text: "Thanks" } });
		expect(form.status).toBe("published");

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 200 });
		const logged = entries.find((entry) => entry.siteId === siteId && entry.action === "formEmails.publish");
		expect(logged).toMatchObject({ via: { kind: "editMode" } });
	});
});

describe("what stays the admin's", () => {
	test("deleting a Form and its CAPTCHA are not on the Site's address", async () => {
		const formId = await cakeForm("Newsletter sign-up");
		for (const [path, input] of [
			["forms.delete", { siteId, formId }],
			["forms.captcha.get", { siteId }],
		] as const) {
			const refusal = await refusalOf(await staffArea.call(path, input));
			expect({ path, refusal }).toMatchObject({ path, refusal: { status: 404, code: "NOT_FOUND" } });
		}
		expect((await staff.api.forms.get({ siteId, formId })).form.name).toBe("Newsletter sign-up");
	});
});
