import { afterAll, beforeAll, describe, test } from "bun:test";

import { inviteLinkIn, type TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";
import { ADMIN_SCREENS, type ScreenFixture } from "./screens.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let staff: TestAccount;
let fixture: ScreenFixture;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	const { local } = install;
	const workspace = await local.createWorkspace("Acme Ltd");
	await local.createWorkspace("Nimbus Bikes");
	const site = await local.createSite(workspace.id, { name: "Acme Bakery", slug: "bakery" });
	await local.createSite(workspace.id, { name: "Acme Careers", slug: "careers" });
	staff = (await local.createStaff({ workspaces: [workspace.id], name: "Ciara Byrne" })).account;
	await local.createStaff({ workspaces: "all", name: "Tom Walsh" });
	const admin = await local.superadmin();
	await admin.api.staff.invite({ email: "niamh@agency.example", workspaces: [workspace.id] });
	const invite = local.mail.sent.findLast((email) => email.to === "niamh@agency.example");
	const inviteToken = new URL(inviteLinkIn(invite)).searchParams.get("token") ?? "";
	fixture = { workspaceId: workspace.id, siteId: site.id, inviteToken };
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`admin screens, ${theme}`, () => {
		for (const screen of ADMIN_SCREENS) {
			test(screen.name, async () => {
				const page = await install.newPage(theme);
				if (screen.as === "superadmin") await install.signIn(page, superadmin);
				if (screen.as === "staff") await install.signIn(page, staff);
				const path = typeof screen.path === "string" ? screen.path : screen.path(fixture);
				await page.goto(install.adminUrl(path));
				await page.waitForLoadState("networkidle");

				await expectAccessibleScreen(page, `${screen.name} (${theme})`);
			});
		}
	});
}
