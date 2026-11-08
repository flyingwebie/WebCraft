import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { API_PATH, createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let superadmin: TestAccount;

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin({ email: "sam@agency.example" });
});

afterAll(async () => {
	await install.close();
});

describe("signing in", () => {
	test("with the right email and password signs the person in", async () => {
		const browser = install.browser();

		const { person } = await browser.api.session.signIn({ email: "Sam@Agency.example", password: superadmin.password });

		expect(person).toMatchObject({ name: superadmin.name, email: "sam@agency.example", installRole: "superadmin" });
		expect(await browser.api.session.current()).toMatchObject({ person: { email: "sam@agency.example" } });
	});

	test("the session cookie is HttpOnly, Secure and SameSite=Lax", async () => {
		const response = await install.request(install.adminUrl(`${API_PATH}/session/signIn`), {
			method: "POST",
			headers: { "content-type": "application/json", origin: "https://admin.test" },
			body: JSON.stringify({ json: { email: superadmin.email, password: superadmin.password } }),
		});

		expect(response.status).toBe(200);
		const [cookie] = response.headers.getSetCookie();
		expect(cookie).toMatch(/^__Secure-webcraft\.session_token=/);
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("Secure");
		expect(cookie).toMatch(/SameSite=Lax/i);
		expect(cookie).toContain("Path=/");
	});

	test("a wrong password is refused, and so is an unknown email, with the same answer", async () => {
		const browser = install.browser();

		const wrongPassword = browser.api.session.signIn({ email: superadmin.email, password: "not the right password" });
		const unknownEmail = browser.api.session.signIn({ email: "nobody@agency.example", password: superadmin.password });

		await expect(wrongPassword).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
		await expect(unknownEmail).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
		const [first, second] = await Promise.allSettled([wrongPassword, unknownEmail]);
		expect(first.status === "rejected" && first.reason.message).toBe(
			second.status === "rejected" && second.reason.message,
		);
		expect(browser.cookies.size).toBe(0);
		expect(await browser.api.session.current()).toEqual({ person: null });
	});

	test("is refused when the request comes from another site's page", async () => {
		const browser = install.browser({ origin: "https://evil.example" });

		await expect(
			browser.api.session.signIn({ email: superadmin.email, password: superadmin.password }),
		).rejects.toMatchObject({ status: 403 });
	});
});

describe("signing out", () => {
	test("ends the session: the browser is signed out and the old cookie no longer works", async () => {
		const browser = await install.signIn(superadmin);
		const stolen = new Map(browser.cookies);

		await browser.api.session.signOut();

		expect(browser.cookies.size).toBe(0);
		expect(await browser.api.session.current()).toEqual({ person: null });
		const replayed = await install.request(install.adminUrl(`${API_PATH}/session/current`), {
			method: "POST",
			headers: {
				"content-type": "application/json",
				cookie: Array.from(stolen, ([name, value]) => `${name}=${value}`).join("; "),
			},
			body: JSON.stringify({ json: {} }),
		});
		expect(await replayed.json()).toEqual({ json: { person: null } });
	});

	test("when nobody is signed in does nothing", async () => {
		const browser = install.browser();

		await browser.api.session.signOut();

		expect(await browser.api.session.current()).toEqual({ person: null });
	});

	test("another session of the same person stays signed in", async () => {
		const laptop = await install.signIn(superadmin);
		const phone = await install.signIn(superadmin);

		await laptop.api.session.signOut();

		expect(await phone.api.session.current()).toMatchObject({ person: { email: superadmin.email } });
	});
});
