// Every Sensitive action, one row each: refused without an identity check in the last 10 minutes,
// allowed once the person confirms their password. The list lives in `SENSITIVE_ACTIONS`
// (`@webcraft/core`); the last test fails while an action there has no row here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiClient } from "@webcraft/api";
import { ALL_SENSITIVE_ACTIONS, type SensitiveAction } from "@webcraft/core";

import { createApiToken, tokenClient } from "../harness/api-tokens.ts";
import { createTestInstall, TEST_PASSWORD, type TestAccount, type TestInstall } from "../harness/index.ts";
import { authorizationParameters, pkcePair, registerClient } from "../harness/mcp.ts";
import { exportedArchive, uploadArchive } from "../harness/site-transfer.ts";
import { addAuthenticator, signInWithAuthenticator } from "../harness/two-factor.ts";
import { sample } from "../modules/sample/index.ts";

const MINUTE = 60 * 1000;

type Fixture = {
	staffId: string;
	workspaceId: string;
	siteId: string;
	/** A Dashboard of the Site, to make Share links to. */
	dashboardId: string;
	/** A Site export the Superadmin uploaded into the Workspace, ready to be imported. */
	siteImportId: string;
	/** A Member whose access is changed, and one who is removed. */
	changedMemberId: string;
	removedMemberId: string;
	/** An AI client's authorization request, as it sends the person to the approval page. */
	authorization: Record<string, string>;
	/** Staff with an authenticator app, for the actions that need one of the person's own. */
	impersonator: { account: TestAccount; secret: string };
	next: () => number;
};

/**
 * The actions that need the person's own second factor: Staff with an authenticator app take them
 * (impersonating a Member of their Workspace), since the Superadmin here signs in with a password only.
 */
const AS_STAFF_WITH_SECOND_FACTOR: readonly SensitiveAction[] = ["impersonation.start"];

/** How the Superadmin takes each Sensitive action. */
const SENSITIVE_ACTION_CALLS: Record<SensitiveAction, (api: ApiClient, fixture: Fixture) => Promise<unknown>> = {
	"installSmtp.change": (api) =>
		api.install.smtp.update({
			host: "smtp.agency.example",
			port: 587,
			security: "starttls",
			username: "webcraft",
			fromAddress: "webcraft@agency.example",
			replyTo: null,
			password: "an SMTP password",
		}),
	"staff.invite": (api, { next }) => api.staff.invite({ email: `invited-${next()}@agency.example`, workspaces: "all" }),
	"staff.changeWorkspaces": (api, { staffId, workspaceId }) =>
		api.staff.setWorkspaces({ personId: staffId, workspaces: [workspaceId] }),
	"member.invite": (api, { workspaceId, next }) =>
		api.members.invite({ workspaceId, email: `invited-member-${next()}@client.example`, role: "author", sites: "all" }),
	"member.changeAccess": (api, { workspaceId, changedMemberId }) =>
		api.members.changeAccess({ workspaceId, personId: changedMemberId, role: "editor", sites: "all" }),
	"member.remove": (api, { workspaceId, removedMemberId }) =>
		api.members.remove({ workspaceId, personId: removedMemberId }),
	"masterKey.confirmStored": (api) => api.install.masterKey.confirmStored(),
	"password.change": (api) => api.me.changePassword({ newPassword: TEST_PASSWORD }),
	"twoFactor.change": (api) => api.me.twoFactor.startAuthenticator(),
	"twoFactor.reset": (api, { workspaceId, changedMemberId }) =>
		api.members.resetTwoFactor({ workspaceId, personId: changedMemberId }),
	// Switching it off: switching it on needs the Superadmin's own second factor first.
	"twoFactorRequirement.change": (api) => api.install.security.requireTwoFactor({ required: false }),
	"leakedPasswordCheck.change": (api) => api.install.security.update({ leakedPasswordCheck: true }),
	"storage.change": (api) => api.install.storage.update({ kind: "disk" }),
	"backups.change": (api) => api.install.backups.update({ scheduled: true, target: { kind: "folder" } }),
	"module.approve": (api) => api.modules.approve({ moduleId: "sample", version: "1.0.0" }),
	"webhook.change": (api, { siteId }) =>
		api.webhooks.add({ siteId, url: "https://hooks.agency.example/build", events: ["publish"] }),
	"formCaptcha.change": (api, { siteId }) => api.forms.captcha.set({ siteId, captcha: null }),
	"siteSmtp.change": (api, { siteId }) => api.siteSmtp.update({ siteId, fromName: null, replyTo: null, server: null }),
	"aiKey.change": (api, { workspaceId }) =>
		api.aiKeys.setOwn({
			workspaceId,
			provider: "openai",
			model: "gpt-5-mini",
			endpoint: null,
			key: "sk-test-key-for-the-sensitive-action",
		}),
	"stagingPassword.change": (api, { siteId }) => api.staging.setPassword({ siteId, password: "a review password" }),
	"shareLink.change": (api, { siteId, dashboardId, next }) =>
		api.shareLinks.create({ siteId, dashboardId, name: `Client link ${next()}` }),
	"impersonation.start": (api, { changedMemberId }) => api.impersonation.start({ personId: changedMemberId }),
	"auditRetention.change": (api) => api.install.security.setAuditRetention({ days: 365 }),
	"apiToken.create": (api, { workspaceId, next }) => api.apiTokens.create({ workspaceId, name: `Token ${next()}` }),
	"aiClient.approve": (api, { workspaceId, authorization }) =>
		api.oauth.approve({ parameters: authorization, workspaceId }),
	"site.export": (api, { siteId }) => api.siteExports.start({ siteId, passphrase: null }),
	"site.import": (api, { workspaceId, siteImportId, next }) =>
		api.siteImports.start({
			workspaceId,
			importId: siteImportId,
			name: "Imported",
			slug: `imported-${next()}`,
			passphrase: null,
		}),
};

