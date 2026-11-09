// A Site's optional CAPTCHA (off by default): any challenge provider of the usual shape. Its script
// is an outside script, its widget sits in each Form, and every answer is checked with the provider,
// through the guarded fetcher, with the Site's secret key.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type forms from "@webcraft/module-forms";

import { formVisitor } from "../harness/forms.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let siteId: string;
let formId: string;
const PAGE = "https://bakery.sites.test/visit/contact";
const VERIFY = "https://verify.challenges.example/siteverify";
const CAPTCHA = {
	scriptUrl: "https://challenges.example/widget.js",
	verifyUrl: VERIFY,
	siteKey: "site-key-1",
	responseField: "challenge-response",
	widgetClass: "challenge-widget",
};

async function kept(folder: "inbox" | "spam") {
	return (await moduleApi<typeof forms>(owner, "forms").submissions.list({ siteId, formId, folder })).submissions;
}

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "forms", version: "1.0.0" });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
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
	install.dns.answer("verify.challenges.example", ["93.184.216.34"]);
});

afterAll(async () => {
	await install.close();
});

describe("setting it up", () => {
	test("Staff set the provider and the Site's keys; the secret key is never shown", async () => {
		const view = await staff.api.forms.captcha.set({ siteId, captcha: CAPTCHA, secret: "the-secret-key-1234" });

		expect(view.captcha).toEqual(CAPTCHA);
		expect(view.secret).toMatchObject({ set: true, lastFour: "1234" });
		expect(JSON.stringify(await staff.api.forms.captcha.get({ siteId }))).not.toContain("the-secret-key");
		await expect(owner.api.forms.captcha.get({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("a CAPTCHA needs its secret key, and addresses on https", async () => {
		const other = (
			await install.createSite((await staff.api.sites.get({ siteId })).site.workspaceId, { slug: "other" })
		).id;

		await expect(staff.api.forms.captcha.set({ siteId: other, captcha: CAPTCHA })).rejects.toMatchObject({
			code: "CAPTCHA_INVALID",
			data: { problems: [{ at: "secret" }] },
		});
		await expect(
			staff.api.forms.captcha.set({
				siteId: other,
				captcha: { ...CAPTCHA, verifyUrl: "http://plain.example/check" },
				secret: "x",
			}),
		).rejects.toMatchObject({ code: "CAPTCHA_INVALID", data: { problems: [{ at: "verifyUrl" }] } });
	});

	test("pages with a Form show its widget and load the provider's script", async () => {
		const page = await formVisitor(install).open(PAGE);

		expect(page.html).toContain(
			'<div class="challenge-widget" id="wc-form-1-captcha" data-sitekey="site-key-1" data-lang="en"></div>',
		);
		expect(page.html).toContain('<script src="https://challenges.example/widget.js" async defer></script>');
	});
});

describe("checking answers", () => {
	test("an answer the provider accepts goes through; it was asked with the Site's secret key", async () => {
		install.http.respond("POST", VERIFY, { status: 200, body: JSON.stringify({ success: true }) });
		const visitor = formVisitor(install);
		const page = await visitor.open(PAGE);
		await install.clock.advance(5000);

		const answer = await visitor.send(page, { email: "ada@example.com", "challenge-response": "solved-123" });

		expect(answer.status).toBe(303);
		expect((await kept("inbox"))[0]?.spamReason).toBeNull();
		const asked = install.http.requests.findLast((request) => request.url === VERIFY);
		expect(new URLSearchParams(asked?.body ?? "")).toEqual(
			new URLSearchParams({ secret: "the-secret-key-1234", response: "solved-123", remoteip: visitor.address }),
		);
	});

	test("no answer, or one the provider refuses, comes back as an error to try again", async () => {
		install.http.respond("POST", VERIFY, { status: 200, body: JSON.stringify({ success: false }) });
		const visitor = formVisitor(install);
		const page = await visitor.open(PAGE);
		await install.clock.advance(5000);

		const missing = await visitor.send(page, { email: "bea@example.com" });
		const refused = await visitor.send(page, { email: "bea@example.com", "challenge-response": "guessed" });

		expect(missing.status).toBe(422);
		const html = await refused.text();
		expect(refused.status).toBe(422);
		expect(html).toContain('<a href="#wc-form-1-captcha">Complete the check before sending.</a>');
		expect(html).toContain('value="bea@example.com"');
	});

	test("when the provider can't be asked, the Submission is kept as spam, never lost", async () => {
		install.http.reset();
		const visitor = formVisitor(install);
		const page = await visitor.open(PAGE);
		await install.clock.advance(5000);

		const answer = await visitor.send(page, { email: "cy@example.com", "challenge-response": "solved" });

		expect(answer.status).toBe(303);
		expect((await kept("spam"))[0]).toMatchObject({ spamReason: "captcha" });
	});
});

describe("switching it off", () => {
	test("Forms show no widget and load no script, and the secret key is forgotten", async () => {
		const view = await staff.api.forms.captcha.set({ siteId, captcha: null });
		const page = await formVisitor(install).open(PAGE);

		expect(view).toEqual({ captcha: null, secret: { set: false } });
		expect(page.html).not.toContain("challenge");
	});
});
