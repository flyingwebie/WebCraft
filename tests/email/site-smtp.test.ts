// A Site's own mail server (Site SMTP): Staff set it on Site › Email, it is a Sensitive action like the
// Install SMTP, its password is a secret of the Site, and Send test tries settings before they are
// saved. Which emails go through it (the Site's mail) is in `tests/forms/notifications.test.ts`.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { createTestInstall, FAKE_SMTP_RESPONSE, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let siteId: string;
let workspaceId: string;

const SERVER = {
	host: "smtp.acmebakery.example",
	port: 587,
	security: "starttls",
	username: "mailer@acmebakery.example",
	fromAddress: "hello@acmebakery.example",
} as const;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	// A Site's own server must be on the public internet (`site-smtp-network.test.ts`).
	install.dns.answer(SERVER.host, ["93.184.216.40"]);
	install.dns.answer("smtp.elsewhere.example", ["93.184.216.41"]);
});

afterAll(async () => {
	await install.close();
});

beforeEach(async () => {
	install.mail.clear();
	install.mail.accept();
	await install.clock.advance(1_000);
});

describe("Site SMTP", () => {
	test("a new Site has none: its mail goes through the Install SMTP under the Site's name", async () => {
		const otherSite = (await install.createSite(workspaceId, { name: "Acme Café", slug: "cafe" })).id;

		expect(await staff.api.siteSmtp.get({ siteId: otherSite })).toEqual({
			settings: { fromName: null, replyTo: null, server: null, updatedAt: null },
			siteName: "Acme Café",
			health: { state: "not-set", failuresInARow: 0, failingSince: null, lastResponse: null },
		});
	});

	test("Staff set the Site's own server; the password is a Site secret, shown only as set with its last 4 characters", async () => {
		const saved = await staff.api.siteSmtp.update({
			siteId,
			fromName: "Acme Bakery orders",
			replyTo: "Orders@AcmeBakery.example",
			server: { ...SERVER, password: "a long site smtp password k3j9" },
		});

		const expected = {
			settings: {
				fromName: "Acme Bakery orders",
				replyTo: "orders@acmebakery.example",
				server: { ...SERVER, password: { set: true, lastFour: "k3j9", updatedAt: install.clock.now() } },
				updatedAt: install.clock.now(),
			},
			siteName: "Acme Bakery",
			health: { state: "working" as const, failuresInARow: 0, failingSince: null, lastResponse: null },
		};
		expect(saved).toEqual(expected);
		expect(await staff.api.siteSmtp.get({ siteId })).toEqual(expected);
		expect(JSON.stringify(saved)).not.toContain("a long site smtp password");
	});

	test("saving without a password keeps it; leaving the server out goes back to the Install SMTP and forgets it", async () => {
		await staff.api.siteSmtp.update({
			siteId,
			fromName: null,
			replyTo: null,
			server: { ...SERVER, password: "the first site password abcd" },
		});

		const kept = await staff.api.siteSmtp.update({
			siteId,
			fromName: null,
			replyTo: null,
			server: { ...SERVER, host: "mail.acmebakery.example" },
		});
		expect(kept.settings.server).toMatchObject({
			host: "mail.acmebakery.example",
			password: { set: true, lastFour: "abcd" },
		});

		const back = await staff.api.siteSmtp.update({ siteId, fromName: null, replyTo: null, server: null });
		expect(back.settings.server).toBeNull();
		expect(back.health.state).toBe("not-set");

		const again = await staff.api.siteSmtp.update({ siteId, fromName: null, replyTo: null, server: SERVER });
		expect(again.settings.server?.password).toEqual({ set: false });
	});

	test("each change is in the Audit log, with what changed but never the password", async () => {
		await staff.api.siteSmtp.update({
			siteId,
			fromName: "Bakery",
			replyTo: null,
			server: { ...SERVER, password: "an audited site password" },
		});
		await staff.api.siteSmtp.update({ siteId, fromName: "Bakery", replyTo: null, server: null });

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 2 });
		expect(entries).toMatchObject([
			{
				action: "siteSmtp.change",
				siteId,
				details: { fromName: "Bakery", replyTo: null, server: null, password: "removed" },
			},
			{
				action: "siteSmtp.change",
				siteId,
				details: { fromName: "Bakery", replyTo: null, server: { host: SERVER.host, port: 587 }, password: "replaced" },
			},
		]);
		expect(JSON.stringify(entries)).not.toContain("an audited site password");
	});

	test("addresses, host and port are checked", async () => {
		const change = { siteId, fromName: null, replyTo: null, server: SERVER };
		await expect(staff.api.siteSmtp.update({ ...change, replyTo: "nope" })).rejects.toMatchObject({
			code: "EMAIL_INVALID",
		});
		await expect(
			staff.api.siteSmtp.update({ ...change, server: { ...SERVER, fromAddress: "not an address" } }),
		).rejects.toMatchObject({ code: "EMAIL_INVALID" });
		await expect(staff.api.siteSmtp.update({ ...change, server: { ...SERVER, port: 0 } })).rejects.toMatchObject({
			code: "BAD_REQUEST",
		});
		await expect(
			staff.api.siteSmtp.update({ ...change, server: { ...SERVER, host: "smtp example com" } }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			staff.api.siteSmtp.update({ ...change, fromName: "Bakery\r\nBcc: everyone@example.com" }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	test("it is Structure: Owners can't read or change it", async () => {
		await expect(owner.api.siteSmtp.get({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			owner.api.siteSmtp.update({ siteId, fromName: null, replyTo: null, server: null }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("Send test email", () => {
	test("sends at once through the settings in the form, before they are saved, and answers the server's reply", async () => {
		await staff.api.siteSmtp.update({
			siteId,
			fromName: null,
			replyTo: null,
			server: { ...SERVER, password: "the stored site password" },
		});

		const result = await staff.api.siteSmtp.sendTest({
			siteId,
			to: "davide@agency.example",
			fromName: "Acme Bakery orders",
			replyTo: "orders@acmebakery.example",
			server: SERVER,
		});

		expect(result).toEqual({ status: "sent", response: FAKE_SMTP_RESPONSE });
		const [email] = install.mail.sent;
		expect(email).toMatchObject({
			to: "davide@agency.example",
			from: { name: "Acme Bakery orders", address: SERVER.fromAddress },
			replyTo: "orders@acmebakery.example",
			smtp: { host: SERVER.host, port: 587, password: "the stored site password" },
		});
	});

	test("the stored password goes only to the server it was saved for: another needs its password typed", async () => {
		await staff.api.siteSmtp.update({
			siteId,
			fromName: null,
			replyTo: null,
			server: { ...SERVER, password: "the stored site password" },
		});

		for (const server of [
			{ ...SERVER, host: "smtp.elsewhere.example" },
			{ ...SERVER, username: "someone-else@acmebakery.example" },
		]) {
			await expect(
				staff.api.siteSmtp.sendTest({ siteId, to: "davide@agency.example", fromName: null, replyTo: null, server }),
			).rejects.toMatchObject({ code: "SMTP_PASSWORD_NEEDED", status: 400 });
		}
		expect(install.mail.attempts).toEqual([]);

		const typed = await staff.api.siteSmtp.sendTest({
			siteId,
			to: "davide@agency.example",
			fromName: null,
			replyTo: null,
			server: { ...SERVER, host: "smtp.elsewhere.example", password: "its own password" },
		});
		expect(typed.status).toBe("sent");
		expect(install.mail.sent[0]?.smtp).toMatchObject({ host: "smtp.elsewhere.example", password: "its own password" });
	});

	test("without a server of its own, the test goes through the Install SMTP under the Site's name", async () => {
		const admin = await install.superadmin();
		await admin.api.install.smtp.update({
			host: "smtp.agency.example",
			port: 587,
			security: "starttls",
			username: null,
			fromAddress: "noreply@agency.example",
			replyTo: "help@agency.example",
		});

		const result = await staff.api.siteSmtp.sendTest({
			siteId,
			to: "davide@agency.example",
			fromName: null,
			replyTo: null,
			server: null,
		});

		expect(result.status).toBe("sent");
		const [email] = install.mail.sent;
		expect(email).toMatchObject({
			from: { name: "Acme Bakery", address: "noreply@agency.example" },
			smtp: { host: "smtp.agency.example" },
		});
		// The agency's own reply-to address is never given to a Site's mail.
		expect(email?.replyTo).toBeUndefined();
	});

	test("a server that refuses answers failed with its reply, and it doesn't count towards Failing", async () => {
		install.mail.fail("535 5.7.8 Authentication failed");

		const result = await staff.api.siteSmtp.sendTest({
			siteId,
			to: "davide@agency.example",
			fromName: null,
			replyTo: null,
			server: { ...SERVER, password: "a wrong password" },
		});

		expect(result).toEqual({ status: "failed", response: "535 5.7.8 Authentication failed" });
		expect((await staff.api.siteSmtp.get({ siteId })).health.failuresInARow).toBe(0);
	});
});
