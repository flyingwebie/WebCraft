// Submissions hold what visitors typed into Forms (spec story 144): an AI client or API token reads
// them only through the Submissions Toolset, which is off unless its person chooses it, and every
// read is recorded in the Audit log.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import forms from "@webcraft/module-forms";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { formVisitor } from "../harness/forms.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { answerOf, approveAiClient, connectMcp } from "../harness/mcp.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let formId: string;
let owner: { browser: TestBrowser; personId: string };

beforeAll(async () => {
	install = await createTestInstall();
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "forms", version: forms.manifest.version });
	workspaceId = (await install.createWorkspace("Acme")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const origin = await goLive(install, siteId);
	const { form } = await admin.api.forms.create({ siteId, name: "Contact", key: "contact" });
	formId = form.id;
	await admin.api.forms.saveDraft({
		siteId,
		formId,
		form: { fields: [{ key: "message", type: "textarea", label: "Message", required: true }] },
	});
	await admin.api.forms.publish({ siteId, formId });
	const { postType } = await admin.api.postTypes.create({
		siteId,
		name: "Contact pages",
		urlPattern: "/contact/{slug}",
	});
	const { template } = await admin.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<section data-wc-id="s1">{{@form contact}}</section>`,
	});
	await admin.api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await admin.api.entries.create({ siteId, postTypeId: postType.id, title: "Contact", slug: "form" });
	await admin.api.entries.publish({ siteId, entryId: entry.id });

	const visitor = formVisitor(install);
	const page = await visitor.open(`${origin}/contact/form`);
	await install.clock.advance(5_000);
	expect((await visitor.send(page, { message: "Please call me back on 555 0100" })).status).toBe(303);
	await install.drainJobs();
	owner = await install.createMember({ workspaceId, role: "owner" });
});

afterAll(async () => {
	await install.close();
});

describe("off unless chosen", () => {
	test("an AI client approved without choosing has every Toolset but Submissions", async () => {
		await approveAiClient(install, owner.browser, { workspaceId });
		const { grants } = await owner.browser.api.aiClients.list();
		expect(grants[0]?.toolsets).toContain("content");
		expect(grants[0]?.toolsets).not.toContain("submissions");
	});

	test("without the Submissions Toolset, no tool reads Submissions and /api/v1 refuses them", async () => {
		const { accessToken } = await approveAiClient(install, owner.browser, { workspaceId });
		const client = await connectMcp(install, accessToken);
		const { tools } = await client.listTools();
		expect(tools.map((tool) => tool.name)).not.toContain("forms_submissions_list");
		await client.close();

		const { secret } = await createApiToken(owner.browser, { workspaceId, name: "Without Submissions" });
		const script = tokenClient(install, secret);
		const answer = await script.request("m/forms/submissions/list", {
			body: JSON.stringify({ siteId }),
			headers: { "content-type": "application/json" },
		});
		expect(answer.status).toBe(403);
		expect(await answer.json()).toMatchObject({ code: "TOOLSET_OFF", data: { toolsets: ["submissions"] } });
	});
});

describe("chosen", () => {
	test("an AI client with the Submissions Toolset reads them, and every read is in the Audit log", async () => {
		const { accessToken } = await approveAiClient(
			install,
			owner.browser,
			{ workspaceId, toolsets: ["content", "submissions"] },
			{ client_name: "Inbox helper" },
		);
		const client = await connectMcp(install, accessToken);

		const listed = answerOf<{ submissions: { id: string }[] }>(
			await client.callTool({ name: "forms_submissions_list", arguments: { siteId, formId } }),
		);
		expect(listed.submissions).toHaveLength(1);
		const id = listed.submissions[0]?.id as string;
		const one = await client.callTool({ name: "forms_submissions_get", arguments: { siteId, id } });
		expect(JSON.stringify(one.structuredContent)).toContain("555 0100");
		await client.close();

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 20 });
		const reads = entries.filter((entry) => entry.action === "submissions.read");
		expect(reads.slice(0, 2).reverse()).toEqual([
			expect.objectContaining({
				personId: owner.personId,
				via: { kind: "aiClient", name: "Inbox helper" },
				siteId,
				details: expect.objectContaining({ procedure: "m.forms.submissions.list", input: { formId } }),
			}),
			expect.objectContaining({
				via: { kind: "aiClient", name: "Inbox helper" },
				details: expect.objectContaining({ procedure: "m.forms.submissions.get", input: { id } }),
			}),
		]);
	});

	test("an API token with the Submissions Toolset reads them at /api/v1, each read in the Audit log", async () => {
		const { secret } = await createApiToken(owner.browser, {
			workspaceId,
			name: "Inbox export",
			toolsets: ["submissions"],
		});
		const script = tokenClient(install, secret);
		const answer = await script.request("m/forms/submissions/export", {
			body: JSON.stringify({ siteId, formId }),
			headers: { "content-type": "application/json" },
		});
		expect(answer.status).toBe(200);

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 20 });
		expect(entries.find((entry) => entry.action === "submissions.read")).toMatchObject({
			via: { kind: "token", name: "Inbox export" },
			details: { procedure: "m.forms.submissions.export", input: { formId } },
		});
	});

	test("a read of Submissions whose input is over 1 MiB is held to the API's own limit, not the default one", async () => {
		const { secret } = await createApiToken(owner.browser, {
			workspaceId,
			name: "Inbox export with a long note",
			toolsets: ["submissions"],
		});
		const script = tokenClient(install, secret);
		const answer = await script.request("m/forms/submissions/export", {
			body: JSON.stringify({ siteId, formId, note: "x".repeat(2 * 1024 * 1024) }),
			headers: { "content-type": "application/json" },
		});
		expect(answer.status).not.toBe(413);
		expect(answer.status).toBeLessThan(500);
	});
});
