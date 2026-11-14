// The Management API's refusals under the dev server (`bun run dev`). The web process opens the
// Install's services once per process, but after every change to a source file the dev server runs
// the web process's code again. The packages the services are made of must not run again with it:
// a second copy of them holds other error classes than the ones the services throw, and a refusal
// (a wrong password, a link that no longer works) then answered 500 "Something went wrong", or
// stopped the page that asked, on the dev server alone. The production web process answers these
// in password-reset, invites and tenancy. So: after a change, every refusal keeps its own answer.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { utimes } from "node:fs/promises";

import { type BrowserInstall, pageErrors, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let email: string;

/** A source file of the web process: touching it makes the dev server run the web process's code again. */
const SOURCE_FILE = new URL("../../apps/server/src/routes/sign-in.tsx", import.meta.url);

beforeAll(async () => {
	install = await startBrowserInstall({ devServer: true });
	await install.createSuperadmin();
	const workspaceId = (await install.install.createWorkspace("Acme Ltd")).id;
	email = (await install.install.createMember({ workspaceId, role: "editor" })).account.email;
	// A page rendered before the change: the dev server has loaded the web process's code, its routes too.
	const before = await install.webBrowser().request(install.adminUrl("/sign-in"));
	expect(before.status).toBe(200);

	const now = new Date();
	await utimes(SOURCE_FILE, now, now);
	// The dev server sees the change and runs the code again with the next request.
	await Bun.sleep(2_000);
}, 300_000);

afterAll(async () => {
	await install?.close();
});

describe("refusals under the dev server, after a change to the web process's code", () => {
	test("the Management API answers each with its own code", async () => {
		const browser = install.webBrowser();
		await expect(browser.api.session.signIn({ email, password: "not the right password" })).rejects.toMatchObject({
			code: "INVALID_CREDENTIALS",
			status: 401,
		});
		await expect(browser.api.invites.get({ token: "not-a-link-anyone-was-sent" })).rejects.toMatchObject({
			code: "INVITE_INVALID",
		});
	});

	test("a page whose link no longer works says so", async () => {
		const page = await install.newPage("light");
		page.setDefaultTimeout(60_000);
		await page.goto(install.adminUrl("/invite?token=not-a-link-anyone-was-sent"));
		await page.getByRole("heading", { level: 1, name: "This link is no longer good" }).waitFor();
		await page.goto(install.adminUrl("/reset-password?token=not-a-link-anyone-was-sent"));
		await page.getByRole("heading", { level: 1, name: "This link is no longer good" }).waitFor();
		await page.getByRole("link", { name: "Ask for a new one" }).waitFor();
		expect(pageErrors(page)).toEqual([]);
		await page.close();
	});

	test("a wrong password on the sign-in page says so", async () => {
		const page = await install.newPage("light");
		page.setDefaultTimeout(60_000);
		await page.goto(install.adminUrl("/sign-in"), { waitUntil: "networkidle" });
		await page.locator("#sign-in-email").fill(email);
		await page.locator("#sign-in-password").fill("not the right password");
		await page.locator("form button[type=submit]").click();
		await page.locator("#sign-in-error").waitFor();
		expect(await page.locator("#sign-in-error").textContent()).toStartWith("The email or password is wrong.");
		expect(pageErrors(page)).toEqual([]);
		await page.close();
	});
});
