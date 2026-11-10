// The server commands the CLI ticket adds under `webcraft admin`: setup (a fresh link to the setup
// wizard), health (the web process's /readyz, or whether a worker checked in), doctor (every part of
// the Install, OK, Warning or Failing) and media move's refusals. Run for real, in an empty
// directory so Bun loads no `.env`, with the Install's environment, as on a server.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestInstall, TEST_PASSWORD, type TestInstall } from "../harness/index.ts";

const CLI = join(new URL("../../", import.meta.url).pathname, "apps/cli/src/main.ts");
const WORKER = new URL("../../apps/worker/src/main.ts", import.meta.url).pathname;
const EMPTY_DIRECTORY = mkdtempSync(join(tmpdir(), "webcraft-cli-"));

let install: TestInstall;

beforeAll(async () => {
	install = await createTestInstall();
});

afterAll(async () => {
	await install.close();
	await rm(EMPTY_DIRECTORY, { recursive: true, force: true });
});

async function webcraft(args: string[], env: Record<string, string> = {}) {
	const child = Bun.spawn(["bun", CLI, "admin", ...args], {
		cwd: EMPTY_DIRECTORY,
		env: { PATH: process.env.PATH ?? "", ...install.env, ...env },
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

describe("webcraft admin setup", () => {
	test("prints a new link to the setup wizard, whose token claims the Install", async () => {
		const { code, stdout } = await webcraft(["setup"]);

		expect(code).toBe(0);
		expect(stdout).toContain("This Install has no Superadmin yet.");
		const link = /^(https:\/\/admin\.test\/setup\?token=\S+)$/m.exec(stdout)?.[1];
		expect(link).toBeDefined();
		const token = new URL(link ?? "").searchParams.get("token") ?? "";
		await install.browser().api.setup.claim({
			token,
			name: "Ada Admin",
			email: "ada@agency.example",
			password: TEST_PASSWORD,
			adminLanguage: "en",
		});

		const after = await webcraft(["setup"]);
		expect(after.code).toBe(0);
		expect(after.stdout).toContain("The Superadmin exists.");
	});
});

describe("webcraft admin health", () => {
	test("says whether the web process here answers /readyz", async () => {
		// A web process on a port of its own, answering as the Install's handler does.
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (request) => {
				const url = new URL(request.url);
				const host = request.headers.get("host") ?? url.host;
				return install.request(new Request(`https://${host}${url.pathname}`, { headers: request.headers }));
			},
		});
		try {
			const ready = await webcraft(["health"], { PORT: String(server.port) });
			expect(ready).toMatchObject({ code: 0 });
			expect(ready.stdout).toContain("is ready");
		} finally {
			await server.stop(true);
		}
		const nobody = await webcraft(["health"], { PORT: String(server.port) });
		expect(nobody.code).toBe(1);
		expect(nobody.stdout).toContain("No web process answers");
	});

	test("--worker says whether a worker checked in lately", async () => {
		const before = await webcraft(["health", "--worker"]);
		expect(before.code).toBe(1);
		expect(before.stdout).toContain("No worker has ever checked in");

		const worker = Bun.spawn(["node", WORKER], {
			env: { ...process.env, ...install.env },
			stdout: "ignore",
			stderr: "ignore",
		});
		try {
			let running = await webcraft(["health", "--worker"]);
			for (let tries = 0; running.code !== 0 && tries < 40; tries++) {
				await Bun.sleep(250);
				running = await webcraft(["health", "--worker"]);
			}
			expect(running.code).toBe(0);
			expect(running.stdout).toContain("A worker is working the job queue");
		} finally {
			worker.kill("SIGTERM");
			await worker.exited;
		}
		// A worker that stops says so.
		expect((await webcraft(["health", "--worker"])).code).toBe(1);
	}, 60_000);
});

describe("webcraft admin doctor", () => {
	test("checks every part of the Install and says what is Failing", async () => {
		const { code, stdout } = await webcraft(["doctor", "--json"]);

		const { checks } = JSON.parse(stdout) as { checks: { name: string; state: string; detail: string }[] };
		expect(Object.fromEntries(checks.map((check) => [check.name, check.state]))).toEqual({
			Settings: "ok",
			Database: "ok",
			"Master key": "warning",
			Storage: "ok",
			Mail: "warning",
			Worker: "failing",
			Backups: "warning",
			Updates: "ok",
		});
		expect(checks.find((check) => check.name === "Worker")?.detail).toContain("start the worker");
		expect(code).toBe(1);

		const human = await webcraft(["doctor"]);
		expect(human.stdout).toContain("✓ Database: it answers");
		expect(human.stdout).toContain("✗ Worker:");
		expect(human.stdout).toContain("Something is Failing");
	});

	test("says which setting is missing, and stops there", async () => {
		const { code, stdout } = await webcraft(["doctor"], { WEBCRAFT_SECRET_KEY: "" });

		expect(code).toBe(1);
		expect(stdout).toContain("✗ Settings:");
		expect(stdout).toContain("WEBCRAFT_SECRET_KEY");
		expect(stdout).not.toContain("Database");
	});
});

describe("webcraft admin media move", () => {
	test("refuses a move to a bucket that isn't set, or while new files go elsewhere", async () => {
		const noBucket = await webcraft(["media", "move", "--to", "s3"]);
		expect(noBucket.code).toBe(1);
		expect(noBucket.stderr).toContain("No S3-compatible bucket is set");

		const nothing = await webcraft(["media", "move", "--to", "disk"]);
		expect(nothing.code).toBe(0);
		expect(nothing.stdout).toContain("Every Media file is already in local disk: nothing to move.");

		const wrong = await webcraft(["media", "move", "--to", "ftp"]);
		expect(wrong.code).toBe(1);
		expect(wrong.stderr).toContain("Unknown command or options: webcraft admin media");
	});
});
