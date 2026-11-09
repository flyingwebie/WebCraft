// The domain settings in the environment (ADR 0015): `WEBCRAFT_EDGE` and `WEBCRAFT_PUBLIC_ADDRESSES`.
// A process given a wrong one refuses to start and says what it expects; this starts the real web entry.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestInstall } from "../harness/index.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const WEB = join(ROOT, "apps/server/src/serve.ts");

/** Bun loads `.env` from the directory it starts in: an empty one keeps the developer's out. */
const EMPTY_DIRECTORY = mkdtempSync(join(tmpdir(), "webcraft-domain-settings-"));

const BASE_ENV = {
	PATH: process.env.PATH ?? "",
	DATABASE_URL: "postgres://webcraft:unused@127.0.0.1:1/never-reached",
	WEBCRAFT_ADMIN_HOST: "admin.test",
	WEBCRAFT_SECRET_KEY: "a-master-key-long-enough-0123456789abcdef",
};

async function startWeb(env: Record<string, string>): Promise<{ code: number; output: string }> {
	const child = Bun.spawn(["bun", WEB], { cwd: EMPTY_DIRECTORY, env, stdout: "pipe", stderr: "pipe" });
	const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	clearTimeout(timer);
	return { code, output: stdout + stderr };
}

describe("the domain settings", () => {
	test("a wrong WEBCRAFT_EDGE or WEBCRAFT_PUBLIC_ADDRESSES stops the web process, saying what it takes", async () => {
		const edge = await startWeb({ ...BASE_ENV, WEBCRAFT_EDGE: "nginx" });
		expect(edge.code).toBe(1);
		expect(edge.output).toContain("WEBCRAFT_EDGE must be one of caddy, coolify, railway");

		const addresses = await startWeb({ ...BASE_ENV, WEBCRAFT_PUBLIC_ADDRESSES: "203.0.113.10, my-server" });
		expect(addresses.code).toBe(1);
		expect(addresses.output).toContain("WEBCRAFT_PUBLIC_ADDRESSES must be IP addresses");
	});

	test("on Coolify, the Domains screen says so; without public addresses it offers a CNAME record only", async () => {
		const install = await createTestInstall({ edge: "coolify", publicAddresses: [] });
		try {
			const admin = await install.superadmin();
			const workspace = await install.createWorkspace();
			const site = await install.createSite(workspace.id);
			await admin.api.domains.add({ siteId: site.id, name: "platform-bakery.example" });

			const listed = await admin.api.domains.list({ siteId: site.id });

			expect(listed.edge).toBe("coolify");
			expect(listed.domains[0]?.records).toEqual({
				address: [],
				alias: { type: "CNAME", name: "platform-bakery.example", value: install.adminHost },
			});
		} finally {
			await install.close();
		}
	});
});
