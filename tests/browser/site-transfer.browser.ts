// Site export and Site import in a browser, in light and dark: Site › Export with an export ready to
// download, Workspace › Site imports with a file uploaded from the keyboard into the start form, a
// Site import report with its tabs, and the Paused domains on Site › Domains.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { exportedArchive, exportSite, importArchive } from "../harness/site-transfer.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let siteId: string;
let otherWorkspaceId: string;
let doneImportId: string;
let importedSiteId: string;
let archive: Uint8Array;

beforeAll(async () => {
	install = await startBrowserInstall();
	// The web process runs on the real clock: the export's 24-hour link must hold by it.
	await install.install.clock.set(new Date());
	superadmin = await install.createSuperadmin();
	const workspaceId = (await install.install.createWorkspace("Acme Ltd")).id;
	otherWorkspaceId = (await install.install.createWorkspace("Beta Ltd")).id;
	siteId = (await install.install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await install.install.createMember({ workspaceId, role: "editor", name: "Eve Editor" });
	const admin = await install.install.superadmin();
	await admin.api.domains.add({ siteId, name: "acmebakery.example", withPartner: true });
	archive = await exportedArchive(install.install, admin, siteId);
	// An export ready to download, on the Export page.
	await exportSite(install.install, admin, siteId);
	const done = await importArchive(install.install, admin, otherWorkspaceId, archive, {
		name: "Beta Bakery",
		slug: "beta-bakery",
	});
	doneImportId = done.id;
	importedSiteId = done.site?.id ?? "";
});

afterAll(async () => {
	await install.close();
});

/** Opens an admin page signed in and waits until it settled. */
async function open(page: Page, path: string) {
	await install.signIn(page, superadmin);
	await page.goto(install.adminUrl(path));
	await page.waitForLoadState("networkidle");
}

for (const theme of THEMES) {
	describe(`Site export and import, ${theme}`, () => {
		test("Site › Export, an export ready to download, and the form's problems", async () => {
			const page = await open_(theme, `/sites/${siteId}/export`);
			await page
				.getByRole("link", { name: /^Download webcraft-site-bakery/ })
				.first()
				.waitFor();
			await expectAccessibleScreen(page, `Site export (${theme})`);

			const passphrase = page.getByLabel("Export passphrase (optional)");
			await passphrase.focus();
			await page.keyboard.type("short");
			const start = page.getByRole("button", { name: "Export Site", exact: true });
			await start.focus();
			await page.keyboard.press("Enter");
			await page.getByText("Use at least 12 characters.").waitFor();
			await expectNoAxeViolations(page, `Site export, a passphrase too short (${theme})`);
		});

		test("Workspace › Site imports: a file uploaded into the start form", async () => {
			const page = await open_(theme, `/workspaces/${otherWorkspaceId}/site-imports`);
			await page
				.getByRole("link", { name: /Open the import of/ })
				.first()
				.waitFor();
			await expectAccessibleScreen(page, `Site imports (${theme})`);

			await page.locator("input[type=file]").setInputFiles({
				name: `bakery-${theme}.tar`,
				mimeType: "application/x-tar",
				buffer: Buffer.from(archive),
			});
			await page.getByRole("heading", { name: "Import as a new Site" }).waitFor();
			await page.getByText("Acme Bakery (bakery), exported").waitFor();
			await expectAccessibleScreen(page, `Site import, ready to start (${theme})`);
		});

		test("a Site import report and its tabs, from the keyboard", async () => {
			const page = await open_(theme, `/workspaces/${otherWorkspaceId}/site-imports/${doneImportId}`);
			await page.getByRole("heading", { name: "Site import report" }).waitFor();
			await expectAccessibleScreen(page, `Site import report (${theme})`);

			const paused = page.getByRole("tab", { name: /Paused domains/ });
			await paused.focus();
			await page.keyboard.press("Enter");
			await page.getByRole("cell", { name: "acmebakery.example", exact: true }).waitFor();
			await expectNoAxeViolations(page, `Site import report, Paused domains (${theme})`);
		});

		test("Site › Domains shows the Paused domains to switch on", async () => {
			const page = await open_(theme, `/sites/${importedSiteId}/domains`);
			await page.getByRole("heading", { name: "Paused domains" }).waitFor();
			await expectAccessibleScreen(page, `Domains with Paused domains (${theme})`);
		});

		test("Submissions excluded from an export using the keyboard", async () => {
			const page = await open_(theme, `/sites/${siteId}/export`);
			const include = page.getByRole("checkbox", { name: "Include Submissions and private Form uploads" });
			await include.waitFor({ timeout: 5000 });
			expect(await include.isChecked()).toBe(true);
			await include.focus();
			await page.keyboard.press("Space");
			expect(await include.isChecked()).toBe(false);
			await page.getByRole("button", { name: "Export Site", exact: true }).focus();
			await page.keyboard.press("Enter");
			await page.getByText("The export is being written. Its download link shows here when it is ready.").waitFor();
			// The web process queues jobs by real time; bring the test worker up to it.
			await install.install.clock.set(new Date());
			expect((await install.install.drainJobs()).failed).toEqual([]);
			await page.reload();
			await page.getByText("Submissions and private Form uploads were left out.").first().waitFor();
			await expectAccessibleScreen(page, `Site export without Submissions (${theme})`);
		});
	});
}

/** A new page in the theme, opened at the path. */
async function open_(theme: (typeof THEMES)[number], path: string): Promise<Page> {
	const page = await install.newPage(theme);
	await open(page, path);
	return page;
}
