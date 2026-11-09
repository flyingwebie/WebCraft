// The client address of a request: where rate limits, lockout records, the sessions list, Consent
// records and Form posts say a request came from. Behind a proxy (Caddy in the Compose file, Coolify's
// proxy, Railway's edge) the connection comes from the proxy, which says whom it forwarded for:
// `X-Forwarded-For` (Railway: `X-Real-IP`). `WEBCRAFT_TRUSTED_PROXIES` says which proxies to believe;
// anyone else can write those headers, so from anyone else they are ignored.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestInstall, type TestAccount, type TestBrowserOptions, type TestInstall } from "../harness/index.ts";

/** Where Caddy reaches the web process in the Compose file: a private Docker network. */
const CADDY = "172.18.0.5";
/** Where Railway's edge reaches a service: inside Railway's network (shared address space). */
const RAILWAY_EDGE = "100.92.14.3";

const installs: TestInstall[] = [];

async function installWith(options: Parameters<typeof createTestInstall>[0] = {}) {
	const install = await createTestInstall(options);
	installs.push(install);
	return { install, account: await install.createSuperadmin() };
}

afterAll(async () => {
	await Promise.all(installs.map((install) => install.close()));
});

/** The network the sessions list shows for a browser that signs in with these options. */
async function networkSeen(
	{ install, account }: { install: TestInstall; account: TestAccount },
	options: TestBrowserOptions,
): Promise<string | null | undefined> {
	const browser = await install.signIn(account, options);
	const { sessions } = await browser.api.me.sessions.list();
	return sessions.find((session) => session.current)?.network;
}

/**
 * The exact address the auth rate limit counts a browser under: it takes 10 attempts a minute from
 * one address, and logs the address it refuses once.
 */
async function addressCounted(install: TestInstall, options: TestBrowserOptions): Promise<unknown> {
	const browser = install.browser(options);
	const before = install.logs.length;
	for (let attempt = 0; attempt < 11; attempt++) {
		await browser.api.session
			.signIn({ email: "nobody@agency.example", password: "a guessed password" })
			.catch(() => {});
	}
	return install.logs.slice(before).find((entry) => entry.msg.includes("Too many"))?.clientAddress;
}

describe("behind Caddy (WEBCRAFT_EDGE=caddy, the default)", () => {
	let caddy: { install: TestInstall; account: TestAccount };

	beforeAll(async () => {
		caddy = await installWith();
	});

	test("a request Caddy forwarded comes from the visitor it names in X-Forwarded-For", async () => {
		expect(await networkSeen(caddy, { address: CADDY, headers: { "x-forwarded-for": "198.51.100.7" } })).toBe(
			"198.51.100.*",
		);
	});

	test("rate limits count each visitor behind the proxy apart, under their own address", async () => {
		expect(
			await addressCounted(caddy.install, { address: CADDY, headers: { "x-forwarded-for": "198.51.100.77" } }),
		).toBe("198.51.100.77");

		const neighbour = install(caddy).browser({ address: CADDY, headers: { "x-forwarded-for": "198.51.100.78" } });
		await expect(neighbour.api.session.signIn(caddy.account)).resolves.toMatchObject({
			person: { email: caddy.account.email },
		});
	});

	test("a connection from anywhere else is the client itself, whatever X-Forwarded-For it sends", async () => {
		expect(await networkSeen(caddy, { address: "203.0.113.40", headers: { "x-forwarded-for": "198.51.100.7" } })).toBe(
			"203.0.113.*",
		);
	});

	test("X-Forwarded-For is read from the right, past every trusted proxy: what a client wrote to the left is never believed", async () => {
		expect(
			await addressCounted(caddy.install, {
				address: CADDY,
				headers: { "x-forwarded-for": "203.0.113.66, 198.51.100.81, 10.0.4.2" },
			}),
		).toBe("198.51.100.81");
	});

	test("when every address in the chain is a proxy's, the client is the first one", async () => {
		expect(await networkSeen(caddy, { address: CADDY, headers: { "x-forwarded-for": "192.168.40.20" } })).toBe(
			"192.168.40.*",
		);
	});

	test("an entry that isn't an address stops the walk at the last proxy", async () => {
		expect(
			await addressCounted(caddy.install, {
				address: CADDY,
				headers: { "x-forwarded-for": "198.51.100.90, junk, 10.0.5.3" },
			}),
		).toBe("10.0.5.3");
	});

	test("without X-Forwarded-For, the proxy's own address is all there is", async () => {
		expect(await networkSeen(caddy, { address: CADDY })).toBe("172.18.0.*");
	});

	test("IPv4 written inside IPv6, IPv6 in brackets and addresses with ports are each read as the one address", async () => {
		expect(
			await networkSeen(caddy, { address: "::ffff:172.18.0.5", headers: { "x-forwarded-for": "::ffff:198.51.100.8" } }),
		).toBe("198.51.100.*");
		expect(
			await addressCounted(caddy.install, { address: CADDY, headers: { "x-forwarded-for": "[2001:DB8:85A3::7]:443" } }),
		).toBe("2001:db8:85a3::7");
		expect(
			await addressCounted(caddy.install, {
				address: "fd00::5",
				headers: { "x-forwarded-for": "198.51.100.91:51234" },
			}),
		).toBe("198.51.100.91");
	});
});

