// The CLI's remote commands, generated from the Install's OpenAPI document: one per public
// procedure, its options from the procedure's input schema, its answer printed for people or as
// JSON (`--json`). Driven in process with an API token (`WEBCRAFT_TOKEN`), as CI does.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken } from "../harness/api-tokens.ts";
import { type CliUser, cliUser } from "../harness/cli.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let cli: CliUser;
let workspaceId: string;
let siteId: string;
let env: Record<string, string>;

beforeAll(async () => {
	install = await createTestInstall();
	const admin = await install.superadmin();
	({ id: workspaceId } = await install.createWorkspace("Bakeries"));
	({ id: siteId } = await install.createSite(workspaceId, { name: "Sourdough Corner", slug: "sourdough" }));
	const { secret } = await createApiToken(admin, { workspaceId, name: "CI" });
	env = { WEBCRAFT_TOKEN: secret, WEBCRAFT_INSTALL: install.adminUrl("/") };
	cli = cliUser(install);
});

afterAll(async () => {
	await cli.close();
	await install.close();
});

describe("a generated command", () => {
	test("calls its procedure with the API token and prints the answer for people", async () => {
		const { code, stdout, stderr } = await cli.run(["sites", "list", "--workspace-id", workspaceId], { env });

		expect(stderr).toBe("");
		expect(code).toBe(0);
		expect(stdout).toContain("name: Sourdough Corner");
		expect(stdout).toContain(`id: ${siteId}`);
		expect(stdout).not.toContain("{");
	});

	test("prints the answer as JSON with --json", async () => {
		const { code, stdout } = await cli.run(["sites", "get", "--site-id", siteId, "--json"], { env });

		expect(code).toBe(0);
		const answer = JSON.parse(stdout) as { site: { id: string; name: string } };
		expect(answer.site).toMatchObject({ id: siteId, name: "Sourdough Corner" });
	});
});

describe("options", () => {
	test("come from the input schema: wrong values, unknown options and missing ones are refused before anything is sent", async () => {
		const sent = cli.requests.length;

		const notANumber = await cli.run(["media", "list", "--site-id", siteId, "--limit", "lots"], { env });
		expect(notANumber).toMatchObject({ code: 2, stdout: "" });
		expect(notANumber.stderr).toContain("--limit takes a whole number");

		const notAChoice = await cli.run(["media", "list", "--site-id", siteId, "--kind", "spreadsheet"], { env });
		expect(notAChoice.code).toBe(2);
		expect(notAChoice.stderr).toContain("--kind is one of image, document, video, audio");

		const unknown = await cli.run(["sites", "list", "--workspace-id", workspaceId, "--colour", "red"], { env });
		expect(unknown.code).toBe(2);
		expect(unknown.stderr).toContain("has no option --colour");

		const missing = await cli.run(["sites", "get"], { env });
		expect(missing.code).toBe(2);
		expect(missing.stderr).toContain("needs --site-id");

		// Only the catalogue was read: no procedure was called.
		expect(cli.requests.slice(sent).filter((request) => request.method === "POST")).toEqual([]);
	});

	test("take switches, repeated values and JSON, and --data gives the whole input", async () => {
		const admin = await install.superadmin();
		const { postType } = await admin.api.postTypes.create({ siteId, name: "Loaves", urlPattern: "/loaves/{slug}" });
		const created = await cli.run(
			["entries", "create", "--data", JSON.stringify({ siteId, postTypeId: postType.id, title: "Rye" }), "--json"],
			{ env },
		);
		expect(created.code).toBe(0);
		const { entry } = JSON.parse(created.stdout) as { entry: { id: string } };

		const saved = await cli.run(
			[
				"entries",
				"save-draft",
				"--site-id",
				siteId,
				"--entry-id",
				entry.id,
				"--title",
				"Dark rye",
				"--seo",
				'{"noindex": true}',
			],
			{ env },
		);
		expect(saved.code).toBe(0);
		const fromStdin = await cli.run(["entries", "get", "--data", "-", "--json"], {
			env,
			stdin: JSON.stringify({ siteId, entryId: entry.id }),
		});
		const { entry: read } = JSON.parse(fromStdin.stdout) as {
			entry: { draft: { title: string; seo: { noindex: boolean | null } } };
		};
		expect(read.draft).toMatchObject({ title: "Dark rye", seo: { noindex: true } });

		const trash = await cli.run(["media", "list", "--site-id", siteId, "--trash", "--json"], { env });
		expect(trash.code).toBe(0);
		expect(JSON.parse(trash.stdout)).toMatchObject({ items: [] });
	});

	test("an operation id works as the command too", async () => {
		const { code, stdout } = await cli.run(["sites.get", "--site-id", siteId, "--json"], { env });

		expect(code).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({ site: { id: siteId } });
	});
});

