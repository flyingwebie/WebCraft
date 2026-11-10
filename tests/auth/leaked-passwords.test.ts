import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";

import { createTestInstall, inviteLinkIn, type TestBrowser, type TestInstall } from "../harness/index.ts";

/** The range service: given the first 5 characters of a password's SHA-1, it lists the leaked ones. */
const RANGE = /^https:\/\/api\.pwnedpasswords\.com\/range\/[0-9A-F]{5}$/;

const LEAKED = "correct horse battery staple";

function sha1(password: string): string {
	return createHash("sha1").update(password).digest("hex").toUpperCase();
}

/** A range answer listing `password` as seen `count` times, among other hashes. */
function rangeListing(password: string, count: number): string {
	const suffix = sha1(password).slice(5);
	return ["0018A45C4D1DEF81644B54AB7F969B88D65:3", `${suffix}:${count}`, "00D4F6E8FA6EECAD2A3AA415EEC418D38EC:0"].join(
		"\r\n",
	);
}

let install: TestInstall;
let person: TestBrowser;

beforeAll(async () => {
	install = await createTestInstall();
	const workspace = await install.createWorkspace();
	person = (await install.createMember({ workspaceId: workspace.id, role: "owner" })).browser;
});

afterAll(async () => {
	await install.close();
});

beforeEach(async () => {
	install.http.reset();
	// Changing a password is a Sensitive action; the person signed in moments ago, but keep it fresh.
	await person.api.session.confirmIdentity({ password: currentPassword });
});

let currentPassword = "a long enough test password";
async function changePassword(newPassword: string) {
	await person.api.me.changePassword({ newPassword });
	currentPassword = newPassword;
}

describe("the leaked-password check", () => {
	test("refuses a password found in leaked-password lists; only the first 5 characters of its hash leave the server", async () => {
		install.http.respond("GET", RANGE, { body: rangeListing(LEAKED, 52_579) });

		await expect(changePassword(LEAKED)).rejects.toMatchObject({
			code: "PASSWORD_REFUSED",
			data: { problem: "leaked" },
		});

		expect(install.http.requests.map((request) => request.url)).toEqual([
			`https://api.pwnedpasswords.com/range/${sha1(LEAKED).slice(0, 5)}`,
		]);
		const [request] = install.http.requests;
		expect(request?.headers.get("add-padding")).toBe("true");
		expect(JSON.stringify({ ...request, headers: Object.fromEntries(request?.headers ?? []) })).not.toContain(
			sha1(LEAKED).slice(5),
		);
		expect(JSON.stringify(install.logs)).not.toContain(LEAKED);
	});

	test("accepts a password the lists don't hold, and one only listed as padding (seen 0 times)", async () => {
		install.http.respond("GET", RANGE, { body: rangeListing("some other password entirely", 7) });
		await expect(changePassword("a password nobody has leaked yet")).resolves.toBeUndefined();

		install.http.respond("GET", RANGE, { body: rangeListing("padding only password here", 0) });
		await expect(changePassword("padding only password here")).resolves.toBeUndefined();
	});

	test("accepts the password and logs a warning when the lookup can't be reached", async () => {
		await expect(changePassword("chosen while the service is down")).resolves.toBeUndefined();

		install.http.respond("GET", RANGE, { status: 503, body: "Service Unavailable" });
		await expect(changePassword("chosen while the service is failing")).resolves.toBeUndefined();

		const warnings = install.logs.filter(
			(entry) => entry.level === "warn" && entry.msg.includes("leaked-password lookup failed"),
		);
		expect(warnings).toHaveLength(2);
		expect(JSON.stringify(warnings)).not.toContain("chosen while the service");
	});

	test("checks new accounts too", async () => {
		install.http.respond("GET", RANGE, { body: rangeListing(LEAKED, 3) });
		const admin = await install.superadmin();
		await admin.api.staff.invite({ email: "leaky@agency.example", workspaces: "all" });
		const token = new URL(inviteLinkIn(await install.lastEmailTo("leaky@agency.example"))).searchParams.get("token");

		await expect(
			install
				.browser()
				.api.invites.accept({ token: token ?? "", name: "Leaky", password: LEAKED, adminLanguage: "en" }),
		).rejects.toMatchObject({ code: "PASSWORD_REFUSED", data: { problem: "leaked" } });
	});
});

describe("switching the leaked-password check", () => {
	test("is on unless the Superadmin switches it off; then nothing is looked up", async () => {
		const admin = await install.superadmin();
		expect(await admin.api.install.security.get()).toEqual({ leakedPasswordCheck: true, requireTwoFactor: false });
		install.http.respond("GET", RANGE, { body: rangeListing(LEAKED, 52_579) });

		await admin.api.session.confirmIdentity({ password: "a long enough test password" });
		await admin.api.install.security.update({ leakedPasswordCheck: false });

		expect(await admin.api.install.security.get()).toEqual({ leakedPasswordCheck: false, requireTwoFactor: false });
		await expect(changePassword(LEAKED)).resolves.toBeUndefined();
		expect(install.http.requests).toEqual([]);

		await admin.api.install.security.update({ leakedPasswordCheck: true });
		await person.api.session.confirmIdentity({ password: currentPassword });
		await expect(changePassword(`${LEAKED}!`)).resolves.toBeUndefined();
		expect(install.http.requests).toHaveLength(1);
	});

	test("is recorded in the Audit log", async () => {
		const admin = await install.superadmin();
		await admin.api.session.confirmIdentity({ password: "a long enough test password" });

		await admin.api.install.security.update({ leakedPasswordCheck: false });
		await admin.api.install.security.update({ leakedPasswordCheck: true });

		const { entries } = await admin.api.audit.list({ limit: 2 });
		expect(entries).toMatchObject([
			{ action: "leakedPasswordCheck.change", details: { on: true } },
			{ action: "leakedPasswordCheck.change", details: { on: false } },
		]);
	});

	test("is for the Superadmin only", async () => {
		const staff = await install.createStaff({ workspaces: "all" });

		await expect(staff.browser.api.install.security.get()).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(staff.browser.api.install.security.update({ leakedPasswordCheck: false })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
		await expect(person.api.install.security.update({ leakedPasswordCheck: false })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});
