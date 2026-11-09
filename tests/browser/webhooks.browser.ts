// Site › Webhooks in a real browser: a Site with a Webhook that delivers and one that kept failing
// (switched off), the delivery log with a delivery opened, the menus and dialogs (adding a Webhook,
// the signing secret shown once, removing one), used from the keyboard, in light and dark; and the
// screen as an Owner sees it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let owner: TestAccount;
let siteId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	owner = (await local.createMember({ workspaceId, role: "owner", email: "owner@client.example" })).account;
	local.dns.answer("hooks.agency.example", ["93.184.216.34"]);
	local.dns.answer("crm.client.example", ["93.184.216.35"]);
	local.http.respond("POST", "https://hooks.agency.example/build", { status: 200, body: '{"queued":true}' });
	local.http.respond("POST", "https://crm.client.example/inbound/token", { status: 404, body: "Unknown hook" });
	await api.webhooks.add({
		siteId,
		name: "Build hook",
		url: "https://hooks.agency.example/build",
		events: ["publish"],
	});
	await api.webhooks.add({
		siteId,
		name: "CRM",
		url: "https://crm.client.example/inbound/token",
		events: ["publish"],
	});
	// Ten failed deliveries switch the CRM's Webhook off; the build hook delivers each one.
	for (let count = 0; count < 10; count++) {
		await api.globals.publish({ siteId });
		expect((await local.drainJobs()).failed).toEqual([]);
	}
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Site › Webhooks, ${theme}`, () => {
		const open = async (account = superadmin, path = `/sites/${siteId}/webhooks`) => {
			const page = await install.newPage(theme);
			await install.signIn(page, account);
			await page.goto(install.adminUrl(path));
			await page.waitForLoadState("networkidle");
			return page;
		};

		test("the Webhooks, one switched off after failing, and a delivery log with a delivery opened", async () => {
			const page = await open();
			await page.getByText("Off: kept failing").waitFor();
			await page.getByRole("link", { name: "Delivery log of CRM" }).click();
			await page.getByRole("heading", { name: "Delivery log: CRM" }).waitFor();
			await page.locator("details summary").first().click();
			await page.getByText("What was sent").first().waitFor();

			await expectAccessibleScreen(page, `Webhooks, a delivery opened (${theme})`);
		});

		test("a Webhook's menu opens and closes from the keyboard", async () => {
			const page = await open();
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Actions for Build hook" }),
				"menu",
				`Webhooks › a Webhook's menu (${theme})`,
			);
		});

		test("adding a Webhook", async () => {
			const page = await open();
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Add Webhook" }),
				"dialog",
				`Webhooks › Add a Webhook (${theme})`,
			);
		});

		test("the signing secret WebCraft made is shown once, to copy", async () => {
			const page = await open();
			await page.getByRole("button", { name: "Add Webhook" }).click();
			const dialog = page.getByRole("dialog");
			await dialog.getByLabel("Name").fill(`Search index ${theme}`);
			await dialog.getByLabel("URL").fill(`https://index.agency.example/${theme}`);
			await dialog.getByRole("button", { name: "Add Webhook" }).click();
			await page.getByRole("heading", { name: `The signing secret of Search index ${theme}` }).waitFor();

			await expectNoAxeViolations(page, `Webhooks › the signing secret shown (${theme})`, ["region"]);
			await page.getByRole("button", { name: "Done" }).click();
			await page.getByRole("dialog").waitFor({ state: "hidden" });
		});

		test("a refused URL is said beside its field", async () => {
			const page = await open();
			await page.getByRole("button", { name: "Add Webhook" }).click();
			const dialog = page.getByRole("dialog");
			await dialog.getByLabel("URL").fill("http://hooks.agency.example/insecure");
			await dialog.getByRole("button", { name: "Add Webhook" }).click();
			await dialog.getByText("A Webhook's URL must start with https://.").waitFor();

			await expectNoAxeViolations(page, `Webhooks › a refused URL (${theme})`, ["region"]);
			await page.keyboard.press("Escape");
		});

		test("removing a Webhook says what goes with it before it is confirmed", async () => {
			const page = await open();
			await page.getByRole("button", { name: "Actions for CRM" }).click();
			await page.getByRole("menuitem", { name: "Remove" }).click();
			await page.getByRole("dialog").getByText("delivery log (10 deliveries)").waitFor();

			await expectNoAxeViolations(page, `Webhooks › Remove (${theme})`, ["region"]);
			await page.keyboard.press("Escape");
		});

		test("as an Owner: each Webhook's origin, its status and its delivery log, nothing to change", async () => {
			const page = await open(owner);
			await page.getByText("https://crm.client.example").first().waitFor();
			expect(await page.getByRole("button", { name: "Add Webhook" }).count()).toBe(0);

			await expectAccessibleScreen(page, `Webhooks as an Owner (${theme})`);
		});
	});
}
