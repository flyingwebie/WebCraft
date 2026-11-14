// A field's width (whole, half or third): part of a Form's fields, so Structure, kept in its Draft,
// its published version and its Revisions. On a Site, fields with a width sit side by side from the
// Design system's smallest breakpoint up, through the default Form styles; a Form without widths
// renders exactly as it did before fields had one.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import forms from "@webcraft/module-forms";
import pg from "pg";

import { formVisitor } from "../harness/forms.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

const ORIGIN = "https://bakery.live.test";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;

const COUNTIES = [
	{ value: "cork", label: "Cork" },
	{ value: "kerry", label: "Kerry" },
];

/** A Form of the Site, saved with these fields. */
async function formWith(name: string, key: string, fields: readonly Record<string, unknown>[]) {
	const { form } = await staff.api.forms.create({ siteId, name, key });
	const saved = await staff.api.forms.saveDraft({ siteId, formId: form.id, form: { fields: [...fields] } });
	return saved.form;
}

/** Publishes a Form and places it on a page of its own, `/<key>/form`; answers the page's address. */
async function placed(formId: string, key: string): Promise<string> {
	await staff.api.forms.publish({ siteId, formId });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: `Pages of ${key}`,
		urlPattern: `/${key}/{slug}`,
	});
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<section data-wc-id="s1">{{@form ${key}}}</section>`,
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: key, slug: "form" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	return `${ORIGIN}/${key}/form`;
}

/** What refusing a Draft answers: the place of each problem. */
async function problemsAt(save: Promise<unknown>): Promise<string[]> {
	const refusal = (await save.then(
		() => null,
		(error: unknown) => error,
	)) as { code?: string; data?: { problems?: { at: string }[] } } | null;
	expect(refusal?.code).toBe("FORM_INVALID");
	return (refusal?.data?.problems ?? []).map((problem) => problem.at);
}

/** The stylesheet a page of the Site links. */
async function stylesheetOf(url: string): Promise<string> {
	const html = await (await install.request(url)).text();
	const href = /<link rel="stylesheet" href="([^"]+)">/.exec(html)?.[1] ?? "";
	expect(href).toMatch(/^\/_wc\/css\/[0-9a-f]{16}\.css$/);
	return (await install.request(`${ORIGIN}${href}`)).text();
}

/** One cascade layer of a stylesheet. */
function layerOf(css: string, layer: string): string {
	return new RegExp(`@layer ${layer} \\{\\n([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? "";
}

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "forms", version: forms.manifest.version });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

