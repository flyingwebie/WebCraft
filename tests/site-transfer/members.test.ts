// A Site export carries its Members by email only (ADR 0033): passwords, passkeys and 2FA never leave
// their Install. On import, a Member of the Workspace keeps their role and reaches the new Site; anyone
// else becomes a pending invitation, emailed only when someone sends them; what people without an
// account here did is attributed to the person importing, and listed; the Audit log keeps their names.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
	createTestInstall,
	inviteLinkIn,
	TEST_PASSWORD,
	type TestBrowser,
	type TestInstall,
} from "../harness/index.ts";
import { exportedArchive, importArchive } from "../harness/site-transfer.ts";

let source: TestInstall;
let workspaceId: string;
let otherWorkspaceId: string;
let siteId: string;
let archive: Uint8Array;
let staff: { browser: TestBrowser; email: string; name: string };
let editor: { email: string; name: string; personId: string };
let owner: { email: string; name: string; personId: string };
const INVITEE = "invitee@client.example";

beforeAll(async () => {
	source = await createTestInstall();
	workspaceId = (await source.createWorkspace("Acme Ltd")).id;
	otherWorkspaceId = (await source.createWorkspace("Beta Ltd")).id;
	siteId = (await source.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const madeStaff = await source.createStaff({ workspaces: [workspaceId, otherWorkspaceId], name: "Sam Staff" });
	staff = { browser: madeStaff.browser, email: madeStaff.account.email, name: "Sam Staff" };
	const madeEditor = await source.createMember({ workspaceId, role: "editor", name: "Eve Editor" });
	editor = { email: madeEditor.account.email, name: "Eve Editor", personId: madeEditor.personId };
	const madeOwner = await source.createMember({ workspaceId, role: "owner", name: "Olive Owner" });
	owner = { email: madeOwner.account.email, name: "Olive Owner", personId: madeOwner.personId };
	// Olive also works on the other Workspace, as an Author on none of its Sites yet.
	await source.addMembership({ personId: owner.personId, workspaceId: otherWorkspaceId, role: "author", sites: [] });
	await staff.browser.api.members.invite({ workspaceId, email: INVITEE, role: "author", sites: [siteId] });

	const pages = (await staff.browser.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page");
	const { entry } = await madeEditor.browser.api.entries.create({
		siteId,
		postTypeId: pages?.id ?? "",
		title: "About",
	});
	await staff.browser.api.entries.publish({ siteId, entryId: entry.id });
	archive = await exportedArchive(source, staff.browser, siteId);
});

afterAll(async () => {
	await source?.close();
});

describe("imported into another Workspace of the same Install", () => {
	let imported: Awaited<ReturnType<typeof importArchive>>;

	beforeAll(async () => {
		source.mail.clear();
		imported = await importArchive(source, staff.browser, otherWorkspaceId, archive, {
			name: "Beta Bakery",
			slug: "beta-bakery",
		});
	});

	test("a Member of the Workspace keeps their role there and reaches the new Site", async () => {
		expect(imported.report?.matched).toEqual([{ email: owner.email, name: owner.name, role: "author" }]);
		const { members } = await staff.browser.api.members.list({ workspaceId: otherWorkspaceId });
		const olive = members.find((member) => member.email === owner.email);
		expect(olive?.role).toBe("author");
		expect(JSON.stringify(olive)).toContain(imported.site?.id ?? "?");
	});

	test("everyone else becomes a pending invitation to the new Site, with the role they had, and no email yet", async () => {
		const invited = imported.report?.invited.map((invite) => [invite.email, invite.role, invite.sent]);
		expect(invited?.sort((a, b) => String(a[0]).localeCompare(String(b[0])))).toEqual([
			[INVITEE, "author", false],
			[editor.email, "editor", false],
		]);
		expect(source.mail.sent.filter((email) => [editor.email, INVITEE].includes(email.to))).toEqual([]);
		const { invites } = await staff.browser.api.members.list({ workspaceId: otherWorkspaceId });
		expect(invites.map((invite) => invite.email).sort()).toEqual([INVITEE, editor.email]);
	});

	test("Staff stay themselves, and nothing is reassigned: everyone has an account here", () => {
		expect(imported.report?.staff.map((person) => person.email)).toContain(staff.email);
		expect(imported.report?.reassigned).toEqual([]);
	});

	test("sending the invitations emails each a link to join the new Site", async () => {
		const { import: sent } = await staff.browser.api.siteImports.sendInvitations({
			workspaceId: otherWorkspaceId,
			importId: imported.id,
		});
		expect(sent.report?.invited.every((invite) => invite.sent)).toBe(true);
		const email = await source.lastEmailTo(editor.email);
		const token = new URL(inviteLinkIn(email)).searchParams.get("token") ?? "";
		const eve = await source.signIn({ email: editor.email, password: TEST_PASSWORD });
		await eve.api.invites.join({ token });
		const { site } = await eve.api.sites.get({ siteId: imported.site?.id ?? "" });
		expect(site.name).toBe("Beta Bakery");
	});
});

describe("imported into a fresh Install", () => {
	let target: TestInstall;
	let admin: TestBrowser;
	let imported: Awaited<ReturnType<typeof importArchive>>;
	let newSiteId: string;

	beforeAll(async () => {
		target = await createTestInstall();
		admin = await target.superadmin();
		const targetWorkspaceId = (await target.createWorkspace("Acme Ltd")).id;
		imported = await importArchive(target, admin, targetWorkspaceId, archive, { name: "Acme Bakery", slug: "bakery" });
		newSiteId = imported.site?.id ?? "";
	});

	afterAll(async () => {
		await target?.close();
	});

	test("what people without an account here did is attributed to the person importing, and listed", async () => {
		expect(imported.status).toBe("done");
		const reassigned = imported.report?.reassigned.map((person) => [person.email, person.was]).sort();
		expect(reassigned).toEqual([
			[editor.email, "editor"],
			[staff.email, "staff"],
		]);
		const pages = (await admin.api.postTypes.list({ siteId: newSiteId })).postTypes.find(
			(type) => type.builtIn === "page",
		);
		const { entries } = await admin.api.entries.list({ siteId: newSiteId, postTypeId: pages?.id ?? "" });
		const about = entries.find((entry) => entry.draft.title === "About");
		const me = (await admin.api.session.current()).person;
		expect(about?.author?.id).toBe(me?.id);
		const item = { kind: "entry" as const, id: about?.id ?? "" };
		const history = await admin.api.history.list({ siteId: newSiteId, item });
		const saved = await admin.api.history.get({
			siteId: newSiteId,
			item,
			copy: { type: "revision", id: history.copies[0]?.id ?? "" },
		});
		expect(saved.content).toMatchObject({ values: { title: { en: { by: { kind: "person", personId: me?.id } } } } });
	});

	test("its Members become pending invitations: nobody's password came", async () => {
		expect(imported.report?.invited.map((invite) => invite.email).sort()).toEqual(
			[editor.email, owner.email, INVITEE].sort(),
		);
		await expect(target.signIn({ email: editor.email, password: "anything at all 123" })).rejects.toBeDefined();
	});

	test("the Audit log keeps the Site's entries, naming people who have no account here", async () => {
		const { entries } = await admin.api.audit.list({ limit: 100 });
		const mine = entries.filter((entry) => entry.siteId === newSiteId);
		expect(mine.map((entry) => entry.action)).toEqual(expect.arrayContaining(["site.import", "entry.publish"]));
		const publish = mine.find((entry) => entry.action === "entry.publish");
		expect(publish?.personId).toBeNull();
		expect(publish?.details).toMatchObject({ importedPerson: { name: staff.name, email: staff.email } });
		const record = mine.find((entry) => entry.action === "site.import");
		expect(record?.personId).toBe((await admin.api.session.current()).person?.id);
	});
});
