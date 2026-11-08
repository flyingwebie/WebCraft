// Web and worker refuse to start without a usable Master key, and say how to make one. These tests
// start the real processes: the worker with `node`, the production web entry with `bun`.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const WORKER = join(ROOT, "apps/worker/src/main.ts");
/** The production web entry (`bun run start`). It checks its settings before loading the built bundle. */
const WEB = join(ROOT, "apps/server/src/serve.ts");

const MAKE_ONE = "openssl rand -base64 32";

/** Settings that are fine, so only the Master key decides whether a process starts. */
const BASE_ENV = {
	PATH: process.env.PATH ?? "",
	DATABASE_URL: "postgres://webcraft:unused@127.0.0.1:1/never-reached",
	WEBCRAFT_ADMIN_HOST: "admin.test",
};

/**
 * Bun loads `.env` from the directory it starts in, which would fill in a key a test left out on
 * purpose, so every process starts in an empty directory.
 */
const EMPTY_DIRECTORY = mkdtempSync(join(tmpdir(), "webcraft-start-"));

async function start(command: string[], env: Record<string, string>) {
	const child = Bun.spawn(command, { cwd: EMPTY_DIRECTORY, env, stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clearTimeout(timer);
	return { code, output: stdout + stderr };
}

const SHORT_KEY = "k".repeat(31);

const processes = [
	{ name: "the worker", command: ["node", WORKER] },
	{ name: "the web process", command: ["bun", WEB] },
];

for (const { name, command } of processes) {
	describe(name, () => {
		test("refuses to start without WEBCRAFT_SECRET_KEY and prints the command that makes one", async () => {
			const { code, output } = await start(command, BASE_ENV);

			expect(code).toBe(1);
			expect(output).toContain("WEBCRAFT_SECRET_KEY is not set");
			expect(output).toContain(MAKE_ONE);
		});

		test("refuses an empty WEBCRAFT_SECRET_KEY the same way", async () => {
			const { code, output } = await start(command, { ...BASE_ENV, WEBCRAFT_SECRET_KEY: "   " });

			expect(code).toBe(1);
			expect(output).toContain("WEBCRAFT_SECRET_KEY is not set");
			expect(output).toContain(MAKE_ONE);
		});

		test("refuses a key shorter than 32 characters, without printing it", async () => {
			const { code, output } = await start(command, { ...BASE_ENV, WEBCRAFT_SECRET_KEY: SHORT_KEY });

			expect(code).toBe(1);
			expect(output).toContain("WEBCRAFT_SECRET_KEY is shorter than 32 characters");
			expect(output).toContain(MAKE_ONE);
			expect(output).not.toContain(SHORT_KEY);
		});

		test("counts the key's characters without the whitespace around it", async () => {
			const { code, output } = await start(command, { ...BASE_ENV, WEBCRAFT_SECRET_KEY: ` ${SHORT_KEY}\n` });

			expect(code).toBe(1);
			expect(output).toContain("WEBCRAFT_SECRET_KEY is shorter than 32 characters");
		});
	});
}

describe("on an Install whose secrets are encrypted under another key", () => {
	let install: TestInstall;
	const OTHER_KEY = "another-key-that-is-long-enough-0123456789";

	beforeAll(async () => {
		install = await createTestInstall();
		await install.secrets.set({ owner: { kind: "install" }, name: "smtp.password" }, "a password, long enough");
	});

	afterAll(async () => {
		await install.close();
	});

	test("the worker refuses to start, naming the key version it needs", async () => {
		const { code, output } = await start(["node", WORKER], {
			...BASE_ENV,
			...install.env,
			WEBCRAFT_SECRET_KEY: OTHER_KEY,
		});

		expect(code).toBe(1);
		expect(output).toContain(
			"WEBCRAFT_SECRET_KEY is not this Install's Master key: its secrets are encrypted under Master key version 1",
		);
		expect(output).toContain("webcraft admin rotate-key");
		expect(output).not.toContain(OTHER_KEY);
	}, 20_000);

	test("the web process refuses to start the same way", async () => {
		await expect(install.restart({ masterKey: OTHER_KEY })).rejects.toThrow(
			"WEBCRAFT_SECRET_KEY is not this Install's Master key: its secrets are encrypted under Master key version 1",
		);
	});
});