describe("a field's width", () => {
	test("a field is whole unless Staff make it half or third; the Draft keeps each field's", async () => {
		const form = await formWith("Delivery", "delivery", [
			{ key: "first_name", type: "text", label: "First name", width: "half" },
			{ key: "last_name", type: "text", label: "Last name", width: "half" },
			{ key: "street", type: "text", label: "Street" },
			{ key: "postcode", type: "text", label: "Postcode", width: "third" },
			{ key: "town", type: "text", label: "Town", width: "third" },
			{ key: "county", type: "select", label: "County", width: "third", options: COUNTIES },
			{ key: "notes", type: "textarea", label: "Notes", width: "whole" },
			// Left unset, as every other setting may be.
			{ key: "phone", type: "phone", label: "Phone", width: null },
		]);

		expect(form.draft.fields.map((field) => [field.key, field.width])).toEqual([
			["first_name", "half"],
			["last_name", "half"],
			["street", "whole"],
			["postcode", "third"],
			["town", "third"],
			["county", "third"],
			["notes", "whole"],
			["phone", "whole"],
		]);
		const read = await staff.api.forms.get({ siteId, formId: form.id });
		expect(read.form.draft.fields).toEqual(form.draft.fields);
		const { forms: listed } = await staff.api.forms.list({ siteId });
		expect(listed.find((each) => each.id === form.id)?.draft.fields[0]).toMatchObject({ width: "half" });
	});

	test("every kind of field visitors fill in takes a width", async () => {
		const options = COUNTIES;
		const form = await formWith("Every kind", "every-kind", [
			{ key: "text", type: "text", label: "Text", width: "third" },
			{ key: "email", type: "email", label: "Email", width: "third" },
			{ key: "phone", type: "phone", label: "Phone", width: "third" },
			{ key: "url", type: "url", label: "Website", width: "half" },
			{ key: "number", type: "number", label: "Number", width: "half" },
			{ key: "date", type: "date", label: "Date", width: "half" },
			{ key: "select", type: "select", label: "Select", width: "half", options },
			{ key: "radio", type: "radio", label: "Radio", width: "half", options },
			{ key: "checkboxes", type: "checkboxes", label: "Checkboxes", width: "half", options },
			{ key: "textarea", type: "textarea", label: "Textarea", width: "half" },
			{ key: "file", type: "file", label: "File", width: "half", accept: ["pdf"] },
			{ key: "consent", type: "consent", label: "Consent", width: "third" },
			{ key: "hidden", type: "hidden", label: "Hidden", width: "third" },
		]);

		expect(form.draft.fields.map((field) => field.width)).toEqual([
			"third",
			"third",
			"third",
			"half",
			"half",
			"half",
			"half",
			"half",
			"half",
			"half",
			"half",
			"third",
			"third",
		]);
	});

	test("a width that isn't whole, half or third is refused where it is", async () => {
		const { form } = await staff.api.forms.create({ siteId, name: "Refused" });

		const at = await problemsAt(
			staff.api.forms.saveDraft({
				siteId,
				formId: form.id,
				form: {
					fields: [
						{ key: "name", type: "text", label: "Name", width: "quarter" },
						{ key: "email", type: "email", label: "Email", width: "half" },
						{ key: "phone", type: "phone", label: "Phone", width: 50 },
						{ key: "town", type: "text", label: "Town", width: "Half" },
					],
				},
			}),
		);

		expect(at).toEqual(["fields[0].width", "fields[2].width", "fields[3].width"]);
		expect((await staff.api.forms.get({ siteId, formId: form.id })).form.draft.fields).toEqual([]);
	});

	test("sections and steps have no width; the fields in them keep their own", async () => {
		const form = await formWith("Order", "order", [
			{ key: "details", type: "step", label: "Your details" },
			{ key: "who", type: "section", label: "Who you are", width: null },
			{ key: "first_name", type: "text", label: "First name", width: "half" },
			{ key: "last_name", type: "text", label: "Last name", width: "half" },
			{ key: "cake", type: "step", label: "Your cake" },
			{ key: "tiers", type: "number", label: "Tiers", width: "third" },
		]);

		expect(form.draft.fields.map((field) => [field.type, field.width])).toEqual([
			["step", null],
			["section", null],
			["text", "half"],
			["text", "half"],
			["step", null],
			["number", "third"],
		]);
		const at = await problemsAt(
			staff.api.forms.saveDraft({
				siteId,
				formId: form.id,
				form: {
					fields: [
						{ key: "details", type: "step", label: "Your details", width: "half" },
						{ key: "who", type: "section", label: "Who you are", width: "whole" },
						{ key: "first_name", type: "text", label: "First name", width: "half" },
					],
				},
			}),
		);
		expect(at).toEqual(["fields[0].width", "fields[1].width"]);
	});

	test("what the Draft answers can be saved again as it is", async () => {
		const form = await formWith("Again", "again", [
			{ key: "about", type: "section", label: "About you" },
			{ key: "name", type: "text", label: "Name", width: "half" },
			{ key: "email", type: "email", label: "Email", width: "half" },
		]);

		const again = await staff.api.forms.saveDraft({ siteId, formId: form.id, form: { fields: form.draft.fields } });

		expect(again.form.draft.fields).toEqual(form.draft.fields);
	});

	test("publishing keeps the widths, a Revision holds them and restoring it brings them back", async () => {
		const form = await formWith("Kept", "kept", [
			{ key: "name", type: "text", label: "Name", width: "half" },
			{ key: "email", type: "email", label: "Email", width: "half" },
		]);
		const item = { kind: "form", id: form.id } as const;

		const { form: published } = await staff.api.forms.publish({ siteId, formId: form.id });
		expect(published.status).toBe("published");
		expect(published.published?.fields.map((field) => field.width)).toEqual(["half", "half"]);

		await install.clock.advance(60_000);
		const { form: changed } = await staff.api.forms.saveDraft({
			siteId,
			formId: form.id,
			form: {
				fields: [
					{ key: "name", type: "text", label: "Name", width: "third" },
					{ key: "email", type: "email", label: "Email" },
				],
			},
		});
		// A width is part of the Form: changing one alone is a change to publish.
		expect(changed.status).toBe("changed");
		expect(changed.published?.fields.map((field) => field.width)).toEqual(["half", "half"]);

		const { copies } = await staff.api.history.list({ siteId, item });
		const revision = copies.find((copy) => copy.type === "revision");
		if (!revision) throw new Error("Publishing saved no Revision.");
		const copy = { type: "revision", id: revision.id } as const;
		const { content } = await staff.api.history.get({ siteId, item, copy });
		expect((content as { fields: { width: string }[] }).fields.map((field) => field.width)).toEqual(["half", "half"]);
		expect((await staff.api.history.compare({ siteId, item, copy })).changes).toBeGreaterThan(0);

		await staff.api.history.restore({ siteId, item, copy });

		const { form: restored } = await staff.api.forms.get({ siteId, formId: form.id });
		expect(restored.draft.fields.map((field) => field.width)).toEqual(["half", "half"]);
		expect(restored.status).toBe("published");
	});

	test("the API's document says which widths a field takes", async () => {
		const response = await install.request(install.adminUrl("/api/v1/openapi.json"));
		const document = (await response.json()) as {
			paths: Record<string, { post: { requestBody: { content: Record<string, { schema: unknown }> } } }>;
		};
		const input = document.paths["/forms/saveDraft"]?.post.requestBody.content["application/json"]?.schema as {
			properties: {
				form: { properties: { fields: { items: { properties: Record<string, unknown>; required: string[] } } } };
			};
		};
		const item = input.properties.form.properties.fields.items;

		// Whole unless given; null for a section or a step, which have none.
		expect(item.properties.width).toMatchObject({
			anyOf: [{ type: "string", enum: ["whole", "half", "third"] }, { type: "null" }],
			default: "whole",
		});
		// A width is never needed: clients that don't know of it keep working.
		expect(item.required).toEqual(["key", "type", "label"]);
	});
});

