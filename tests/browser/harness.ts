// Seam 2: a real browser on the real admin. Each browser Install is a test Install (its own
// database, see ../harness) served by the production web process (`bun run build` first), with
// Chromium driven through Playwright. One check asks for the dev server instead (`devServer`).
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { type Browser, type BrowserContext, type Cookie, chromium, type Page } from "playwright";

import { createTestBrowser, type TestBrowser } from "../harness/browser.ts";
import {
	createTestInstall,
	TEST_INSTALL_ADDRESSES,
	TEST_MASTER_KEY,
	type TestAccount,
	type TestInstall,
} from "../harness/index.ts";
import { TEST_MODULES } from "../harness/modules.ts";
import { goLive } from "../harness/staging.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
/** The production web process, started with the test suite's Modules (see web.ts). */
const WEB = join(ROOT, "tests/browser/web.ts");
const BUNDLE = join(ROOT, "apps/server/dist/server/server.js");
/** Where `bun run dev` starts the web process: the dev server reads its config there. */
const SERVER = join(ROOT, "apps/server");

/** Chromium sends every `*.localhost` name to this machine, so the admin needs no DNS. */
const ADMIN_HOST = "admin.localhost";

/** The domain Sites' Staging addresses sit under: a Site with the slug `bakery` is `bakery.sites.localhost`. */
const SITES_DOMAIN = "sites.localhost";
/** The domain `goLive` puts Sites on: names under `.localhost` reach this machine in a browser. */
const LIVE_DOMAIN = "live.localhost";

export type Theme = "light" | "dark";

const PAGE_ERRORS = new WeakMap<Page, string[]>();

/** What the page reported as errors (uncaught exceptions, console errors) since it opened. */
export function pageErrors(page: Page): readonly string[] {
	return PAGE_ERRORS.get(page) ?? [];
}

/**
 * Forgets the errors the page reported from the `from`-th on that `isNoise` picks out: reports
 * caused by a check itself rather than by the page.
 */
export function forgetPageErrors(page: Page, from: number, isNoise: (error: string) => boolean): void {
	const errors = PAGE_ERRORS.get(page);
	if (!errors) return;
	const kept = errors.slice(from).filter((error) => !isNoise(error));
	errors.splice(from, errors.length - from, ...kept);
}

export const THEMES: readonly Theme[] = ["light", "dark"];

export type BrowserInstall = {
	/**
	 * The test Install the web process serves, in this process: its Management API browsers, job
	 * drain, fake mailer and clock (the web process itself sends with the real Mailer).
	 */
	install: TestInstall;
	/** A URL on the admin, such as `adminUrl("/setup")`. */
	adminUrl(path: string): string;
	/**
	 * A URL on a Site's Staging address, such as `siteUrl("bakery", "/blog/fresh-bread")`: it shows the
	 * Site with its Drafts to the people reviewing it (Edit mode opens there too, while the Site has
	 * no domain).
	 */
	siteUrl(siteSlug: string, path: string): string;
	/**
	 * Puts a Site live on its Primary domain, `<slug>.live.localhost` (a browser finds names under
	 * `.localhost` on this machine), verified by the Install, where visitors see what is published.
	 */
	goLive(siteId: string): Promise<void>;
	/** A URL on the Primary domain `goLive` gave a Site, such as `liveUrl("bakery", "/blog/fresh-bread")`. */
	liveUrl(siteSlug: string, path: string): string;
	/**
	 * A person's browser with no page, on the web process's own admin: for what only the web process
	 * answers with its own addresses (`editMode.open`'s link), where `install` would give the test
	 * Install's. It isn't signed in (`api.session.signIn`).
	 */
	webBrowser(): TestBrowser;
	/** The setup token the web process printed in its log when it started. */
	setupToken(): string;
	/** Creates the Superadmin without the wizard (as `webcraft admin create-superadmin` does). */
	createSuperadmin(account?: Partial<TestAccount>): Promise<TestAccount>;
	/**
	 * A new page in a fresh browser (no cookies), with the device set to light or dark. The admin
	 * follows the device until a person chooses, so this is how both themes are checked. With
	 * `javaScript: false`, the browser runs no page script, as a visitor's browser with it switched off.
	 * With `touch: true`, the device has a touch screen (taps arrive as touch then click).
	 */
	newPage(theme: Theme, options?: { javaScript?: boolean; touch?: boolean }): Promise<Page>;
	/**
	 * Signs in and waits for the admin to open. The first time for an account it goes through the
	 * sign-in page; after that the page gets the same session, as a browser that stayed signed in
	 * would (the web process limits sign-ins per address, and every page here comes from this machine).
	 */
	signIn(page: Page, account: Pick<TestAccount, "email" | "password">): Promise<void>;
	/**
	 * Signs the page in with a session whose last identity check is `minutesAgo` old, so the next
	 * Sensitive action asks "Confirm it's you". The web process runs on the real clock, so the test
	 * Install makes the session with its own clock set back, and the page gets its cookie.
	 */
	signInWithOldIdentityCheck(
		page: Page,
		account: Pick<TestAccount, "email" | "password">,
		minutesAgo: number,
	): Promise<void>;
	/** Stops the web process and the browser, and drops the database. */
	close(): Promise<void>;
};

