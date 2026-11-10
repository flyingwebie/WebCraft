// While impersonating, nothing about the person's account changes (ADR 0008): their password,
// second factors, passkeys, sessions, API tokens, AI clients and preferences stay as they are, every
// change refused with NOT_WHILE_IMPERSONATING. Sensitive actions, confirming who they are, Edit mode
// and the Staging address are refused too: they are for the impersonator, as themselves. Reading
// the person's account works, so the impersonator sees what they see.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiClient } from "@webcraft/api";

import { createApiToken } from "../harness/api-tokens.ts";
import { impersonate, type WithSecondFactor, withSecondFactor } from "../harness/impersonation.ts";
import { createTestInstall, TEST_PASSWORD, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { approveAiClient, authorizationParameters, pkcePair, registerClient } from "../harness/mcp.ts";

type Person = { personId: string; browser: TestBrowser };

let install: TestInstall;
let acme: string;
let bakery: string;
let anna: WithSecondFactor<Person>;
let owner: WithSecondFactor<Person>;
let tokenId: string;
let grantId: string;
let ownerSessions: number;

beforeAll(async () => {
	install = await createTestInstall();
	acme = (await install.createWorkspace("Acme Ltd")).id;
	bakery = (await install.createSite(acme, { name: "Acme Bakery", slug: "bakery" })).id;
	anna = await withSecondFactor(install, await install.createStaff({ workspaces: [acme], name: "Agency Anna" }));
	owner = await withSecondFactor(
		install,
		await install.createMember({ workspaceId: acme, role: "owner", name: "Olive Owner" }),
	);
	tokenId = (await createApiToken(owner.browser, { workspaceId: acme, name: "Owner's script" })).tokenId;
	await approveAiClient(install, owner.browser, { workspaceId: acme });
	grantId = (await owner.browser.api.aiClients.list()).grants[0]?.id ?? "";
	ownerSessions = (await owner.browser.api.me.sessions.list()).sessions.length;
	await impersonate(anna.browser, owner.personId);
});

afterAll(async () => {
	await install.close();
});

/** Each change to the person's account, and what the refusal names. */
const CHANGES: Record<string, [string, (api: ApiClient) => Promise<unknown>]> = {
	"changing the password": ["password", (api) => api.me.changePassword({ newPassword: "a brand new password 42" })],
	"adding an authenticator app": ["twoFactor", (api) => api.me.twoFactor.startAuthenticator()],
	"confirming an authenticator app": ["twoFactor", (api) => api.me.twoFactor.confirmAuthenticator({ code: "123456" })],
	"removing the authenticator app": ["twoFactor", (api) => api.me.twoFactor.removeAuthenticator()],
	"making new backup codes": ["twoFactor", (api) => api.me.twoFactor.regenerateBackupCodes()],
	"adding a passkey": ["twoFactor", (api) => api.me.twoFactor.passkeyOptions()],
	"removing a passkey": [
		"twoFactor",
		(api) => api.me.twoFactor.removePasskey({ passkeyId: "00000000-0000-4000-8000-000000000000" }),
	],
	"putting off the reminder": ["twoFactor", (api) => api.me.twoFactor.remindLater()],
	"signing out a session": [
		"sessions",
		async (api) => {
			const [session] = (await api.me.sessions.list()).sessions;
			return api.me.sessions.revoke({ sessionId: session?.id ?? "" });
		},
	],
	"signing out every other session": ["sessions", (api) => api.me.sessions.revokeOthers()],
	"making an API token": ["apiTokens", (api) => api.apiTokens.create({ workspaceId: acme, name: "Sneaky" })],
	"revoking an API token": ["apiTokens", (api) => api.apiTokens.revoke({ tokenId })],
	"approving an AI client": [
		"aiClients",
		(api) => api.oauth.approve({ parameters: { client_id: "x" }, workspaceId: acme }),
	],
	"denying an AI client": ["aiClients", (api) => api.oauth.deny({ parameters: { client_id: "x" } })],
	"revoking an AI client": ["aiClients", (api) => api.aiClients.revoke({ grantId })],
	"changing the Admin language": ["preferences", (api) => api.me.updatePreferences({ adminLanguage: "it" })],
	"changing the email switches": ["preferences", (api) => api.me.emails.update({ turnedOff: [] })],
	"confirming who they are": ["identityCheck", (api) => api.session.confirmIdentity({ password: TEST_PASSWORD })],
	"confirming who they are with a passkey": ["identityCheck", (api) => api.session.identityPasskeyOptions()],
	"a Sensitive action": [
		"sensitiveAction",
		(api) => api.members.invite({ workspaceId: acme, email: "new@client.example", role: "author", sites: "all" }),
	],
	"opening Edit mode": ["editMode", (api) => api.editMode.open({ siteId: bakery })],
	"opening the Staging address": ["staging", (api) => api.staging.open({ siteId: bakery })],
};

describe("while impersonating, refused", () => {
	for (const [name, [what, change]] of Object.entries(CHANGES)) {
		test(name, async () => {
			await expect(change(anna.browser.api)).rejects.toMatchObject({ code: "NOT_WHILE_IMPERSONATING", data: { what } });
		});
	}

	test("and nothing changed: the person signs in, keeps their sessions, tokens and AI clients", async () => {
		await install.clock.advance(31_000);
		expect((await owner.browser.api.me.sessions.list()).sessions).toHaveLength(ownerSessions);
		expect((await owner.browser.api.apiTokens.list()).tokens.map((token) => token.status)).toEqual(["active"]);
		expect((await owner.browser.api.aiClients.list()).grants.map((grant) => grant.status)).toEqual(["active"]);
		expect((await owner.browser.api.me.twoFactor.get()).authenticator).not.toBeNull();
		expect((await owner.browser.api.session.current()).person?.adminLanguage).toBe("en");
	});
});

describe("while impersonating, readable", () => {
	test("the person's sessions, none of them this browser's", async () => {
		const { sessions } = await anna.browser.api.me.sessions.list();

		expect(sessions).toHaveLength(ownerSessions);
		expect(sessions.some((session) => session.current)).toBe(false);
	});

	test("the person's API tokens, AI clients and second factors", async () => {
		expect((await anna.browser.api.apiTokens.list()).tokens.map((token) => token.name)).toEqual(["Owner's script"]);
		expect((await anna.browser.api.aiClients.list()).grants).toHaveLength(1);
		expect((await anna.browser.api.me.twoFactor.get()).authenticator).not.toBeNull();
	});
});

test("an AI client's approval page can be opened, but never approved", async () => {
	const client = await registerClient(install);
	const { challenge } = await pkcePair();
	const parameters = authorizationParameters(install, String(client.body.client_id), challenge);

	await expect(anna.browser.api.oauth.check({ parameters })).resolves.toBeDefined();
	await expect(anna.browser.api.oauth.approve({ parameters, workspaceId: acme })).rejects.toMatchObject({
		code: "NOT_WHILE_IMPERSONATING",
	});
});
