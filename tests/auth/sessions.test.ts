import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

let install: TestInstall;
let superadmin: TestAccount;

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin();
});

afterAll(async () => {
	await install.close();
});

describe("admin sessions", () => {
	test("end after 7 days unused, and the cookie is cleared", async () => {
		const browser = await install.signIn(superadmin);

		await install.clock.advance(7 * DAY - MINUTE);
		expect(await browser.api.session.current()).toMatchObject({ person: { email: superadmin.email } });

		await install.clock.advance(7 * DAY);
		expect(await browser.api.session.current()).toEqual({ person: null });
		expect(browser.cookies.size).toBe(0);
	});

	test("renew while they are used: each use gives another 7 days", async () => {
		const browser = await install.signIn(superadmin);

		for (let week = 0; week < 3; week++) {
			await install.clock.advance(6 * DAY);
			expect(await browser.api.session.current()).toMatchObject({ person: { email: superadmin.email } });
		}
	});

	test("end 30 days after signing in, however often they are used", async () => {
		const browser = await install.signIn(superadmin);

		for (let day = 1; day < 30; day++) {
			await install.clock.advance(DAY);
			expect(await browser.api.session.current()).toMatchObject({ person: { email: superadmin.email } });
		}
		await install.clock.advance(DAY);

		expect(await browser.api.session.current()).toEqual({ person: null });
	});

	test("an ended session can't be brought back: signing in again starts a new one", async () => {
		const browser = await install.signIn(superadmin);
		await install.clock.advance(8 * DAY);
		expect(await browser.api.session.current()).toEqual({ person: null });

		await browser.api.session.signIn({ email: superadmin.email, password: superadmin.password });

		expect(await browser.api.session.current()).toMatchObject({ person: { email: superadmin.email } });
	});
});
