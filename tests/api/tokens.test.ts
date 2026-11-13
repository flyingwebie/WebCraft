// API tokens (spec › Management API): made by a person under Your account › API tokens, for one
// Workspace, shown once and kept only as a hash; scripts call `/api/v1` with one, acting as that
// person, recorded in the Audit log as the token.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";

const DAY = 24 * 60 * 60 * 1000;

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

describe("a token at work", () => {
	test("a script with a token reads its Workspace through /api/v1, as the token's person", async () => {
		const workspace = await install.createWorkspace("Acme");
		const site = await install.createSite(workspace.id, { name: "Acme Bakery" });
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		const { secret } = await createApiToken(owner.browser, { workspaceId: workspace.id, name: "Deploy script" });

		const script = tokenClient(install, secret);
		const { sites } = await script.api.sites.list({ workspaceId: workspace.id });

		expect(sites.map((listed) => listed.id)).toEqual([site.id]);
	});
});

describe("making a token", () => {
	test("the token is shown once: the list shows its last 4 characters, and no table holds it", async () => {
		const workspace = await install.createWorkspace();
		const admin = await install.superadmin();
		const { secret, tokenId } = await createApiToken(admin, { workspaceId: workspace.id, name: "Build server" });

		expect(secret).toMatch(/^webcraft_[A-Za-z0-9_-]{43}$/);
		const { tokens } = await admin.api.apiTokens.list();
		const listed = tokens.find((token) => token.id === tokenId);
		expect(listed).toMatchObject({
			name: "Build server",
			workspace: { id: workspace.id },
			sites: "all",
			readOnly: false,
			hint: secret.slice(-4),
			status: "active",
		});
		expect(JSON.stringify(tokens)).not.toContain(secret);
		expect(await install.tablesHolding(secret)).toEqual([]);
	});

	test("a token lasts 90 days unless its person chooses 30, 365 or never", async () => {
		const workspace = await install.createWorkspace();
		const admin = await install.superadmin();
		const made = async (lifetimeDays?: 30 | 90 | 365 | null) => {
			const { tokenId } = await createApiToken(admin, {
				workspaceId: workspace.id,
				name: `Lasting ${lifetimeDays}`,
				...(lifetimeDays === undefined ? {} : { lifetimeDays }),
			});
			const { tokens } = await admin.api.apiTokens.list();
			const token = tokens.find((listed) => listed.id === tokenId);
			return token?.expiresAt ? (token.expiresAt.getTime() - token.createdAt.getTime()) / DAY : null;
		};

		expect(await made()).toBe(90);
		expect(await made(30)).toBe(30);
		expect(await made(365)).toBe(365);
		expect(await made(null)).toBeNull();
	});

	test("making a token is recorded in its Workspace's Audit log, never with the token itself", async () => {
		const workspace = await install.createWorkspace();
		const admin = await install.superadmin();
		const { secret, tokenId } = await createApiToken(admin, {
			workspaceId: workspace.id,
			name: "Recorded",
			readOnly: true,
			lifetimeDays: 30,
		});

		const { entries } = await admin.api.audit.list({ limit: 20 });
		const made = entries.find((entry) => entry.action === "apiToken.create" && entry.details.tokenId === tokenId);
		expect(made).toMatchObject({
			workspaceId: workspace.id,
			via: { kind: "admin" },
			details: { name: "Recorded", sites: "all", readOnly: true },
		});
		expect(JSON.stringify(entries)).not.toContain(secret);
	});

	test("a token is only for a Workspace its person reaches, and only for Sites they see there", async () => {
		const ours = await install.createWorkspace();
		const theirs = await install.createWorkspace();
		const site = await install.createSite(ours.id);
		const other = await install.createSite(ours.id);
		const theirSite = await install.createSite(theirs.id);
		const editor = await install.createMember({ workspaceId: ours.id, role: "editor", sites: [site.id] });

		await expect(createApiToken(editor.browser, { workspaceId: theirs.id, name: "Not theirs" })).rejects.toMatchObject({
			code: "WORKSPACE_NOT_FOUND",
		});
		await expect(
			createApiToken(editor.browser, { workspaceId: ours.id, name: "Unseen Site", sites: [other.id] }),
		).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
		await expect(
			createApiToken(editor.browser, { workspaceId: ours.id, name: "Another Workspace's Site", sites: [theirSite.id] }),
		).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });

		const { workspaces } = await editor.browser.api.apiTokens.list();
		expect(workspaces).toEqual([{ id: ours.id, name: ours.name, sites: [{ id: site.id, name: expect.any(String) }] }]);
	});
});

