// Imports in a browser, in light and dark: the Import list, the steps of a new Import (Source, Map,
// Preview) driven from the keyboard, a run in progress (Run), an Import report (Report) with its
// Undo dialog, and the CSV side sheet an Owner opens from a Post Type's Entries.
import { afterAll, beforeAll, describe, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let owner: TestAccount;
let siteId: string;
let postTypeId: string;
let importId: string;
let doneRunId: string;
let waitingRunId: string;
let waitingImportId: string;

const CSV = "name,sku,price,notes\nPumpkin loaf,PK-700,5.50,check stock\nSeeded rye,RY-650,5.20 €,\nFocaccia,FO-1,6,\n";

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	const workspaceId = (await install.install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	owner = (await install.install.createMember({ workspaceId, role: "owner" })).account;
	const { api } = await install.install.superadmin();
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Products",
		urlPattern: "/products/{slug}",
		fields: [
			{ key: "sku", label: "SKU", type: "text" },
			{ key: "price", label: "Price", type: "number" },
		],
	});
	postTypeId = postType.id;
	const settings = {
		postTypeId,
		language: null,
		match: "fields.sku",
		columns: [
			{ column: "name", to: "title" },
			{ column: "sku", to: "fields.sku" },
			{ column: "price", to: "fields.price" },
			{ column: "notes", to: null },
		],
	};
	const csvFile = () => new File([CSV], "products-spring.csv", { type: "text/csv" });
	// A run that ended, with a problem row, a skipped column and Drafts it created.
	const done = await api.imports.create({ siteId, name: "Spring products", source: "csv", settings });
	importId = done.import.id;
	const first = await api.imports.uploadCsv({ siteId, file: csvFile() });
	doneRunId = (await api.imports.start({ siteId, importId, fileId: first.file.id })).run.id;
	await install.install.drainJobs();
	// A run the worker hasn't taken yet: its page shows the Run step.
	const waiting = await api.imports.create({ siteId, name: "Autumn products", source: "csv", settings });
	waitingImportId = waiting.import.id;
	const second = await api.imports.uploadCsv({ siteId, file: csvFile() });
	waitingRunId = (await api.imports.start({ siteId, importId: waitingImportId, fileId: second.file.id })).run.id;
});

afterAll(async () => {
	await install.close();
});

/** Opens an admin page signed in and waits until it settled. */
async function open(page: Page, account: TestAccount, path: string) {
	await install.signIn(page, account);
	await page.goto(install.adminUrl(path));
	await page.waitForLoadState("networkidle");
}

/** Presses a button from the keyboard. */
async function press(page: Page, name: string) {
	const button = page.getByRole("button", { name, exact: true });
	await button.focus();
	await page.keyboard.press("Enter");
}

for (const theme of THEMES) {
	describe(`Imports, ${theme}`, () => {
		test("the Import list", async () => {
			const page = await install.newPage(theme);
			await open(page, superadmin, `/sites/${siteId}/imports`);
			await page.getByText("Spring products", { exact: true }).waitFor();

			await expectAccessibleScreen(page, `Imports (${theme})`);
		});

		test("the steps of a new Import: Source, Map and Preview, from the keyboard", async () => {
			const page = await install.newPage(theme);
			await open(page, superadmin, `/sites/${siteId}/imports/new`);
			await expectAccessibleScreen(page, `New Import, Source (${theme})`);

			await page.locator("input[type=file]").setInputFiles({
				name: "products-autumn.csv",
				mimeType: "text/csv",
				buffer: Buffer.from(CSV),
			});
			await page.getByText("3 rows · 4 columns · comma separated · UTF-8").waitFor();
			await page.getByLabel("Post Type", { exact: true }).selectOption({ label: "Products" });
			await expectAccessibleScreen(page, `New Import, Source with a file (${theme})`);

			await press(page, "Continue to mapping");
			await page.getByRole("heading", { name: "Columns" }).waitFor();
			await page.getByText(/Will create/).waitFor();
			await expectAccessibleScreen(page, `New Import, Map (${theme})`);

			await press(page, "Preview");
			await page.getByRole("button", { name: "See rows" }).waitFor();
			await press(page, "See rows");
			await page.getByText("Not a number (write it like 5.50 or 5,50).").waitFor();
			await expectAccessibleScreen(page, `New Import, Preview (${theme})`);
		});

		test("a run in progress (Run)", async () => {
			const page = await install.newPage(theme);
			await open(page, superadmin, `/sites/${siteId}/imports/${waitingImportId}/runs/${waitingRunId}`);
			await page.getByRole("progressbar").waitFor();

			await expectAccessibleScreen(page, `Import run (${theme})`);
		});

		test("an Import report (Report), its tabs, and Undo from the keyboard", async () => {
			const page = await install.newPage(theme);
			await open(page, superadmin, `/sites/${siteId}/imports/${importId}/runs/${doneRunId}`);
			await page.getByRole("tab", { name: "Problem rows (1)" }).waitFor();
			await expectAccessibleScreen(page, `Import report (${theme})`);

			const created = page.getByRole("tab", { name: "Created (3)" });
			await created.focus();
			await page.keyboard.press("Enter");
			await page.getByRole("link", { name: "Pumpkin loaf" }).waitFor();
			await expectNoAxeViolations(page, `Import report, Created (${theme})`);

			await expectOverlayUsable(page, page.getByRole("button", { name: "Undo run" }), "dialog", `Undo (${theme})`);
		});

		test("the CSV side sheet an Owner opens from a Post Type's Entries", async () => {
			const page = await install.newPage(theme);
			await open(page, owner, `/sites/${siteId}/entries/${postTypeId}`);
			const trigger = page.getByRole("button", { name: "Import CSV" });

			await expectOverlayUsable(page, trigger, "dialog", `Import CSV (${theme})`);

			await trigger.focus();
			await page.keyboard.press("Enter");
			await page.locator("input[type=file]").setInputFiles({
				name: "products-autumn.csv",
				mimeType: "text/csv",
				buffer: Buffer.from(CSV),
			});
			await page.getByText(/Will create/).waitFor();
			// The sheet is placed at the end of the page, outside the landmarks, as dialogs are.
			await expectNoAxeViolations(page, `Import CSV with a file (${theme})`, ["region"]);
		});
	});
}
