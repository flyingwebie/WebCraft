// AI clients in a real browser: the approval page an AI client sends the person to (the client's
// name and where it sends them back shown plainly, Workspace, Sites, Toolsets with Submissions'
// warning, access and May publish), approving from the keyboard, a request that can't be approved,
// and Your account › AI clients with revoking, in light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { TestAccount } from "../harness/index.ts";
import { approveAiClient, LOOPBACK_REDIRECT, pkcePair, registerClient } from "../harness/mcp.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let clientId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	const local = install.install;
	const admin = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	const bakery = await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" });
	await local.createSite(workspaceId, { name: "Acme Catering", slug: "catering" });
	clientId = String((await registerClient(local, { client_name: "Desk assistant" })).body.client_id);
	await approveAiClient(local, admin, { workspaceId, mayPublish: true }, { client_name: "Writing assistant" });
	await approveAiClient(
		local,
		admin,
		{ workspaceId, sites: [bakery.id], readOnly: true, toolsets: ["content", "submissions"] },
		{ client_name: "Inbox helper" },
	);
	await approveAiClient(local, admin, { workspaceId }, { client_name: "Old assistant" });
	const { grants } = await admin.api.aiClients.list();
	const old = grants.find((grant) => grant.client.name === "Old assistant");
	await admin.api.aiClients.revoke({ grantId: old?.id as string });
});

afterAll(async () => {
	await install.close();
});

/** The approval page's address, as an AI client sends the person there. */
async function approvalUrl(more: Record<string, string> = {}): Promise<string> {
	const { challenge } = await pkcePair();
	const parameters = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: LOOPBACK_REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		state: "browser-state",
		resource: install.adminUrl("/mcp"),
		...more,
	});
	return install.adminUrl(`/oauth/authorize?${parameters}`);
}

for (const theme of THEMES) {
	describe(`the approval page, ${theme}`, () => {
		test("shows the client's name, where it sends the person back, and what they may choose", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(await approvalUrl());
			await page.getByRole("heading", { name: "Approve Desk assistant?" }).waitFor();
			await page.getByText("127.0.0.1:33418").waitFor();
			expect(await page.getByRole("checkbox", { name: /^Submissions/ }).isChecked()).toBe(false);
			expect(await page.getByRole("checkbox", { name: /^Content/ }).isChecked()).toBe(true);

			await expectAccessibleScreen(page, `Approval page (${theme})`);
		});

		test("approving from the keyboard sends the person back to the client with a code", async () => {
			const page = await install.newPage(theme);
			await page.route(`${LOOPBACK_REDIRECT}**`, (route) =>
				route.fulfill({ status: 200, body: "Back in the client." }),
			);
			await install.signIn(page, superadmin);
			await page.goto(await approvalUrl());
			await page.getByRole("heading", { name: "Approve Desk assistant?" }).waitFor();
			await page.getByRole("checkbox", { name: /^Submissions/ }).check();
			await page.getByRole("radio", { name: "Only the Sites I choose" }).check();
			await page.getByRole("checkbox", { name: "Acme Catering" }).check();
			await page.getByRole("checkbox", { name: "May publish" }).check();
			await expectNoAxeViolations(page, `Approval page, choices made (${theme})`);
			await page.getByRole("button", { name: "Approve Desk assistant" }).focus();
			await page.keyboard.press("Enter");

			await page.waitForURL((url) => url.href.startsWith(LOOPBACK_REDIRECT));
			const back = new URL(page.url());
			expect(back.searchParams.get("code")).toStartWith("webcraft-code_");
			expect(back.searchParams.get("state")).toBe("browser-state");
		});

		test("a request for an address the client didn't register can't be approved, and sends nobody anywhere", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(await approvalUrl({ redirect_uri: "http://127.0.0.1:33418/elsewhere" }));
			await page.getByRole("heading", { name: "This request can't be approved" }).waitFor();

			await expectAccessibleScreen(page, `Approval page, refused (${theme})`);
		});
	});

	describe(`Your account › AI clients, ${theme}`, () => {
		const open = async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl("/account/ai-clients"));
			await page.waitForLoadState("networkidle");
			return page;
		};

		test("the AI clients: active, read-only for one Site with Submissions, and revoked", async () => {
			const page = await open();
			await page.getByText("Inbox helper").waitFor();
			await page.getByText("Revoked", { exact: true }).waitFor();

			await expectAccessibleScreen(page, `AI clients (${theme})`);
		});

		test("revoking an AI client asks first", async () => {
			const page = await open();
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Revoke Writing assistant" }),
				"dialog",
				`AI clients › Revoke (${theme})`,
			);
		});
	});
}
