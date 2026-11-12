// AI clients find WebCraft's authorization server from the MCP server, register themselves, send
// the person to approve them in the admin, and exchange the one-time code (with PKCE) for an
// access token (1 hour) and a refresh token (30 days, replaced on use). Codes and tokens are kept
// only as keyed hashes. A grant acts as its person within what they chose, and ends when they
// revoke it, when its person loses access, or when a used code or refresh token comes back.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { ipv6Network } from "../harness/addresses.ts";
import { createTestInstall, fromAddress, type TestInstall } from "../harness/index.ts";
import {
	approveAiClient,
	approveInAdmin,
	authorizationParameters,
	connectMcp,
	connectMcpWithOAuth,
	LOOPBACK_REDIRECT,
	pkcePair,
	registerClient,
	tokenRequest,
} from "../harness/mcp.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
});

async function mcpStatus(token: string): Promise<{ status: number; challenge: string | null }> {
	const response = await install.request(
		new Request(install.adminUrl("/mcp"), {
			method: "POST",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
				accept: "application/json, text/event-stream",
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "probe", version: "1" } },
			}),
		}),
	);
	return { status: response.status, challenge: response.headers.get("www-authenticate") };
}

describe("finding the authorization server", () => {
	test("a request to /mcp without a token is told where the MCP server's metadata is", async () => {
		const { status, challenge } = await mcpStatus("");
		expect(status).toBe(401);
		expect(challenge).toContain(`resource_metadata="${install.adminUrl("/.well-known/oauth-protected-resource/mcp")}"`);
	});

	test("the MCP server's metadata names the admin as its authorization server", async () => {
		const response = await install.request(install.adminUrl("/.well-known/oauth-protected-resource/mcp"));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			resource: install.adminUrl("/mcp"),
			authorization_servers: [install.adminUrl("").replace(/\/$/, "")],
			bearer_methods_supported: ["header"],
		});
	});

	test("the authorization server's metadata offers the code flow with PKCE (S256), device codes, registration and revocation", async () => {
		const issuer = install.adminUrl("").replace(/\/$/, "");
		const response = await install.request(install.adminUrl("/.well-known/oauth-authorization-server"));
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({
			issuer,
			authorization_endpoint: `${issuer}/oauth/authorize`,
			token_endpoint: `${issuer}/oauth/token`,
			registration_endpoint: `${issuer}/oauth/register`,
			revocation_endpoint: `${issuer}/oauth/revoke`,
			device_authorization_endpoint: `${issuer}/oauth/device_authorization`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
			code_challenge_methods_supported: ["S256"],
			authorization_response_iss_parameter_supported: true,
		});
	});
});

describe("registering a client", () => {
	test("a client registers its name and redirect addresses and gets a client id, without a secret when it asks for none", async () => {
		const { status, body } = await registerClient(install, { client_name: "Desk assistant" });
		expect(status).toBe(201);
		expect(body).toMatchObject({
			client_name: "Desk assistant",
			redirect_uris: [LOOPBACK_REDIRECT],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
		});
		expect(body.client_id).toEqual(expect.any(String));
		expect(body.client_secret).toBeUndefined();
	});

	test("redirect addresses must be https, or http on the loopback interface, without a fragment", async () => {
		for (const uri of [
			"http://example.com/callback",
			"javascript:alert(1)",
			"https://example.com/callback#fragment",
			"https://user:pass@example.com/callback",
			"not an address",
		]) {
			const { status, body } = await registerClient(install, { redirect_uris: [uri] });
			expect({ uri, status, error: body.error }).toEqual({ uri, status: 400, error: "invalid_redirect_uri" });
		}
		for (const uri of ["https://app.example.com/oauth/callback", "http://localhost:8123/cb", "http://[::1]:9000/cb"]) {
			const { status } = await registerClient(install, { redirect_uris: [uri] });
			expect({ uri, status }).toEqual({ uri, status: 201 });
		}
	});

	test("a confidential client gets a secret once, and only a hash of it is kept", async () => {
		const { body } = await registerClient(install, { token_endpoint_auth_method: "client_secret_basic" });
		expect(String(body.client_secret)).toStartWith("webcraft-cs_");
		expect(await install.tablesHolding(String(body.client_secret))).toEqual([]);
	});
});