function install(entry: { install: TestInstall }): TestInstall {
	return entry.install;
}

describe("WEBCRAFT_TRUSTED_PROXIES", () => {
	test("none: no proxy is believed, not even on a private network", async () => {
		const none = await installWith({ trustedProxies: "none" });

		expect(await networkSeen(none, { address: CADDY, headers: { "x-forwarded-for": "198.51.100.7" } })).toBe(
			"172.18.0.*",
		);
	});

	test("addresses and ranges: only those are proxies", async () => {
		const listed = await installWith({ trustedProxies: "198.51.100.0/24, 2001:db8:aa::1" });

		expect(await networkSeen(listed, { address: "198.51.100.5", headers: { "x-forwarded-for": "203.0.113.80" } })).toBe(
			"203.0.113.*",
		);
		expect(
			await networkSeen(listed, { address: "2001:db8:aa::1", headers: { "x-forwarded-for": "203.0.114.80" } }),
		).toBe("203.0.114.*");
		expect(await networkSeen(listed, { address: CADDY, headers: { "x-forwarded-for": "203.0.113.80" } })).toBe(
			"172.18.0.*",
		);
	});

	test("on Coolify, its proxy on the server's Docker network is believed by default", async () => {
		const coolify = await installWith({ edge: "coolify" });

		expect(await networkSeen(coolify, { address: "10.0.1.7", headers: { "x-forwarded-for": "198.51.100.12" } })).toBe(
			"198.51.100.*",
		);
	});

	describe("on Railway (the default there: railway)", () => {
		let railway: { install: TestInstall; account: TestAccount };

		beforeAll(async () => {
			railway = await installWith({ edge: "railway" });
		});

		test("Railway's edge gives the client's address in X-Real-IP; X-Forwarded-For is not read", async () => {
			expect(
				await addressCounted(railway.install, {
					address: RAILWAY_EDGE,
					headers: { "x-real-ip": "198.51.100.33", "x-forwarded-for": "203.0.113.9" },
				}),
			).toBe("198.51.100.33");
		});

		test("a connection from outside Railway's network didn't come through the edge: its X-Real-IP is ignored", async () => {
			expect(await networkSeen(railway, { address: "203.0.113.41", headers: { "x-real-ip": "198.51.100.33" } })).toBe(
				"203.0.113.*",
			);
		});

		test("without a usable X-Real-IP, the connection's address is used", async () => {
			expect(await networkSeen(railway, { address: RAILWAY_EDGE })).toBe("100.92.14.*");
			expect(await networkSeen(railway, { address: RAILWAY_EDGE, headers: { "x-real-ip": "not an address" } })).toBe(
				"100.92.14.*",
			);
		});
	});
});

describe("a wrong WEBCRAFT_TRUSTED_PROXIES", () => {
	const ROOT = new URL("../../", import.meta.url).pathname;
	/** Bun loads `.env` from the directory it starts in: an empty one keeps the developer's out. */
	const EMPTY_DIRECTORY = mkdtempSync(join(tmpdir(), "webcraft-trusted-proxies-"));
	const BASE_ENV = {
		PATH: process.env.PATH ?? "",
		DATABASE_URL: "postgres://webcraft:unused@127.0.0.1:1/never-reached",
		WEBCRAFT_ADMIN_HOST: "admin.test",
		WEBCRAFT_SECRET_KEY: "a-master-key-long-enough-0123456789abcdef",
	};

	async function start(command: string[], value: string) {
		const child = Bun.spawn(command, {
			cwd: EMPTY_DIRECTORY,
			env: { ...BASE_ENV, WEBCRAFT_TRUSTED_PROXIES: value },
			stdout: "pipe",
			stderr: "pipe",
		});
		const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		clearTimeout(timer);
		return { code, output: stdout + stderr };
	}

	for (const [name, command] of [
		["the web process", ["bun", join(ROOT, "apps/server/src/serve.ts")]],
		["the worker", ["node", join(ROOT, "apps/worker/src/main.ts")]],
	] as const) {
		test(`stops ${name}, saying what it takes`, async () => {
			const wrong = await start([...command], "10.0.0.0/8, caddy");
			expect(wrong.code).toBe(1);
			expect(wrong.output).toContain("WEBCRAFT_TRUSTED_PROXIES must be IP addresses or ranges (such as 172.18.0.0/16)");
			expect(wrong.output).toMatch(/got .{0,4}caddy/);

			const everyone = await start([...command], "0.0.0.0/0");
			expect(everyone.code).toBe(1);
			expect(everyone.output).toContain("WEBCRAFT_TRUSTED_PROXIES can't trust every address");
		});
	}
});
