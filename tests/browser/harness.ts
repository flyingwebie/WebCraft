// Seam 2: a real browser on the real admin. Each browser Install is a test Install (its own
// database, see ../harness) served by the production web process (`bun run build` first), with
// Chromium driven through Playwright.
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { type Browser, type BrowserContext, type Cookie, chromium, type Page } from "playwright";

import { createTestInstall, TEST_MASTER_KEY, type TestAccount, type TestInstall } from "../harness/index.ts";
import { TEST_MODULES } from "../harness/modules.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
/** The production web process, started with the test suite's Modules (see web.ts). */
const WEB = join(ROOT, "tests/browser/web.ts");
const BUNDLE = join(ROOT, "apps/server/dist/server/server.js");

/** Chromium sends every `*.localhost` name to this machine, so the admin needs no DNS. */
const ADMIN_HOST = "admin.localhost";

/** The domain Sites' Staging addresses sit under: a Site with the slug `bakery` is `bakery.sites.localhost`. */
const SITES_DOMAIN = "sites.localhost";

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
	/** A URL on a Site's Staging address, such as `siteUrl("bakery", "/blog/fresh-bread")`. */
	siteUrl(siteSlug: string, path: string): string;
	/** The setup token the web process printed in its log when it started. */
	setupToken(): string;
	/** Creates the Superadmin without the wizard (as `webcraft admin create-superadmin` does). */
	createSuperadmin(account?: Partial<TestAccount>): Promise<TestAccount>;
	/**
	 * A new page in a fresh browser (no cookies), with the device set to light or dark. The admin
	 * follows the device until a person chooses, so this is how both themes are checked.
	 */
	newPage(theme: Theme): Promise<Page>;
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

/** Starts an Install with no Superadmin, served by the production web process, and a browser. */
export async function startBrowserInstall(): Promise<BrowserInstall> {
	if (!existsSync(BUNDLE)) {
		throw new Error("The browser tests run the production web process: run `bun run build` first.");
	}
	// The web process runs on the real clock, so the data prepared in the test process (invites
	// that expire, sessions) is made at the real time too.
	const install = await createTestInstall({ now: new Date(), modules: TEST_MODULES });
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
		web = startWeb(install, port, logs);
		await waitUntilReady(origin, web, logs);
		browser = await chromium.launch();
	} catch (error) {
		await close();
		throw error;
	}
	const started = browser;

	return {
		install,
		adminUrl: (path) => new URL(path, origin).toString(),
		siteUrl: (siteSlug, path) => new URL(path, `http://${siteSlug}.${SITES_DOMAIN}:${port}`).toString(),
		setupToken() {
			const token = logs.findLast((entry) => typeof entry.setupToken === "string")?.setupToken;
			if (typeof token !== "string") throw new Error("The web process printed no setup token.");
			return token;
		},
		createSuperadmin: (account) => install.createSuperadmin(account),
		async newPage(theme) {
			// Reduced motion: colour transitions finish at once, so checks never see a half-changed colour.
			const context = await started.newContext({
				colorScheme: theme,
				reducedMotion: "reduce",
				viewport: { width: 1280, height: 900 },
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
				if (url === page.url() || new URL(url, page.url()).pathname.startsWith("/api/rpc/")) return;
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
	const web = Bun.spawn(["bun", WEB], {
		// Bun loads `.env` from the directory it starts in; an empty one keeps the developer's out.
		cwd: mkdtempSync(join(tmpdir(), "webcraft-browser-")),
		env: {
			PATH: process.env.PATH ?? "",
			DATABASE_URL: install.databaseUrl,
			WEBCRAFT_ADMIN_HOST: ADMIN_HOST,
			WEBCRAFT_SITES_DOMAIN: SITES_DOMAIN,
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

async function waitUntilReady(origin: string, web: Subprocess, logs: Record<string, unknown>[]): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt++) {
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
	throw new Error(
		`The web process didn't start (if the code changed since the last \`bun run build\`, build again: these tests serve the built bundle):\n${logs.map((entry) => JSON.stringify(entry)).join("\n")}`,
	);
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