describe("approving a client", () => {
	test("the approval page shows the client's name and where it sends the person back to", async () => {
		const workspace = await install.createWorkspace();
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		const { body } = await registerClient(install, { client_name: "Desk assistant" });
		const { challenge } = await pkcePair();

		const { check, workspaces, toolsets } = await owner.browser.api.oauth.check({
			parameters: authorizationParameters(install, String(body.client_id), challenge),
		});

		expect(check).toEqual({
			kind: "ask",
			request: {
				client: {
					id: String(body.client_id),
					name: "Desk assistant",
					redirectHost: "127.0.0.1:33418",
					onThisDevice: true,
				},
				redirectUri: LOOPBACK_REDIRECT,
				state: "state-123",
			},
		});
		expect(workspaces.map((each) => each.id)).toEqual([workspace.id]);
		expect(toolsets.find((toolset) => toolset.key === "submissions")).toMatchObject({ optIn: true });
	});

	test("an unknown client, or an address it didn't register, is never sent anywhere", async () => {
		const admin = await install.superadmin();
		const { body } = await registerClient(install);
		const { challenge } = await pkcePair();
		const unknown = await admin.api.oauth.check({
			parameters: authorizationParameters(install, crypto.randomUUID(), challenge),
		});
		expect(unknown.check).toEqual({ kind: "refused", problem: "client" });
		const elsewhere = await admin.api.oauth.check({
			parameters: authorizationParameters(install, String(body.client_id), challenge, {
				redirect_uri: "http://127.0.0.1:33418/other",
			}),
		});
		expect(elsewhere.check).toEqual({ kind: "refused", problem: "redirectUri" });
	});

	// The person is never sent on by the page itself: anyone may register an app with any address,
	// so the error goes back only when the person chooses to (`returnTo`, behind a button).
	test("a request without PKCE, or with the plain method, is refused, with the error for the client behind a button", async () => {
		const admin = await install.superadmin();
		const { body } = await registerClient(install);
		const { challenge } = await pkcePair();
		for (const more of [{ code_challenge: "" }, { code_challenge_method: "plain" }] as Record<string, string>[]) {
			const { check } = await admin.api.oauth.check({
				parameters: authorizationParameters(install, String(body.client_id), challenge, more),
			});
			expect(check).toMatchObject({
				kind: "refused",
				problem: "request",
				client: { name: "Test AI client", redirectHost: "127.0.0.1:33418" },
			});
			const back = new URL((check as { returnTo: string }).returnTo);
			expect(`${back.origin}${back.pathname}`).toBe(LOOPBACK_REDIRECT);
			expect(back.searchParams.get("error")).toBe("invalid_request");
			expect(back.searchParams.get("state")).toBe("state-123");
		}
	});

	test("a faulty request from an app registered with an outside address never answers a redirect to follow", async () => {
		const admin = await install.superadmin();
		const landing = "https://elsewhere.example/landing";
		const { body } = await registerClient(install, { redirect_uris: [landing], application_type: "web" });

		const { check } = await admin.api.oauth.check({
			parameters: { client_id: String(body.client_id), redirect_uri: landing, response_type: "x" },
		});

		expect(check).toMatchObject({
			kind: "refused",
			problem: "request",
			client: { redirectHost: "elsewhere.example" },
			returnTo: expect.stringContaining(`${landing}?error=unsupported_response_type`),
		});
	});

	test("approving is a Sensitive action, recorded in the Workspace's Audit log", async () => {
		const workspace = await install.createWorkspace();
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		const { body } = await registerClient(install, { client_name: "Desk assistant" });
		const { challenge } = await pkcePair();
		const parameters = authorizationParameters(install, String(body.client_id), challenge);
		await install.clock.advance(11 * 60 * 1000);

		await expect(owner.browser.api.oauth.approve({ parameters, workspaceId: workspace.id })).rejects.toMatchObject({
			code: "IDENTITY_CHECK_REQUIRED",
		});
		const back = await approveInAdmin(owner.browser, parameters, { workspaceId: workspace.id, mayPublish: true });

		expect(back.searchParams.get("code")).toStartWith("webcraft-code_");
		expect(back.searchParams.get("state")).toBe("state-123");
		expect(back.searchParams.get("iss")).toBe(install.adminUrl("").replace(/\/$/, ""));
		const { entries } = await (await install.superadmin()).api.audit.list({ limit: 20 });
		expect(entries.find((entry) => entry.action === "aiClient.approve")).toMatchObject({
			workspaceId: workspace.id,
			via: { kind: "admin" },
			details: { client: "Desk assistant", redirectHost: "127.0.0.1:33418", mayPublish: true, sites: "all" },
		});
	});

	test("denying sends the person back with access_denied", async () => {
		const admin = await install.superadmin();
		const { body } = await registerClient(install);
		const { challenge } = await pkcePair();
		const { redirectTo } = await admin.api.oauth.deny({
			parameters: authorizationParameters(install, String(body.client_id), challenge),
		});
		expect(new URL(redirectTo).searchParams.get("error")).toBe("access_denied");
	});
});

