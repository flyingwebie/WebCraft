// Site › Redirects in a real browser: the Redirect rules (a person's and one added when a slug
// changed) and the 404 log (and its ignored paths), the rule dialog and a row's menu from the
// keyboard, Add redirect from the log starting at the target, and a refused target said beside its
// field, in light and dark.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type redirects from "@webcraft/module-redirects";

import type { TestAccount } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let editor: TestAccount;
let siteId: string;

const BROWSER =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36";

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const local = install.install;
	const admin = await local.superadmin();
	await admin.api.modules.approve({ moduleId: "redirects", version: "1.0.0" });
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	// Visitors are on the Site's domain; its Staging address is for the people reviewing it.
	await install.goLive(siteId);
	await admin.api.languages.add({ siteId, code: "fr" });
	const member = await local.createMember({ workspaceId, role: "editor", name: "Giulia Romano" });
	editor = member.account;
	const rules = moduleApi<typeof redirects>(member.browser, "redirects").rules;
	await rules.add({ siteId, from: "/summer-offers", to: "/offers", status: 302 });
	await rules.add({ siteId, from: "/old-shop/*", to: "https://shop.acme.example/*", status: 301 });
	// A Page whose slug changed: its old path gets a rule by itself.
	const pagesId = (await admin.api.postTypes.list({ siteId })).postTypes.find((each) => each.builtIn === "page")?.id;
	const { entry } = await admin.api.entries.create({ siteId, postTypeId: pagesId ?? "", title: "Opening hours" });
	await admin.api.entries.publish({ siteId, entryId: entry.id });
	await admin.api.entries.saveDraft({ siteId, entryId: entry.id, slug: "hours" });
	await admin.api.entries.publish({ siteId, entryId: entry.id });
	// Visitors miss a few paths, one linked from another site, and a robots file people ignored.
	const visit = (path: string, referer?: string) =>
		local.request(
			new Request(install.liveUrl("bakery", path), {
				headers: { "user-agent": BROWSER, ...(referer ? { referer } : {}) },
			}),
		);
	for (const theme of THEMES) {
		for (let count = 0; count < 3; count++) {
			await visit(`/wedding-cakes-${theme}`, "https://news.example.org/best-bakeries");
		}
	}
	await visit("/fr/gateaux");
	await visit("/apple-touch-icon-precomposed");
	expect((await local.drainJobs()).failed).toEqual([]);
	const { misses } = await moduleApi<typeof redirects>(member.browser, "redirects").notFound.list({ siteId });
	const icon = misses.find((miss) => miss.path === "/apple-touch-icon-precomposed");
	await moduleApi<typeof redirects>(member.browser, "redirects").notFound.ignore({ siteId, missId: icon?.id ?? "" });
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Site › Redirects, ${theme}`, () => {
		const open = async (search = "") => {
			const page = await install.newPage(theme);
			await install.signIn(page, editor);
			await page.goto(install.adminUrl(`/sites/${siteId}/m/redirects/redirects${search}`));
			await page.waitForLoadState("networkidle");
			return page;
		};

		test("the Redirect rules, one added when a published path changed", async () => {
			const page = await open();
			await page.getByRole("heading", { name: "Redirect rules" }).waitFor();
			await page.getByText("/opening-hours").waitFor();
			await page.getByText("Added when a published path changed").waitFor();
			expect(await page.title()).toContain("Redirects");

			await expectAccessibleScreen(page, `Redirects › rules (${theme})`);
		});

		test("the 404 log, and its ignored paths", async () => {
			const page = await open("?tab=log");
			await page.getByRole("heading", { name: "404 log" }).waitFor();
			await page.getByText("news.example.org").first().waitFor();
			await expectAccessibleScreen(page, `Redirects › 404 log (${theme})`);

			await page.getByRole("button", { name: "Ignored paths (1)" }).click();
			await page.getByRole("heading", { name: "Ignored paths" }).waitFor();
			await expectAccessibleScreen(page, `Redirects › ignored paths (${theme})`);
		});

		test("adding a rule, from the keyboard", async () => {
			const page = await open();
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Add rule" }),
				"dialog",
				`Redirects › Add a rule (${theme})`,
			);
		});

		test("a rule's menu opens and closes from the keyboard", async () => {
			const page = await open();
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Actions for the rule from /summer-offers" }),
				"menu",
				`Redirects › a rule's menu (${theme})`,
			);
		});

		test("Add redirect from the 404 log starts at the target, and a refused one is said beside its field", async () => {
			const page = await open("?tab=log");
			await page.getByRole("button", { name: `Add redirect for /wedding-cakes-${theme}` }).click();
			const dialog = page.getByRole("dialog");
			expect(await dialog.getByLabel("From").inputValue()).toBe(`/wedding-cakes-${theme}`);
			expect(await dialog.getByLabel("To").evaluate((field) => field === document.activeElement)).toBe(true);

			await page.keyboard.type("javascript:alert(1)");
			await page.keyboard.press("Enter");
			await dialog.getByText("An address on another site must start with https://").waitFor();
			await expectNoAxeViolations(page, `Redirects › a refused target (${theme})`, ["region"]);

			await dialog.getByLabel("To").fill(`/cakes/${theme}`);
			await page.keyboard.press("Enter");
			await dialog.waitFor({ state: "hidden" });
			await page.getByRole("tab", { name: /Redirect rules/ }).click();
			await page.getByRole("cell", { name: `/cakes/${theme}` }).waitFor();
		});
	});
}
