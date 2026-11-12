// Who may impersonate whom (ADR 0008), what starting needs, and how long it lasts: the Superadmin
// impersonates any Staff member or Member; Staff only the Members of their Workspaces, and then only
// within those Workspaces; Members never. It needs the impersonator's own second factor and a recent
// identity check, and ends by itself after an hour.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { impersonate, type WithSecondFactor, withSecondFactor } from "../harness/impersonation.ts";
import { createTestInstall, TEST_PASSWORD, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { signInWithAuthenticator } from "../harness/two-factor.ts";

const MINUTE = 60 * 1000;

type Person = { personId: string; browser: TestBrowser };

let install: TestInstall;
let superadmin: WithSecondFactor<Person>;
let anna: WithSecondFactor<Person>;
let tom: Person;
let acme: string;
let nimbus: string;
let owner: Person;
let editor: Person;
let nimbusAuthor: Person;
let both: Person;

beforeAll(async () => {
	install = await createTestInstall();
	const admin = await install.superadmin();
	superadmin = await withSecondFactor(install, {
		personId: (await admin.api.session.current()).person?.id ?? "",
		browser: admin,
	});
	acme = (await install.createWorkspace("Acme Ltd")).id;
	nimbus = (await install.createWorkspace("Nimbus Bikes")).id;
	await install.createSite(acme, { name: "Acme Bakery", slug: "bakery" });
	await install.createSite(nimbus, { name: "Nimbus Shop", slug: "shop" });
	anna = await withSecondFactor(install, await install.createStaff({ workspaces: [acme], name: "Agency Anna" }));
	tom = await install.createStaff({ workspaces: [nimbus], name: "Agency Tom" });
	owner = await install.createMember({ workspaceId: acme, role: "owner", name: "Olive Owner" });
	editor = await install.createMember({ workspaceId: acme, role: "editor", name: "Eddie Editor" });
	nimbusAuthor = await install.createMember({ workspaceId: nimbus, role: "author", name: "Nina Nimbus" });
	both = await install.createMember({ workspaceId: acme, role: "editor", name: "Bo Both" });
	await install.addMembership({ workspaceId: nimbus, personId: both.personId, role: "owner", sites: "all" });
});

afterEach(async () => {
	// Every test leaves its impersonator as themselves.
	for (const browser of [superadmin.browser, anna.browser]) await browser.api.impersonation.stop().catch(() => {});
});

afterAll(async () => {
	await install.close();
});

/** Who the admin session acts as now. */
async function actingAs(browser: TestBrowser): Promise<string | undefined> {
	return (await browser.api.session.current()).person?.id;
}

describe("Staff", () => {
	test("impersonate a Member of their Workspaces: the admin is then the Member's", async () => {
		const started = await impersonate(anna.browser, editor.personId, { reason: "Ticket 4021" });

		expect(started.impersonation).toMatchObject({
			person: { id: editor.personId, name: "Eddie Editor" },
			impersonator: { id: anna.personId, name: "Agency Anna" },
		});
		expect(await actingAs(anna.browser)).toBe(editor.personId);
		const shell = await anna.browser.api.shell.context();
		expect(shell.person?.name).toBe("Eddie Editor");
		expect(shell.workspaces.map((workspace) => workspace.id)).toEqual([acme]);
		expect(shell.impersonation).toMatchObject({
			person: { name: "Eddie Editor" },
			impersonator: { name: "Agency Anna" },
			endsAt: new Date(install.clock.now().getTime() + 60 * MINUTE),
		});
		// As the Editor, not as Staff: no Members screen.
		await expect(anna.browser.api.members.list({ workspaceId: acme })).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("never impersonate other Staff or the Superadmin", async () => {
		await expect(impersonate(anna.browser, tom.personId)).rejects.toMatchObject({
			code: "IMPERSONATION_REFUSED",
			data: { reason: "staff" },
		});
		await expect(impersonate(anna.browser, superadmin.personId)).rejects.toMatchObject({
			code: "IMPERSONATION_REFUSED",
			data: { reason: "superadmin" },
		});
		expect(await actingAs(anna.browser)).toBe(anna.personId);
	});

	test("never impersonate a Member of a Workspace they aren't assigned to", async () => {
		await expect(impersonate(anna.browser, nimbusAuthor.personId)).rejects.toMatchObject({ code: "PERSON_NOT_FOUND" });
	});

	test("reach only their own Workspaces as a Member who belongs to others too", async () => {
		await impersonate(anna.browser, both.personId);

		expect((await anna.browser.api.shell.context()).workspaces.map((workspace) => workspace.id)).toEqual([acme]);
		await expect(anna.browser.api.sites.list({ workspaceId: nimbus })).rejects.toMatchObject({
			code: "WORKSPACE_NOT_FOUND",
		});
	});

	test("can't impersonate themselves", async () => {
		await expect(impersonate(anna.browser, anna.personId)).rejects.toMatchObject({
			code: "IMPERSONATION_REFUSED",
			data: { reason: "self" },
		});
	});
});

describe("the Superadmin", () => {
	test("impersonates Staff, with everything their Workspaces hold", async () => {
		await impersonate(superadmin.browser, tom.personId);

		expect(await actingAs(superadmin.browser)).toBe(tom.personId);
		expect((await superadmin.browser.api.shell.context()).workspaces.map((workspace) => workspace.id)).toEqual([
			nimbus,
		]);
		expect((await superadmin.browser.api.members.list({ workspaceId: nimbus })).members.length).toBeGreaterThan(0);
	});

	test("impersonates any Member, in all their Workspaces", async () => {
		await impersonate(superadmin.browser, both.personId);

		const workspaces = (await superadmin.browser.api.shell.context()).workspaces.map((workspace) => workspace.id);
		expect(workspaces.sort()).toEqual([acme, nimbus].sort());
	});
});

describe("Members", () => {
	test("never impersonate anyone, not even in their own Workspace", async () => {
		await expect(impersonate(owner.browser, editor.personId)).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("starting", () => {
	test("needs the impersonator's own second factor", async () => {
		const plain = await install.createStaff({ workspaces: [acme] });

		await expect(impersonate(plain.browser, editor.personId)).rejects.toMatchObject({ code: "TWO_FACTOR_OFF" });
		expect(await actingAs(plain.browser)).toBe(plain.personId);
	});

	test("needs a recent identity check (a Sensitive action)", async () => {
		await install.clock.advance(11 * MINUTE);

		await expect(anna.browser.api.impersonation.start({ personId: editor.personId })).rejects.toMatchObject({
			code: "IDENTITY_CHECK_REQUIRED",
			data: { action: "impersonation.start" },
		});
		await anna.browser.api.session.confirmIdentity({ password: TEST_PASSWORD });
		await anna.browser.api.impersonation.start({ personId: editor.personId });
		expect(await actingAs(anna.browser)).toBe(editor.personId);
	});

	test("one at a time: not while impersonating someone already", async () => {
		await impersonate(anna.browser, editor.personId);

		await expect(anna.browser.api.impersonation.start({ personId: owner.personId })).rejects.toMatchObject({
			code: "NOT_WHILE_IMPERSONATING",
		});
	});

	test("is never for an API token: the admin's own", async () => {
		const { secret } = await createApiToken(anna.browser, { workspaceId: acme, name: "Support script" });

		const response = await tokenClient(install, secret).request("impersonation/start", {
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ personId: editor.personId }),
		});

		expect(response.status).toBe(404);
	});
});

describe("ending", () => {
	test("Stop goes back to the impersonator's own session, where it started", async () => {
		await impersonate(anna.browser, editor.personId, { returnTo: "/workspaces/x/members" });

		expect(await anna.browser.api.impersonation.stop()).toEqual({ returnTo: "/workspaces/x/members" });

		expect(await actingAs(anna.browser)).toBe(anna.personId);
		expect((await anna.browser.api.shell.context()).impersonation).toBeNull();
		// Their own Members screen again.
		await expect(anna.browser.api.members.list({ workspaceId: acme })).resolves.toBeDefined();
	});

	test("after an hour at most it ends by itself, back to the impersonator", async () => {
		await impersonate(anna.browser, editor.personId);

		await install.clock.advance(59 * MINUTE);
		expect(await actingAs(anna.browser)).toBe(editor.personId);
		await install.clock.advance(MINUTE);
		expect(await actingAs(anna.browser)).toBe(anna.personId);
		expect((await anna.browser.api.shell.context()).impersonation).toBeNull();
	});

	test("signing out ends it: signing in again is as the impersonator", async () => {
		const sam = await withSecondFactor(install, await install.createStaff({ workspaces: [acme] }));
		await impersonate(sam.browser, editor.personId);

		await sam.browser.api.session.signOut();

		const again = await signInWithAuthenticator(install, sam.account, sam.secret);
		expect(await actingAs(again)).toBe(sam.personId);
		const [stop] = (await superadmin.browser.api.audit.list({ action: "impersonation.stop", personId: sam.personId }))
			.entries;
		expect(stop?.details).toMatchObject({ reason: "signedOut" });
	});

	test("losing the access it needs ends it on the next request: back to the impersonator, recorded as access", async () => {
		const kim = await withSecondFactor(install, await install.createStaff({ workspaces: [acme] }));
		await impersonate(kim.browser, editor.personId);
		expect(await actingAs(kim.browser)).toBe(editor.personId);

		await superadmin.browser.api.session.confirmIdentity({ password: TEST_PASSWORD });
		await superadmin.browser.api.staff.setWorkspaces({ personId: kim.personId, workspaces: [nimbus] });

		expect(await actingAs(kim.browser)).toBe(kim.personId);
		const [stop] = (await superadmin.browser.api.audit.list({ action: "impersonation.stop", personId: kim.personId }))
			.entries;
		expect(stop?.details).toMatchObject({ reason: "access" });
	});

	test("a return address is a page of the admin, nowhere else", async () => {
		for (const returnTo of ["https://evil.example/", "//evil.example/", "javascript:alert(1)"]) {
			await expect(impersonate(anna.browser, editor.personId, { returnTo })).rejects.toMatchObject({
				code: "BAD_REQUEST",
			});
		}
	});
});
