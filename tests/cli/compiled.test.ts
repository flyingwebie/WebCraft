// The compiled, single-file `webcraft` (scripts/build-cli.ts, `bun build --compile`) for this
// computer: it runs on its own, talks to an Install over HTTP (here a local port in front of the test
// Install's handler) with an API token, and points server commands to the Install's own webcraft.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createApiToken } from "../harness/api-tokens.ts";
import { createTestInstall, type TestInstall } from "../harness/index.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const VERSION: string = (await Bun.file(join(ROOT, "package.json")).json()).version;
const OUT = mkdtempSync(join(tmpdir(), "webcraft-compiled-"));
const BINARY = join(OUT, `webcraft-${process.platform}-${process.arch}${process.platform === "win32" ? ".exe" : ""}`);

let install: TestInstall;
let server: ReturnType<typeof Bun.serve>;
let env: Record<string, string>;
let workspaceId: string;

beforeAll(async () => {
	const build = Bun.spawn(["bun", "scripts/build-cli.ts", "--target", "host", "--out", OUT], {
		cwd: ROOT,
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(await build.exited).toBe(0);
	install = await createTestInstall();
	// The Install, on a port of this computer: every request goes to its handler, on its admin host.
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: async (request) => {
			const url = new URL(request.url);
			const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
			return install.request(
				new Request(install.adminUrl(`${url.pathname}${url.search}`), {
					method: request.method,
					headers: request.headers,
					body,
				}),
			);
		},
	});
	({ id: workspaceId } = await install.createWorkspace("Bakeries"));
	await install.createSite(workspaceId, { name: "Sourdough Corner", slug: "sourdough" });
	const { secret } = await createApiToken(await install.superadmin(), { workspaceId, name: "CI" });
	env = {
		PATH: process.env.PATH ?? "",
		WEBCRAFT_CONFIG_DIR: join(OUT, "config"),
		WEBCRAFT_CREDENTIALS: "file",
		WEBCRAFT_TOKEN: secret,
		WEBCRAFT_INSTALL: `http://127.0.0.1:${server.port}`,
	};
});

afterAll(async () => {
	await server.stop(true);
	await install.close();
	await rm(OUT, { recursive: true, force: true });
});

async function run(args: string[]) {
	const child = Bun.spawn([BINARY, ...args], { cwd: OUT, env, stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { code, stdout, stderr };
}

test("the compiled webcraft says its version", async () => {
	expect(await run(["--version"])).toMatchObject({ code: 0, stdout: `webcraft ${VERSION}\n` });
});

test("the compiled webcraft runs the Install's commands", async () => {
	const { code, stdout, stderr } = await run(["sites", "list", "--workspace-id", workspaceId, "--json"]);

	expect(stderr).toBe("");
	expect(code).toBe(0);
	expect(JSON.parse(stdout)).toMatchObject({ sites: [{ name: "Sourdough Corner" }] });
});

test("the compiled webcraft points server commands to the Install's own webcraft", async () => {
	const { code, stderr } = await run(["admin", "migrate"]);

	expect(code).toBe(2);
	expect(stderr).toContain("use the webcraft in the web image");
});
