// Where a Site's own mail server may be (audit A4-5): Staff name its host and port, so without a
// check Send test would be a port scanner and banner reader for the Install's own network. The host
// is resolved first and must be on the public internet, the connection goes to the address checked,
// and a connection that fails answers one fixed reason. The Superadmin may let Sites use a relay
// inside the network; the Install SMTP, the Superadmin's own, is never held to this.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { sample } from "../modules/sample/index.ts";

const PUBLIC = "93.184.216.40";
const NOT_PUBLIC = "The mail server's host doesn't resolve to an address on the public internet, so nothing was sent.";
const UNREACHABLE = "The mail server couldn't be reached, or didn't answer as a mail server.";

const SERVER = {
	host: "smtp.acmebakery.example",
	port: 587,
	security: "starttls",
	username: null,
	fromAddress: "hello@acmebakery.example",
} as const;

let install: TestInstall;
let workspaceId: string;
let siteId: string;
let staff: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall({ modules: [sample] });
	await (await install.superadmin()).api.modules.approve({ moduleId: "sample", version: "1.0.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	install.dns.answer("smtp.acmebakery.example", [PUBLIC]);
	install.dns.answer("relay.internal.example", ["10.0.0.25"]);
	install.dns.answer("mixed.example", [PUBLIC, "192.168.0.4"]);
});

afterAll(async () => {
	await install.close();
});

beforeEach(() => {
	install.mail.clear();
	install.mail.accept();
});

const sendTest = (server: { host: string; port: number }, as = staff, to = siteId) =>
	as.api.siteSmtp.sendTest({
		siteId: to,
		to: "davide@agency.example",
		fromName: null,
		replyTo: null,
		server: { ...SERVER, ...server },
	});

describe("Send test to a Site's own server", () => {
	test("never connects inside the server's network, and says the same whatever is there", async () => {
		for (const server of [
			{ host: "127.0.0.1", port: 5432 },
			{ host: "::1", port: 6379 },
			{ host: "10.0.0.25", port: 25 },
			{ host: "169.254.169.254", port: 80 },
			{ host: "relay.internal.example", port: 25 },
			{ host: "mixed.example", port: 25 },
			// A name that doesn't resolve reads the same as one that resolves inside.
			{ host: "postgres", port: 5432 },
		]) {
			expect(await sendTest(server)).toEqual({ status: "failed", response: NOT_PUBLIC });
		}
		expect(install.mail.attempts).toEqual([]);
	});

	test("connects to the address it checked, keeping the name for the certificate (DNS rebinding)", async () => {
		install.dns.answerInTurn("rebind.example", [[PUBLIC], ["127.0.0.1"]]);
		const lookupsBefore = install.dns.lookups.length;

		const result = await sendTest({ host: "rebind.example", port: 465 });

		expect(result.status).toBe("sent");
		expect(install.mail.sent.map((email) => email.smtp)).toMatchObject([
			{ host: "rebind.example", port: 465, connectTo: PUBLIC },
		]);
		expect(install.dns.lookups.slice(lookupsBefore)).toEqual(["rebind.example"]);
	});

	test("a server that can't be reached, or isn't a mail server, answers one fixed reason; the log keeps what happened", async () => {
		for (const happened of [
			`connect ECONNREFUSED ${PUBLIC}:587`,
			"Greeting never received",
			"SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13",
		]) {
			install.mail.fail(happened);
			const loggedBefore = install.logs.length;

			expect(await sendTest(SERVER)).toEqual({ status: "failed", response: UNREACHABLE });

			const logged = install.logs
				.slice(loggedBefore)
				.find((line) => line.msg === "A Site's own mail server couldn't be reached");
			expect(logged).toMatchObject({ level: "warn", response: happened });
		}
		// What a mail server says in SMTP is still passed on: it is how Staff fix their settings.
		install.mail.fail("535 5.7.8 Authentication failed");
		expect(await sendTest(SERVER)).toEqual({ status: "failed", response: "535 5.7.8 Authentication failed" });
	});
});