describe("a Form saved before fields had widths", () => {
	test("reads as every field whole, stays published as it was, and renders as it always did", async () => {
		const form = await formWith("Before", "before", [
			{ key: "about", type: "section", label: "About you" },
			{ key: "name", type: "text", label: "Name", required: true },
			{ key: "email", type: "email", label: "Email" },
		]);
		const url = await placed(form.id, "before");
		// Act as an earlier version of WebCraft did, as tests/content/rich-text.test.ts does: there is no
		// other way to store a Form whose fields have no width.
		const database = new pg.Client({ connectionString: install.databaseUrl });
		await database.connect();
		try {
			const without = (version: string) =>
				`jsonb_set(${version}, '{fields}', (SELECT jsonb_agg(field - 'width') FROM jsonb_array_elements(${version} -> 'fields') AS field))`;
			const { rowCount } = await database.query(
				`UPDATE forms SET draft = ${without("draft")}, published = ${without("published")} WHERE id = $1`,
				[form.id],
			);
			expect(rowCount).toBe(1);
		} finally {
			await database.end();
		}

		const { form: read } = await staff.api.forms.get({ siteId, formId: form.id });
		expect(read.status).toBe("published");
		for (const version of [read.draft, read.published]) {
			expect(version?.fields.map((field) => [field.type, field.width])).toEqual([
				["section", null],
				["text", "whole"],
				["email", "whole"],
			]);
		}
		// The page is rendered for the first time now, from the stored version.
		const page = await formVisitor(install).open(url);
		expect(page.html).not.toContain("data-wc-width");
		expect(page.html).toContain(
			'<fieldset class="wc-form-section" id="wc-form-1-about" data-wc-key="about"><legend>About you</legend>' +
				'<div class="wc-form-field" data-type="text"><label class="wc-form-label" for="wc-form-1-name">Name<span class="wc-form-required" aria-hidden="true"> *</span></label><input type="text" id="wc-form-1-name" name="name" value="" required></div>' +
				'<div class="wc-form-field" data-type="email"><label class="wc-form-label" for="wc-form-1-email">Email</label><input type="email" id="wc-form-1-email" name="email" value="" autocomplete="email"></div>' +
				"</fieldset>",
		);
	});
});

