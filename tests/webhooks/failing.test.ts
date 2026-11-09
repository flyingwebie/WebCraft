// A Webhook that keeps failing is switched off (spec story 139): after 10 deliveries in a row failed
// (each after all its attempts), WebCraft switches it off and sends the Site's Owners the
// `webhook-switched-off` email once. A delivery that goes through starts the count again; test sends
// don't count. Staff switch it on again once the receiver works.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { RecordedRequest } from "../harness/fake-http.ts";
import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { confirmed } from "./support.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let staffAccount: TestAccount;
let owner: { email: string };
let editor: { email: string };
let otherSitesOwner: { email: string };

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	({ browser: staff, account: staffAccount } = await install.createStaff({ workspaces: [workspaceId] }));
	owner = (await install.createMember({ workspaceId, role: "owner", email: "owner@client.example" })).account;
	editor = (await install.createMember({ workspaceId, role: "editor", email: "editor@client.example" })).account;
	const elsewhere = (await install.createSite(workspaceId)).id;
	otherSitesOwner = (
		await install.createMember({ workspaceId, role: "owner", sites: [elsewhere], email: "careers@client.example" })
	).account;
	install.dns.answer("hooks.agency.example", ["93.184.216.34"]);
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

/** A new Site with a Webhook receiving `publish` at `https://hooks.agency.example/<path>`, answered `status`. */
async function webhookAnswering(path: string, status: number) {
	const { id: siteId } = await install.createSite(workspaceId, { name: "Acme Bakery", slug: `failing-${++sites}` });
	const url = `https://hooks.agency.example/${path}`;
	install.http.respond("POST", url, { status });
	const { webhook } = await confirmed(staff, staffAccount, () =>
		staff.api.webhooks.add({ siteId, name: "CRM", url, events: ["publish"] }),
	);
	return { siteId, webhookId: webhook.id, url };
}

/** Publishes the Site's Globals `times` times, each delivery run to its end. */
async function publish(siteId: string, times: number): Promise<void> {
	for (let count = 0; count < times; count++) {
		await staff.api.globals.publish({ siteId });
		expect((await install.drainJobs()).failed).toEqual([]);
	}
}

async function webhookOf(siteId: string) {
	const [webhook] = (await staff.api.webhooks.list({ siteId })).webhooks;
	if (!webhook) throw new Error("No Webhook.");
	return webhook;
}

/** The `webhook-switched-off` emails that went to an address (written to the log: the Install has no SMTP). */
function switchedOffEmailsTo(address: string): { subject: string; text: string }[] {
	return install.logs.flatMap((entry) => {
		const email = entry.email as { to?: string; subject?: string; text?: string } | undefined;
		return email?.to === address && email.subject?.startsWith("A Webhook of Acme Bakery was switched off")
			? [{ subject: email.subject, text: email.text ?? "" }]
			: [];
	});
}

function requestsTo(url: string): RecordedRequest[] {
	return install.http.requests.filter((request) => request.url === url);
}

describe("a Webhook that keeps failing", () => {
	test("is switched off after 10 failed deliveries in a row, and the Site's Owners are emailed once", async () => {
		const { siteId, url } = await webhookAnswering("gone", 404);

		await publish(siteId, 9);
		expect(await webhookOf(siteId)).toMatchObject({ status: "on", failuresInARow: 9 });
		expect(switchedOffEmailsTo(owner.email)).toEqual([]);

		await publish(siteId, 1);
		expect(await webhookOf(siteId)).toMatchObject({ status: "off", offReason: "failing", failuresInARow: 10 });
		const [email, ...more] = switchedOffEmailsTo(owner.email);
		expect(more).toEqual([]);
		expect(email?.subject).toBe("A Webhook of Acme Bakery was switched off");
		expect(email?.text).toContain("CRM");
		expect(email?.text).toContain("hooks.agency.example");
		expect(email?.text).toContain("10");
		expect(email?.text).toContain(`https://${install.adminHost}/sites/${siteId}/webhooks`);
		expect(email?.text).not.toContain("/gone");
		for (const address of [editor.email, otherSitesOwner.email]) {
			expect(switchedOffEmailsTo(address)).toEqual([]);
		}

		// Switched off, it receives nothing more.
		await publish(siteId, 2);
		expect(requestsTo(url)).toHaveLength(10);
		expect(switchedOffEmailsTo(owner.email)).toHaveLength(1);
	});

	test("a delivery that goes through starts the count again", async () => {
		const { siteId, url } = await webhookAnswering("flaky", 500);
		install.http.respond("POST", url, { status: 400 });
		await publish(siteId, 9);
		install.http.respond("POST", url, { status: 200 });
		await publish(siteId, 1);
		expect(await webhookOf(siteId)).toMatchObject({ status: "on", failuresInARow: 0 });

		install.http.respond("POST", url, { status: 400 });
		await publish(siteId, 9);
		expect(await webhookOf(siteId)).toMatchObject({ status: "on", failuresInARow: 9 });
	});

	test("switched on again by Staff, its count starts over and it receives events again", async () => {
		const { siteId, webhookId, url } = await webhookAnswering("recovered", 404);
		await publish(siteId, 10);
		expect(await webhookOf(siteId)).toMatchObject({ status: "off", offReason: "failing" });

		install.http.respond("POST", url, { status: 200 });
		const { webhook } = await staff.api.webhooks.setEnabled({ siteId, webhookId, enabled: true });
		expect(webhook).toMatchObject({ status: "on", offReason: null, failuresInARow: 0 });
		await publish(siteId, 1);
		expect(requestsTo(url)).toHaveLength(11);
	});
});
