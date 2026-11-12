// The admin's pages under their Content Security Policy, in a real browser on the production build
// (audit A3-2). What seam 1 can't see (it has no admin app): a page's policy takes scripts from the
// admin host's files and the page's own nonce only, the built admin runs under it without a single
// refusal, an injected inline handler doesn't run, another site can't frame the admin, and built files
// carry the headers too. This Install is on plain HTTP (`admin.localhost`), where no
// Strict-Transport-Security goes out.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import { expectAdminHeaders, expectInertAnswer } from "../harness/admin-safety.ts";
import type { TestAccount } from "../harness/index.ts";
import { type BrowserInstall, pageErrors, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Ada Staff" })).account;
});

afterAll(async () => {
	await install?.close();
});

/** The nonce a policy allows inline scripts by. */
function nonceOf(sources: readonly string[]): string {
	const source = sources.find((each) => each.startsWith("'nonce-")) ?? "";
	return source.slice("'nonce-".length, -1);
}

/** Collects what the page's policy refused, as the browser reports it. */
async function watchRefusals(page: Page): Promise<() => Promise<string[]>> {
	await page.addInitScript(() => {
		const seen: string[] = [];
		(window as { refused?: string[] }).refused = seen;
		document.addEventListener("securitypolicyviolation", (event) => {
			seen.push(`${event.effectiveDirective} ${event.blockedURI}`);
		});
	});
	return () => page.evaluate(() => (window as { refused?: string[] }).refused ?? []);
}

describe("an admin page", () => {
	test("is answered with a policy that takes scripts only from the admin's files and the page's own nonce", async () => {
		const response = await fetch(install.adminUrl("/sign-in"));
		expect(response.status).toBe(200);
		const policy = expectAdminHeaders(response, { https: false });
		expect(policy.get("default-src")).toEqual(["'self'"]);
		const scripts = policy.get("script-src") ?? [];
		expect(scripts).toHaveLength(2);
		expect(scripts[0]).toBe("'self'");
		const nonce = nonceOf(scripts);
		expect(nonce.length).toBeGreaterThanOrEqual(22);
		expect(policy.get("object-src")).toEqual(["'none'"]);
		expect(policy.get("base-uri")).toEqual(["'none'"]);
		expect(policy.get("form-action")).toEqual(["'self'"]);
		expect(policy.get("frame-ancestors")).toEqual(["'none'"]);
		expect(policy.get("frame-src")).toEqual(["'self'"]);
		expect(response.headers.get("x-frame-options")).toBe("DENY");

		// Every script the page is written with carries that nonce, and no element an inline handler.
		const html = await response.text();
		const tags = html.match(/<script\b[^>]*>/g) ?? [];
		expect(tags.length).toBeGreaterThan(0);
		for (const tag of tags) expect(tag).toContain(`nonce="${nonce}"`);
		expect(html).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);

		// The nonce is the answer's own: the next one has another.
		const again = await fetch(install.adminUrl("/sign-in"));
		expect(nonceOf(expectAdminHeaders(again, { https: false }).get("script-src") ?? [])).not.toBe(nonce);
	});

	test("its built files carry the headers too, and load nothing themselves", async () => {
		const html = await (await fetch(install.adminUrl("/sign-in"))).text();
		const file = /(?:src|href)="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
		if (!file) throw new Error("The page names no built script.");
		const response = await fetch(install.adminUrl(file));
		expect(response.status).toBe(200);
		expectInertAnswer(response, { https: false });
	});

	test("runs under its policy without a refusal, signed out and signed in", async () => {
		const page = await install.newPage("light");
		const refusals = await watchRefusals(page);
		await page.goto(install.adminUrl("/sign-in"));
		await page.locator("#sign-in-email").waitFor();
		expect(await refusals()).toEqual([]);

		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("heading", { name: "Acme Bakery" }).first().waitFor();
		await page.waitForLoadState("networkidle");
		expect(await refusals()).toEqual([]);
		expect(pageErrors(page)).toEqual([]);
		await page.close();
	});

	test("runs no inline handler and no script from elsewhere put into it", async () => {
		const page = await install.newPage("light");
		const refusals = await watchRefusals(page);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.waitForLoadState("networkidle");

		await page.evaluate(() => {
			const holder = document.createElement("div");
			holder.innerHTML = '<img src="/nothing-here.png" onerror="window.pwned = 1">';
			document.body.append(holder);
			const script = document.createElement("script");
			script.src = "https://elsewhere.example/script.js";
			document.body.append(script);
		});
		await page.waitForFunction(() => ((window as { refused?: string[] }).refused ?? []).length >= 2);
		expect(await page.evaluate(() => (window as { pwned?: number }).pwned ?? null)).toBeNull();
		expect((await refusals()).sort()).toEqual([
			"script-src-attr inline",
			"script-src-elem https://elsewhere.example/script.js",
		]);
		await page.close();
	});
});

describe("the sign-in page's way back", () => {
	test("goes only to a path of the admin, never to an address a browser reads as another host", async () => {
		const page = await install.newPage("light");
		await install.signIn(page, staff);
		// A browser drops a tab from an address: `/<tab>/elsewhere.example` reads as `//elsewhere.example`.
		for (const redirect of [
			"/%09/elsewhere.example",
			"/%0A/elsewhere.example",
			"/%5Celsewhere.example",
			"//elsewhere.example",
		]) {
			const response = await page.goto(install.adminUrl(`/sign-in?redirect=${redirect}`));
			await page.waitForLoadState("networkidle");
			const at = new URL(page.url());
			expect({ redirect, status: response?.status(), at: `${at.host}${at.pathname}` }).toEqual({
				redirect,
				status: 200,
				at: `${new URL(install.adminUrl("/")).host}/`,
			});
		}
		// A path of the admin's own still works, its query kept.
		await page.goto(install.adminUrl(`/sign-in?redirect=${encodeURIComponent(`/sites/${siteId}?tab=pages`)}`));
		await page.waitForLoadState("networkidle");
		expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe(`/sites/${siteId}?tab=pages`);
		expect(pageErrors(page)).toEqual([]);
		await page.close();
	});
});

describe("another site's page", () => {
	test("can't show the admin in a frame", async () => {
		const page = await install.newPage("light");
		await install.signIn(page, staff);
		// A page on a sibling hostname of the admin's, where a Site's Staging address would be.
		const framing = install.siteUrl("framing", "/frame");
		await page.route(framing, (route) =>
			route.fulfill({
				contentType: "text/html",
				body: `<!doctype html><title>Framing</title><iframe src="${install.adminUrl("/")}"></iframe>`,
			}),
		);
		await page.goto(framing);
		const frame = page.frames().find((each) => each !== page.mainFrame());
		if (!frame) throw new Error("The page holds no frame.");
		await page.waitForLoadState("networkidle");
		// The browser shows its own refusal in the frame, never the admin.
		expect(frame.url().startsWith(install.adminUrl("/"))).toBe(false);
		expect(await page.frameLocator("iframe").getByRole("navigation").count()).toBe(0);
		await page.close();
	});
});
