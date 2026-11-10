// Richer Forms (spec stories 97 and 98): sections, steps and conditions, built by Staff in the Form's
// Structure. Sections and steps are fieldsets named by their legends; without JavaScript every step
// shows on one page and the server checks the whole Form. Conditions show or hide fields, sections and
// steps by other fields' values; the server reads the same conditions, and what they hide is neither
// checked nor kept.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import forms from "@webcraft/module-forms";

import { formVisitor } from "../harness/forms.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let siteId: string;
let formId: string;
const PAGE = "https://bakery.live.test/visit/order";

/** A cake order: a step about the visitor, then one about the cake, with a section and conditions. */
const ORDER_FIELDS = [
	{ key: "about_you", type: "step", label: { text: "About you", translations: { it: "Chi sei" } } },
	{ key: "name", type: "text", label: "Your name", required: true },
	{
		key: "contact_by",
		type: "radio",
		label: "Contact me by",
		required: true,
		options: [
			{ value: "email", label: "Email" },
			{ value: "phone", label: "Phone" },
		],
	},
	{
		key: "email",
		type: "email",
		label: "Email",
		required: true,
		condition: { match: "all", rules: [{ field: "contact_by", op: "is", value: "email" }] },
	},
	{
		key: "phone",
		type: "phone",
		label: "Phone",
		required: true,
		condition: { match: "all", rules: [{ field: "contact_by", op: "is", value: "phone" }] },
	},
	{ key: "the_cake", type: "step", label: "The cake", help: "Tell us what you'd like." },
	{
		key: "cake",
		type: "select",
		label: "Cake",
		required: true,
		options: [
			{ value: "single", label: "Single tier" },
			{ value: "tiered", label: "Tiered" },
		],
	},
	{
		key: "tiers_section",
		type: "section",
		label: "Tiers",
		help: "Only for tiered cakes.",
		condition: { match: "any", rules: [{ field: "cake", op: "is", value: "tiered" }] },
	},
	{ key: "tiers", type: "number", label: "How many tiers", required: true, min: 2, max: 6, integer: true },
	{ key: "flavours", type: "text", label: "Flavours" },
	{ key: "notes_section", type: "section", label: "Anything else" },
	{ key: "notes", type: "textarea", label: "Notes" },
];

/** The Submissions kept for the Form, newest first. */
async function kept(folder: "inbox" | "spam" = "inbox") {
	return (await moduleApi<typeof forms>(owner, "forms").submissions.list({ siteId, formId, folder })).submissions;
}

/** Sends the Form from its page as a visitor without JavaScript does. */
async function send(fields: Record<string, string | readonly string[]>) {
	const visitor = formVisitor(install);
	const page = await visitor.open(PAGE);
	await install.clock.advance(5_000);
	return visitor.send(page, fields);
}

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "forms", version: forms.manifest.version });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	const { form } = await staff.api.forms.create({ siteId, name: "Cake order", key: "order" });
	formId = form.id;
	await staff.api.forms.saveDraft({ siteId, formId, form: { fields: ORDER_FIELDS } });
	await staff.api.forms.publish({ siteId, formId });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Visits", urlPattern: "/visit/{slug}" });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<section data-wc-id="s1"><h1 data-wc-id="h1">{{ title }}</h1>{{@form order}}</section>',
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Order", slug: "order" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
});

afterAll(async () => {
	await install.close();
});

describe("building a Form with steps, sections and conditions", () => {
	test("Staff save them in the Draft, in order; each comes back with every setting", async () => {
		const { form } = await staff.api.forms.get({ siteId, formId });

		expect(form.draft.fields.map((field) => [field.key, field.type])).toEqual(
			ORDER_FIELDS.map((field) => [field.key, field.type]),
		);
		expect(form.draft.fields[0]).toMatchObject({
			key: "about_you",
			type: "step",
			label: { text: "About you", translations: { it: "Chi sei" } },
			required: false,
			condition: null,
		});
		expect(form.draft.fields[3]?.condition).toEqual({
			match: "all",
			rules: [{ field: "contact_by", op: "is", value: "email" }],
		});
		expect(form.draft.fields[7]).toMatchObject({
			type: "section",
			help: { text: "Only for tiered cakes." },
			condition: { match: "any", rules: [{ field: "cake", op: "is", value: "tiered" }] },
		});
	});

	test("what can't be shaped so is refused, each problem where it is", async () => {
		const { form } = await staff.api.forms.create({ siteId, name: "Broken order" });

		const refused = staff.api.forms.saveDraft({
			siteId,
			formId: form.id,
			form: {
				fields: [
					{ key: "intro", type: "section", label: "Intro" },
					{ key: "first", type: "step", label: "First" },
					{
						key: "name",
						type: "text",
						label: "Name",
						condition: { match: "all", rules: [{ field: "age", op: "isEmpty" }] },
					},
					{ key: "age", type: "number", label: "Age" },
					{
						key: "self",
						type: "text",
						label: "Self",
						condition: { match: "all", rules: [{ field: "self", op: "isEmpty" }] },
					},
					{ key: "campaign", type: "hidden", label: "Campaign" },
					{
						key: "late",
						type: "text",
						label: "Late",
						condition: { match: "all", rules: [{ field: "campaign", op: "is", value: "x" }] },
					},
					{
						key: "odd",
						type: "text",
						label: "Odd",
						condition: { match: "some", rules: [{ field: "age", op: "isEmpty" }] },
					},
					{
						key: "bigger",
						type: "text",
						label: "Bigger",
						condition: { match: "all", rules: [{ field: "age", op: "greaterThan", value: "ten" }] },
					},
					{ key: "box", type: "section", label: "Box", required: true },
				],
			},
		});

		await expect(refused).rejects.toMatchObject({ code: "FORM_INVALID" });
		const problems = ((await refused.catch((error) => error)) as { data: { problems: { at: string }[] } }).data
			.problems;
		expect(problems.map((problem) => problem.at)).toEqual([
			"fields[0]",
			"fields[2].condition.rules[0].field",
			"fields[4].condition.rules[0].field",
			"fields[6].condition.rules[0].field",
			"fields[7].condition.match",
			"fields[8].condition.rules[0].value",
			"fields[9].required",
		]);
	});
});

