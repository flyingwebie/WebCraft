// AI clients in a real browser: the approval page an AI client sends the person to (the client's
// name and where it sends them back shown plainly, Workspace, Sites, Toolsets with Submissions'
// warning, access and May publish), approving from the keyboard, a request that can't be approved,
// signing in a device (`webcraft login`'s code entered and approved from the keyboard, a wrong
// code said beside its field), and Your account › AI clients with revoking, in light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { TestAccount } from "../harness/index.ts";
import { approveAiClient, LOOPBACK_REDIRECT, pkcePair, registerClient } from "../harness/mcp.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let clientId: string;
let deviceClientId: string;

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
	deviceClientId = String(
		(
			await registerClient(local, {
				client_name: "webcraft CLI on build-box",
				redirect_uris: undefined,
				response_types: undefined,
				grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
			})
		).body.client_id,
	);
});

/** A new device sign-in's user code, as `webcraft login` would show it. */
async function userCode(): Promise<string> {
	const response = await install.install.request(
		new Request(install.install.adminUrl("/oauth/device_authorization"), {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ client_id: deviceClientId }),
		}),
	);
	return ((await response.json()) as { user_code: string }).user_code;
}

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

	describe(`a faulty request, ${theme}`, () => {
		// Anyone may register an app with any https address: a link on the admin's own hostname must
		// never land a signed-in person there by itself (the report's A1-5).
		test("from an app nobody vouched for stays on the admin, names where it wants to send the person, and goes only on a click", async () => {
			const landing = "https://elsewhere.example/landing";
			const registered = await registerClient(install.install, {
				client_name: "Session helper",
				redirect_uris: [landing],
				application_type: "web",
			});
			const page = await install.newPage(theme);
			let left = 0;
			await page.route("https://elsewhere.example/**", (route) => {
				left++;
				return route.fulfill({ status: 200, contentType: "text/html", body: "<h1>Elsewhere</h1>" });
			});
			await install.signIn(page, superadmin);
			const parameters = new URLSearchParams({
				client_id: String(registered.body.client_id),
				redirect_uri: landing,
				response_type: "x",
				state: "s-1",
			});
			await page.goto(install.adminUrl(`/oauth/authorize?${parameters}`));

			await page.getByRole("heading", { name: "This request can't be approved" }).waitFor();
			expect(new URL(page.url()).origin).toBe(new URL(install.adminUrl("/")).origin);
			expect(left).toBe(0);
			expect(await page.locator("main").textContent()).toContain("elsewhere.example");
			await expectAccessibleScreen(page, `Approval page, a faulty request (${theme})`);

			await page.getByRole("link", { name: "Go back to elsewhere.example" }).click();
			await page.waitForURL((url) => url.href.startsWith(landing));
			const back = new URL(page.url());
			expect(back.searchParams.get("error")).toBe("unsupported_response_type");
			expect(back.searchParams.get("state")).toBe("s-1");
		});
	});

	describe(`signing in a device, ${theme}`, () => {
		test("the code entry, and a wrong code said beside its field", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl("/oauth/device"));
			await page.getByRole("heading", { name: "Sign in a device" }).waitFor();
			await expectAccessibleScreen(page, `Device sign-in, code entry (${theme})`);

			await page.getByRole("textbox", { name: "Code" }).fill("BBBB-BBBB");
			await page.keyboard.press("Enter");
			await page.getByText("There is no such code.").waitFor();
			expect(await page.getByRole("textbox", { name: "Code" }).getAttribute("aria-invalid")).toBe("true");
			await expectAccessibleScreen(page, `Device sign-in, unknown code (${theme})`);
		});

		test("entering the code and approving from the keyboard", async () => {
			const code = await userCode();
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl("/oauth/device"));
			await page.getByRole("textbox", { name: "Code" }).focus();
			await page.keyboard.type(code.toLowerCase());
			await page.keyboard.press("Enter");
			await page.getByRole("heading", { name: "Sign in webcraft CLI on build-box?" }).waitFor();
			await page.getByText(code, { exact: true }).waitFor();
			await page.getByText("Approve only a sign-in you started yourself").waitFor();
			await expectAccessibleScreen(page, `Device sign-in, approval (${theme})`);

			await page.getByRole("button", { name: "Approve webcraft CLI on build-box" }).focus();
			await page.keyboard.press("Enter");
			const done = page.getByRole("heading", { name: "webcraft CLI on build-box is signed in" });
			await done.waitFor();
			expect(await done.evaluate((element) => element === document.activeElement)).toBe(true);
			await expectNoAxeViolations(page, `Device sign-in, approved (${theme})`);
		});

		test("the code filled in from the address webcraft login shows", async () => {
			const code = await userCode();
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/oauth/device?user_code=${code}`));
			await page.getByRole("heading", { name: "Sign in webcraft CLI on build-box?" }).waitFor();
			await page.getByRole("button", { name: "Deny" }).click();
			await page.getByRole("heading", { name: "Sign-in denied" }).waitFor();
			await expectNoAxeViolations(page, `Device sign-in, denied (${theme})`);
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