describe("on a Site", () => {
	let url: string;
	let formId: string;

	beforeAll(async () => {
		const form = await formWith("Enquiry", "enquiry", [
			{ key: "first_name", type: "text", label: "First name", width: "half", required: true },
			{ key: "last_name", type: "text", label: "Last name", width: "half" },
			{ key: "street", type: "text", label: "Street" },
			{ key: "postcode", type: "text", label: "Postcode", width: "third" },
			{ key: "town", type: "text", label: "Town", width: "third" },
			{ key: "county", type: "select", label: "County", width: "third", options: COUNTIES },
			{ key: "contact", type: "radio", label: "Contact me by", width: "half", options: COUNTIES },
			{ key: "extras", type: "checkboxes", label: "Extras", width: "half", options: COUNTIES },
			{ key: "newsletter", type: "consent", label: "Send me the newsletter", width: "half" },
			{ key: "brief", type: "file", label: "Brief", width: "half", accept: ["pdf"] },
			{
				key: "company",
				type: "text",
				label: "Company",
				width: "third",
				condition: { match: "all", rules: [{ field: "contact", op: "is", value: "cork" }] },
			},
			{ key: "campaign", type: "hidden", label: "Campaign", width: "half" },
			{ key: "more", type: "section", label: "Anything else" },
			{ key: "message", type: "textarea", label: "Message", width: "half" },
			{ key: "budget", type: "number", label: "Budget", width: "half" },
		]);
		formId = form.id;
		url = await placed(form.id, "enquiry");
	});

	test("a field with a width says so on its wrapper; a whole field renders as it always did", async () => {
		const page = await formVisitor(install).open(url);

		expect(page.status).toBe(200);
		expect(page.html).toContain(
			'<div class="wc-form-field" data-type="text" data-wc-width="half"><label class="wc-form-label" for="wc-form-1-first_name">First name<span class="wc-form-required" aria-hidden="true"> *</span></label><input type="text" id="wc-form-1-first_name" name="first_name" value="" required></div>' +
				'<div class="wc-form-field" data-type="text" data-wc-width="half"><label class="wc-form-label" for="wc-form-1-last_name">Last name</label><input type="text" id="wc-form-1-last_name" name="last_name" value=""></div>' +
				'<div class="wc-form-field" data-type="text"><label class="wc-form-label" for="wc-form-1-street">Street</label><input type="text" id="wc-form-1-street" name="street" value=""></div>' +
				'<div class="wc-form-field" data-type="text" data-wc-width="third"><label class="wc-form-label" for="wc-form-1-postcode">Postcode</label>',
		);
		expect(page.html).toContain('<div class="wc-form-field" data-type="select" data-wc-width="third"><label');
		expect(page.html).toContain(
			'<fieldset class="wc-form-field" data-type="radio" data-wc-width="half"><legend>Contact me by</legend>',
		);
		expect(page.html).toContain(
			'<fieldset class="wc-form-field" data-type="checkboxes" data-wc-width="half"><legend>Extras</legend>',
		);
		expect(page.html).toContain('<div class="wc-form-field" data-type="consent" data-wc-width="half"><div');
		expect(page.html).toContain('<div class="wc-form-field" data-type="file" data-wc-width="half"><label');
		// A field shown under a condition carries both marks.
		expect(page.html).toContain(
			'<div class="wc-form-field" data-type="text" data-wc-width="third" data-wc-key="company"><label',
		);
		// In a section, fields sit side by side as anywhere else; the section itself has no width.
		expect(page.html).toContain(
			'<fieldset class="wc-form-section" id="wc-form-1-more" data-wc-key="more"><legend>Anything else</legend>' +
				'<div class="wc-form-field" data-type="textarea" data-wc-width="half"><label',
		);
		// A hidden field is never on the page, whatever its width.
		expect(page.html).not.toContain("campaign");
		// Nothing inline: the widths are laid out by the Site's stylesheet.
		await expectSafePage(await install.request(url));
	});

	test("a Form sent back with errors keeps its fields' widths", async () => {
		const visitor = formVisitor(install);
		const page = await visitor.open(url);
		await install.clock.advance(5_000);

		const answer = await visitor.send(page, { last_name: "Byrne" });

		expect(answer.status).toBe(422);
		const html = await answer.text();
		expect(html).toContain(
			'<div class="wc-form-field" data-type="text" data-wc-width="half"><label class="wc-form-label" for="wc-form-1-first_name">',
		);
		expect(html).toContain('id="wc-form-1-last_name" name="last_name" value="Byrne"');
	});

	test("the default Form styles lay them side by side from the Design system's smallest breakpoint up", async () => {
		const base = layerOf(await stylesheetOf(url), "base");

		// Six columns hold halves (three each) and thirds (two each), wherever fields with a width sit:
		// in the Form itself, a section or a step. Everything else keeps the whole line.
		const wide = /@media \(min-width:768px\)\{(.*\[data-wc-width.*)\}$/m.exec(base)?.[1] ?? "";
		expect(wide).toContain(
			".wc-form:has(>[data-wc-width]),.wc-form-section:has(>[data-wc-width]),.wc-form-step:has(>[data-wc-width]){display:grid;grid-template-columns:repeat(6,minmax(0,1fr));column-gap:1em}",
		);
		expect(wide).toContain(".wc-form-field[data-wc-width=half]{grid-column:span 3}");
		expect(wide).toContain(".wc-form-field[data-wc-width=third]{grid-column:span 2}");
		// Below it nothing lays fields out in columns: every field is whole.
		expect(base.replace(wide, "")).not.toContain("data-wc-width");
	});

	test("the Site's own breakpoints decide what narrow is, and its own CSS restyles the widths", async () => {
		const { designSystem } = await staff.api.designSystem.get({ siteId });
		const [smallest, ...others] = [...designSystem.draft.tokens.breakpoints].sort((a, b) => a.width - b.width);
		if (!smallest) throw new Error("The default Design system has no breakpoint.");
		await staff.api.designSystem.saveDraft({
			siteId,
			tokens: { ...designSystem.draft.tokens, breakpoints: [{ ...smallest, width: 600 }, ...others] },
			customCss: ".wc-form-field[data-wc-width=third] { grid-column: span 3; }",
		});
		await staff.api.designSystem.publish({ siteId });

		const css = await stylesheetOf(url);

		expect(layerOf(css, "base")).toContain("@media (min-width:600px){.wc-form:has(>[data-wc-width])");
		expect(layerOf(css, "base")).not.toContain("@media (min-width:768px){.wc-form:has(");
		// The Site's custom CSS is a later layer than the default Form styles, so it wins without `!important`.
		expect(css.indexOf("@layer custom {")).toBeGreaterThan(css.indexOf("@layer base {"));
		expect(layerOf(css, "custom")).toContain(".wc-form-field[data-wc-width=third]{grid-column:span 3}");
		// The Form itself is as it was: only the stylesheet changed.
		expect((await staff.api.forms.get({ siteId, formId })).form.status).toBe("published");
	});
});
