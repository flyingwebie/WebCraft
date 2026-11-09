// Forms are Structure (GLOSSARY.md): Staff build each one in the admin, with a Draft and a published
// version, its fields and their labels, help, options and messages in every language.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let siteId: string;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
});

afterAll(async () => {
	await install.close();
});

describe("creating a Form", () => {
	test("Staff name it; its key is made from the name, and it starts as a Draft with no fields", async () => {
		const { form } = await staff.api.forms.create({ siteId, name: "Wedding cake enquiry" });

		expect(form).toMatchObject({
			siteId,
			key: "wedding-cake-enquiry",
			name: "Wedding cake enquiry",
			status: "draft",
			published: null,
			publishedAt: null,
			draft: {
				fields: [],
				submitLabel: { text: "Send" },
				success: { kind: "message", message: { text: "Thank you. We have received your message." } },
				spam: { minFillSeconds: 3, perMinute: 5, perHour: 30 },
			},
		});
		expect((await staff.api.forms.get({ siteId, formId: form.id })).form).toEqual(form);
		const { forms } = await staff.api.forms.list({ siteId });
		expect(forms.map((listed) => [listed.key, listed.status])).toContainEqual(["wedding-cake-enquiry", "draft"]);
	});

	test("a key is lower-case words joined by dashes, and names one Form of the Site", async () => {
		await staff.api.forms.create({ siteId, name: "Newsletter", key: "newsletter" });

		await expect(staff.api.forms.create({ siteId, name: "Another", key: "newsletter" })).rejects.toMatchObject({
			code: "FORM_KEY_TAKEN",
			data: { key: "newsletter" },
		});
		await expect(staff.api.forms.create({ siteId, name: "Bad", key: "Not A Key" })).rejects.toMatchObject({
			code: "FORM_INVALID",
			data: { problems: [{ at: "key" }] },
		});
		await expect(staff.api.forms.create({ siteId, name: "  " })).rejects.toMatchObject({
			code: "FORM_INVALID",
			data: { problems: [{ at: "name" }] },
		});
	});

	test("Members never build Forms: their fields are Structure (Owners read them, for their Submissions and emails)", async () => {
		const { form } = await staff.api.forms.create({ siteId, name: "Staff only" });

		expect((await owner.api.forms.get({ siteId, formId: form.id })).form.name).toBe("Staff only");
		await expect(owner.api.forms.create({ siteId, name: "Mine" })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			owner.api.forms.saveDraft({ siteId, formId: form.id, form: { submitLabel: "Go" } }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(owner.api.forms.rename({ siteId, formId: form.id, name: "Mine" })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});

describe("building a Form", () => {
	test("Staff save its fields to the Draft; every setting comes back, unset ones as null", async () => {
		const { form } = await staff.api.forms.create({ siteId, name: "Contact" });

		const { form: saved } = await staff.api.forms.saveDraft({
			siteId,
			formId: form.id,
			form: {
				fields: [
					{ key: "name", type: "text", label: "Your name", required: true, autocomplete: "name" },
					{ key: "email", type: "email", label: { text: "Email", translations: { it: "Email" } }, required: true },
					{ key: "phone", type: "phone", label: "Phone", help: "We call back within a day." },
					{
						key: "cake",
						type: "select",
						label: "Cake",
						options: [
							{ value: "single", label: "Single tier" },
							{ value: "tiered", label: { text: "Tiered", translations: { it: "A piani" } } },
						],
					},
					{ key: "tiers", type: "number", label: "Tiers", min: 2, max: 6, integer: true },
					{ key: "message", type: "textarea", label: "Message", maxLength: 2000 },
					{ key: "consent", type: "consent", label: "I agree to be contacted", required: true },
					{ key: "source", type: "hidden", label: "Campaign", source: { kind: "query", name: "utm_source" } },
				],
				submitLabel: { text: "Send enquiry", translations: { it: "Invia richiesta" } },
				success: { kind: "message", message: "Thanks! A baker will be in touch." },
				spam: { minFillSeconds: 2, perMinute: 3, perHour: 20 },
			},
		});

		expect(saved.status).toBe("draft");
		expect(saved.draft.fields[0]).toEqual({
			key: "name",
			type: "text",
			label: { text: "Your name" },
			hideLabel: false,
			help: null,
			placeholder: null,
			message: null,
			required: true,
			minLength: null,
			maxLength: null,
			pattern: null,
			autocomplete: "name",
			min: null,
			max: null,
			integer: false,
			minDate: null,
			maxDate: null,
			options: [],
			minChoices: null,
			maxChoices: null,
			source: null,
		});
		expect(saved.draft.fields.map((field) => [field.key, field.type, field.required])).toEqual([
			["name", "text", true],
			["email", "email", true],
			["phone", "phone", false],
			["cake", "select", false],
			["tiers", "number", false],
			["message", "textarea", false],
			["consent", "consent", true],
			["source", "hidden", false],
		]);
		expect(saved.draft.fields[3]?.options).toEqual([
			{ value: "single", label: { text: "Single tier" } },
			{ value: "tiered", label: { text: "Tiered", translations: { it: "A piani" } } },
		]);
		expect(saved.draft.fields[7]?.source).toEqual({ kind: "query", name: "utm_source" });
		expect(saved.draft.submitLabel).toEqual({ text: "Send enquiry", translations: { it: "Invia richiesta" } });
		expect(saved.draft.success).toEqual({ kind: "message", message: { text: "Thanks! A baker will be in touch." } });
		expect(saved.draft.spam).toEqual({ minFillSeconds: 2, perMinute: 3, perHour: 20 });
		expect(saved.published).toBeNull();
	});

	test("what can't be saved is refused with every problem where it is", async () => {
		const { form } = await staff.api.forms.create({ siteId, name: "Broken" });

		const refused = staff.api.forms.saveDraft({
			siteId,
			formId: form.id,
			form: {
				fields: [
					{ key: "name", type: "text", label: "Name" },
					{ key: "name", type: "email", label: "Email" },
					{ key: "Bad-Key", type: "text", label: "Bad" },
					{ key: "colour", type: "radio", label: "Colour", options: [] },
					{ key: "code", type: "text", label: "Code", pattern: "(?=a)b" },
					{ key: "blank", type: "text", label: "   " },
					{ key: "age", type: "number", label: "Age", min: 10, max: 2 },
					{ key: "where", type: "nowhere", label: "Where" },
					{ key: "said", type: "text", label: { text: "Said", translations: { klingon: "x" } } },
				],
			},
		});

		await expect(refused).rejects.toMatchObject({ code: "FORM_INVALID" });
		const problems = ((await refused.catch((error) => error)) as { data: { problems: { at: string }[] } }).data
			.problems;
		expect(problems.map((problem) => problem.at)).toEqual([
			"fields[1].key",
			"fields[2].key",
			"fields[3].options",
			"fields[4].pattern",
			"fields[5].label",
			"fields[6].max",
			"fields[7].type",
			"fields[8].label.translations.klingon",
		]);
	});

	test("every field has a label, which may be visually hidden", async () => {
		const { form } = await staff.api.forms.create({ siteId, name: "Search box" });

		const { form: saved } = await staff.api.forms.saveDraft({
			siteId,
			formId: form.id,
			form: { fields: [{ key: "q", type: "text", label: "Search the site", hideLabel: true }] },
		});

		expect(saved.draft.fields[0]).toMatchObject({ label: { text: "Search the site" }, hideLabel: true });
		await expect(
			staff.api.forms.saveDraft({ siteId, formId: form.id, form: { fields: [{ key: "q", type: "text" }] } }),
		).rejects.toMatchObject({ code: "FORM_INVALID", data: { problems: [{ at: "fields[0].label" }] } });
	});

	test("a redirect after sending goes to one of the Site's Pages", async () => {
		const { form } = await staff.api.forms.create({ siteId, name: "Booking" });
		const pages = (await staff.api.postTypes.list({ siteId })).postTypes.find(
			(postType) => postType.builtIn === "page",
		);
		const { entry: thanks } = await staff.api.entries.create({
			siteId,
			postTypeId: pages?.id ?? "",
			title: "Thanks",
			fields: {},
		});

		const { form: saved } = await staff.api.forms.saveDraft({
			siteId,
			formId: form.id,
			form: { success: { kind: "redirect", pageId: thanks.id } },
		});

		expect(saved.draft.success).toEqual({ kind: "redirect", pageId: thanks.id });
		await expect(
			staff.api.forms.saveDraft({
				siteId,
				formId: form.id,
				form: { success: { kind: "redirect", pageId: crypto.randomUUID() } },
			}),
		).rejects.toMatchObject({ code: "FORM_INVALID", data: { problems: [{ at: "success.pageId" }] } });
	});

	test("publishing makes the Draft what visitors fill in; a later save changes only the Draft", async () => {
		const { form } = await staff.api.forms.create({ siteId, name: "Quote" });
		await staff.api.forms.saveDraft({
			siteId,
			formId: form.id,
			form: { fields: [{ key: "email", type: "email", label: "Email", required: true }] },
		});

		const { form: published } = await staff.api.forms.publish({ siteId, formId: form.id });

		expect(published.status).toBe("published");
		expect(published.published?.fields.map((field) => field.key)).toEqual(["email"]);
		expect(published.publishedAt).not.toBeNull();
		const { form: changed } = await staff.api.forms.saveDraft({
			siteId,
			formId: form.id,
			form: { fields: [{ key: "phone", type: "phone", label: "Phone" }] },
		});
		expect(changed.status).toBe("changed");
		expect(changed.published?.fields.map((field) => field.key)).toEqual(["email"]);
		await expect(owner.api.forms.publish({ siteId, formId: form.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 5 });
		expect(entries.map((entry) => entry.action)).toContain("form.publish");
	});

	test("Staff change a Form's name and key", async () => {
		const { form } = await staff.api.forms.create({ siteId, name: "Old name" });

		const { form: renamed } = await staff.api.forms.rename({ siteId, formId: form.id, name: "New name", key: "new" });

		expect(renamed).toMatchObject({ name: "New name", key: "new" });
		await expect(staff.api.forms.rename({ siteId, formId: form.id, key: "newsletter" })).rejects.toMatchObject({
			code: "FORM_KEY_TAKEN",
		});
	});

	test("deleting takes two steps", async () => {
		const { form } = await staff.api.forms.create({ siteId, name: "Gone soon" });

		const first = await staff.api.forms.delete({ siteId, formId: form.id });
		expect(first.deleted).toBe(false);
		const second = await staff.api.forms.delete({
			siteId,
			formId: form.id,
			confirmation: first.deleted ? "" : first.confirmation.id,
		});

		expect(second.deleted).toBe(true);
		await expect(staff.api.forms.get({ siteId, formId: form.id })).rejects.toMatchObject({ code: "FORM_NOT_FOUND" });
	});
});