let install: TestInstall;
let superadmin: TestAccount;
let fixture: Fixture;

beforeAll(async () => {
	install = await createTestInstall({ modules: [sample] });
	superadmin = await install.createSuperadmin();
	const workspace = await install.createWorkspace();
	const site = await install.createSite(workspace.id);
	const staff = await install.createStaff({ workspaces: "all" });
	const impersonator = await install.createStaff({ workspaces: [workspace.id] });
	const { secret } = await addAuthenticator(install, impersonator.browser);
	const changed = await install.createMember({ workspaceId: workspace.id, role: "author" });
	const removed = await install.createMember({ workspaceId: workspace.id, role: "author" });
	const client = await registerClient(install);
	const { challenge } = await pkcePair();
	const admin = await install.superadmin();
	const { dashboard } = await admin.api.dashboards.create({ siteId: site.id, name: "Overview" });
	const uploaded = await uploadArchive(admin, workspace.id, await exportedArchive(install, admin, site.id));
	let made = 0;
	fixture = {
		authorization: authorizationParameters(install, String(client.body.client_id), challenge),
		impersonator: { account: impersonator.account, secret },
		staffId: staff.personId,
		workspaceId: workspace.id,
		siteId: site.id,
		dashboardId: dashboard.id,
		siteImportId: uploaded.id,
		changedMemberId: changed.personId,
		removedMemberId: removed.personId,
		next: () => ++made,
	};
});

afterAll(async () => {
	await install.close();
});

describe("each Sensitive action", () => {
	for (const action of ALL_SENSITIVE_ACTIONS) {
		test(`${action}: refused without a recent identity check, allowed after one`, async () => {
			const call = SENSITIVE_ACTION_CALLS[action];
			const browser = AS_STAFF_WITH_SECOND_FACTOR.includes(action)
				? await signInWithAuthenticator(install, fixture.impersonator.account, fixture.impersonator.secret)
				: await install.signIn(superadmin);
			await install.clock.advance(11 * MINUTE);

			await expect(call(browser.api, fixture)).rejects.toMatchObject({
				code: "IDENTITY_CHECK_REQUIRED",
				data: { action },
			});

			await browser.api.session.confirmIdentity({ password: TEST_PASSWORD });
			await expect(call(browser.api, fixture)).resolves.toBeDefined();
		});
	}

	test("nobody is asked to confirm who they are for something they may not do in a Workspace or on a Site", async () => {
		const author = await install.createMember({ workspaceId: fixture.workspaceId, role: "author" });
		await install.clock.advance(11 * MINUTE);

		const actions = [
			"member.invite",
			"member.changeAccess",
			"member.remove",
			"formCaptcha.change",
			"webhook.change",
			"stagingPassword.change",
		] as const;
		for (const action of actions) {
			const refusal = await SENSITIVE_ACTION_CALLS[action](author.browser.api, fixture).then(
				() => "allowed",
				(error: { code: string }) => error.code,
			);
			expect({ action, refusal }).toEqual({ action, refusal: "FORBIDDEN" });
		}
	});

	test("no API token takes a Sensitive action: refused where /api/v1 serves its procedure, unserved elsewhere", async () => {
		const browser = await install.signIn(superadmin);
		const answers: Record<string, string> = {};
		for (const action of ALL_SENSITIVE_ACTIONS) {
			// A token of the Superadmin's own for each, so no count of requests a minute gets in the way.
			const { secret } = await createApiToken(browser, {
				workspaceId: fixture.workspaceId,
				name: `Sensitive ${action}`,
			});
			answers[action] = await SENSITIVE_ACTION_CALLS[action](tokenClient(install, secret).api, fixture).then(
				() => "allowed",
				(error: { code: string }) => error.code,
			);
		}

		const refused = [
			"member.invite",
			"member.changeAccess",
			"member.remove",
			"webhook.change",
			"formCaptcha.change",
			"siteSmtp.change",
			"aiKey.change",
			"stagingPassword.change",
			"shareLink.change",
		];
		expect(answers).toEqual(
			Object.fromEntries(
				ALL_SENSITIVE_ACTIONS.map((action) => [
					action,
					refused.includes(action) ? "SENSITIVE_ACTION_REFUSED" : "NOT_FOUND",
				]),
			),
		);
	});

	test("every Sensitive action has a row here", () => {
		expect(Object.keys(SENSITIVE_ACTION_CALLS).sort()).toEqual([...ALL_SENSITIVE_ACTIONS].sort());
	});
});
