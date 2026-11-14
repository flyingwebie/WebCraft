// Settings screens on the settings layout, in a real browser: one foot bar for a screen of several
// cards (Save waits for a change, leaving with changes asks first, Discard puts every card back),
// saving every changed card at once ("Saving…", then "Saved"), a refused save ("Could not save",
// "Try again"), and a destructive row action that asks first, naming the thing; in light and dark,
// with the keyboard and axe.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let workspaceId: string;
let siteId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	const local = install.install;
	workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
});

afterAll(async () => {
	await install.close();
});

async function open(theme: (typeof THEMES)[number], path: string): Promise<Page> {
	const page = await install.newPage(theme);
	await install.signIn(page, superadmin);
	await page.goto(install.adminUrl(path));
	await page.waitForLoadState("networkidle");
	return page;
}

function footBar(page: Page) {
	return page.getByRole("region", { name: "Saving this screen" });
}

for (const theme of THEMES) {
	describe(`settings screens, ${theme}`, () => {
		test("one foot bar for two cards: leaving asks first, and Discard puts both back", async () => {
			const page = await open(theme, "/settings/security");
			const bar = footBar(page);
			const save = bar.getByRole("button", { name: "Save" });
			await bar.getByText("No changes").waitFor();
			expect(await save.isDisabled()).toBe(true);

			const leaked = page.getByRole("switch", { name: /leaked passwords/ });
			const retention = page.getByRole("combobox", { name: "Keep Audit log entries for" });
			const before = await retention.inputValue();
			expect(await leaked.isChecked()).toBe(true);
			await leaked.focus();
			await page.keyboard.press("Space");
			await retention.selectOption("730");
			await bar.getByText("Unsaved changes").waitFor();
			expect(await save.isDisabled()).toBe(false);
			await expectAccessibleScreen(page, `Security with unsaved changes (${theme})`);

			await page
				.getByRole("navigation", { name: "Admin" })
				.getByRole("link", { name: /^Workspaces/ })
				.click();
			const guard = page.getByRole("dialog", { name: "Leave without saving?" });
			await guard.waitFor();
			await page.waitForFunction(() => document.activeElement?.textContent === "Keep editing", undefined, {
				timeout: 2000,
			});
			await page.keyboard.press("Enter");
			await guard.waitFor({ state: "hidden" });
			expect(new URL(page.url()).pathname).toBe("/settings/security");

			await bar.getByRole("button", { name: "Discard" }).click();
			await bar.getByText("No changes").waitFor();
			expect(await leaked.isChecked()).toBe(true);
			expect(await retention.inputValue()).toBe(before);
			const { api } = await install.install.superadmin();
			expect((await api.install.security.get()).leakedPasswordCheck).toBe(true);
		});

		test("Save saves every changed card, then says Saved", async () => {
			const page = await open(theme, `/sites/${siteId}/seo`);
			const bar = footBar(page);
			await page.getByRole("textbox", { name: "Site name in titles" }).fill(`Acme ${theme}`);
			await page.getByRole("switch", { name: "Generate Social cards" }).click();
			await bar.getByText("Unsaved changes").waitFor();
			await bar.getByRole("button", { name: "Save" }).click();
			await bar.getByText("Saved", { exact: true }).waitFor();
			expect(await bar.getByRole("button", { name: "Save" }).isDisabled()).toBe(true);
			await expectAccessibleScreen(page, `SEO, saved (${theme})`);

			const { api } = await install.install.superadmin();
			const { settings } = await api.seoSettings.get({ siteId });
			expect(settings.siteName).toBe(`Acme ${theme}`);
			await api.seoSettings.update({
				siteId,
				siteName: null,
				socialCards: { ...settings.socialCards, enabled: !settings.socialCards.enabled },
			});
		});

		test("a refused save says Could not save, keeps what was typed and offers Try again", async () => {
			const page = await open(theme, `/sites/${siteId}/crawlers`);
			const bar = footBar(page);
			const lines = page.getByRole("textbox", { name: "Lines" });
			await lines.fill("Disallow: /private");
			await bar.getByRole("button", { name: "Save" }).click();
			await bar.getByText("Could not save").waitFor();
			await bar.getByRole("button", { name: "Try again" }).waitFor();
			expect(await lines.inputValue()).toBe("Disallow: /private");
			await expectAccessibleScreen(page, `Crawlers, could not save (${theme})`);

			await bar.getByRole("button", { name: "Discard" }).click();
			await bar.getByText("No changes").waitFor();
			expect(await lines.inputValue()).toBe("");
		});

		test("removing a row asks first, naming it, with focus on Cancel", async () => {
			const { api } = await install.install.superadmin();
			await api.protectedTerms.add({
				workspaceId,
				siteId: null,
				terms: [{ term: `Sourdough ${theme}`, matchCase: true }],
			});
			const page = await open(theme, `/workspaces/${workspaceId}/protected-terms`);
			await page.getByRole("button", { name: `Actions for Sourdough ${theme}` }).click();
			await page.getByRole("menuitem", { name: "Remove" }).click();
			const dialog = page.getByRole("dialog", { name: `Remove “Sourdough ${theme}”?` });
			await dialog.waitFor();
			await page.waitForFunction(() => document.activeElement?.textContent === "Cancel", undefined, { timeout: 2000 });
			await expectNoAxeViolations(page, `Protected terms, remove asks first (${theme})`, ["region"]);

			await page.keyboard.press("Enter");
			await dialog.waitFor({ state: "hidden" });
			const { terms } = await api.protectedTerms.list({ workspaceId });
			expect(terms.some((term) => term.term === `Sourdough ${theme}`)).toBe(true);
		});
	});
}
