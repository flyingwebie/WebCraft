import { afterAll, beforeAll, expect, test } from "bun:test";

import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";
import { liveWordpressReply } from "./live-wordpress.ts";

let install: BrowserInstall;

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const admin = await install.install.superadmin();
	await admin.api.modules.approve({ moduleId: "wordpress-import", version: "1.1.0" });
	install.install.dns.answer("live-browser.example", ["93.184.216.80"]);
	install.install.http.respond("GET", /^https:\/\/live-browser.example\//, (r) => liveWordpressReply(new URL(r.url)));
});

afterAll(async () => {
	await install.close();
});

const languages = [
	{
		code: "en",
		filter: "What",
		actions: [
			["import.connect", "Import source connected"],
			["import.credentials.use", "Import login used"],
			["import.remove", "Import removed"],
		],
	},
	{
		code: "it",
		filter: "Cosa",
		actions: [
			["import.connect", "Origine dell'importazione collegata"],
			["import.credentials.use", "Credenziali dell'importazione utilizzate"],
			["import.remove", "Importazione rimossa"],
		],
	},
] as const;

for (const theme of THEMES) {
	for (const language of languages) {
		test(`live Import audit actions have readable labels and work in the filter, ${language.code}, ${theme}`, async () => {
			const workspace = await install.install.createWorkspace();
			const site = await install.install.createSite(workspace.id);
			const staff = await install.install.createStaff({ workspaces: [workspace.id] });
			await staff.browser.api.me.updatePreferences({ adminLanguage: language.code, adminTheme: theme });
			const connected = await staff.browser.api.imports.connect({
				siteId: site.id,
				source: "wordpress-import.live",
				name: "Audited import",
				address: "https://live-browser.example",
				username: "writer",
				applicationPassword: "one-time-application-password",
			});
			const removal = { siteId: site.id, importId: connected.importId };
			const asked = await staff.browser.api.imports.remove(removal);
			if (asked.removed) throw new Error("Removing an Import must ask for confirmation.");
			await staff.browser.api.imports.remove({ ...removal, confirmation: asked.confirmation.id });
			const page = await install.newPage(theme);
			try {
				await install.signIn(page, staff.account);
				await page.goto(install.adminUrl(`/workspaces/${workspace.id}/audit-log`));
				await page.waitForLoadState("networkidle");
				const filter = page.getByLabel(language.filter, { exact: true });
				for (const [action, label] of language.actions) {
					expect(await filter.getByRole("option", { name: label, exact: true }).count()).toBe(1);
					await filter.selectOption(action);
					await page.waitForFunction((label) => {
						const rows = Array.from(document.querySelectorAll("tbody tr"));
						return (
							rows.length > 0 && rows.every((row) => row.querySelector("td:nth-child(3)")?.textContent?.includes(label))
						);
					}, label);
					expect(await filter.inputValue()).toBe(action);
				}
				await expectAccessibleScreen(page, `Import Audit log (${language.code}, ${theme})`);
			} finally {
				await page.close();
			}
		});
	}
}
