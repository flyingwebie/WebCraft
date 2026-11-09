// The Staging address in a real browser (ADR 0014): the page it shows people it doesn't know, with
// the Site's staging password form, and again after a wrong password, in light and dark; and the
// right password, typed and sent from the keyboard, opening the Site.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
const slug = "review";
const PASSWORD = "a review password";

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	const siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const pages = (await api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	await api.entries.create({ siteId, postTypeId: pages?.id ?? "", title: "About us", slug: "about" });
	await api.staging.setPassword({ siteId, password: PASSWORD });
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`the Staging address, ${theme}`, () => {
		test("asks someone it doesn't know to sign in, or to give the staging password", async () => {
			const page = await install.newPage(theme);
			await page.goto(install.siteUrl(slug, "/about"));
			await page.getByRole("heading", { name: "Sign in to see this site" }).waitFor();

			await expectAccessibleScreen(page, `Staging address, signing in (${theme})`);
		});

		test("says beside the field when the password isn't right, and leaves focus there", async () => {
			const page = await install.newPage(theme);
			await page.goto(install.siteUrl(slug, "/about"));
			await page.getByLabel("Password").fill("not the password");
			await page.keyboard.press("Enter");
			await page.getByRole("alert").waitFor();
			expect(await page.title()).toStartWith("Error:");
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("password");

			await expectAccessibleScreen(page, `Staging address, a wrong password (${theme})`);
		});
	});
}

describe("giving the staging password", () => {
	test("from the keyboard opens the Site's Drafts", async () => {
		const page = await install.newPage("light");
		await page.goto(install.siteUrl(slug, "/about"));
		await page.getByLabel("Password").focus();
		await page.keyboard.type(PASSWORD);
		await page.keyboard.press("Enter");

		// The Page, never published, at the same address: its title, and no password form any more.
		await page.waitForFunction(() => document.title.startsWith("About us"));
		expect(page.url()).toBe(install.siteUrl(slug, "/about"));
		expect(await page.title()).toBe("About us · Acme Bakery");
		expect(await page.getByLabel("Password").count()).toBe(0);
	});
});