/**
 * Starts an Install with no Superadmin, served by the production web process, and a browser. With
 * `devServer`, the web process is the dev server instead, started as `bun run dev` starts it: for the
 * one check of what only differs there (`dev-server.browser.ts`). It needs no build, loads this
 * build's own Modules, and its admin is slow to open in a browser (nothing is bundled), so that check
 * signs in with `webBrowser()`.
 */
export async function startBrowserInstall(
	options: { backForwardCache?: boolean; devServer?: boolean } = {},
): Promise<BrowserInstall> {
	if (!options.devServer && !existsSync(BUNDLE)) {
		throw new Error("The browser tests run the production web process: run `bun run build` first.");
	}
	// The web process runs on the real clock, so the data prepared in the test process (invites
	// that expire, sessions) is made at the real time too.
	const install = await createTestInstall({ now: new Date(), modules: options.devServer ? undefined : TEST_MODULES });
	const port = await freePort();
	const origin = `http://${ADMIN_HOST}:${port}`;
	const logs: Record<string, unknown>[] = [];
	let web: Subprocess | undefined;
	let browser: Browser | undefined;
	const contexts: BrowserContext[] = [];
	const signedIn = new Map<string, Cookie[]>();

	const close = async () => {
		await Promise.all(contexts.map((context) => context.close().catch(() => {})));
		await browser?.close();
		web?.kill();
		await web?.exited;
		await install.close();
	};

	try {
		web = options.devServer ? startDevWeb(install, port, logs) : startWeb(install, port, logs);
		// The dev server reads the whole web process's code as its first request arrives.
		if (options.devServer) await waitUntilReady(origin, web, logs, { tries: 1200, hint: "the dev server, `vite dev`" });
		else await waitUntilReady(origin, web, logs, { tries: 100, hint: BUILD_HINT });
		// Playwright disables the cache by default; real Back/Forward restoration needs full Chromium.
		browser = await chromium.launch(
			options.backForwardCache ? { channel: "chromium", ignoreDefaultArgs: ["--disable-back-forward-cache"] } : {},
		);
	} catch (error) {
		await close();
		throw error;
	}
	const started = browser;

	return {
		install,
		adminUrl: (path) => new URL(path, origin).toString(),
		siteUrl: (siteSlug, path) => new URL(path, `http://${siteSlug}.${SITES_DOMAIN}:${port}`).toString(),
		async goLive(siteId) {
			await goLive(install, siteId, LIVE_DOMAIN);
		},
		liveUrl: (siteSlug, path) => new URL(path, `http://${siteSlug}.${LIVE_DOMAIN}:${port}`).toString(),
		webBrowser: () =>
			createTestBrowser({
				adminOrigin: origin,
				// Only a browser finds names under `.localhost` on this machine: the request goes to the
				// loopback address, naming the host it is for.
				async send(request) {
					const url = new URL(request.url);
					const headers = new Headers(request.headers);
					headers.set("host", url.host);
					const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer();
					return fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
						method: request.method,
						headers,
						body,
						redirect: "manual",
					});
				},
				async upgrade() {
					throw new Error("A browser with no page opens no socket: open a page for that.");
				},
			}),
		setupToken() {
			const token = logs.findLast((entry) => typeof entry.setupToken === "string")?.setupToken;
			if (typeof token !== "string") throw new Error("The web process printed no setup token.");
			return token;
		},
		createSuperadmin: (account) => install.createSuperadmin(account),
		async newPage(theme, options = {}) {
			// Reduced motion: colour transitions finish at once, so checks never see a half-changed colour.
			const context = await started.newContext({
				colorScheme: theme,
				reducedMotion: "reduce",
				viewport: { width: 1280, height: 900 },
				javaScriptEnabled: options.javaScript ?? true,
				hasTouch: options.touch ?? false,
			});
			contexts.push(context);
			const page = await context.newPage();
			const errors: string[] = [];
			page.on("pageerror", (error) => errors.push(String(error)));
			page.on("console", (message) => {
				if (message.type() !== "error") return;
				// A page's own status (such as the 404 of "Page not found") is not an error of the page, and
				// neither is a refusal from the Management API, which the page shows to the person.
				const url = message.location().url;
				const path = new URL(url, page.url()).pathname;
				if (url === page.url() || path.startsWith("/api/rpc/")) return;
				// Full Chromium asks for this optional file even when the Site declares no icon.
				if (path === "/favicon.ico" && message.text().includes("404 (Not Found)")) return;
				errors.push(message.text());
			});
			PAGE_ERRORS.set(page, errors);
			return page;
		},
		async signIn(page, { email, password }) {
			const cookies = signedIn.get(email);
			if (cookies) {
				await page.context().addCookies(cookies);
				await page.goto(new URL("/", origin).toString());
				await page.waitForLoadState("networkidle");
				return;
			}
			await page.goto(new URL("/sign-in", origin).toString());
			await page.locator("#sign-in-email").fill(email);
			await page.locator("#sign-in-password").fill(password);
			await page.locator("form button[type=submit]").click();
			await page.waitForURL((url) => url.pathname !== "/sign-in");
			await page.waitForLoadState("networkidle");
			signedIn.set(email, await page.context().cookies());
		},
		async signInWithOldIdentityCheck(page, account, minutesAgo) {
			const now = install.clock.now();
			await install.clock.set(new Date(Date.now() - minutesAgo * 60_000));
			const local = await install.signIn(account);
			await install.clock.set(now);
			// The test Install's admin is on https, so its cookie carries the `__Secure-` prefix; the
			// web process here is on plain http, where the same signed value goes without it.
			const value = local.cookies.get("__Secure-webcraft.session_token");
			if (!value) throw new Error("The test Install's sign-in set no session cookie.");
			await page
				.context()
				.addCookies([
					{ name: "webcraft.session_token", value, domain: ADMIN_HOST, path: "/", httpOnly: true, sameSite: "Lax" },
				]);
			await page.goto(new URL("/", origin).toString());
			await page.waitForLoadState("networkidle");
		},
		close,
	};
}