describe("a Site's mail through its own server", () => {
	const notes = (browser: TestBrowser) => moduleApi<typeof sample>(browser, "sample").notes;

	test("is never sent to a saved server that is inside the network: it fails with the fixed reason", async () => {
		const site = await install.createSite(workspaceId, { name: "Acme Café" });
		await staff.api.siteSmtp.update({
			siteId: site.id,
			fromName: null,
			replyTo: null,
			server: { ...SERVER, host: "relay.internal.example", port: 25 },
		});
		const { note } = await notes(staff).add({ siteId: site.id, body: "Pick up at noon." });

		await notes(staff).share({ siteId: site.id, noteId: note.id, email: "baker@client.example" });
		await install.drainJobs();

		expect(install.mail.attempts).toEqual([]);
		const { lines } = await (await install.superadmin()).api.install.emailLog.list({ limit: 50 });
		expect(lines.find((line) => line.recipient === "baker@client.example")).toMatchObject({
			smtp: "site",
			status: "retrying",
			lastResponse: NOT_PUBLIC,
		});
		expect((await staff.api.siteSmtp.get({ siteId: site.id })).health).toMatchObject({
			failuresInARow: 1,
			lastResponse: NOT_PUBLIC,
		});
	});

	test("goes to the address checked for its saved server", async () => {
		const site = await install.createSite(workspaceId, { name: "Acme Deli" });
		await staff.api.siteSmtp.update({ siteId: site.id, fromName: null, replyTo: null, server: SERVER });
		const { note } = await notes(staff).add({ siteId: site.id, body: "Closed on Monday." });

		await notes(staff).share({ siteId: site.id, noteId: note.id, email: "baker@client.example" });
		await install.drainJobs();

		expect(install.mail.sent.map((email) => email.smtp)).toMatchObject([
			{ host: "smtp.acmebakery.example", connectTo: PUBLIC },
		]);
	});
});

describe("servers inside the Install's network", () => {
	test("only the Superadmin lets Sites use them; then Send test connects, still to the address it checked", async () => {
		const admin = await install.superadmin();
		expect((await admin.api.install.smtp.get()).sitePrivateServers).toBe(false);
		await expect(staff.api.install.smtp.setSitePrivateServers({ on: true })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});

		expect(await admin.api.install.smtp.setSitePrivateServers({ on: true })).toEqual({ sitePrivateServers: true });
		try {
			expect((await admin.api.install.smtp.get()).sitePrivateServers).toBe(true);
			const { entries } = await admin.api.audit.list({ limit: 1 });
			expect(entries[0]).toMatchObject({ action: "siteSmtpPrivateServers.change", details: { on: true } });

			expect((await sendTest({ host: "relay.internal.example", port: 25 })).status).toBe("sent");
			expect((await sendTest({ host: "10.0.0.25", port: 25 })).status).toBe("sent");
			expect(install.mail.sent.map((email) => email.smtp)).toMatchObject([
				{ host: "relay.internal.example", port: 25, connectTo: "10.0.0.25" },
				{ host: "10.0.0.25", port: 25 },
			]);
			// A name that doesn't resolve is still not called.
			expect(await sendTest({ host: "postgres", port: 5432 })).toEqual({ status: "failed", response: NOT_PUBLIC });
		} finally {
			await admin.api.install.smtp.setSitePrivateServers({ on: false });
		}
		expect(await sendTest({ host: "relay.internal.example", port: 25 })).toEqual({
			status: "failed",
			response: NOT_PUBLIC,
		});
	});

	test("the Install SMTP, the Superadmin's own, may be one, and its server's words are passed on", async () => {
		const admin = await install.superadmin();
		install.mail.fail("connect ECONNREFUSED 10.0.0.25:25");

		const result = await admin.api.install.smtp.sendTest({
			to: "davide@agency.example",
			settings: {
				host: "relay.internal.example",
				port: 25,
				security: "none",
				username: null,
				fromAddress: "noreply@agency.example",
				replyTo: null,
			},
		});

		expect(result).toEqual({ status: "failed", response: "connect ECONNREFUSED 10.0.0.25:25" });
		expect(install.mail.attempts.map((email) => email.smtp)).toEqual([
			{ host: "relay.internal.example", port: 25, security: "none", username: null, password: null },
		]);
	});
});