describe("procedures that take two steps", () => {
	async function draftEntry(title: string) {
		const admin = await install.superadmin();
		const { postType } = await admin.api.postTypes.create({
			siteId,
			name: `Notes ${title}`,
			urlPattern: `/notes-${title.toLowerCase().replaceAll(" ", "-")}/{slug}`,
		});
		const { entry } = await admin.api.entries.create({ siteId, postTypeId: postType.id, title });
		return {
			entryId: entry.id,
			status: async () => (await admin.api.entries.get({ siteId, entryId: entry.id })).entry.status,
		};
	}

	test("show the preview and change nothing without a confirmation", async () => {
		const entry = await draftEntry("Opening hours");

		const { code, stdout, stderr } = await cli.run(
			["entries", "publish", "--site-id", siteId, "--entry-id", entry.entryId],
			{
				env,
			},
		);

		expect(code).toBe(4);
		expect(stdout).toBe("");
		expect(stderr).toContain("asks you to confirm first");
		expect(stderr).toContain("name: Opening hours");
		expect(stderr).toContain("Nothing changed. Pass --yes");
		expect(await entry.status()).toBe("draft");
	});

	test("go ahead with --yes", async () => {
		const entry = await draftEntry("Holiday closures");

		const { code, stdout } = await cli.run(
			["entries", "publish", "--site-id", siteId, "--entry-id", entry.entryId, "--yes", "--json"],
			{ env },
		);

		expect(code).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({ entry: { status: "published" } });
		expect(await entry.status()).toBe("published");
	});

	test("ask on a terminal, and go ahead only on yes", async () => {
		const declined = await draftEntry("Gift cards");
		const no = await cli.run(["entries", "publish", "--site-id", siteId, "--entry-id", declined.entryId], {
			env,
			answers: ["n"],
		});
		expect(no.code).toBe(4);
		expect(no.stderr).toContain("Go ahead? [y/N]");
		expect(await declined.status()).toBe("draft");

		const accepted = await draftEntry("Wholesale");
		const yes = await cli.run(["entries", "publish", "--site-id", siteId, "--entry-id", accepted.entryId], {
			env,
			answers: ["y"],
		});
		expect(yes.code).toBe(0);
		expect(await accepted.status()).toBe("published");
	});
});

describe("what the Install doesn't offer", () => {
	test("a Sensitive action is never a command", async () => {
		const { code, stderr } = await cli.run(["members", "invite", "--workspace-id", workspaceId], { env });

		expect(code).toBe(7);
		expect(stderr).toContain("Sensitive action (member.invite)");
		expect(stderr).toContain("in the admin");
	});

	test("a command this webcraft knows but the Install doesn't offer is refused, saying why", async () => {
		// An Install that runs none of the first-party Modules has no Redirects commands.
		const bare = await createTestInstall({ modules: [] });
		const bareCli = cliUser(bare);
		try {
			const { id: bareWorkspace } = await bare.createWorkspace();
			const { secret } = await createApiToken(await bare.superadmin(), { workspaceId: bareWorkspace, name: "CI" });
			const { code, stderr } = await bareCli.run(["redirects", "rules", "list", "--site-id", siteId], {
				env: { WEBCRAFT_TOKEN: secret, WEBCRAFT_INSTALL: bare.adminUrl("/") },
			});

			expect(code).toBe(7);
			expect(stderr).toContain("doesn't offer webcraft redirects rules list (m.redirects.rules.list)");
		} finally {
			await bareCli.close();
			await bare.close();
		}
	});

	test("a mistyped command suggests the right one", async () => {
		const { code, stderr } = await cli.run(["sites", "lisst"], { env });

		expect(code).toBe(2);
		expect(stderr).toContain("webcraft sites list");
	});
});

describe("the Install's version", () => {
	test("an older webcraft says so once per run, on standard error", async () => {
		const admin = await install.superadmin();
		const { postType } = await admin.api.postTypes.create({ siteId, name: "Recipes", urlPattern: "/recipes/{slug}" });
		const { entry } = await admin.api.entries.create({ siteId, postTypeId: postType.id, title: "Focaccia" });

		const older = await cli.run(["entries", "publish", "--site-id", siteId, "--entry-id", entry.id, "--yes"], {
			env,
			version: "0.0.1",
		});

		expect(older.code).toBe(0);
		const warnings = older.stderr.split("\n").filter((line) => line.includes("older than the Install"));
		expect(warnings).toEqual([expect.stringContaining("this webcraft is 0.0.1, older than the Install (WebCraft ")]);

		const newer = await cli.run(["sites", "list", "--workspace-id", workspaceId], { env, version: "999.0.0" });
		expect(newer.stderr).toBe("");
	});
});
