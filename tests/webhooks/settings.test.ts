// Webhooks are Site settings (spec stories 51, 139): Staff add them per Site with a URL and a signing
// secret, which is a secret (write-only, "set" and its last 4 characters). They save at once, are
// recorded in the Audit log, and are never part of Publish all.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

async function newSite(): Promise<string> {
	return (await install.createSite(workspaceId, { name: "Acme Bakery" })).id;
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
		expect((await staff.api.webhooks.list({ siteId })).events).toEqual(["publish"]);
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