describe("the code for tokens", () => {
	async function approvedCode(workspaceId: string) {
		const owner = await install.createMember({ workspaceId, role: "owner" });
		const { body } = await registerClient(install);
		const clientId = String(body.client_id);
		const { verifier, challenge } = await pkcePair();
		const back = await approveInAdmin(owner.browser, authorizationParameters(install, clientId, challenge), {
			workspaceId,
		});
		return { clientId, verifier, code: back.searchParams.get("code") ?? "", owner };
	}

	const exchange = (clientId: string, code: string, verifier: string, more: Record<string, string> = {}) =>
		tokenRequest(install, {
			grant_type: "authorization_code",
			code,
			redirect_uri: LOOPBACK_REDIRECT,
			client_id: clientId,
			code_verifier: verifier,
			resource: install.adminUrl("/mcp"),
			...more,
		});

	test("the code and its PKCE verifier give an access token for an hour and a refresh token, kept only as hashes", async () => {
		const workspace = await install.createWorkspace();
		const { clientId, verifier, code } = await approvedCode(workspace.id);

		const { status, body } = await exchange(clientId, code, verifier);

		expect(status).toBe(200);
		expect(body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
		expect(String(body.access_token)).toStartWith("webcraft-at_");
		expect(String(body.refresh_token)).toStartWith("webcraft-rt_");
		expect(await install.tablesHolding(String(body.access_token))).toEqual([]);
		expect(await install.tablesHolding(String(body.refresh_token))).toEqual([]);
		expect(await install.tablesHolding(code)).toEqual([]);
		expect((await mcpStatus(String(body.access_token))).status).toBe(200);
	});

	test("a wrong verifier, another redirect address, another client or another resource is refused", async () => {
		const workspace = await install.createWorkspace();
		const { clientId, verifier, code } = await approvedCode(workspace.id);
		const other = await registerClient(install);

		expect((await exchange(clientId, code, (await pkcePair()).verifier)).body.error).toBe("invalid_grant");
		expect((await exchange(clientId, code, verifier, { redirect_uri: "http://127.0.0.1:1/x" })).body.error).toBe(
			"invalid_grant",
		);
		expect((await exchange(String(other.body.client_id), code, verifier)).body.error).toBe("invalid_grant");
		expect((await exchange(clientId, code, verifier, { resource: "https://elsewhere.example/mcp" })).body.error).toBe(
			"invalid_target",
		);
		// None of the refusals used the code up.
		expect((await exchange(clientId, code, verifier)).status).toBe(200);
	});

	test("a code works once: used again, it ends the grant and the tokens it gave", async () => {
		const workspace = await install.createWorkspace();
		const { clientId, verifier, code } = await approvedCode(workspace.id);
		const first = await exchange(clientId, code, verifier);

		const again = await exchange(clientId, code, verifier);

		expect(again).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
		expect((await mcpStatus(String(first.body.access_token))).status).toBe(401);
	});

	test("a code lasts a minute", async () => {
		const workspace = await install.createWorkspace();
		const { clientId, verifier, code } = await approvedCode(workspace.id);
		await install.clock.advance(61_000);
		expect((await exchange(clientId, code, verifier)).body.error).toBe("invalid_grant");
	});

	test("an access token lasts an hour", async () => {
		const workspace = await install.createWorkspace();
		const { clientId, verifier, code } = await approvedCode(workspace.id);
		const { body } = await exchange(clientId, code, verifier);
		await install.clock.advance(HOUR + 1000);
		const { status, challenge } = await mcpStatus(String(body.access_token));
		expect(status).toBe(401);
		expect(challenge).toContain('error="invalid_token"');
	});
});

describe("refreshing", () => {
	test("a refresh token gives new tokens once and is replaced; used again, it ends the grant", async () => {
		const workspace = await install.createWorkspace();
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		const approved = await approveAiClient(install, owner.browser, { workspaceId: workspace.id });
		const refresh = (token: string) =>
			tokenRequest(install, { grant_type: "refresh_token", refresh_token: token, client_id: approved.clientId });

		const renewed = await refresh(approved.refreshToken);
		expect(renewed.status).toBe(200);
		expect(renewed.body.refresh_token).not.toBe(approved.refreshToken);
		expect((await mcpStatus(String(renewed.body.access_token))).status).toBe(200);

		const reused = await refresh(approved.refreshToken);
		expect(reused).toMatchObject({ status: 400, body: { error: "invalid_grant" } });
		expect((await mcpStatus(String(renewed.body.access_token))).status).toBe(401);
		expect((await refresh(String(renewed.body.refresh_token))).body.error).toBe("invalid_grant");
		const { grants } = await owner.browser.api.aiClients.list();
		expect(grants[0]).toMatchObject({ status: "revoked", revokedReason: "reuse" });
	});

	test("a refresh token unused for 30 days has expired", async () => {
		const workspace = await install.createWorkspace();
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		const approved = await approveAiClient(install, owner.browser, { workspaceId: workspace.id });
		await install.clock.advance(30 * DAY + 1000);
		const refreshed = await tokenRequest(install, {
			grant_type: "refresh_token",
			refresh_token: approved.refreshToken,
			client_id: approved.clientId,
		});
		expect(refreshed.body.error).toBe("invalid_grant");
		const browser = await install.signIn(owner.account);
		const { grants } = await browser.api.aiClients.list();
		expect(grants[0]?.status).toBe("expired");
	});

	test("a confidential client authenticates with its secret", async () => {
		const workspace = await install.createWorkspace();
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		const registered = await registerClient(install, { token_endpoint_auth_method: "client_secret_basic" });
		const clientId = String(registered.body.client_id);
		const secret = String(registered.body.client_secret);
		const { verifier, challenge } = await pkcePair();
		const back = await approveInAdmin(owner.browser, authorizationParameters(install, clientId, challenge), {
			workspaceId: workspace.id,
		});
		const form = {
			grant_type: "authorization_code",
			code: back.searchParams.get("code") ?? "",
			redirect_uri: LOOPBACK_REDIRECT,
			code_verifier: verifier,
		};
		const basic = (password: string) => ({
			authorization: `Basic ${Buffer.from(`${clientId}:${password}`).toString("base64")}`,
		});

		const wrong = await tokenRequest(install, form, basic("not the secret"));
		expect(wrong).toMatchObject({ status: 401, body: { error: "invalid_client" } });
		expect((await tokenRequest(install, form, basic(secret))).status).toBe(200);
	});
});

describe("ending a grant", () => {
	test("its person sees it under Your account › AI clients and revokes it: its tokens stop at once", async () => {
		const workspace = await install.createWorkspace();
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		const approved = await approveAiClient(install, owner.browser, { workspaceId: workspace.id, readOnly: true });

		const { grants } = await owner.browser.api.aiClients.list();
		expect(grants).toEqual([
			expect.objectContaining({
				client: { name: "Test AI client", redirectHost: "127.0.0.1:33418" },
				workspace: { id: workspace.id, name: expect.any(String) },
				sites: "all",
				readOnly: true,
				mayPublish: false,
				status: "active",
			}),
		]);
		await owner.browser.api.aiClients.revoke({ grantId: grants[0]?.id as string });

		expect((await mcpStatus(approved.accessToken)).status).toBe(401);
		const refreshed = await tokenRequest(install, {
			grant_type: "refresh_token",
			refresh_token: approved.refreshToken,
			client_id: approved.clientId,
		});
		expect(refreshed.body.error).toBe("invalid_grant");
		const after = await owner.browser.api.aiClients.list();
		expect(after.grants[0]).toMatchObject({ status: "revoked", revokedReason: "person" });
	});

	test("nobody revokes another person's AI client", async () => {
		const workspace = await install.createWorkspace();
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		const other = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		await approveAiClient(install, owner.browser, { workspaceId: workspace.id });
		const { grants } = await owner.browser.api.aiClients.list();
		await expect(other.browser.api.aiClients.revoke({ grantId: grants[0]?.id as string })).rejects.toMatchObject({
			code: "AI_CLIENT_NOT_FOUND",
		});
	});

	test("a client revokes its own grant with one of its tokens", async () => {
		const workspace = await install.createWorkspace();
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		const approved = await approveAiClient(install, owner.browser, { workspaceId: workspace.id });
		const response = await install.request(
			new Request(install.adminUrl("/oauth/revoke"), {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ token: approved.refreshToken, client_id: approved.clientId }).toString(),
			}),
		);
		expect(response.status).toBe(200);
		expect((await mcpStatus(approved.accessToken)).status).toBe(401);
		const { grants } = await owner.browser.api.aiClients.list();
		expect(grants[0]).toMatchObject({ status: "revoked", revokedReason: "client" });
	});

	test("a person removed from the Workspace loses their AI clients with it", async () => {
		const workspace = await install.createWorkspace();
		const editor = await install.createMember({ workspaceId: workspace.id, role: "editor" });
		const approved = await approveAiClient(install, editor.browser, { workspaceId: workspace.id });
		const admin = await install.superadmin();
		await admin.api.session.confirmIdentity({ password: "a long enough test password" }).catch(() => {});
		await admin.api.members.remove({ workspaceId: workspace.id, personId: editor.personId });

		expect((await mcpStatus(approved.accessToken)).status).toBe(401);
		const { grants } = await editor.browser.api.aiClients.list();
		expect(grants[0]).toMatchObject({ status: "revoked", revokedReason: "access" });
		const { entries } = await admin.api.audit.list({ limit: 20 });
		expect(entries.find((entry) => entry.action === "aiClient.revoke")).toMatchObject({
			workspaceId: workspace.id,
			details: { reason: "access", owner: editor.personId },
		});
	});
});