function startWeb(install: TestInstall, port: number, logs: Record<string, unknown>[]): Subprocess {
	// Bun loads `.env` from the directory it starts in; an empty one keeps the developer's out.
	return spawnWeb(["bun", WEB], mkdtempSync(join(tmpdir(), "webcraft-browser-")), install, port, logs);
}

/**
 * The web process as `bun run dev` starts it (`scripts/dev.ts`): `vite dev` on Bun, in the server's own
 * folder (the repo's `.env` is one above it, so Bun doesn't load it). Vite listens on `localhost`,
 * which may be the IPv6 loopback alone; the checks here ask the IPv4 one.
 */
function startDevWeb(install: TestInstall, port: number, logs: Record<string, unknown>[]): Subprocess {
	return spawnWeb(["bun", "--bun", "vite", "dev", "--host", "127.0.0.1"], SERVER, install, port, logs);
}

function spawnWeb(
	command: string[],
	cwd: string,
	install: TestInstall,
	port: number,
	logs: Record<string, unknown>[],
): Subprocess {
	const web = Bun.spawn(command, {
		cwd,
		env: {
			PATH: process.env.PATH ?? "",
			DATABASE_URL: install.databaseUrl,
			WEBCRAFT_ADMIN_HOST: ADMIN_HOST,
			WEBCRAFT_SITES_DOMAIN: SITES_DOMAIN,
			// The addresses Site domains point at, as the Domains screen shows them (the test Install's own).
			WEBCRAFT_PUBLIC_ADDRESSES: TEST_INSTALL_ADDRESSES.join(","),
			WEBCRAFT_SECRET_KEY: TEST_MASTER_KEY,
			// The test Install's own storage folder, where its Media files are.
			WEBCRAFT_STORAGE_DIR: install.storageDir,
			PORT: String(port),
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	void collectLines(web.stdout, logs);
	void collectLines(web.stderr, logs);
	return web;
}

async function collectLines(stream: ReadableStream<Uint8Array>, logs: Record<string, unknown>[]): Promise<void> {
	let buffered = "";
	const decoder = new TextDecoder();
	for await (const bytes of stream) {
		buffered += decoder.decode(bytes, { stream: true });
		const lines = buffered.split("\n");
		buffered = lines.pop() ?? "";
		for (const line of lines) {
			try {
				logs.push(JSON.parse(line));
			} catch {
				logs.push({ msg: line });
			}
		}
	}
}

/** What to try when the production web process doesn't start. */
const BUILD_HINT =
	"if the code changed since the last `bun run build`, build again: these tests serve the built bundle";

async function waitUntilReady(
	origin: string,
	web: Subprocess,
	logs: Record<string, unknown>[],
	{ tries, hint }: { tries: number; hint: string },
): Promise<void> {
	for (let attempt = 0; attempt < tries; attempt++) {
		if (web.exitCode !== null) break;
		try {
			const { host, port } = new URL(origin);
			const response = await fetch(`http://127.0.0.1:${port}/readyz`, { headers: { host } });
			if (response.ok && logs.some((entry) => typeof entry.setupToken === "string")) return;
		} catch {
			// Not listening yet.
		}
		await Bun.sleep(100);
	}
	throw new Error(`The web process didn't start (${hint}):\n${logs.map((entry) => JSON.stringify(entry)).join("\n")}`);
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject()));
		});
	});
}
