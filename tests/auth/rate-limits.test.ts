import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { ipv6Network } from "../harness/addresses.ts";
import { API_PATH, createTestInstall, type TestAccount, type TestInstall } from "../harness/index.ts";
import { rejection } from "../harness/settled.ts";

const SECOND = 1000;

let install: TestInstall;
let superadmin: TestAccount;
let guesses = 0;

beforeAll(async () => {
	install = await createTestInstall();
	superadmin = await install.createSuperadmin();
});

afterAll(async () => {
	await install.close();
});

/** A sign-in with an address nobody signs in with, so no account gets locked along the way. */
function guess(browser: ReturnType<TestInstall["browser"]>) {
	return browser.api.session.signIn({ email: `guess-${++guesses}@agency.example`, password: "a guessed password" });
}

describe("auth endpoints", () => {
	test("take at most 10 requests a minute from one address; the next ones wait for the minute to pass", async () => {
		const guesser = install.browser({ address: "203.0.113.10" });
		for (let attempt = 0; attempt < 10; attempt++) {
			expect(await rejection(guess(guesser))).toMatchObject({ code: "INVALID_CREDENTIALS" });
		}
		await install.clock.advance(20 * SECOND);

		expect(await rejection(guess(guesser))).toMatchObject({
			code: "TOO_MANY_REQUESTS",
			status: 429,
			data: { retryAfterSeconds: 40 },
		});
		expect(await rejection(guesser.api.session.signIn(superadmin))).toMatchObject({ code: "TOO_MANY_REQUESTS" });

		await install.clock.advance(40 * SECOND);
		expect(await guesser.api.session.signIn(superadmin)).toMatchObject({
			person: { email: superadmin.email },
		});
	});

	test("count per address: another address isn't held back", async () => {
		const guesser = install.browser({ address: "203.0.113.11" });
		for (let attempt = 0; attempt < 11; attempt++) await guess(guesser).catch(() => {});

		const neighbour = install.browser({ address: "203.0.113.12" });
		expect(await neighbour.api.session.signIn(superadmin)).toBeDefined();
	});

	test("count an IPv6 connection by its /64: another address of it is no fresh start", async () => {
		const network = ipv6Network();
		for (let attempt = 0; attempt < 10; attempt++) {
			expect(await rejection(guess(install.browser({ address: network(attempt + 1) })))).toMatchObject({
				code: "INVALID_CREDENTIALS",
			});
		}

		expect(await rejection(guess(install.browser({ address: network(11) })))).toMatchObject({
			code: "TOO_MANY_REQUESTS",
			status: 429,
		});
		// Another connection's /64 isn't held back.
		const neighbour = install.browser({ address: ipv6Network()(1) });
		expect(await neighbour.api.session.signIn(superadmin)).toBeDefined();
	});

	test("share one limit: signing in, confirming who you are, setup tokens and invite links", async () => {
		const address = "2001:db8::55";
		const signedIn = await install.signIn(superadmin, { address });
		const visitor = install.browser({ address });
		await signedIn.api.session.confirmIdentity({ password: superadmin.password });
		expect(await rejection(visitor.api.setup.checkToken({ token: "not-a-token" }))).toMatchObject({
			code: "SETUP_CLOSED",
		});
		expect(await rejection(visitor.api.invites.get({ token: "not-a-token" }))).toMatchObject({
			code: "INVITE_INVALID",
		});
		for (let attempt = 0; attempt < 6; attempt++) await guess(visitor).catch(() => {});

		expect(await rejection(visitor.api.invites.get({ token: "not-a-token" }))).toMatchObject({
			code: "TOO_MANY_REQUESTS",
		});
		expect(await rejection(signedIn.api.session.confirmIdentity({ password: superadmin.password }))).toMatchObject({
			code: "TOO_MANY_REQUESTS",
		});
		expect(
			await rejection(
				visitor.api.setup.claim({
					token: "not-a-token",
					name: "Someone",
					email: "someone@agency.example",
					password: "a long enough password",
					adminLanguage: "en",
				}),
			),
		).toMatchObject({ code: "TOO_MANY_REQUESTS" });
		expect(
			await rejection(
				visitor.api.invites.accept({
					token: "not-a-token",
					name: "Someone",
					password: "a long enough password",
					adminLanguage: "en",
				}),
			),
		).toMatchObject({ code: "TOO_MANY_REQUESTS" });
	});

	test("leave everything else alone", async () => {
		const browser = await install.signIn(superadmin, { address: "203.0.113.13" });
		for (let attempt = 0; attempt < 11; attempt++) await guess(browser).catch(() => {});

		for (let call = 0; call < 20; call++) {
			expect(await browser.api.session.current()).toMatchObject({ person: { email: superadmin.email } });
		}
		expect(await browser.api.workspaces.list()).toBeDefined();
	});

	test("answer with Retry-After, and log the address once a minute", async () => {
		const guesser = install.browser({ address: "203.0.113.14" });
		for (let attempt = 0; attempt < 12; attempt++) await guess(guesser).catch(() => {});

		const response = await guesser.request(install.adminUrl(`${API_PATH}/session/signIn`), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ json: { email: superadmin.email, password: superadmin.password } }),
		});

		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("60");
		const warnings = install.logs.filter(
			(entry) => entry.msg.includes("Too many") && entry.clientAddress === "203.0.113.14",
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toMatchObject({ level: "warn", limit: "auth" });
	});

	test("requests whose address the web process can't tell share one limit", async () => {
		const first = install.browser({ address: null });
		const second = install.browser({ address: null });
		for (let attempt = 0; attempt < 10; attempt++) await guess(first).catch(() => {});

		expect(await rejection(guess(second))).toMatchObject({ code: "TOO_MANY_REQUESTS" });
	});
});
