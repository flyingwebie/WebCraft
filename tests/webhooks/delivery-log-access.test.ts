// Who reads a Webhook's delivery log (audit A4-1): it keeps each delivery's body as sent, so a
// `formSubmitted` delivery holds what a visitor typed, and each attempt keeps the start of what the
// receiver answered. Only Staff (`structure.edit`) read it; everyone else who sees the Site still
// sees its Webhooks and how each one's last delivery went.
import { afterAll, beforeAll, expect, test } from "bun:test";
import forms from "@webcraft/module-forms";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { formVisitor } from "../harness/forms.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { goLive } from "../harness/staging.ts";

const HOOK = "https://hooks.crm.example/leads";

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let formId: string;
let webhookId: string;
let staff: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "forms", version: forms.manifest.version });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;

	const { form } = await staff.api.forms.create({ siteId, name: "Contact", key: "contact" });
	formId = form.id;
	await staff.api.forms.saveDraft({
		siteId,
		formId,
		form: {
			fields: [
				{ key: "name", type: "text", label: "Your name", required: true },
				{ key: "message", type: "textarea", label: "Message" },
			],
		},
	});
	await staff.api.forms.publish({ siteId, formId });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Pages", urlPattern: "/contact/{slug}" });
	const { template } = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<section data-wc-id="s1">{{@form contact}}</section>',
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Contact", slug: "form" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });

	install.dns.answer("hooks.crm.example", ["93.184.216.34"]);
	install.http.respond("POST", HOOK, { status: 500, body: "lead 4471 refused for niamh@example.ie" });
	webhookId = (await staff.api.webhooks.add({ siteId, url: HOOK, name: "CRM", events: ["formSubmitted"] })).webhook.id;

	const visitor = formVisitor(install);
	const page = await visitor.open("https://bakery.live.test/contact/form");
	await install.clock.advance(5_000);
	const sent = await visitor.send(page, { name: "Niamh Byrne", message: "Call me on 087 555 0101" });
	expect(sent.status).toBe(303);
	await install.drainJobs();
});

afterAll(async () => {
	await install.close();
});

test("Staff read a delivery's body and what the receiver answered", async () => {
	const { deliveries } = await staff.api.webhooks.deliveries({ siteId, webhookId });

	expect(deliveries).toHaveLength(1);
	expect(deliveries[0]?.body).toContain("087 555 0101");
	expect(deliveries[0]?.attempts[0]?.excerpt).toBe("lead 4471 refused for niamh@example.ie");
});

test("an Author, who may not read Submissions, is refused the delivery log that holds them", async () => {
	const author = (await install.createMember({ workspaceId, role: "author" })).browser;
	await expect(moduleApi<typeof forms>(author, "forms").submissions.list({ siteId, formId })).rejects.toMatchObject({
		code: "FORBIDDEN",
	});

	// The Webhook's id is theirs to read: the list is a Site setting everyone on the Site sees.
	const { webhooks } = await author.api.webhooks.list({ siteId });
	expect(webhooks).toMatchObject([{ id: webhookId, name: "CRM", lastDelivery: { status: "retrying" } }]);

	await expect(author.api.webhooks.deliveries({ siteId, webhookId })).rejects.toMatchObject({
		code: "FORBIDDEN",
		data: { permission: "structure.edit" },
	});
});

test("Owners and Editors see the Webhooks, never the delivery log", async () => {
	for (const role of ["owner", "editor"] as const) {
		const member = (await install.createMember({ workspaceId, role })).browser;
		expect((await member.api.webhooks.list({ siteId })).webhooks).toHaveLength(1);
		await expect(member.api.webhooks.deliveries({ siteId, webhookId })).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: { permission: "structure.edit" },
		});
	}
});

test("an Owner's API token with the Site settings Toolset is refused the delivery log too", async () => {
	const owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	const { secret } = await createApiToken(owner, {
		workspaceId,
		name: "Reporting",
		readOnly: true,
		toolsets: ["siteSettings"],
	});
	const token = tokenClient(install, secret);

	expect((await token.api.webhooks.list({ siteId })).webhooks).toHaveLength(1);
	await expect(token.api.webhooks.deliveries({ siteId, webhookId })).rejects.toMatchObject({ code: "FORBIDDEN" });
});
