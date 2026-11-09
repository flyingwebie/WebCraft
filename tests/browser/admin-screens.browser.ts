import { afterAll, beforeAll, describe, test } from "bun:test";
import { pdf, photo, upload } from "../harness/images.ts";
import { inviteLinkIn, type TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";
import { ADMIN_SCREENS, type ScreenFixture } from "./screens.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let staff: TestAccount;
let owner: TestAccount;
let fixture: ScreenFixture;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	const local = install.install;
	const workspace = await local.createWorkspace("Acme Ltd");
	await local.createWorkspace("Nimbus Bikes");
	const site = await local.createSite(workspace.id, { name: "Acme Bakery", slug: "bakery" });
	const careers = await local.createSite(workspace.id, { name: "Acme Careers", slug: "careers" });
	staff = (await local.createStaff({ workspaces: [workspace.id], name: "Ciara Byrne" })).account;
	await local.createStaff({ workspaces: "all", name: "Tom Walsh" });
	owner = (
		await local.createMember({ workspaceId: workspace.id, role: "owner", sites: [site.id], name: "Sarah Murphy" })
	).account;
	await local.createMember({ workspaceId: workspace.id, role: "editor", name: "Giulia Romano" });
	const author = await local.createMember({
		workspaceId: workspace.id,
		role: "author",
		sites: [careers.id],
		name: "Aoife Kelly",
	});
	const admin = await local.superadmin();
	// The sample Module runs on every Site; the sample board waits for approval.
	await admin.api.modules.approve({ moduleId: "sample", version: "1.0.0" });
	await admin.api.staff.invite({ email: "niamh@agency.example", workspaces: [workspace.id] });
	const invite = await local.lastEmailTo("niamh@agency.example");
	const inviteToken = new URL(inviteLinkIn(invite)).searchParams.get("token") ?? "";
	await admin.api.members.invite({
		workspaceId: workspace.id,
		email: "orders@acme.example",
		role: "author",
		sites: "all",
	});
	// A Member of one Workspace invited into another signs in and joins.
	const nimbus = (await admin.api.workspaces.list()).workspaces.find((listed) => listed.name === "Nimbus Bikes");
	await admin.api.members.invite({
		workspaceId: nimbus?.id ?? "",
		email: author.account.email,
		role: "editor",
		sites: "all",
	});
	const joinToken =
		new URL(inviteLinkIn(await local.lastEmailTo(author.account.email))).searchParams.get("token") ?? "";
	// The Media library: a folder holding a photo with its sizes made, and a document.
	const { folder } = await admin.api.media.folders.create({ siteId: site.id, name: "Products" });
	const { media } = await admin.api.media.upload({
		siteId: site.id,
		file: upload(await photo({ width: 700, height: 500 }), "sourdough-loaf.jpg"),
		folderId: folder.id,
	});
	await admin.api.media.update({ siteId: site.id, mediaId: media.id, alt: "A round sourdough loaf" });
	await admin.api.media.upload({ siteId: site.id, file: upload(pdf(), "allergen-guide.pdf") });
	await local.drainJobs();
	// The Site's languages: French, and Arabic, written right to left.
	await admin.api.languages.add({ siteId: site.id, code: "fr" });
	await admin.api.languages.add({ siteId: site.id, code: "ar" });
	fixture = { workspaceId: workspace.id, siteId: site.id, inviteToken, joinToken, mediaId: media.id };
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
				if (screen.as === "owner") await install.signIn(page, owner);
				const path = typeof screen.path === "string" ? screen.path : screen.path(fixture);
				await page.goto(install.adminUrl(path));
				await page.waitForLoadState("networkidle");

				await expectAccessibleScreen(page, `${screen.name} (${theme})`);
			});
		}
	});
}
