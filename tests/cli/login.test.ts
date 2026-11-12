// Signing the CLI in with the OAuth 2.0 device authorization grant (RFC 8628): `webcraft login`
// shows a short code, the person approves it in the admin (choosing the Workspace, Sites, Toolsets,
// read-only and May publish), and the CLI's polling gets tokens for the public Management API.
// `whoami` says who it acts as, `logout` revokes the grant.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { approveDevice, type CliUser, cliUser, signInCli, userCodeIn } from "../harness/cli.ts";
import { createTestInstall, fromAddress, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { approveAiClient, connectMcp } from "../harness/mcp.ts";

let install: TestInstall;
let workspaceId: string;
let bakery: { id: string };
let cafe: { id: string };
let owner: { browser: TestBrowser; personId: string };

const DEVICE = "urn:ietf:params:oauth:grant-type:device_code";

beforeAll(async () => {
	install = await createTestInstall();
	({ id: workspaceId } = await install.createWorkspace("Bakeries"));
	bakery = await install.createSite(workspaceId, { name: "Sourdough Corner", slug: "sourdough" });
	cafe = await install.createSite(workspaceId, { name: "Corner Café", slug: "cafe" });
	const member = await install.createMember({ workspaceId, role: "owner", name: "Olive Owner" });
	owner = { browser: member.browser, personId: member.personId };
});

afterAll(async () => {
	await install.close();
});

async function post(path: string, form: Record<string, string>) {
	const response = await install.request(
		fromAddress(
			new Request(install.adminUrl(path), {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams(form),
			}),
			"10.230.0.1",
		),
	);
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function deviceClient(): Promise<string> {
	const response = await install.request(
		new Request(install.adminUrl("/oauth/register"), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "Kiosk",
				grant_types: [DEVICE, "refresh_token"],
				token_endpoint_auth_method: "none",
			}),
		}),
	);
	expect(response.status).toBe(201);
	const body = (await response.json()) as { client_id: string; redirect_uris: string[] };
	expect(body.redirect_uris).toEqual([]);
	return body.client_id;
}

