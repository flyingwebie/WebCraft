import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";
import { rejection } from "../harness/settled.ts";

const MINUTE = 60 * 1000;

let install: TestInstall;
let superadmin: TestAccount;
let invited = 0;

/** A Sensitive action the Superadmin can take: inviting Staff (it grants a role). */
const inviteStaff = (browser: Awaited<ReturnType<TestInstall["signIn"]>>) =>
	browser.api.staff.invite({ email: `staff-${++invited}@agency.example`, workspaces: "all" });

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin();
});

afterAll(async () => {
	await install.close();
});

describe("Sensitive actions", () => {
	test("are allowed within 10 minutes of signing in: signing in with the password is an identity check", async () => {
		const browser = await install.signIn(superadmin);

		await install.clock.advance(10 * MINUTE - 1000);

		expect(await inviteStaff(browser)).toMatchObject({ invite: { workspaces: "all" } });
	});

	test("are refused once the last identity check is more than 10 minutes old", async () => {
		const browser = await install.signIn(superadmin);

		await install.clock.advance(10 * MINUTE + 1000);

		expect(await rejection(inviteStaff(browser))).toMatchObject({
			code: "IDENTITY_CHECK_REQUIRED",
			status: 403,
			data: { action: "staff.invite" },
		});
	});

	test("are allowed again for 10 minutes after the person confirms their password", async () => {
		const browser = await install.signIn(superadmin);
		await install.clock.advance(30 * MINUTE);

		await browser.api.session.confirmIdentity({ password: superadmin.password });

		expect(await inviteStaff(browser)).toBeDefined();
		await install.clock.advance(9 * MINUTE);
		expect(await inviteStaff(browser)).toBeDefined();
		await install.clock.advance(2 * MINUTE);
		expect(await rejection(inviteStaff(browser))).toMatchObject({ code: "IDENTITY_CHECK_REQUIRED" });
	});

	test("a wrong password confirms nothing", async () => {
		const browser = await install.signIn(superadmin);
		await install.clock.advance(30 * MINUTE);

		expect(await rejection(browser.api.session.confirmIdentity({ password: "not the right password" }))).toMatchObject({
			code: "INVALID_CREDENTIALS",
			status: 401,
		});

		expect(await rejection(inviteStaff(browser))).toMatchObject({ code: "IDENTITY_CHECK_REQUIRED" });
		expect(await browser.api.session.current()).toMatchObject({ person: { email: superadmin.email } });
	});

	test("a check counts only for the browser it was made in", async () => {
		const laptop = await install.signIn(superadmin);
		const phone = await install.signIn(superadmin);
		await install.clock.advance(30 * MINUTE);

		await laptop.api.session.confirmIdentity({ password: superadmin.password });

		expect(await inviteStaff(laptop)).toBeDefined();
		expect(await rejection(inviteStaff(phone))).toMatchObject({ code: "IDENTITY_CHECK_REQUIRED" });
	});

	test("are refused to people who may not take them before any identity check is asked for", async () => {
		const workspace = await install.createWorkspace();
		const staff = await install.createStaff({ workspaces: [workspace.id] });
		await install.clock.advance(30 * MINUTE);

		expect(await rejection(inviteStaff(staff.browser))).toMatchObject({ code: "FORBIDDEN", status: 403 });
	});

	test("confirming needs a session", async () => {
		const browser = install.browser();

		expect(await rejection(browser.api.session.confirmIdentity({ password: superadmin.password }))).toMatchObject({
			code: "UNAUTHORIZED",
		});
	});
});

describe("the test harness", () => {
	test("makes Staff even when the Superadmin's last identity check is old", async () => {
		await install.superadmin();
		await install.clock.advance(30 * MINUTE);

		expect(await install.createStaff({ workspaces: "all" })).toMatchObject({ personId: expect.any(String) });
	});
});

describe("actions that aren't Sensitive", () => {
	test("need no recent identity check", async () => {
		const browser = await install.signIn(superadmin);
		await install.clock.advance(2 * 24 * 60 * MINUTE);

		expect(await browser.api.workspaces.create({ name: "No check needed" })).toBeDefined();
	});
});
