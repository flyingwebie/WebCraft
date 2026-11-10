// `webcraft site export` and `webcraft site import`, run for real on the server (in an empty directory,
// so Bun loads no `.env`, with the Install's environment): the export is written where it is told,
// its secrets under a passphrase read from standard input, never from the command line; the import
// makes a new Site with its Site import report, which the admin lists; both are in the Audit log as
// done by the command.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { manifestIn, PASSPHRASE, rewritten } from "../harness/site-transfer.ts";

const CLI = join(new URL("../../", import.meta.url).pathname, "apps/cli/src/main.ts");
const EMPTY_DIRECTORY = mkdtempSync(join(tmpdir(), "webcraft-cli-"));
const SMTP_PASSWORD = "site-smtp-password-1234";

async function webcraft(install: TestInstall, args: string[], stdin = "") {
	const child = Bun.spawn(["bun", CLI, ...args], {
		cwd: EMPTY_DIRECTORY,
		env: { PATH: process.env.PATH ?? "", ...install.env },
		stdin: new TextEncoder().encode(stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

let install: TestInstall;
let admin: TestBrowser;
let siteId: string;
let otherWorkspaceId: string;
let folder: string;
let archive: string;

beforeAll(async () => {
	folder = mkdtempSync(join(tmpdir(), "webcraft-site-exports-"));
	install = await createTestInstall({ now: new Date() });
	admin = await install.superadmin();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	otherWorkspaceId = (await install.createWorkspace("Beta Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await admin.api.postTypes.create({ siteId, name: "Posts", key: "posts", urlPattern: "/posts/{slug}" });
	await admin.api.siteSmtp.update({
		siteId,
		fromName: null,
		replyTo: null,
		server: {
			host: "smtp.bakery.example",
			port: 587,
			security: "starttls",
			username: "bakery",
			fromAddress: "hello@bakery.example",
			password: SMTP_PASSWORD,
		},
	});
});

afterAll(async () => {
	await install?.close();
	await rm(folder, { recursive: true, force: true });
	await rm(EMPTY_DIRECTORY, { recursive: true, force: true });
});

describe("webcraft site export", () => {
	test("writes the Site's export where it is told, its secrets under a passphrase from standard input", async () => {
		const { code, stdout, stderr } = await webcraft(
			install,
			["site", "export", siteId, "--to", folder, "--passphrase"],
			`${PASSPHRASE}\n`,
		);

		expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
		const [name] = readdirSync(folder);
		expect(name).toMatch(/^webcraft-site-bakery-\d{8}-\d{6}\.tar$/);
		archive = join(folder, name ?? "");
		expect(stdout).toContain(`Exported the Site: ${archive}`);
		expect(stdout).toContain("encrypted under the passphrase");
	});

	test("refuses a passphrase given on the command line", async () => {
		const { code } = await webcraft(install, ["site", "export", siteId, "--passphrase", PASSPHRASE]);
		expect(code).toBe(1);
	});

	test("can explicitly leave Submissions and private Form uploads out", async () => {
		const path = join(folder, "without-submissions.tar");
		const result = await webcraft(install, ["site", "export", siteId, "--to", path, "--without-submissions"]);
		expect({ code: result.code, error: result.code === 0 ? "" : result.stderr }).toEqual({ code: 0, error: "" });
		expect(manifestIn(readFileSync(path)).leftOut.submissions).toBe(true);
		expect(result.stdout).toContain("Submissions and private Form uploads were left out.");
	});
});

describe("webcraft site import", () => {
	test("imports it into a Workspace as a new Site, its secrets working, its report in the admin", async () => {
		const { code, stdout, stderr } = await webcraft(
			install,
			[
				"site",
				"import",
				archive,
				"--workspace",
				otherWorkspaceId,
				"--slug",
				"beta-bakery",
				"--name",
				"Beta Bakery",
				"--passphrase",
			],
			`${PASSPHRASE}\n`,
		);

		expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({ code: 0, stderr: "" });
		expect(stdout).toContain("Imported the Site as beta-bakery");
		const { imports } = await admin.api.siteImports.list({ workspaceId: otherWorkspaceId });
		expect(imports.map((each) => [each.status, each.site?.name])).toEqual([["done", "Beta Bakery"]]);
		const newSiteId = imports[0]?.site?.id ?? "";
		// The command queues work with the real clock; let the frozen worker clock reach it.
		await install.clock.set(new Date());
		const cards = await install.drainJobs({ only: ["socialCards.render"] });
		expect(cards.failed).toEqual([]);
		expect(cards.completed).toContainEqual({
			name: "socialCards.render",
			data: expect.objectContaining({ siteId: newSiteId }),
		});
		expect(install.socialCards.rendered).toEqual([]);

		install.mail.clear();
		await admin.api.siteSmtp.sendTest({
			siteId: newSiteId,
			to: "ops@agency.example",
			fromName: null,
			replyTo: null,
			server: {
				host: "smtp.bakery.example",
				port: 587,
				security: "starttls",
				username: "bakery",
				fromAddress: "hello@bakery.example",
			},
		});
		expect(install.mail.sent.at(-1)?.smtp).toMatchObject({ password: SMTP_PASSWORD });
	});

	test("refuses a slug another Site has", async () => {
		const { code, stderr } = await webcraft(install, [
			"site",
			"import",
			archive,
			"--workspace",
			otherWorkspaceId,
			"--slug",
			"bakery",
		]);
		expect(code).toBe(1);
		expect(stderr).toContain("Another Site already has the slug bakery");
	});

	test("both are in the Audit log as done by the command", async () => {
		const { entries } = await admin.api.audit.list({ limit: 50 });
		const byCommand = entries
			.filter((entry) => entry.via.kind === "command")
			.map((entry) => [entry.action, (entry.via as { name?: string }).name]);
		expect(byCommand).toEqual(
			expect.arrayContaining([
				["site.export", "site export"],
				["site.import", "site import"],
			]),
		);
	});
});

test("the real import command refuses invalid identities and leaves no Site or success report", async () => {
	const bad = join(folder, "invalid-id.tar");
	writeFileSync(
		bad,
		rewritten(readFileSync(archive), {
			manifest: (manifest) => {
				manifest.site.id = "00000000-0000-0000-0000-000000000001";
			},
		}),
	);
	const workspaceId = (await install.createWorkspace("Refused CLI import")).id;
	const result = await webcraft(install, [
		"site",
		"import",
		bad,
		"--workspace",
		workspaceId,
		"--slug",
		"bad-id",
		"--name",
		"Invalid ID",
	]);
	expect(result.code).toBe(1);
	expect((await admin.api.sites.list({ workspaceId })).sites).toEqual([]);
	expect((await admin.api.siteImports.list({ workspaceId })).imports).toEqual([]);
});
