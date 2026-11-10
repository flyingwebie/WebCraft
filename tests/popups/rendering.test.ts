import { afterAll, beforeAll, expect, test } from "bun:test";
import type forms from "@webcraft/module-forms";
import { openEditMode } from "../harness/edit-mode.ts";
import { formVisitor } from "../harness/forms.ts";
import { photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { expectSafePage, expectSiteHeaders } from "../harness/site-safety.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let popupId: string;
let postTypeId: string;
const PAGE = "https://offers.live.test/pages/welcome";
beforeAll(async () => {
	install = await createTestInstall();
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "popups", version: "1.0.0" });
	await admin.api.modules.approve({ moduleId: "forms", version: "1.2.0" });
	const ws = await install.createWorkspace();
	siteId = (await install.createSite(ws.id, { slug: "offers" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [ws.id] })).browser;
	await staff.api.languages.add({ siteId, code: "it" });
	const { form } = await staff.api.forms.create({ siteId, name: "Contact", key: "contact" });
	await staff.api.forms.saveDraft({
		siteId,
		formId: form.id,
		form: { fields: [{ key: "email", type: "email", label: "Email", required: true }], spam: { minFillSeconds: 0 } },
	});
	await staff.api.forms.publish({ siteId, formId: form.id });
	const { popup } = await staff.api.popups.create({ siteId, name: "Offer", key: "offer" });
	popupId = popup.id;
	await staff.api.components.saveMarkup({
		siteId,
		componentId: popup.componentId,
		markup: "<p>{{ props.text }}</p>{{@form contact}}",
	});
	await staff.api.components.publish({ siteId, componentId: popup.componentId });
	await staff.api.popups.saveContent({
		siteId,
		popupId,
		values: { title: "Join us", text: "Summer savings", enabled: true },
	});
	await staff.api.popups.saveContent({ siteId, popupId, language: "it", values: { title: "Iscriviti" } });
	await staff.api.popups.publish({ siteId, popupId });
	await staff.api.popups.publishContent({ siteId, popupId });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Articles",
		urlPattern: "/pages/{slug}",
		fields: [],
	});
	postTypeId = postType.id;
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: "<h1>{{ title }}</h1>{{@popup offer}}",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId,
		title: "Welcome",
		slug: "welcome",
		fields: {},
	});
	await staff.api.entries.publish({ siteId, entryId: entry.id });
});
afterAll(async () => {
	await install.close();
});
test("a click Popup has hidden dialog markup, a no-script fallback and same-origin assets", async () => {
	const response = await install.request(PAGE);
	const html = await expectSafePage(response);
	expect(html).toContain("data-wc-popup=");
	expect(html).toContain('<dialog class="wc-popup"');
	expect(html).toContain("<noscript><section");
	expect(html).toContain(`href="#popup-offer"`);
	expect(html).toContain("Summer savings");
	expect(html).toContain('data-wc-module="popups"');
	const markup = await staff.api.templates.getEntryTemplateMarkup({ siteId, postTypeId });
	expect(markup.markup?.draft).toContain("{{@popup offer}}");
	expect(markup.template?.draft.nodes[1]).toEqual({ type: "popup", popup: popupId });
});
test("the hidden Popup Form participates in normal validation and submission", async () => {
	const visitor = formVisitor(install);
	const page = await visitor.open(PAGE);
	await expectSafePage(await install.request(PAGE));
	const invalid = await visitor.send(page, { email: "invalid" });
	expect(invalid.status).toBe(422);
	const html = await expectSafePage(invalid);
	expect(html).toContain('aria-invalid="true"');
	expect(html).toContain(`<section id="popup-offer"`);
});
test("turning the Module off leaves a working page with no promotion", async () => {
	await staff.api.modules.setOnSite({ siteId, moduleId: "popups", on: false });
	const html = await expectSafePage(await install.request(PAGE));
	expect(html).not.toContain("data-wc-popup=");
	expect(html).not.toContain('data-wc-module="popups"');
	await staff.api.modules.setOnSite({ siteId, moduleId: "popups", on: true });
});