describe("webcraft login", () => {
	let cli: CliUser;
	beforeAll(() => {
		cli = cliUser(install, { hostname: "olive-laptop" });
	});
	afterAll(() => cli.close());

	test("shows a code the person approves in the admin, then signs in with what they chose", async () => {
		const { code, stdout, stderr } = await signInCli(cli, install, owner.browser, {
			workspaceId,
			sites: [bakery.id],
			readOnly: true,
			toolsets: ["content"],
		});

		expect(stderr).toContain(`open ${install.adminUrl("/oauth/device")}`);
		expect(userCodeIn(stderr)).toMatch(/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
		expect(code).toBe(0);
		expect(stdout).toContain("Signed in to https://admin.test as Olive Owner");
		expect(stdout).toContain("in Bakeries");
		// The test's CLI keeps sign-ins in its file, as on a computer without a keychain.
		expect(stdout).toContain("readable only by you");
	});

	test("whoami says who it acts as, on which Install, and what it reaches", async () => {
		const { code, stdout } = await cli.run(["whoami"]);

		expect(code).toBe(0);
		expect(stdout).toContain("Person:     Olive Owner <");
		expect(stdout).toContain("Install:    https://admin.test (WebCraft ");
		expect(stdout).toContain("Workspace:  Bakeries");
		expect(stdout).toContain("Sites:      Sourdough Corner");
		expect(stdout).not.toContain("Corner Café");
		expect(stdout).toContain("Toolsets:   content");
		expect(stdout).toContain("Access:     reads only; doesn't publish");

		const json = await cli.run(["whoami", "--json"]);
		expect(JSON.parse(json.stdout)).toMatchObject({
			credential: "signIn",
			profile: "admin.test",
			client: { kind: "oauthGrant", name: "webcraft CLI on olive-laptop", readOnly: true, toolsets: ["content"] },
		});
	});

	test("its commands act as the person within what they approved", async () => {
		const read = await cli.run(["post-types", "list", "--site-id", bakery.id]);
		expect(read.code).toBe(0);

		const elsewhere = await cli.run(["post-types", "list", "--site-id", cafe.id]);
		expect(elsewhere.code).toBe(1);
		expect(elsewhere.stderr).toContain("SITE_NOT_FOUND");

		const write = await cli.run([
			"post-types",
			"create",
			"--site-id",
			bakery.id,
			"--name",
			"Loaves",
			"--url-pattern",
			"/loaves/{slug}",
		]);
		expect(write.code).toBe(1);
		expect(write.stderr).toContain("TOKEN_READ_ONLY");
	});

	test("its grant is listed under Your account › AI clients, sending nobody anywhere", async () => {
		const { grants } = await owner.browser.api.aiClients.list();

		expect(grants).toContainEqual(
			expect.objectContaining({
				client: { name: "webcraft CLI on olive-laptop", redirectHost: null },
				status: "active",
				readOnly: true,
			}),
		);
	});

	test("refreshes its access token when it runs out, keeping the new one", async () => {
		await install.clock.advance(2 * 60 * 60 * 1000);

		expect((await cli.run(["whoami"])).code).toBe(0);
		expect((await cli.run(["whoami"])).code).toBe(0);
	});

	test("logging in again replaces the sign-in kept before: its grant is revoked", async () => {
		const before = (await owner.browser.api.aiClients.list()).grants.filter(
			(grant) => grant.client.name === "webcraft CLI on olive-laptop" && grant.status === "active",
		);
		expect(before).toHaveLength(1);

		const again = await signInCli(cli, install, owner.browser, { workspaceId, sites: [bakery.id], readOnly: true });
		expect(again.code).toBe(0);

		const grants = (await owner.browser.api.aiClients.list()).grants.filter(
			(grant) => grant.client.name === "webcraft CLI on olive-laptop",
		);
		expect(grants.filter((grant) => grant.status === "active")).toHaveLength(1);
		expect(grants.find((grant) => grant.id === before[0]?.id)).toMatchObject({
			status: "revoked",
			revokedReason: "client",
		});
	});

	test("a denied code signs nothing in", async () => {
		const other = cliUser(install);
		try {
			const { code, stderr } = await other.run(["login", "--install", "admin.test"], {
				whileWaiting: async ({ stderr: printed }) => {
					const userCode = userCodeIn(printed);
					if (userCode) await owner.browser.api.oauth.denyDevice({ userCode }).catch(() => undefined);
				},
			});
			expect(code).toBe(4);
			expect(stderr).toContain("denied");
			expect((await other.run(["whoami"])).code).toBe(3);
		} finally {
			await other.close();
		}
	});

	test("logout revokes the grant on the Install: commands then ask to sign in again", async () => {
		const { code, stdout } = await cli.run(["logout"]);
		expect(code).toBe(0);
		expect(stdout).toContain("revoked on the Install");

		const after = await cli.run(["sites", "list", "--workspace-id", workspaceId]);
		expect(after.code).toBe(3);
		expect(after.stderr).toContain("webcraft login --install admin.test");
		const { grants } = await owner.browser.api.aiClients.list();
		expect(grants.find((grant) => grant.client.name === "webcraft CLI on olive-laptop")).toMatchObject({
			status: "revoked",
			revokedReason: "client",
		});
	});
});

describe("a sign-ins file that can't be read", () => {
	test("is left as it is: a new sign-in never replaces it with a file of one", async () => {
		const cli = cliUser(install);
		try {
			expect((await signInCli(cli, install, owner.browser, { workspaceId }, ["--name", "client-side"])).code).toBe(0);
			const file = `${cli.configDir}/credentials.json`;
			// Damaged: cut off part-way, as a full disk or a crash leaves a file.
			const damaged = (await Bun.file(file).text()).slice(0, -20);
			await Bun.write(file, damaged);

			const staff = await install.createStaff({ workspaces: [workspaceId], name: "Sam Second" });
			const again = await signInCli(cli, install, staff.browser, { workspaceId }, ["--name", "agency-side"]);

			expect(again.code).not.toBe(0);
			expect(again.stderr).toContain("credentials.json");
			expect(again.stderr).toContain("can't be read");
			// Whatever of the other sign-in is still in it stays there for the person to mend.
			expect(await Bun.file(file).text()).toBe(damaged);
			// And nothing acts as if nobody had signed in.
			const who = await cli.run(["whoami", "--install", "client-side"]);
			expect(who.code).not.toBe(0);
			expect(who.stderr).toContain("can't be read");
		} finally {
			await cli.close();
		}
	});
});

describe("several Installs", () => {
	test("each sign-in is a profile; --install picks one, and the newest is the default", async () => {
		const cli = cliUser(install);
		try {
			const staff = await install.createStaff({ workspaces: [workspaceId], name: "Sam Staff" });
			expect((await signInCli(cli, install, owner.browser, { workspaceId }, ["--name", "client-side"])).code).toBe(0);
			expect((await signInCli(cli, install, staff.browser, { workspaceId }, ["--name", "agency-side"])).code).toBe(0);

			const listed = await cli.run(["profiles"]);
			expect(listed.stdout).toContain("* agency-side  https://admin.test  signed in as");
			expect(listed.stdout).toContain("  client-side  https://admin.test  signed in as");

			expect((await cli.run(["whoami"])).stdout).toContain("Sam Staff");
			expect((await cli.run(["whoami", "--install", "client-side"])).stdout).toContain("Olive Owner");
			await cli.run(["profiles", "use", "client-side"]);
			expect((await cli.run(["whoami"])).stdout).toContain("Olive Owner");
		} finally {
			await cli.close();
		}
	});
});

describe("a config file that can't be read", () => {
	// The report's "Sloppy code": a file cut short (a full disk, an editor's mistake) was taken for
	// an empty one, and the next sign-in wrote that back, dropping every other profile and sign-in.
	test("stops the command and is left exactly as it is, never taken for empty and written over", async () => {
		const cli = cliUser(install, { hostname: "ruined-laptop" });
		try {
			const first = await signInCli(cli, install, owner.browser, { workspaceId, sites: "all" });
			expect(first.code).toBe(0);
			for (const name of ["config.json", "credentials.json"]) {
				const path = join(cli.configDir, name);
				const whole = await readFile(path, "utf8");
				const cut = whole.slice(0, Math.floor(whole.length / 2));
				await writeFile(path, cut);

				const whoami = await cli.run(["whoami"]);
				expect({ name, code: whoami.code }).toEqual({ name, code: 1 });
				expect(whoami.stderr).toContain(path);
				const login = await signInCli(cli, install, owner.browser, { workspaceId, sites: "all" }, ["--name", "second"]);
				expect({ name, code: login.code }).toEqual({ name, code: 1 });
				expect(login.stderr).toContain(path);
				expect(await readFile(path, "utf8")).toBe(cut);

				await writeFile(path, whole);
				expect((await cli.run(["whoami"])).code).toBe(0);
			}
		} finally {
			await cli.close();
		}
	});
});

describe("the device authorization grant", () => {
	test("polling too fast slows the client down; an approved code gives tokens once", async () => {
		const clientId = await deviceClient();
		const started = await post("/oauth/device_authorization", { client_id: clientId });
		expect(started.status).toBe(200);
		expect(started.body).toMatchObject({
			expires_in: 600,
			interval: 5,
			verification_uri: install.adminUrl("/oauth/device"),
		});
		const device = String(started.body.device_code);
		const poll = () => post("/oauth/token", { grant_type: DEVICE, device_code: device, client_id: clientId });

		expect((await poll()).body.error).toBe("authorization_pending");
		expect((await poll()).body.error).toBe("slow_down");
		await install.clock.advance(5_000);
		// The interval is 10 seconds now, and each poll too soon adds 5 more: 15.
		expect((await poll()).body.error).toBe("slow_down");
		await install.clock.advance(15_000);
		expect((await poll()).body.error).toBe("authorization_pending");

		await approveDevice(owner.browser, String(started.body.user_code).toLowerCase(), { workspaceId });
		await install.clock.advance(15_000);
		const tokens = await poll();
		expect(tokens.status).toBe(200);
		expect(tokens.body).toMatchObject({ token_type: "Bearer", expires_in: 3600 });

		await install.clock.advance(15_000);
		const again = await poll();
		expect(again.body.error).toBe("invalid_grant");
		// Used twice: someone else may hold it, so the grant it made is revoked.
		const answer = await install.request(
			new Request(install.adminUrl("/api/v1/access/current"), {
				method: "POST",
				headers: { authorization: `Bearer ${String(tokens.body.access_token)}`, "content-type": "application/json" },
				body: "{}",
			}),
		);
		expect(answer.status).toBe(401);
	});

	test("a code lasts 10 minutes and is decided once", async () => {
		const clientId = await deviceClient();
		const late = await post("/oauth/device_authorization", { client_id: clientId });
		await install.clock.advance(10 * 60 * 1000);
		expect(
			await owner.browser.api.oauth.checkDevice({ userCode: String(late.body.user_code), typed: true }),
		).toMatchObject({
			check: { kind: "refused", problem: "expired" },
		});
		expect(
			(
				await post("/oauth/token", {
					grant_type: DEVICE,
					device_code: String(late.body.device_code),
					client_id: clientId,
				})
			).body.error,
		).toBe("expired_token");

		const fresh = await post("/oauth/device_authorization", { client_id: clientId });
		const userCode = String(fresh.body.user_code);
		expect(await owner.browser.api.oauth.checkDevice({ userCode, typed: true })).toMatchObject({
			check: { kind: "ask", request: { client: { name: "Kiosk" }, userCode } },
		});
		await owner.browser.api.oauth.denyDevice({ userCode });
		expect(await owner.browser.api.oauth.checkDevice({ userCode, typed: true })).toMatchObject({
			check: { kind: "refused", problem: "decided" },
		});
		await expect(approveDevice(owner.browser, userCode, { workspaceId })).rejects.toMatchObject({
			code: "DEVICE_CODE_INVALID",
		});
	});

	// Nothing a device sign-in says about itself can be trusted: anyone may register a client under
	// any name. The approval shows what WebCraft itself knows, and a code that came in a link is
	// shown only to a browser on the network that asked for it (the report's A1-6).
	test("the approval says when the code was asked for and from which network", async () => {
		const clientId = await deviceClient();
		const fresh = await post("/oauth/device_authorization", { client_id: clientId });
		const userCode = String(fresh.body.user_code);
		await install.clock.advance(2 * 60 * 1000);

		const { check } = await owner.browser.api.oauth.checkDevice({ userCode, typed: true });

		expect(check).toEqual({
			kind: "ask",
			request: {
				client: { id: clientId, name: "Kiosk" },
				userCode,
				requestedAt: new Date(install.clock.now().getTime() - 2 * 60 * 1000),
				network: "10.230.0.*",
				sameNetwork: false,
			},
		});
	});

	test("a code that arrives in a link isn't looked up for a browser on another network: the person types the code their own terminal shows", async () => {
		const clientId = await deviceClient();
		const fresh = await post("/oauth/device_authorization", { client_id: clientId });
		const userCode = String(fresh.body.user_code);
		const person = await install.createMember({ workspaceId, role: "editor" });

		// Sent the link by someone else: nothing about the sign-in is shown, whatever name it carries.
		expect(await person.browser.api.oauth.checkDevice({ userCode, typed: false })).toMatchObject({
			check: { kind: "type" },
		});
		// Their own terminal, on their own network, opened the link.
		const sameNetwork = await install.signIn(person.account, { address: "10.230.0.1" });
		expect(await sameNetwork.api.oauth.checkDevice({ userCode, typed: false })).toMatchObject({
			check: { kind: "ask", request: { client: { name: "Kiosk" }, userCode, sameNetwork: true } },
		});
		// Typed in, it is looked up from anywhere: that is what a device sign-in is for.
		expect(await person.browser.api.oauth.checkDevice({ userCode, typed: true })).toMatchObject({
			check: { kind: "ask", request: { userCode, sameNetwork: false } },
		});
	});

	test("looking up user codes is limited per person, so they can't be guessed", async () => {
		const guesser = await install.createMember({ workspaceId, role: "editor" });
		for (let attempt = 0; attempt < 20; attempt++) {
			await guesser.browser.api.oauth.checkDevice({ userCode: "BBBB-BBBB", typed: true });
		}
		await expect(guesser.browser.api.oauth.checkDevice({ userCode: "BBBB-BBBB", typed: true })).rejects.toMatchObject({
			code: "TOO_MANY_REQUESTS",
		});
		// Denying (or approving) a code counts the same: guessing one to deny someone's sign-in is hopeless too.
		await expect(guesser.browser.api.oauth.denyDevice({ userCode: "BBBB-BBBC" })).rejects.toMatchObject({
			code: "TOO_MANY_REQUESTS",
		});
	});

	test("a client that didn't register for device codes can't ask for one", async () => {
		const { body } = await approveAiClient(install, owner.browser, { workspaceId }).then(async (approved) =>
			post("/oauth/device_authorization", { client_id: approved.clientId }),
		);
		expect(body.error).toBe("unauthorized_client");
	});

	test("tokens are for one resource: the CLI's for the API, an AI client's for the MCP server", async () => {
		const cli = cliUser(install);
		try {
			await signInCli(cli, install, owner.browser, { workspaceId });
			const stored = JSON.parse(await Bun.file(`${cli.configDir}/credentials.json`).text()) as Record<
				string,
				{ accessToken: string }
			>;
			const cliToken = Object.values(stored)[0]?.accessToken ?? "";
			await expect(connectMcp(install, cliToken)).rejects.toThrow();

			const aiClient = await approveAiClient(install, owner.browser, { workspaceId });
			const response = await install.request(
				new Request(install.adminUrl("/api/v1/access/current"), {
					method: "POST",
					headers: { authorization: `Bearer ${aiClient.accessToken}`, "content-type": "application/json" },
					body: "{}",
				}),
			);
			expect(response.status).toBe(401);
		} finally {
			await cli.close();
		}
	});
});
