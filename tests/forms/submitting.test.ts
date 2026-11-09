// A Form on a Site's page, as visitors use it without JavaScript: the page shows it, a post with
// errors gets the page again with what they typed and each field's error, and one that goes through
// is kept (with its language and page) and redirected (post, redirect, get).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type forms from "@webcraft/module-forms";

import { formIn, formVisitor } from "../harness/forms.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { expectSafePage } from "../harness/site-safety.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let siteId: string;
let formId: string;
let postTypeId: string;
const PAGE = "https://bakery.sites.test/visit/contact";

/** The Submissions kept for the Form, newest first. */
async function kept(folder: "inbox" | "spam" = "inbox") {
	return (await moduleApi<typeof forms>(owner, "forms").submissions.list({ siteId, formId, folder })).submissions;
}

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "forms", version: "1.1.0" });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	await staff.api.languages.add({ siteId, code: "it" });
	const { form } = await staff.api.forms.create({ siteId, name: "Contact", key: "contact" });
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
				{
					key: "email",
					type: "email",
					label: "Email",
					required: true,
					help: { text: "We reply here.", translations: { it: "Rispondiamo qui." } },
				},
				{
					key: "cake",
					type: "radio",
					label: "Cake",
					options: [
						{ value: "single", label: "Single tier" },
						{ value: "tiered", label: "Tiered" },
					],
				},
				{
					key: "tiers",
					type: "number",
					label: "Tiers",
					min: 2,
					max: 6,
					integer: true,
					message: { text: "Choose between 2 and 6 tiers.", translations: { it: "Scegli da 2 a 6 piani." } },
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
				{ key: "message", type: "textarea", label: "Message", hideLabel: true, maxLength: 500 },
				{ key: "consent", type: "consent", label: "I agree to be contacted", required: true },
				{ key: "campaign", type: "hidden", label: "Campaign", source: { kind: "query", name: "utm_source" } },
			],
			success: {
				kind: "message",
				message: { text: "Thanks! A baker will be in touch.", translations: { it: "Grazie! Ti contatteremo." } },
			},
		},
	});
	await staff.api.forms.publish({ siteId, formId });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Visits",
		key: "visits",
		urlPattern: "/visit/{slug}",
		fields: [],
	});
	postTypeId = postType.id;
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: '<section data-wc-id="s1"><h1 data-wc-id="h1">{{ title }}</h1>{{@form contact}}</section>',
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId,
		title: "Contact",
		slug: "contact",
		fields: {},
	});
	await staff.api.entries.publish({ siteId, entryId: entry.id });
});

afterAll(async () => {
	await install.close();
});

describe("the page shows the Form", () => {
	test("a form posting to the Site, every field labelled, with its help linked and nothing inline", async () => {
		const page = await formVisitor(install).open(PAGE);

		expect(page.status).toBe(200);
		expect(page.html).toContain(
			`<form class="wc-form" id="wc-form-1" method="post" action="/_webcraft/forms/${formId}" novalidate>`,
		);
		expect(page.html).toContain(
			'<label class="wc-form-label" for="wc-form-1-name">Your name<span class="wc-form-required" aria-hidden="true"> *</span></label>',
		);
		expect(page.html).toContain('<input type="text" id="wc-form-1-name" name="name" value="" required>');
		expect(page.html).toContain(
			'<input type="email" id="wc-form-1-email" name="email" value="" required aria-describedby="wc-form-1-email-help" autocomplete="email">',
		);
		expect(page.html).toContain('<p class="wc-form-help" id="wc-form-1-email-help">We reply here.</p>');
		expect(page.html).toContain('<fieldset class="wc-form-field" data-type="radio"><legend>Cake</legend>');
		expect(page.html).toContain(
			'<label class="wc-form-label wc-visually-hidden" for="wc-form-1-message">Message</label>',
		);
		expect(page.html).toContain('<button type="submit" class="wc-form-submit">Send</button>');
		// A hidden field is filled in as the Form is sent; the page holds nothing of it.
		expect(page.html).not.toContain('name="campaign"');
		expect(page.form().hidden).toMatchObject({ "wc-page": "/visit/contact", "wc-i": "1" });
		// Nothing inline, under the Site's policy (which lets forms post only to the Site).
		await expectSafePage(await install.request(PAGE));
	});

	test("the page is cached, but every answer carries a token of its own", async () => {
		const visitor = formVisitor(install);
		const first = await visitor.open(PAGE);
		await install.clock.advance(1000);
		const second = await visitor.open(PAGE);

		expect(second.response.headers.get("x-cache")).toBe("HIT");
		expect(first.form().hidden["wc-t"]).toMatch(/^[0-9a-z]+\.[A-Za-z0-9_-]{43}$/);
		expect(second.form().hidden["wc-t"]).not.toBe(first.form().hidden["wc-t"]);
		expect(second.response.headers.get("etag")).toBe(first.response.headers.get("etag"));
	});

	test("in another language, every text shows its own value there", async () => {
		const page = await formVisitor(install).open("https://bakery.sites.test/it/visit/contact");

		expect(page.html).toContain(">Il tuo nome<");
		expect(page.html).toContain('<p class="wc-form-help" id="wc-form-1-email-help">Rispondiamo qui.</p>');
		expect(page.html).toContain('<button type="submit" class="wc-form-submit">Invia</button>');
		expect(page.form().hidden["wc-page"]).toBe("/it/visit/contact");
	});
});

