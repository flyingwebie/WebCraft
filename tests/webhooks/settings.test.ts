// Webhooks are Site settings (spec stories 51, 139): Staff add them per Site with a URL and a signing
// secret, which is a secret (write-only, "set" and its last 4 characters). They save at once, are
// recorded in the Audit log, and are never part of Publish all.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { RecordedRequest } from "../harness/fake-http.ts";
import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { confirmed, receiverAccepts } from "./support.ts";

const MINUTE = 60_000;

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let staffAccount: TestAccount;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	({ browser: staff, account: staffAccount } = await install.createStaff({ workspaces: [workspaceId] }));
	install.dns.answer("hooks.agency.example", ["93.184.216.34"]);
	install.dns.answer("new-hooks.agency.example", ["93.184.216.35"]);
});

afterAll(async () => {
	await install.close();
});

async function newSite(): Promise<string> {
	return (await install.createSite(workspaceId, { name: "Acme Bakery" })).id;
}

/** A new Site with one Webhook receiving `publish`, answered 200 at its URL. */
async function siteWithWebhook(url: string) {
	const siteId = await newSite();
	install.http.respond("POST", url, { status: 200 });
	const { webhook, secret } = await confirmed(staff, staffAccount, () =>
		staff.api.webhooks.add({ siteId, name: "Build hook", url, events: ["publish"] }),
	);
	return { siteId, webhookId: webhook.id, secret: secret ?? "" };
}

function requestsTo(url: string): RecordedRequest[] {
	return install.http.requests.filter((request) => request.url === url);
}

/** The Audit log entries of a Site with an action, newest first. */
async function auditOf(siteId: string, action: string) {
	const { entries } = await (await install.superadmin()).api.audit.list({ limit: 200 });
	return entries.filter((entry) => entry.siteId === siteId && entry.action === action);
}

describe("adding a Webhook", () => {
	test("without a secret, one is made and shown once; afterwards only 'set' and its last 4 characters", async () => {
		const siteId = await newSite();

		const added = await staff.api.webhooks.add({
			siteId,
			name: "Build hook",
			url: "https://hooks.agency.example/build",
			events: ["publish"],
		});

		expect(added.secret).toMatch(/^[A-Za-z0-9_-]{32,}$/);
		expect(added.webhook).toMatchObject({
			name: "Build hook",
			url: "https://hooks.agency.example/build",
			events: ["publish"],
			status: "on",
			secret: { set: true, lastFour: added.secret?.slice(-4) },
		});

		const { webhooks } = await staff.api.webhooks.list({ siteId });
		expect(webhooks).toHaveLength(1);
		expect(webhooks[0]).toMatchObject({
			id: added.webhook.id,
			secret: { set: true, lastFour: added.secret?.slice(-4) },
		});
		expect(JSON.stringify(webhooks)).not.toContain(added.secret ?? "missing");
	});

	test("with a secret Staff give, that one is kept and never shown back", async () => {
		const siteId = await newSite();
		const secret = "a-shared-secret-the-receiver-made-1234";

		const added = await staff.api.webhooks.add({
			siteId,
			url: "https://crm.client.example/inbound",
			events: ["publish"],
			secret,
		});

		expect(added.secret).toBeNull();
		expect(added.webhook).toMatchObject({ name: "crm.client.example", secret: { set: true, lastFour: "1234" } });
		expect(JSON.stringify(await staff.api.webhooks.list({ siteId }))).not.toContain(secret);
	});

	test("is recorded in the Audit log, with the host but never the secret", async () => {
		const siteId = await newSite();
		const added = await staff.api.webhooks.add({
			siteId,
			name: "Search index",
			url: "https://index.agency.example/hooks/T0123/secret-path",
			events: ["publish"],
		});

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 20 });
		const entry = entries.find((candidate) => candidate.action === "webhook.add" && candidate.siteId === siteId);
		expect(entry?.details).toEqual({
			webhookId: added.webhook.id,
			name: "Search index",
			host: "index.agency.example",
			events: ["publish"],
		});
		expect(JSON.stringify(entries)).not.toContain(added.secret ?? "missing");
		expect(JSON.stringify(entry)).not.toContain("secret-path");
	});
});

