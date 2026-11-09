// A token never outlives its person's access: losing a Membership, Staff losing a Workspace or a
// token's Sites going out of reach revoke it at once, in the same change; a role change or fewer
// Sites take effect on its next request (its person's access is read fresh every time); while its
// person's account is locked, it waits.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { createTestInstall, TEST_PASSWORD, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

/** Runs a Sensitive action as the Superadmin, confirming their password when asked. */
async function sensitively<Result>(call: (admin: TestBrowser) => Promise<Result>): Promise<Result> {
	const admin = await install.superadmin();
	return call(admin).catch(async (error: { code?: string }) => {
		if (error.code !== "IDENTITY_CHECK_REQUIRED") throw error;
		await admin.api.session.confirmIdentity({ password: TEST_PASSWORD });
		return call(admin);
	});
}

async function tokenStatus(browser: TestBrowser, tokenId: string) {
	const { tokens } = await browser.api.apiTokens.list();
	return tokens.find((token) => token.id === tokenId);
}

describe("revoked when access ends", () => {
	test("removing a Member revokes their tokens for that Workspace at once, for good", async () => {
		const workspace = await install.createWorkspace();
		const other = await install.createWorkspace();
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		await install.addMembership({ workspaceId: other.id, personId: owner.personId, role: "editor", sites: "all" });
		const { secret, tokenId } = await createApiToken(owner.browser, { workspaceId: workspace.id, name: "Gone" });
		const kept = await createApiToken(owner.browser, { workspaceId: other.id, name: "Kept" });
		const script = tokenClient(install, secret);
		await script.api.workspaces.get({ workspaceId: workspace.id });

		await sensitively((admin) => admin.api.members.remove({ workspaceId: workspace.id, personId: owner.personId }));

		await expect(script.api.workspaces.get({ workspaceId: workspace.id })).rejects.toMatchObject({
			code: "TOKEN_INVALID",
			data: { problem: "revoked" },
		});
		expect(await tokenStatus(owner.browser, tokenId)).toMatchObject({ status: "revoked", revokedReason: "access" });
		await tokenClient(install, kept.secret).api.workspaces.get({ workspaceId: other.id });

		// A Membership again later doesn't bring the token back.
		await install.addMembership({ workspaceId: workspace.id, personId: owner.personId, role: "owner", sites: "all" });
		await expect(script.api.workspaces.get({ workspaceId: workspace.id })).rejects.toMatchObject({
			data: { problem: "revoked" },
		});

		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 30 });
		expect(
			entries.find((entry) => entry.action === "apiToken.revoke" && entry.details.tokenId === tokenId),
		).toMatchObject({
			workspaceId: workspace.id,
			details: { reason: "access", owner: owner.personId },
		});
	});

	test("Staff losing a Workspace revokes their tokens for it", async () => {
		const workspace = await install.createWorkspace();
		const other = await install.createWorkspace();
		const staff = await install.createStaff({ workspaces: [workspace.id, other.id] });
		const { secret, tokenId } = await createApiToken(staff.browser, {
			workspaceId: workspace.id,
			name: "Staff script",
		});
		const kept = await createApiToken(staff.browser, { workspaceId: other.id, name: "Still assigned" });

		await sensitively((admin) => admin.api.staff.setWorkspaces({ personId: staff.personId, workspaces: [other.id] }));

		await expect(tokenClient(install, secret).api.workspaces.get({ workspaceId: workspace.id })).rejects.toMatchObject({
			data: { problem: "revoked" },
		});
		expect(await tokenStatus(staff.browser, tokenId)).toMatchObject({ status: "revoked", revokedReason: "access" });
		expect(await tokenStatus(staff.browser, kept.tokenId)).toMatchObject({ status: "active" });
	});

	test("a token whose Sites all leave its person's reach is revoked", async () => {
		const workspace = await install.createWorkspace();
		const first = await install.createSite(workspace.id);
		const second = await install.createSite(workspace.id);
		const editor = await install.createMember({ workspaceId: workspace.id, role: "editor" });
		const { secret, tokenId } = await createApiToken(editor.browser, {
			workspaceId: workspace.id,
			name: "Second Site",
			sites: [second.id],
		});

		await sensitively((admin) =>
			admin.api.members.changeAccess({
				workspaceId: workspace.id,
				personId: editor.personId,
				role: "editor",
				sites: [first.id],
			}),
		);

		await expect(tokenClient(install, secret).api.sites.get({ siteId: second.id })).rejects.toMatchObject({
			data: { problem: "revoked" },
		});
		expect(await tokenStatus(editor.browser, tokenId)).toMatchObject({ revokedReason: "access" });
	});
});

describe("checked live on every request", () => {
	test("a role change takes away what the new role can't do on the token's next request", async () => {
		const workspace = await install.createWorkspace();
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		const { secret } = await createApiToken(owner.browser, { workspaceId: workspace.id, name: "Owner's script" });
		const script = tokenClient(install, secret);
		await script.api.members.list({ workspaceId: workspace.id });

		await sensitively((admin) =>
			admin.api.members.changeAccess({
				workspaceId: workspace.id,
				personId: owner.personId,
				role: "author",
				sites: "all",
			}),
		);

		await expect(script.api.members.list({ workspaceId: workspace.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await script.api.workspaces.get({ workspaceId: workspace.id });
	});

	test("fewer Sites for its person means fewer Sites for the token, at once", async () => {
		const workspace = await install.createWorkspace();
		const first = await install.createSite(workspace.id);
		const second = await install.createSite(workspace.id);
		const editor = await install.createMember({ workspaceId: workspace.id, role: "editor" });
		const { secret } = await createApiToken(editor.browser, { workspaceId: workspace.id, name: "Every Site" });
		const script = tokenClient(install, secret);
		await script.api.sites.get({ siteId: second.id });

		await sensitively((admin) =>
			admin.api.members.changeAccess({
				workspaceId: workspace.id,
				personId: editor.personId,
				role: "editor",
				sites: [first.id],
			}),
		);

		await expect(script.api.sites.get({ siteId: second.id })).rejects.toMatchObject({ status: 404 });
		await script.api.sites.get({ siteId: first.id });
	});

	test("while its person's account is locked, a token waits, then works again", async () => {
		const workspace = await install.createWorkspace();
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		const { secret } = await createApiToken(owner.browser, { workspaceId: workspace.id, name: "Patient" });
		const script = tokenClient(install, secret);

		for (let attempt = 0; attempt < 10; attempt++) {
			await install
				.browser()
				.api.session.signIn({ email: owner.account.email, password: "not the password at all" })
				.catch(() => {});
		}

		const answer = await script.request("workspaces/get", {
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ workspaceId: workspace.id }),
		});
		expect(answer.status).toBe(401);
		expect(Number(answer.headers.get("retry-after"))).toBeGreaterThan(0);
		expect(await answer.json()).toMatchObject({ code: "TOKEN_INVALID", data: { problem: "locked" } });

		await install.clock.advance(15 * 60 * 1000);
		await script.api.workspaces.get({ workspaceId: workspace.id });
	});
});