describe("sending without JavaScript", () => {
	test("a Form that keeps its rules is kept, with its language and page, then the visitor sees its message", async () => {
		const visitor = formVisitor(install);
		const page = await visitor.open(`${PAGE}?utm_source=newsletter`);
		await install.clock.advance(5000);

		const sent = await visitor.send(
			{ ...page, url: `${PAGE}?utm_source=newsletter` },
			{
				name: " Ada ",
				email: "Ada@Example.com",
				cake: "tiered",
				tiers: "3",
				extras: ["topper", "candles"],
				message: "For Saturday",
				consent: "yes",
			},
		);

		expect(sent.status).toBe(303);
		expect(sent.headers.get("location")).toBe("/visit/contact?wc-sent=1#wc-form-1");
		expect(sent.headers.get("cache-control")).toBe("no-store");
		const [submission] = await kept();
		expect(submission).toMatchObject({
			formId,
			formKey: "contact",
			formName: "Contact",
			language: "en",
			page: "/visit/contact",
			folder: "inbox",
			spamReason: null,
		});
		expect(submission?.values).toEqual([
			{ key: "name", label: "Your name", type: "text", value: "Ada" },
			{ key: "email", label: "Email", type: "email", value: "ada@example.com" },
			{ key: "cake", label: "Cake", type: "radio", value: "tiered" },
			{ key: "tiers", label: "Tiers", type: "number", value: 3 },
			{ key: "extras", label: "Extras", type: "checkboxes", value: ["candles", "topper"] },
			{ key: "message", label: "Message", type: "textarea", value: "For Saturday" },
			{ key: "consent", label: "I agree to be contacted", type: "consent", value: true },
			{ key: "campaign", label: "Campaign", type: "hidden", value: "newsletter" },
		]);

		await expectSafePage(await install.request(`https://bakery.sites.test${sent.headers.get("location")}`));
		const after = await visitor.open(`https://bakery.sites.test${sent.headers.get("location")}`);
		expect(after.status).toBe(200);
		expect(after.response.headers.get("cache-control")).toBe("no-store");
		expect(after.html).toContain(
			'<div class="wc-form-sent" id="wc-form-1" role="status" tabindex="-1" autofocus><p>Thanks! A baker will be in touch.</p></div>',
		);
		// The page everyone else gets still shows the Form.
		expect((await visitor.open(PAGE)).html).toContain('<form class="wc-form"');
	});

	test("errors come back on the page, with what was typed, each linked to its field", async () => {
		const visitor = formVisitor(install);
		const page = await visitor.open(PAGE);
		await install.clock.advance(5000);
		const before = (await kept()).length;

		const answer = await visitor.send(page, {
			name: "Bea",
			email: "not an email",
			tiers: "9",
			message: "Hello <there>",
		});

		expect(answer.status).toBe(422);
		expect(answer.headers.get("cache-control")).toBe("no-store");
		const html = await expectSafePage(answer);
		expect(html).toContain("<title>Error: Contact · Acme Bakery</title>");
		expect(html).toContain(
			'<div class="wc-form-errors" id="wc-form-1-errors" role="group" aria-labelledby="wc-form-1-errors-title" tabindex="-1" autofocus><h2 id="wc-form-1-errors-title">There is a problem</h2>',
		);
		expect(html).toContain('<a href="#wc-form-1-email">Email: Enter an email address, such as name@example.com.</a>');
		expect(html).toContain('<a href="#wc-form-1-tiers">Tiers: Choose between 2 and 6 tiers.</a>');
		expect(html).toContain('<a href="#wc-form-1-consent">I agree to be contacted: Tick this box to continue.</a>');
		expect(html).toContain(
			'<input type="email" id="wc-form-1-email" name="email" value="not an email" required aria-invalid="true" aria-describedby="wc-form-1-email-help wc-form-1-email-error" autocomplete="email">',
		);
		expect(html).toContain(
			'<p class="wc-form-error" id="wc-form-1-email-error"><span class="wc-visually-hidden">Error:</span> Enter an email address, such as name@example.com.</p>',
		);
		expect(html).toContain('value="Bea"');
		expect(html).toContain(">Hello &lt;there&gt;</textarea>");
		expect(html).not.toContain("wc-form-1-name-error");
		expect((await kept()).length).toBe(before);
	});

	test("errors are in the page's language", async () => {
		const visitor = formVisitor(install);
		const page = await visitor.open("https://bakery.sites.test/it/visit/contact");
		await install.clock.advance(5000);

		const html = await (await visitor.send(page, { email: "x", tiers: "1" })).text();

		expect(html).toContain('<html lang="it"');
		expect(html).toContain('<h2 id="wc-form-1-errors-title">C\'è un problema</h2>');
		expect(html).toContain("Il tuo nome: Inserisci un valore.");
		expect(html).toContain("Tiers: Scegli da 2 a 6 piani.");
	});

	test("a Submission from a page in another language records that language", async () => {
		const visitor = formVisitor(install);
		const page = await visitor.open("https://bakery.sites.test/it/visit/contact");
		await install.clock.advance(5000);

		const sent = await visitor.send(page, { name: "Carla", email: "carla@example.it", consent: "yes" });

		expect(sent.headers.get("location")).toBe("/it/visit/contact?wc-sent=1#wc-form-1");
		expect((await kept())[0]).toMatchObject({ language: "it", page: "/it/visit/contact" });
		const after = await visitor.open(`https://bakery.sites.test${sent.headers.get("location")}`);
		expect(after.html).toContain("<p>Grazie! Ti contatteremo.</p>");
	});

	test("a Form can send visitors on to a Page instead, in their language", async () => {
		const pages = (await staff.api.postTypes.list({ siteId })).postTypes.find((each) => each.builtIn === "page");
		const { entry: thanks } = await staff.api.entries.create({
			siteId,
			postTypeId: pages?.id ?? "",
			title: "Thank you",
			slug: "thank-you",
			fields: {},
		});
		await staff.api.entries.publish({ siteId, entryId: thanks.id });
		await staff.api.forms.saveDraft({ siteId, formId, form: { success: { kind: "redirect", pageId: thanks.id } } });
		await staff.api.forms.publish({ siteId, formId });
		const visitor = formVisitor(install);
		const page = await visitor.open("https://bakery.sites.test/it/visit/contact");
		await install.clock.advance(5000);

		const sent = await visitor.send(page, { name: "Dario", email: "dario@example.it", consent: "yes" });

		expect(sent.status).toBe(303);
		expect(sent.headers.get("location")).toBe("/it/thank-you");
		await staff.api.forms.saveDraft({ siteId, formId, form: { success: { kind: "message", message: "Thanks!" } } });
		await staff.api.forms.publish({ siteId, formId });
	});
});

