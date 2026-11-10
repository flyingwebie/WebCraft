// Site settings › Content API in a real browser: the switch and its addresses, the Content keys (a
// working one with origins and use, a revoked one), making a key from the keyboard and the key shown
// once, a refused origin said beside its field, editing and revoking a key, and what it shows (a Post
// Type and Fields hidden, saved from the keyboard), in light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const created = await local.createStaff({ workspaces: [workspaceId] });
	staff = created.account;
	const api = created.browser.api;
	await api.postTypes.create({
		siteId,
		name: "Recipes",
		key: "recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "price", label: "Price", type: "number" },
			{
				key: "origin",
				label: "Origin",
				type: "group",
				fields: [{ key: "city", label: "City", type: "text" }],
			},
		],
	});
	await api.globals.setFields({ siteId, fields: [{ key: "phone", label: "Phone", type: "text" }] });
	await api.contentApi.update({ siteId, enabled: true });
	await api.contentApi.keys.create({ siteId, name: "Shop app", origins: ["https://shop.example.com"] });
	const old = await api.contentApi.keys.create({ siteId, name: "Old kiosk" });
	await api.contentApi.keys.revoke({ siteId, keyId: old.key.id });
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Site › Content API, ${theme}`, () => {
		const open = async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, staff);
			await page.goto(install.adminUrl(`/sites/${siteId}/content-api`));
			await page.waitForLoadState("networkidle");
			return page;
		};

		test("the switch, the keys (working and revoked) and what it shows", async () => {
			const page = await open();
			await page.getByText("Shop app").waitFor();
			await page.getByText("Revoked", { exact: true }).waitFor();

			await expectAccessibleScreen(page, `Content API (${theme})`);
		});

		test("the New key dialog opens and closes from the keyboard", async () => {
			const page = await open();
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "New key" }),
				"dialog",
				`Content API › New key (${theme})`,
			);
		});

		test("a key made from the keyboard is shown once, to copy", async () => {
			const page = await open();
			await page.getByRole("button", { name: "New key" }).focus();
			await page.keyboard.press("Enter");
			const dialog = page.getByRole("dialog", { name: "New Content key" });
			await dialog.waitFor();
			await dialog.getByLabel("Name").fill(`Kiosk ${theme}`);
			await dialog.getByLabel("Origins").fill("https://kiosk.example.com\nhttp://localhost:5173");
			await dialog.getByRole("button", { name: "Make key" }).focus();
			await page.keyboard.press("Enter");

			const shown = page.getByRole("dialog", { name: `Kiosk ${theme} is ready` });
			await shown.waitFor();
			expect(await shown.getByLabel("Key").inputValue()).toMatch(/^webcraft-ck_/);
			await expectNoAxeViolations(page, `Content API › the key shown (${theme})`, ["region"]);
			await shown.getByRole("button", { name: "Done" }).click();
			await shown.waitFor({ state: "hidden" });
			await page.getByText(`Kiosk ${theme}`).waitFor();
			await page.getByText("http://localhost:5173").first().waitFor();
		});

		test("an origin that isn't one is said beside its field", async () => {
			const page = await open();
			await page.getByRole("button", { name: "New key" }).click();
			const dialog = page.getByRole("dialog");
			await dialog.getByLabel("Name").fill("Wildcard");
			await dialog.getByLabel("Origins").fill("https://*.example.com");
			await dialog.getByRole("button", { name: "Make key" }).click();
			await dialog.getByText("https://*.example.com isn't an origin", { exact: false }).waitFor();

			await expectNoAxeViolations(page, `Content API › a refused origin (${theme})`, ["region"]);
			await page.keyboard.press("Escape");
		});

		test("editing a key and revoking one open their dialogs from the keyboard", async () => {
			const page = await open();
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Edit Shop app" }),
				"dialog",
				`Content API › Edit (${theme})`,
			);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Revoke Shop app" }),
				"dialog",
				`Content API › Revoke (${theme})`,
			);
		});

		test("hiding a Field from the keyboard is saved", async () => {
			const page = await open();
			const price = page.getByRole("checkbox", { name: /^Price/ });
			await price.focus();
			await page.keyboard.press("Space");
			await page.getByRole("button", { name: "Save what it shows" }).focus();
			await page.keyboard.press("Enter");
			await page.getByText("What the Content API shows was saved.").waitFor();

			const { hidden } = await (await install.install.superadmin()).api.contentApi.get({ siteId });
			expect(Object.values(hidden.fields).flat()).toContain("price");
			await page.getByRole("checkbox", { name: /^Price/ }).focus();
			await page.keyboard.press("Space");
			await page.getByRole("button", { name: "Save what it shows" }).click();
			await page.getByText("What the Content API shows was saved.").first().waitFor();
		});
	});
}