describe("what a Webhook may be", () => {
	test("its URL is https, without credentials, on a host that could be on the internet", async () => {
		const siteId = await newSite();
		const refused = [
			["http://hooks.agency.example/build", "scheme"],
			["ftp://hooks.agency.example/build", "scheme"],
			["hooks.agency.example/build", "format"],
			["https://user:pass@hooks.agency.example/build", "credentials"],
			["https://localhost/hook", "host"],
			["https://admin.localhost:3000/hook", "host"],
			["https://intranet/hook", "host"],
			["https://printer.local/hook", "host"],
			["https://build.internal/hook", "host"],
			["https://127.0.0.1/hook", "host"],
			["https://10.1.2.3/hook", "host"],
			["https://[::1]/hook", "host"],
			["https://169.254.169.254/latest/meta-data", "host"],
		] as const;
		for (const [url, reason] of refused) {
			await expect(staff.api.webhooks.add({ siteId, url, events: ["publish"] })).rejects.toMatchObject({
				code: "WEBHOOK_INVALID",
				data: { field: "url", reason },
			});
		}
		expect((await staff.api.webhooks.list({ siteId })).webhooks).toEqual([]);
	});

	test("a public address, a port and a query are fine; a fragment, never sent, is dropped", async () => {
		const siteId = await newSite();
		const { webhook } = await staff.api.webhooks.add({
			siteId,
			url: "https://93.184.216.34:8443/hook?source=webcraft#section",
			events: ["publish"],
		});
		expect(webhook.url).toBe("https://93.184.216.34:8443/hook?source=webcraft");
	});

	test("a signing secret Staff give is 16 to 200 visible characters", async () => {
		const siteId = await newSite();
		for (const secret of ["too-short", "has spaces in the middle of it", "x".repeat(201)]) {
			await expect(
				staff.api.webhooks.add({ siteId, url: "https://hooks.agency.example/a", events: ["publish"], secret }),
			).rejects.toMatchObject({ code: "WEBHOOK_INVALID", data: { field: "secret", reason: "format" } });
		}
	});

	test("it receives at least one event, from the list", async () => {
		const siteId = await newSite();
		expect((await staff.api.webhooks.list({ siteId })).events).toEqual(["publish", "formSubmitted"]);
		await expect(
			staff.api.webhooks.add({ siteId, url: "https://hooks.agency.example/a", events: [] }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			staff.api.webhooks.add({ siteId, url: "https://hooks.agency.example/a", events: ["deleted" as "publish"] }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	test("a Site has at most 20 Webhooks", async () => {
		const siteId = await newSite();
		for (let number = 1; number <= 20; number++) {
			await staff.api.webhooks.add({ siteId, url: `https://hooks.agency.example/${number}`, events: ["publish"] });
		}
		await expect(
			staff.api.webhooks.add({ siteId, url: "https://hooks.agency.example/21", events: ["publish"] }),
		).rejects.toMatchObject({ code: "TOO_MANY_WEBHOOKS", data: { max: 20 } });
	});
});

describe("who sees and changes Webhooks", () => {
	test("Members can't add one; Owners see each one's origin, but neither its full URL nor its secret", async () => {
		const siteId = await newSite();
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const editor = await install.createMember({ workspaceId, role: "editor" });
		await staff.api.webhooks.add({
			siteId,
			name: "Chat",
			url: "https://chat.agency.example/services/T0/B0/token-in-the-path",
			events: ["publish"],
		});

		for (const member of [owner, editor]) {
			await expect(
				member.browser.api.webhooks.add({ siteId, url: "https://evil.example/collect", events: ["publish"] }),
			).rejects.toMatchObject({ code: "FORBIDDEN", data: { permission: "structure.edit" } });
		}
		const { webhooks } = await owner.browser.api.webhooks.list({ siteId });
		expect(webhooks).toMatchObject([{ name: "Chat", url: "https://chat.agency.example", secret: null }]);
		expect(JSON.stringify(webhooks)).not.toContain("token-in-the-path");
	});
});

describe("changing a Webhook", () => {
	test("its name, URL and events change at once, as a Sensitive action, logged with the hosts only", async () => {
		const { siteId, webhookId } = await siteWithWebhook("https://hooks.agency.example/old/token-a");

		await install.clock.advance(11 * MINUTE);
		const change = {
			siteId,
			webhookId,
			name: "Search index",
			url: "https://new-hooks.agency.example/new/token-b",
			events: ["publish" as const],
		};
		await expect(staff.api.webhooks.update(change)).rejects.toMatchObject({
			code: "IDENTITY_CHECK_REQUIRED",
			data: { action: "webhook.change" },
		});
		const { webhook } = await confirmed(staff, staffAccount, () => staff.api.webhooks.update(change));

		expect(webhook).toMatchObject({ name: "Search index", url: "https://new-hooks.agency.example/new/token-b" });
		const [entry] = await auditOf(siteId, "webhook.update");
		expect(entry?.details).toEqual({
			webhookId,
			name: "Search index",
			host: "new-hooks.agency.example",
			events: ["publish"],
			changed: ["name", "url"],
		});
		expect(JSON.stringify(entry)).not.toContain("token-");

		await staff.api.globals.publish({ siteId });
		await install.drainJobs();
		expect(requestsTo("https://new-hooks.agency.example/new/token-b")).toHaveLength(1);
		expect(requestsTo("https://hooks.agency.example/old/token-a")).toEqual([]);
	});

	test("its new URL keeps the rules", async () => {
		const { siteId, webhookId } = await siteWithWebhook("https://hooks.agency.example/rules");
		await expect(
			confirmed(staff, staffAccount, () =>
				staff.api.webhooks.update({ siteId, webhookId, url: "http://hooks.agency.example/rules", events: ["publish"] }),
			),
		).rejects.toMatchObject({ code: "WEBHOOK_INVALID", data: { field: "url", reason: "scheme" } });
	});

	test("replacing its secret: a new one is made and shown once, or Staff give one; deliveries are signed with it", async () => {
		const url = "https://hooks.agency.example/rotated";
		const { siteId, webhookId, secret: first } = await siteWithWebhook(url);

		const made = await confirmed(staff, staffAccount, () => staff.api.webhooks.changeSecret({ siteId, webhookId }));
		expect(made.secret).toMatch(/^[A-Za-z0-9_-]{32,}$/);
		expect(made.secret).not.toBe(first);
		expect(made.webhook.secret).toMatchObject({ set: true, lastFour: made.secret?.slice(-4) });

		const given = "the-receivers-own-secret-0042";
		const kept = await confirmed(staff, staffAccount, () =>
			staff.api.webhooks.changeSecret({ siteId, webhookId, secret: given }),
		);
		expect(kept).toMatchObject({ secret: null, webhook: { secret: { set: true, lastFour: "0042" } } });

		await staff.api.globals.publish({ siteId });
		await install.drainJobs();
		const [request] = requestsTo(url);
		if (!request) throw new Error("Nothing was delivered.");
		expect(receiverAccepts(request, given, install.clock.now())).toBe(true);
		expect(receiverAccepts(request, first, install.clock.now())).toBe(false);

		const entries = await auditOf(siteId, "webhook.changeSecret");
		expect(entries.map((entry) => entry.details)).toEqual([
			{ webhookId, name: "Build hook" },
			{ webhookId, name: "Build hook" },
		]);
		expect(JSON.stringify(entries)).not.toContain(given);
	});

	test("switched off, it receives nothing; switched on again, it does; both are logged", async () => {
		const url = "https://hooks.agency.example/switched";
		const { siteId, webhookId } = await siteWithWebhook(url);

		const off = await staff.api.webhooks.setEnabled({ siteId, webhookId, enabled: false });
		expect(off.webhook).toMatchObject({ status: "off", offReason: "staff" });
		await staff.api.globals.publish({ siteId });
		await install.drainJobs();
		expect(requestsTo(url)).toEqual([]);
		expect((await staff.api.webhooks.deliveries({ siteId, webhookId })).deliveries).toEqual([]);

		const on = await staff.api.webhooks.setEnabled({ siteId, webhookId, enabled: true });
		expect(on.webhook).toMatchObject({ status: "on", offReason: null });
		await staff.api.globals.publish({ siteId });
		await install.drainJobs();
		expect(requestsTo(url)).toHaveLength(1);

		expect((await auditOf(siteId, "webhook.switchOff")).map((entry) => entry.details)).toEqual([
			{ webhookId, name: "Build hook" },
		]);
		expect(await auditOf(siteId, "webhook.switchOn")).toHaveLength(1);
	});

	test("switching it off stops deliveries still waiting, which can be redelivered once it is on again", async () => {
		const url = "https://hooks.agency.example/paused";
		const { siteId, webhookId } = await siteWithWebhook(url);
		install.http.respond("POST", url, { status: 503 });
		await staff.api.globals.publish({ siteId });
		await install.drainJobs();

		await staff.api.webhooks.setEnabled({ siteId, webhookId, enabled: false });
		const [stopped] = (await staff.api.webhooks.deliveries({ siteId, webhookId })).deliveries;
		expect(stopped).toMatchObject({ status: "failed", lastProblem: "switched-off", nextAttemptAt: null });
		await install.clock.advance(60 * MINUTE);
		await install.drainJobs();
		expect(requestsTo(url)).toHaveLength(1);

		install.http.respond("POST", url, { status: 200 });
		await staff.api.webhooks.setEnabled({ siteId, webhookId, enabled: true });
		await staff.api.webhooks.redeliver({ siteId, webhookId, deliveryId: stopped?.id ?? "" });
		await install.drainJobs();
		expect((await staff.api.webhooks.deliveries({ siteId, webhookId })).deliveries[0]).toMatchObject({
			status: "delivered",
		});
	});

	test("removing it takes two steps, and it goes with its secret and its delivery log", async () => {
		const url = "https://hooks.agency.example/removed";
		const { siteId, webhookId } = await siteWithWebhook(url);
		await staff.api.globals.publish({ siteId });
		await install.drainJobs();

		const asked = await staff.api.webhooks.remove({ siteId, webhookId });
		expect(asked).toMatchObject({ removed: false, preview: { name: "Build hook", url, deliveries: 1 } });
		expect((await staff.api.webhooks.list({ siteId })).webhooks).toHaveLength(1);
		if (asked.removed) throw new Error("Removed without confirming.");

		expect(await staff.api.webhooks.remove({ siteId, webhookId, confirmation: asked.confirmation.id })).toEqual({
			removed: true,
		});

		expect((await staff.api.webhooks.list({ siteId })).webhooks).toEqual([]);
		await expect(staff.api.webhooks.deliveries({ siteId, webhookId })).rejects.toMatchObject({
			code: "WEBHOOK_NOT_FOUND",
		});
		const signingSecret = {
			owner: { kind: "site", workspaceId, siteId },
			name: `webhook:${webhookId}:signing`,
		} as const;
		expect(await install.secrets.describe(signingSecret)).toEqual({ set: false });
		expect((await auditOf(siteId, "webhook.remove")).map((entry) => entry.details)).toEqual([
			{ webhookId, name: "Build hook", host: "hooks.agency.example" },
		]);
		await staff.api.globals.publish({ siteId });
		await install.drainJobs();
		expect(requestsTo(url)).toHaveLength(1);
	});

	test("Members change nothing", async () => {
		const { siteId, webhookId } = await siteWithWebhook("https://hooks.agency.example/members");
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const calls = [
			() =>
				owner.browser.api.webhooks.update({ siteId, webhookId, url: "https://evil.example/x", events: ["publish"] }),
			() => owner.browser.api.webhooks.changeSecret({ siteId, webhookId }),
			() => owner.browser.api.webhooks.setEnabled({ siteId, webhookId, enabled: false }),
			() => owner.browser.api.webhooks.remove({ siteId, webhookId }),
		];
		for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});