describe("on the page, without JavaScript", () => {
	test("every step shows, each a fieldset named by its legend, with sections inside it", async () => {
		const page = await formVisitor(install).open(PAGE);

		expect(page.status).toBe(200);
		expect(page.html).toContain(
			'<fieldset class="wc-form-step" id="wc-form-1-about_you" data-wc-key="about_you" data-wc-step="1"><legend>About you</legend>',
		);
		expect(page.html).toContain(
			`<fieldset class="wc-form-step" id="wc-form-1-the_cake" data-wc-key="the_cake" data-wc-step="2" aria-describedby="wc-form-1-the_cake-help"><legend>The cake</legend><p class="wc-form-help" id="wc-form-1-the_cake-help">Tell us what you'd like.</p>`,
		);
		expect(page.html).toContain(
			'<fieldset class="wc-form-section" id="wc-form-1-tiers_section" data-wc-key="tiers_section" aria-describedby="wc-form-1-tiers_section-help"><legend>Tiers</legend>',
		);
		// A section ends where the next one starts; a step closes its sections.
		expect(page.html).toMatch(
			/id="wc-form-1-flavours"[\s\S]*?<\/fieldset><fieldset class="wc-form-section" id="wc-form-1-notes_section"/,
		);
		// Fields shown under a condition say which they are, for the forms script.
		expect(page.html).toContain('<div class="wc-form-field" data-type="email" data-wc-key="email">');
		// The progress and the Back and Next buttons wait, hidden, for the script.
		expect(page.html).toContain(
			'<ol class="wc-form-progress" id="wc-form-1-progress" hidden><li data-wc-step="1">About you</li><li data-wc-step="2">The cake</li></ol>',
		);
		expect(page.html).toContain(
			'<div class="wc-form-step-nav" hidden><button type="button" class="wc-form-next">Next</button></div></fieldset>',
		);
		expect(page.html).toContain(
			'<div class="wc-form-step-nav" hidden><button type="button" class="wc-form-back">Back</button></div></fieldset>',
		);
		await expectSafePage(await install.request(PAGE));
	});

	test("the server checks every step at once, and only what the conditions show", async () => {
		const response = await send({ name: "", contact_by: "phone", email: "not an address", cake: "tiered" });

		expect(response.status).toBe(422);
		const html = await response.text();
		// The name and the phone (shown: contact by phone) are missing, and so are the tiers (shown: tiered).
		expect(html).toContain('<a href="#wc-form-1-name">Your name: Enter a value.</a>');
		expect(html).toContain('<a href="#wc-form-1-phone">Phone: Enter a value.</a>');
		expect(html).toContain('<a href="#wc-form-1-tiers">How many tiers: Enter a value.</a>');
		// The email field is hidden (contact by phone): its value is never checked.
		expect(html).not.toContain('<a href="#wc-form-1-email">');
		expect(await kept()).toEqual([]);
	});

	test("what a condition hides is neither checked nor kept", async () => {
		const response = await send({
			name: "Siobhán",
			contact_by: "email",
			email: "siobhan@example.ie",
			phone: "not a phone",
			cake: "single",
			tiers: "99",
			flavours: "Lemon",
			notes: "Thanks",
		});

		expect(response.status).toBe(303);
		const [submission] = await kept();
		expect(submission?.values.map((value) => [value.key, value.value])).toEqual([
			["name", "Siobhán"],
			["contact_by", "email"],
			["email", "siobhan@example.ie"],
			["cake", "single"],
			["notes", "Thanks"],
		]);
	});

	test("invalid spam still omits every value hidden by a condition", async () => {
		const visitor = formVisitor(install);
		const page = await visitor.open(PAGE);
		await install.clock.advance(5_000);
		const response = await visitor.send(
			page,
			{
				name: "",
				contact_by: "email",
				email: "broken",
				phone: "private hidden phone",
				cake: "single",
				tiers: "99",
				flavours: "private hidden flavours",
			},
			{ hidden: { "wc-website": "spam.example" } },
		);

		expect(response.status).toBe(303);
		const [submission] = await kept("spam");
		expect(submission?.values.map((value) => value.key)).toEqual(["name", "contact_by", "email", "cake", "notes"]);
		expect(JSON.stringify(submission)).not.toContain("private hidden");
	});

	test("hidden steps ignore forged files and hidden controllers cannot reveal later steps", async () => {
		await staff.api.forms.saveDraft({
			siteId,
			formId,
			form: {
				fields: [
					...ORDER_FIELDS,
					{
						key: "extra",
						type: "step",
						label: "Large cake",
						condition: { match: "all", rules: [{ field: "tiers", op: "greaterThan", value: "3" }] },
					},
					{ key: "plan", type: "file", label: "Plan", required: true, accept: ["pdf"] },
				],
			},
		});
		await staff.api.forms.publish({ siteId, formId });
		const visitor = formVisitor(install);
		const page = await visitor.open(PAGE);
		await install.clock.advance(5_000);
		const fields = { name: "Siobhán", contact_by: "email", email: "siobhan@example.ie", cake: "single", tiers: "99" };
		const hidden = await visitor.send(page, fields, {
			files: { plan: [{ name: "not-a-pdf.pdf", bytes: "not a PDF" }] },
		});
		expect(hidden.status).toBe(303);
		expect((await kept())[0]?.values.map((value) => value.key)).toEqual([
			"name",
			"contact_by",
			"email",
			"cake",
			"notes",
		]);
		const shown = await visitor.send(
			page,
			{ ...fields, cake: "tiered", tiers: "4" },
			{ files: { plan: [] }, headers: { "x-webcraft-form": "1" } },
		);
		expect(shown.status).toBe(422);
		expect(await shown.json()).toMatchObject({ errors: { plan: "Choose a file." } });
		await staff.api.forms.saveDraft({ siteId, formId, form: { fields: ORDER_FIELDS } });
		await staff.api.forms.publish({ siteId, formId });
	});
});

