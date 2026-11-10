// Health alerts (spec story 15): one email to the Superadmin when part of the Install has been
// Failing for 5 minutes, one when it has worked again for 15, none for a part that flaps, and a
// banner across the admin while anything is Failing. The worker's minute check works them out here
// (`healthChecks: true` runs it with each drain), or the Install health screen when no worker runs.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { createTestInstall, type SentEmail, type TestBrowser, type TestInstall } from "../harness/index.ts";

const MINUTE = 60_000;

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall({ healthChecks: true });
	await (await install.superadmin()).api.install.smtp.update({
		host: "smtp.agency.example",
		port: 587,
		security: "starttls",
		username: null,
		fromAddress: "noreply@agency.example",
		replyTo: null,
	});
	await install.backup();
});

beforeEach(async () => {
	// Whatever an earlier test left Failing has recovered, and its emails are done.
	for (let minute = 0; minute < 20; minute++) await minutePasses();
	install.mail.clear();
});

afterAll(async () => {
	await install.close();
});

const admin = (): Promise<TestBrowser> => install.superadmin();

/** A minute goes by with the worker running: its minute check runs. */
async function minutePasses(): Promise<void> {
	await install.clock.advance(MINUTE);
	await install.drainJobs();
}

/** The Health alerts the Superadmin got so far. */
function alerts(): SentEmail[] {
	return install.mail.sent.filter(
		(email) => email.to === "superadmin@agency.example" && /failing|works again/.test(email.subject),
	);
}

/** Storage can't be written to, as a disk mounted read-only. Answers how to undo it. */
function storageReadOnly(): () => void {
	const folders = [
		install.storageDir,
		...readdirSync(install.storageDir).map((name) => join(install.storageDir, name)),
	];
	for (const folder of folders) chmodSync(folder, 0o555);
	return () => {
		for (const folder of folders) chmodSync(folder, 0o755);
	};
}

describe("a part that fails, then recovers", () => {
	test("sends one email after 5 minutes Failing, one after 15 minutes working again, and nothing else", async () => {
		const undo = storageReadOnly();
		try {
			for (let minute = 0; minute < 4; minute++) await minutePasses();
			expect(alerts()).toEqual([]);

			await minutePasses();
			await minutePasses();
			const [failing, ...more] = alerts();
			expect(more).toEqual([]);
			expect(failing?.subject).toBe("WebCraft: Storage is failing");
			expect(failing?.text).toContain("Storage: WebCraft can't write to it.");
			expect(failing?.text).toContain("https://admin.test/install/health");

			for (let minute = 0; minute < 10; minute++) await minutePasses();
			expect(alerts()).toHaveLength(1);
		} finally {
			undo();
		}

		for (let minute = 0; minute < 14; minute++) await minutePasses();
		expect(alerts()).toHaveLength(1);
		await minutePasses();
		await minutePasses();
		const [, recovered, ...after] = alerts();
		expect(after).toEqual([]);
		expect(recovered?.subject).toBe("WebCraft: Storage works again");
		expect(recovered?.text).toMatch(/Storage works again, after failing for \d+ minutes\./);

		for (let minute = 0; minute < 20; minute++) await minutePasses();
		expect(alerts()).toHaveLength(2);
	});
});

describe("flapping", () => {
	test("a part Failing for a few minutes at a time never sends an email", async () => {
		for (let round = 0; round < 3; round++) {
			const undo = storageReadOnly();
			try {
				for (let minute = 0; minute < 3; minute++) await minutePasses();
			} finally {
				undo();
			}
			await minutePasses();
		}

		expect(alerts()).toEqual([]);
	});

	test("an alerted part that fails again before it has worked for 15 minutes sends no new email", async () => {
		let undo = storageReadOnly();
		try {
			for (let minute = 0; minute < 6; minute++) await minutePasses();
		} finally {
			undo();
		}
		expect(alerts()).toHaveLength(1);

		for (let minute = 0; minute < 10; minute++) await minutePasses();
		undo = storageReadOnly();
		try {
			for (let minute = 0; minute < 6; minute++) await minutePasses();
		} finally {
			undo();
		}
		expect(alerts()).toHaveLength(1);

		for (let minute = 0; minute < 16; minute++) await minutePasses();
		expect(alerts().map((email) => email.subject)).toEqual([
			"WebCraft: Storage is failing",
			"WebCraft: Storage works again",
		]);
	});
});

describe("the banner", () => {
	test("shows the Superadmin what is Failing while it is, linking to Install health", async () => {
		expect((await (await admin()).api.shell.context()).banners.health).toEqual({ failing: [] });

		const undo = storageReadOnly();
		try {
			await minutePasses();
			expect((await (await admin()).api.shell.context()).banners.health).toEqual({ failing: ["storage"] });
		} finally {
			undo();
		}
		await minutePasses();
		expect((await (await admin()).api.shell.context()).banners.health).toEqual({ failing: [] });
	});
});

describe("when the worker stops", () => {
	test("the banner says so at once, and the screen's checks send the alert straight away, without a worker", async () => {
		// No drain: no worker checks in, and no minute check runs.
		await install.clock.advance(3 * MINUTE);
		expect((await (await admin()).api.shell.context()).banners.health).toEqual({ failing: ["worker"] });

		await (await admin()).api.installHealth.get({ refresh: true });
		await install.clock.advance(5 * MINUTE);
		await (await admin()).api.installHealth.get({ refresh: true });

		// Sent from the web process at once: no job had to run.
		const [failing] = alerts();
		expect(failing?.subject).toBe("WebCraft: The worker is failing");
		expect(failing?.text).toContain("no worker has checked in for over 2 minutes");
	});
});

describe("the emails", () => {
	test("can't be turned off", async () => {
		await expect((await admin()).api.me.emails.update({ turnedOff: ["health-failing"] })).rejects.toMatchObject({
			code: "EMAIL_ALWAYS_SENT",
		});
		const { emails } = await (await admin()).api.me.emails.get();
		expect(emails.find((email) => email.type === "health-recovered")).toMatchObject({
			category: "alert",
			canTurnOff: false,
		});
	});
});