test("a Popup's image uses normal Media rendering and appears in Used in", async () => {
	const { media } = await staff.api.media.upload({
		siteId,
		file: upload(await photo({ width: 100, height: 80 }), "offer.jpg"),
	});
	await install.drainJobs();
	const current = await staff.api.popups.get({ siteId, popupId });
	await staff.api.components.saveMarkup({
		siteId,
		componentId: current.popup.componentId,
		markup: '<p>{{ props.text }}</p><img src="{{ props.image }}">{{@form contact}}',
	});
	await staff.api.components.publish({ siteId, componentId: current.popup.componentId });
	await staff.api.popups.saveContent({ siteId, popupId, values: { image: media.id } });
	await staff.api.popups.publishContent({ siteId, popupId });
	const html = await expectSafePage(await install.request(PAGE));
	expect(html).toContain('<img src="/_media/');
	expect(html).toContain("/_media/");
	const used = await staff.api.media.usage({ siteId, mediaId: media.id });
	expect(JSON.stringify(used)).toContain("popup");
	expect(JSON.stringify(used)).toContain(popupId);
});

test("a hidden Form posts successfully and its private upload stays private", async () => {
	const form = (await staff.api.forms.list({ siteId })).forms.find((f) => f.key === "contact");
	if (!form) throw new Error("Contact Form missing");
	await staff.api.forms.saveDraft({
		siteId,
		formId: form.id,
		form: {
			fields: [
				{ key: "email", type: "email", label: "Email", required: true },
				{ key: "file", type: "file", label: "Document", accept: ["pdf"] },
			],
			spam: { minFillSeconds: 0 },
		},
	});
	await staff.api.forms.publish({ siteId, formId: form.id });
	const visitor = formVisitor(install);
	const page = await visitor.open(PAGE);
	await expectSafePage(await install.request(PAGE));
	const sent = await visitor.send(
		page,
		{ email: "popup@example.test" },
		{
			files: {
				file: [
					{
						name: "offer.pdf",
						type: "application/pdf",
						bytes: `%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n${"x".repeat(500)}\n%%EOF\n`,
					},
				],
			},
		},
	);
	expect(sent.status).toBe(303);
	expectSiteHeaders(sent);
	const location = sent.headers.get("location");
	if (!location) throw new Error("Submission redirect missing");
	const success = await expectSafePage(await install.request(new URL(location, PAGE)));
	expect(success).toContain("Thank you. We have received your message.");
	expect(success).toContain(`<section id="popup-offer"`);
	expect(success).not.toContain("%PDF");
	const inbox = moduleApi<typeof forms>(staff, "forms");
	const { submissions } = await inbox.submissions.list({ siteId, formId: form.id, folder: "inbox", limit: 1 });
	const files = submissions[0]?.values.find((v) => v.key === "file")?.value as { uploadId: string }[] | undefined;
	const file = files?.[0];
	if (!file) throw new Error("Private upload missing");
	expect(file.uploadId).toBeString();
	const exposed = await install.request(`https://offers.live.test/_media/${file.uploadId}`);
	expect(exposed.status).toBe(404);
	expectSiteHeaders(exposed);
});

test("promotions do not open or ship their script in Edit mode or Safe mode", async () => {
	for (const safeMode of [false, true]) {
		const edit = await openEditMode(install, staff, siteId, "/pages/welcome", { safeMode });
		const html = await expectSafePage(await edit.page("/pages/welcome"), "editMode");
		expect(html).not.toContain("data-wc-popup=");
		expect(html).not.toContain('data-wc-module="popups"');
	}
});

test("removing Popup Module data is scoped and old Template links fail gracefully", async () => {
	const ask = await staff.api.modules.removeSiteData({ siteId, moduleId: "popups" });
	if (ask.removed) throw new Error("Expected confirmation");
	await staff.api.modules.removeSiteData({ siteId, moduleId: "popups", confirmation: ask.confirmation.id });
	expect((await staff.api.popups.list({ siteId })).popups).toEqual([]);
	const html = await expectSafePage(await install.request(PAGE));
	expect(html).toContain("Welcome");
	expect(html).not.toContain("data-wc-popup=");
});