describe("housekeeping", () => {
	test("a client nobody approves within a week is forgotten; an approved one stays", async () => {
		const workspace = await install.createWorkspace();
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });
		const unapproved = String((await registerClient(install, { client_name: "Never approved" })).body.client_id);
		const approved = await approveAiClient(install, owner.browser, { workspaceId: workspace.id });
		await install.clock.advance(8 * DAY);
		await install.drainJobs();

		const admin = await install.signIn(owner.account);
		const { challenge } = await pkcePair();
		const forgotten = await admin.api.oauth.check({
			parameters: authorizationParameters(install, unapproved, challenge),
		});
		expect(forgotten.check).toEqual({ kind: "refused", problem: "client" });
		const kept = await admin.api.oauth.check({
			parameters: authorizationParameters(install, approved.clientId, challenge),
		});
		expect(kept.check.kind).toBe("ask");
	});

	test("browser-based clients may call the MCP server and the token endpoint from another origin, without cookies", async () => {
		for (const path of ["/mcp", "/oauth/token", "/oauth/register", "/.well-known/oauth-authorization-server"]) {
			const response = await install.request(
				new Request(install.adminUrl(path), {
					method: "OPTIONS",
					headers: {
						origin: "https://assistant.example",
						"access-control-request-method": "POST",
						"access-control-request-headers": "authorization, content-type, mcp-protocol-version",
					},
				}),
			);
			expect({ path, status: response.status }).toEqual({ path, status: 204 });
			expect(response.headers.get("access-control-allow-origin")).toBe("*");
			expect(response.headers.get("access-control-allow-credentials")).toBeNull();
			expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
		}
	});
});

