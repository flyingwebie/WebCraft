// Install › Services list in a real browser: the services as rows, adding one in a sheet from the
// keyboard, a row's menu, moving a service down from its menu (said in a live region and saved), and
// removing one, which asks first with focus on Cancel. Light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { eventually } from "./building-area.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	const { api } = await install.install.superadmin();
	await api.servicesList.update({
		services: [
			{ name: "Search engine optimisation", description: "Pages people find." },
			{ name: "Monthly content", description: "Two new pages a month." },
		],
	});
});

afterAll(async () => {
	await install.close();
});

async function servicesPage(theme: Theme): Promise<Page> {
	const page = await install.newPage(theme);
	await install.signIn(page, superadmin);
	await page.goto(install.adminUrl("/services"));
	await page.waitForLoadState("networkidle");
	await page.getByRole("cell", { name: "Monthly content", exact: true }).waitFor();
	return page;
}

/** The services' names as the Install keeps them, in order. */
async function savedNames(): Promise<string[]> {
	const { api } = await install.install.superadmin();
	return (await api.servicesList.get()).services.map((service) => service.name);
}

/** The saved list once it is `names`: the screen shows a change before its save has landed. */
function savedAs(names: string[]): Promise<string[]> {
	return eventually(savedNames, (saved) => JSON.stringify(saved) === JSON.stringify(names), {
		what: "The saved Services list",
	});
}

for (const theme of THEMES) {
	describe(`Install › Services list, ${theme}`, () => {
		test("the rows, the add sheet and a row's menu from the keyboard", async () => {
			const page = await servicesPage(theme);
			await expectAccessibleScreen(page, `Services list (${theme})`);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Add service" }),
				"dialog",
				`Services list › add (${theme})`,
			);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Actions for Monthly content" }),
				"menu",
				`Services list › a service's menu (${theme})`,
			);
		});
	});
}

describe("changing the list", () => {
	test("adding a service from the keyboard saves it at the end", async () => {
		const page = await servicesPage("light");
		await page.getByRole("button", { name: "Add service" }).focus();
		await page.keyboard.press("Enter");
		const sheet = page.getByRole("dialog", { name: "Add service" });
		await sheet.getByLabel("Name").waitFor();
		// The name field has focus as the sheet opens.
		await page.keyboard.type("Photography");
		await sheet.getByLabel("What it is").fill("A day of photos at your place.");
		await sheet.getByRole("button", { name: "Add service" }).click();
		await sheet.waitFor({ state: "hidden" });
		await page.getByRole("cell", { name: "Photography", exact: true }).waitFor();
		expect(await savedAs(["Search engine optimisation", "Monthly content", "Photography"])).toEqual([
			"Search engine optimisation",
			"Monthly content",
			"Photography",
		]);
	});

	test("Move down in a row's menu moves the service, says so and saves the order", async () => {
		const page = await servicesPage("light");
		await page.getByRole("button", { name: "Actions for Search engine optimisation" }).click();
		await page.getByRole("menuitem", { name: "Move down" }).click();
		await page.getByRole("status").filter({ hasText: "Search engine optimisation moved to position 2." }).waitFor();
		// The move is said once it is saved.
		expect(await savedNames()).toEqual(["Monthly content", "Search engine optimisation", "Photography"]);
		expect(await page.getByRole("row").nth(1).textContent()).toContain("Monthly content");
		expect(await page.getByRole("row").nth(2).textContent()).toContain("Search engine optimisation");
	});

	test("removing a service asks first, naming it, with focus on Cancel", async () => {
		const page = await servicesPage("dark");
		await page.getByRole("button", { name: "Actions for Photography" }).click();
		await page.getByRole("menuitem", { name: "Remove" }).click();
		const dialog = page.getByRole("dialog", { name: "Remove Photography?" });
		await dialog.waitFor();
		expect(
			await dialog.getByRole("button", { name: "Cancel" }).evaluate((button) => button === document.activeElement),
		).toBe(true);
		await expectNoAxeViolations(page, "Services list › remove (dark)", ["region"]);
		await dialog.getByRole("button", { name: "Remove" }).click();
		await dialog.waitFor({ state: "hidden" });
		await page.getByRole("cell", { name: "Photography", exact: true }).waitFor({ state: "detached" });
		expect(await savedAs(["Monthly content", "Search engine optimisation"])).toEqual([
			"Monthly content",
			"Search engine optimisation",
		]);
	});
});