describe("a token at the door", () => {
	test("a request without a token, with an unknown one, or with only a session cookie is refused", async () => {
		const workspace = await install.createWorkspace();
		const admin = await install.superadmin();

		const answers = await Promise.all([
			tokenClient(install, null).request("workspaces/get", { body: JSON.stringify({ workspaceId: workspace.id }) }),
			tokenClient(install, "webcraft_not-a-token-this-install-made-00000000000").request("workspaces/get"),
			admin.request(install.adminUrl("/api/v1/workspaces/get"), {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ workspaceId: workspace.id }),
			}),
		]);

		expect(answers.map((answer) => answer.status)).toEqual([401, 401, 401]);
		expect(answers[0]?.headers.get("www-authenticate")).toStartWith("Bearer");
		expect(await Promise.all(answers.map((answer) => answer.json()))).toEqual([
			expect.objectContaining({ code: "TOKEN_INVALID", data: { problem: "missing" } }),
			expect.objectContaining({ code: "TOKEN_INVALID", data: { problem: "unknown" } }),
			expect.objectContaining({ code: "TOKEN_INVALID", data: { problem: "missing" } }),
		]);
	});

	test("a token stops when it expires", async () => {
		const workspace = await install.createWorkspace();
		const admin = await install.superadmin();
		const { secret, tokenId } = await createApiToken(admin, {
			workspaceId: workspace.id,
			name: "Short",
			lifetimeDays: 30,
		});
		const script = tokenClient(install, secret);
		await script.api.workspaces.get({ workspaceId: workspace.id });

		await install.clock.advance(30 * DAY);

		await expect(script.api.workspaces.get({ workspaceId: workspace.id })).rejects.toMatchObject({
			code: "TOKEN_INVALID",
			status: 401,
			data: { problem: "expired" },
		});
		const { tokens } = await (await install.superadmin()).api.apiTokens.list();
		expect(tokens.find((token) => token.id === tokenId)?.status).toBe("expired");
	});

	test("a revoked token stops at once, and revoking is recorded", async () => {
		const workspace = await install.createWorkspace();
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		const { secret, tokenId } = await createApiToken(owner.browser, { workspaceId: workspace.id, name: "Leaked" });
		const script = tokenClient(install, secret);
		await script.api.workspaces.get({ workspaceId: workspace.id });

		const { token } = await owner.browser.api.apiTokens.revoke({ tokenId });

		expect(token).toMatchObject({ status: "revoked", revokedReason: "person" });
		await expect(script.api.workspaces.get({ workspaceId: workspace.id })).rejects.toMatchObject({
			code: "TOKEN_INVALID",
			data: { problem: "revoked" },
		});
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 20 });
		expect(
			entries.find((entry) => entry.action === "apiToken.revoke" && entry.details.tokenId === tokenId),
		).toMatchObject({
			personId: owner.personId,
			workspaceId: workspace.id,
			details: { name: "Leaked", reason: "person" },
		});
	});

	test("nobody revokes someone else's token", async () => {
		const workspace = await install.createWorkspace();
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		const { tokenId } = await createApiToken(owner.browser, { workspaceId: workspace.id, name: "Mine" });
		const admin = await install.superadmin();

		await expect(admin.api.apiTokens.revoke({ tokenId })).rejects.toMatchObject({ code: "API_TOKEN_NOT_FOUND" });
	});

	test("what a token does is recorded in the Audit log as the token, with its person", async () => {
		const workspace = await install.createWorkspace();
		const admin = await install.superadmin();
		const { secret } = await createApiToken(admin, { workspaceId: workspace.id, name: "Site maker" });

		const { site } = await tokenClient(install, secret).api.sites.create({
			workspaceId: workspace.id,
			name: "Made by a script",
			slug: "made-by-a-script",
		});

		const { entries } = await admin.api.audit.list({ limit: 20 });
		const me = await admin.api.session.current();
		expect(entries.find((entry) => entry.action === "site.create" && entry.siteId === site.id)).toMatchObject({
			personId: me.person?.id,
			via: { kind: "token", name: "Site maker" },
		});
	});

	test("making and revoking tokens is the admin's own: a token can't reach either", async () => {
		const workspace = await install.createWorkspace();
		const admin = await install.superadmin();
		const { secret, tokenId } = await createApiToken(admin, { workspaceId: workspace.id, name: "Curious" });
		const script = tokenClient(install, secret);

		await expect(script.api.apiTokens.list()).rejects.toMatchObject({ status: 404 });
		await expect(script.api.apiTokens.revoke({ tokenId })).rejects.toMatchObject({ status: 404 });
		await expect(script.api.apiTokens.create({ workspaceId: workspace.id, name: "Another" })).rejects.toMatchObject({
			status: 404,
		});
	});
});