describe("a real client", () => {
	test("finds its way in by itself: discovery, registration, the person's approval, PKCE, then tools", async () => {
		const workspace = await install.createWorkspace();
		const site = await install.createSite(workspace.id, { name: "Bakery" });
		const owner = await install.createMember({ workspaceId: workspace.id, role: "owner" });

		const { client, provider } = await connectMcpWithOAuth(install, owner.browser, { workspaceId: workspace.id });

		expect(provider.issuer).toBe(install.adminUrl("").replace(/\/$/, ""));
		const result = await client.callTool({ name: "sites_list", arguments: { workspaceId: workspace.id } });
		expect(JSON.stringify(result.structuredContent)).toContain(site.id);
		await client.close();
	});
});

describe("isolation", () => {
	test("a grant never reaches another Workspace, nor Sites it wasn't given", async () => {
		const ours = await install.createWorkspace();
		const theirs = await install.createWorkspace();
		const given = await install.createSite(ours.id);
		const notGiven = await install.createSite(ours.id);
		const theirSite = await install.createSite(theirs.id);
		const admin = await install.superadmin();
		const approved = await approveAiClient(install, admin, { workspaceId: ours.id, sites: [given.id] });
		const client = await connectMcp(install, approved.accessToken);

		const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
		const listed = await call("sites_list", { workspaceId: ours.id });
		expect(JSON.stringify(listed.structuredContent)).toContain(given.id);
		expect(JSON.stringify(listed.structuredContent)).not.toContain(notGiven.id);
		for (const [name, args] of [
			["sites_list", { workspaceId: theirs.id }],
			["sites_get", { siteId: theirSite.id }],
			["sites_get", { siteId: notGiven.id }],
			["post_types_list", { siteId: theirSite.id }],
		] as const) {
			const result = await call(name, args);
			expect({ name, args, refused: result.isError }).toEqual({ name, args, refused: true });
			expect(JSON.stringify(result.content)).toMatch(/WORKSPACE_NOT_FOUND|SITE_NOT_FOUND/);
		}
		await client.close();
	});
});