describe("a Form sent from a page that no longer shows it", () => {
	test("comes back with its errors on a page of its own, in the Site template", async () => {
		const visitor = formVisitor(install);
		const page = await visitor.open(PAGE);
		await install.clock.advance(5000);

		const answer = await visitor.send(page, { email: "nope" }, { hidden: { "wc-page": "/no-such-page" } });

		expect(answer.status).toBe(422);
		const html = await answer.text();
		expect(html).toContain("<title>Error: There is a problem · Acme Bakery</title>");
		expect(html).toContain('<a href="#wc-form-1-email">Email: Enter an email address, such as name@example.com.</a>');
		expect(formIn(html).hidden["wc-page"]).toBe("/no-such-page");
	});
});

describe("what the post path refuses", () => {
	test("posts from another site's pages, other methods, other bodies and unknown Forms", async () => {
		const visitor = formVisitor(install);
		const page = await visitor.open(PAGE);
		await install.clock.advance(5000);
		const fields = { name: "Eve", email: "eve@example.com", consent: "yes" };

		expect((await visitor.send(page, fields, { origin: "https://elsewhere.example" })).status).toBe(403);
		expect((await visitor.send(page, fields, { origin: null, fetchSite: null })).status).toBe(403);
		expect((await visitor.send(page, fields, { contentType: "application/json", body: "{}" })).status).toBe(415);
		expect((await install.request(`https://bakery.sites.test/_webcraft/forms/${formId}`)).status).toBe(405);
		const unknown = { ...page, form: () => ({ ...page.form(), action: `/_webcraft/forms/${crypto.randomUUID()}` }) };
		expect((await visitor.send(unknown, fields)).status).toBe(404);
	});
});

describe("where Forms don't run", () => {
	test("switched off on the Site, a Form shows nothing and takes no posts; on again, it is back", async () => {
		const visitor = formVisitor(install);
		const page = await visitor.open(PAGE);
		await install.clock.advance(5000);

		await staff.api.modules.setOnSite({ siteId, moduleId: "forms", on: false });
		const without = await visitor.open(PAGE);
		const post = await visitor.send(page, { name: "Fay", email: "fay@example.com", consent: "yes" });
		await staff.api.modules.setOnSite({ siteId, moduleId: "forms", on: true });

		expect(without.html).not.toContain("<form");
		expect(without.html).toContain("<h1>Contact</h1>");
		expect(post.status).toBe(404);
		expect((await visitor.open(PAGE)).html).toContain('<form class="wc-form"');
	});
});
