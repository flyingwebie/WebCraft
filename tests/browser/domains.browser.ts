// Site › Domains & Staging in a real browser: a Site with a live Primary domain, a live and a waiting
// Redirect domain (with its DNS records, for each place an Install runs) and a language's domain;
// its menus and dialogs, used from the keyboard, in light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let siteId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await api.languages.add({ siteId, code: "fr", domain: "acmebakery.fr" });
	await api.domains.add({ siteId, name: "acmebakery.ie", withPartner: true });
	await api.domains.add({ siteId, name: "acmebakery.com" });
	// The worker verifies the domains that point at the Install; acmebakery.com still waits for DNS.
	for (const name of ["acmebakery.ie", "www.acmebakery.ie", "acmebakery.fr"]) local.connectDomain(name);
	await local.clock.advance(60_000);
	expect((await local.drainJobs()).failed).toEqual([]);
	// A CDN in front of the Site, its secret not made yet.
	await api.domains.setCdn({ siteId, cdn: "cloudflare" });
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Site › Domains & Staging, ${theme}`, () => {
		const open = async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/sites/${siteId}/domains`));
			await page.waitForLoadState("networkidle");
			return page;
		};

		test("the Primary, Redirect and language domains, a domain waiting for DNS and the Staging address", async () => {
			const page = await open();
			await page.getByText("Waiting for DNS").first().waitFor();

			await expectAccessibleScreen(page, `Domains & Staging (${theme})`);
		});

		test("the DNS records for each place an Install runs, chosen with the arrow keys", async () => {
			const page = await open();
			await page.getByRole("tab", { name: "VPS (Caddy)" }).first().focus();
			await page.keyboard.press("ArrowRight");
			await page.getByRole("tab", { name: "Coolify", selected: true }).first().waitFor();
			await page.keyboard.press("ArrowRight");
			await page.getByRole("tab", { name: "Railway", selected: true }).first().waitFor();

			await expectAccessibleScreen(page, `Domains & Staging, Railway's steps (${theme})`);
		});

		test("a Redirect domain's menu opens and closes from the keyboard", async () => {
			const page = await open();
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Actions for www.acmebakery.ie" }),
				"menu",
				`Domains › a Redirect domain's menu (${theme})`,
			);
		});

		test("changing the Primary domain lists the verified Redirect domains", async () => {
			const page = await open();
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Change", exact: true }),
				"dialog",
				`Domains › Change the Primary domain (${theme})`,
			);
		});

		test("the Site's CDN secret is made from the keyboard and shown once, with the header to send it in", async () => {
			const page = await open();
			const make = page.getByRole("button", { name: /^Make (the|a new) CDN secret$/ });
			await make.focus();
			await page.keyboard.press("Enter");
			await page.getByText(/^X-CDN-Secret: [A-Za-z0-9_-]{43}$/).waitFor();
			await page.getByText("This Site has a CDN secret.").waitFor();

			await expectAccessibleScreen(page, `Domains & Staging, the CDN secret shown (${theme})`);
			// Shown only then: the screen opened again says only that there is one.
			await page.reload();
			await page.getByRole("button", { name: "Make a new CDN secret" }).waitFor();
			expect(await page.getByText(/X-CDN-Secret:/).count()).toBe(0);
		});

		test("removing a domain shows what stops before it is confirmed", async () => {
			const page = await open();
			await page.getByRole("button", { name: "Actions for acmebakery.com" }).click();
			await page.getByRole("menuitem", { name: "Remove" }).click();
			const dialog = page.getByRole("dialog");
			await dialog.getByRole("button", { name: "Check what changes" }).click();
			await dialog.getByText("isn't verified yet").waitFor();
			await expectNoAxeViolations(page, `Domains › Remove (${theme})`, ["region"]);
			await page.keyboard.press("Escape");
		});
	});
}