describe("what anyone may ask for, per client address", () => {
	const DEVICE = "urn:ietf:params:oauth:grant-type:device_code";
	const register = (address: string) =>
		install.request(
			fromAddress(
				new Request(install.adminUrl("/oauth/register"), {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({
						client_name: "Kiosk",
						grant_types: [DEVICE, "refresh_token"],
						token_endpoint_auth_method: "none",
					}),
				}),
				address,
			),
		);

	test("registrations count an IPv6 connection by its /64: 20 an hour, whichever of its addresses asks", async () => {
		const network = ipv6Network();
		for (let asked = 0; asked < 20; asked++) expect((await register(network(asked + 1))).status).toBe(201);

		expect((await register(network(21))).status).toBe(429);
		expect((await register(ipv6Network()(1))).status).toBe(201);
	});

	test("device codes count an IPv6 connection by its /64: 30 an hour, whichever of its addresses asks", async () => {
		const { client_id: clientId } = (await (await register(ipv6Network()(1))).json()) as { client_id: string };
		const ask = (address: string) =>
			install.request(
				fromAddress(
					new Request(install.adminUrl("/oauth/device_authorization"), {
						method: "POST",
						headers: { "content-type": "application/x-www-form-urlencoded" },
						body: new URLSearchParams({ client_id: clientId }),
					}),
					address,
				),
			);
		const network = ipv6Network();
		for (let asked = 0; asked < 30; asked++) expect((await ask(network(asked + 1))).status).toBe(200);

		expect((await ask(network(31))).status).toBe(429);
		expect((await ask(ipv6Network()(1))).status).toBe(200);
	});
});
