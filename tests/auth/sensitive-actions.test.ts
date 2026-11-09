// Every Sensitive action, one row each: refused without an identity check in the last 10 minutes,
// allowed once the person confirms their password. The list lives in `SENSITIVE_ACTIONS`
// (`@webcraft/core`); the last test fails while an action there has no row here.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { ApiClient } from "@webcraft/api";
import { ALL_SENSITIVE_ACTIONS, type SensitiveAction } from "@webcraft/core";

import { createTestInstall, TEST_PASSWORD, type TestAccount, type TestInstall } from "../harness/index.ts";
import { sample } from "../modules/sample/index.ts";

const MINUTE = 60 * 1000;

type Fixture = {
	staffId: string;
	workspaceId: string;
	siteId: string;
	/** A Member whose access is changed, and one who is removed. */
	changedMemberId: string;
	removedMemberId: string;
	next: () => number;
};

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
	"leakedPasswordCheck.change": (api) => api.install.security.update({ leakedPasswordCheck: true }),
	"storage.change": (api) => api.install.storage.update({ kind: "disk" }),
	"module.approve": (api) => api.modules.approve({ moduleId: "sample", version: "1.0.0" }),
	"webhook.change": (api, { siteId }) =>
		api.webhooks.add({ siteId, url: "https://hooks.agency.example/build", events: ["publish"] }),
	"formCaptcha.change": (api, { siteId }) => api.forms.captcha.set({ siteId, captcha: null }),
	"siteSmtp.change": (api, { siteId }) => api.siteSmtp.update({ siteId, fromName: null, replyTo: null, server: null }),
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
	const changed = await install.createMember({ workspaceId: workspace.id, role: "author" });
	const removed = await install.createMember({ workspaceId: workspace.id, role: "author" });
	let made = 0;
	fixture = {
		staffId: staff.personId,
		workspaceId: workspace.id,
		siteId: site.id,
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
			const browser = await install.signIn(superadmin);
			await install.clock.advance(11 * MINUTE);

			await expect(call(browser.api, fixture)).rejects.toMatchObject({
				code: "IDENTITY_CHECK_REQUIRED",
				data: { action },
			});

			await browser.api.session.confirmIdentity({ password: superadmin.password });
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
		] as const;
		for (const action of actions) {
			const refusal = await SENSITIVE_ACTION_CALLS[action](author.browser.api, fixture).then(
				() => "allowed",
				(error: { code: string }) => error.code,
			);
			expect({ action, refusal }).toEqual({ action, refusal: "FORBIDDEN" });
		}
	});

	test("every Sensitive action has a row here", () => {
		expect(Object.keys(SENSITIVE_ACTION_CALLS).sort()).toEqual([...ALL_SENSITIVE_ACTIONS].sort());
	});
});