describe("with the forms script", () => {
	test("a page showing a Form links it, a hashed file of the Site's own; other pages carry none", async () => {
		const page = await formVisitor(install).open(PAGE);
		const src = page.html.match(/<script src="(\/_wc\/js\/[0-9a-f]{16}\.js)" defer><\/script>/)?.[1];
		expect(src).toBeDefined();

		const script = await install.request(`https://bakery.live.test${src}`);
		expect(script.status).toBe(200);
		expect(script.headers.get("content-type")).toContain("javascript");
		const code = await script.text();
		// It runs the very rules the server runs: conditions and checks.
		expect(code).toContain("visibleKeys");
		expect(code).toContain("checkFiles");
		expect(code).toContain("x-webcraft-form");

		const home = await install.request("https://bakery.live.test/");
		expect(await home.text()).not.toContain(src ?? "");
	});

	test("the Form's rules are data on the form, never code", async () => {
		const page = await formVisitor(install).open(PAGE);
		const encoded = page.html.match(/data-wc-rules="([^"]*)"/)?.[1] ?? "";
		const rules = JSON.parse(encoded.replaceAll("&quot;", '"').replaceAll("&amp;", "&").replaceAll("&#39;", "'"));

		expect(rules.fields.map((field: { key: string }) => field.key)).toEqual(ORDER_FIELDS.map((field) => field.key));
		expect(rules.fields[3]).toMatchObject({
			key: "email",
			required: true,
			condition: { match: "all", rules: [{ field: "contact_by", op: "is", value: "email" }] },
		});
		expect(rules.words).toMatchObject({ step: "Step {n} of {count}", problem: "There is a problem: 1 error." });
	});

	test("its posts are answered in JSON: each error, or the Form's message", async () => {
		const visitor = formVisitor(install);
		const page = await visitor.open(PAGE);
		await install.clock.advance(5_000);
		const headers = { "x-webcraft-form": "1" };

		const refused = await visitor.send(page, { name: "", contact_by: "email", email: "nope" }, { headers });
		expect(refused.status).toBe(422);
		expect(refused.headers.get("content-type")).toContain("application/json");
		expect(await refused.json()).toEqual({
			sent: false,
			errors: {
				name: "Enter a value.",
				email: "Enter an email address, such as name@example.com.",
				cake: "Choose an option.",
			},
			formError: null,
		});

		const sent = await visitor.send(
			page,
			{ name: "Siobhán", contact_by: "email", email: "siobhan@example.ie", cake: "single" },
			{ headers },
		);
		expect(sent.status).toBe(200);
		expect(await sent.json()).toEqual({
			sent: true,
			location: null,
			message: "Thank you. We have received your message.",
		});
		expect((await kept())[0]?.values[0]).toMatchObject({ key: "name", value: "Siobhán" });
	});
});
