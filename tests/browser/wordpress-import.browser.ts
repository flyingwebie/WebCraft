// The WordPress import in a browser, in light and dark: the Source step with the export file uploaded
// in parts and read by the worker, the Map step (mapping variant B: the types, each key's card and the
// live sample Entry) and the Preview (real Entries with their Blocks and Import leftovers), driven
// from the keyboard; and a WordPress run's Import report with its leftovers and Redirect rules tabs.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";
import { photo } from "../harness/images.ts";
import type { TestAccount } from "../harness/index.ts";
import { OLD_MILL, runImport, serveOldSite, surveyedExport } from "../imports/wordpress.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";
import { liveWordpressReply } from "./live-wordpress.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let importId: string;
let runId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	await install.createSuperadmin();
	const { api: admin } = await install.install.superadmin();
	await admin.modules.approve({ moduleId: "wordpress-import", version: "1.1.0" });
	await admin.modules.approve({ moduleId: "redirects", version: "1.1.0" });
	const workspaceId = (await install.install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.install.createSite(workspaceId, { name: "Old Mill", slug: "old-mill" })).id;
	const member = await install.install.createStaff({ workspaces: [workspaceId] });
	staff = member.account;
	serveOldSite(install.install, {
		"https://oldmill.example/wp-content/uploads/2024/03/loaf.jpg": await photo({ width: 320, height: 240 }),
		"https://oldmill.example/wp-content/uploads/2023/11/oven.png": await photo({
			width: 200,
			height: 150,
			format: "png",
		}),
	});
	// A run that ended, with Import leftovers and Redirect rules, for its report.
	const file = await surveyedExport(install.install, member.browser.api, siteId);
	const done = await runImport(
		install.install,
		member.browser.api,
		siteId,
		file.id,
		file.suggested ?? { language: null, types: [] },
	);
	importId = done.importId;
	runId = done.run.id;
});

afterAll(async () => {
	await install.close();
});

async function open(page: Page, account: TestAccount, path: string) {
	await install.signIn(page, account);
	await page.goto(install.adminUrl(path));
	await page.waitForLoadState("networkidle");
}

async function press(page: Page, name: string) {
	const button = page.getByRole("button", { name, exact: true });
	await button.focus();
	await page.keyboard.press("Enter");
}

/**
 * Lets the worker run what the page queued (the survey, the preview), until the page shows `text`.
 * The web process queues on the real clock, so the test Install's clock catches up first.
 */
async function drainUntil(page: Page, text: string | RegExp) {
	for (let attempt = 0; attempt < 40; attempt++) {
		await install.install.clock.set(new Date());
		await install.install.drainJobs();
		if (await page.getByText(text).first().isVisible()) return;
		await page.waitForTimeout(250);
	}
	await page.getByText(text).first().waitFor();
}

for (const theme of THEMES) {
	describe(`The WordPress import, ${theme}`, () => {
		test("Source, Map with the live sample Entry, and Preview, from the keyboard", async () => {
			const page = await install.newPage(theme);
			await open(page, staff, `/sites/${siteId}/imports/new?source=wordpress-import.export`);
			await page.getByRole("heading", { name: "WordPress export file" }).waitFor();
			await expectAccessibleScreen(page, `WordPress import, Source (${theme})`);

			await page.getByLabel("Export file", { exact: true }).setInputFiles({
				name: "oldmill.xml",
				mimeType: "text/xml",
				buffer: Buffer.from(OLD_MILL),
			});
			await drainUntil(page, "oldmill.xml was read");
			await expectAccessibleScreen(page, `WordPress import, Source read (${theme})`);

			await press(page, "Continue to mapping");
			await page.getByRole("heading", { name: "Sample Entry" }).waitFor();
			// The first type in the file: the categories, with the first of them as the sample.
			await page.getByText("News", { exact: true }).first().waitFor();
			await expectAccessibleScreen(page, `WordPress import, Map (${theme})`);

			// The posts, and their next sample, from the keyboard.
			const posts = page.getByRole("button", { name: /^Posts · 3/ });
			await posts.focus();
			await page.keyboard.press("Enter");
			await page.getByText("Spring opening hours", { exact: true }).first().waitFor();
			await press(page, "Next sample");
			await page.getByText("Rye week", { exact: true }).first().waitFor();
			await expectNoAxeViolations(page, `WordPress import, Map of the posts (${theme})`);

			await press(page, "Preview");
			await drainUntil(page, /Entries as Drafts/);
			await expectAccessibleScreen(page, `WordPress import, Preview (${theme})`);
			const postsTab = page.getByRole("tab", { name: "Posts", exact: true });
			await postsTab.focus();
			await page.keyboard.press("Enter");
			const rye = page.getByRole("button", { name: /^Rye week/ });
			await rye.focus();
			await page.keyboard.press("Enter");
			await page.getByText("Import leftover: markup no Block reads", { exact: false }).waitFor();
			await expectNoAxeViolations(page, `WordPress import, Preview of an Entry (${theme})`);
		});

		test("a WordPress run's Import report, its leftovers and Redirect rules", async () => {
			const page = await install.newPage(theme);
			await open(page, staff, `/sites/${siteId}/imports/${importId}/runs/${runId}`);
			await page.getByRole("tab", { name: "Import leftovers (4)" }).waitFor();
			await expectAccessibleScreen(page, `WordPress import report (${theme})`);

			const rules = page.getByRole("tab", { name: "Redirect rules (5)" });
			await rules.focus();
			await page.keyboard.press("Enter");
			await page.getByText("/2024/03/spring-opening-hours").first().waitFor();
			await expectNoAxeViolations(page, `WordPress import report, Redirect rules (${theme})`);
		});
	});
}

for (const theme of THEMES) {
	test(`Plain-permalink live source shows decoded titles through Map, Preview and Run, ${theme}`, async () => {
		const workspace = await install.install.createWorkspace(`Plain source ${theme}`);
		const site = await install.install.createSite(workspace.id);
		const member = await install.install.createStaff({ workspaces: [workspace.id] });
		install.install.dns.answer("live-browser.example", ["93.184.216.80"]);
		for (const method of ["GET", "HEAD"])
			install.install.http.respond(method, /^https:\/\/live-browser.example\/review\//, (request) =>
				liveWordpressReply(new URL(request.url), request.method),
			);
		const page = await install.newPage(theme);
		try {
			await open(page, member.account, `/sites/${site.id}/imports/new?source=wordpress-import.live`);
			await page.getByLabel("Import name", { exact: true }).fill("Plain source");
			await page.getByLabel("Site address", { exact: true }).fill("https://live-browser.example/review/");
			await page.getByLabel("Username", { exact: true }).fill("editor");
			await page.getByLabel("Application password", { exact: true }).fill("plain-source-login");
			await press(page, "Test connection");
			await page.getByText("Connected · Role: editor", { exact: true }).waitFor();
			await drainUntil(page, "live-browser.example was read");
			await press(page, "Continue to mapping");
			await page.getByRole("heading", { name: "Sample Entry" }).waitFor();
			await page.getByText("Bread & butter – today", { exact: true }).first().waitFor();
			await expectAccessibleScreen(page, `Plain source Map (${theme})`);
			await press(page, "Preview");
			await drainUntil(page, /Entr(?:y as a Draft|ies as Drafts)/);
			await page.getByRole("button", { name: /^Bread & butter – today/ }).waitFor();
			await expectAccessibleScreen(page, `Plain source Preview (${theme})`);
			await press(page, "Start Import");
			await drainUntil(page, "Import report: Plain source");
			await expectAccessibleScreen(page, `Plain source report (${theme})`);
			const { api } = member.browser;
			const posts = (await api.postTypes.list({ siteId: site.id })).postTypes.find((type) => type.name === "Posts");
			if (!posts) throw new Error("Expected the run to create Posts.");
			expect(
				(await api.entries.list({ siteId: site.id, postTypeId: posts.id })).entries.map((entry) => entry.draft.title),
			).toEqual(["Bread & butter – today"]);
		} finally {
			await page.close();
		}
	});

	test(`Live connection, password and visibility controls from the keyboard, ${theme}`, async () => {
		install.install.dns.answer("live-browser.example", ["93.184.216.80"]);
		install.install.http.respond("GET", /^https:\/\/live-browser.example\//, (r) => liveWordpressReply(new URL(r.url)));
		const page = await install.newPage(theme);
		await open(page, staff, `/sites/${siteId}/imports/new?source=wordpress-import.live`);
		await page.getByRole("heading", { name: "WordPress live site" }).waitFor();
		await expectAccessibleScreen(page, `Live Source (${theme})`);
		await page.getByLabel("Import name", { exact: true }).fill("Live browser import");
		await page.getByLabel("Site address", { exact: true }).fill("https://live-browser.example");
		await page.getByLabel("Username", { exact: true }).fill("login");
		const password = page.getByLabel("Application password", { exact: true });
		expect(await password.getAttribute("type")).toBe("password");
		await password.fill("one-time-application-password");
		const hidden = page.getByLabel("Include drafts and private posts", { exact: true });
		expect(await hidden.isChecked()).toBe(false);
		await hidden.focus();
		await page.keyboard.press("Space");
		expect(await hidden.isChecked()).toBe(true);
		await page.keyboard.press("Space");
		await press(page, "Test connection");
		await page.getByText("Connected · Role: editor", { exact: true }).waitFor();
		expect(await password.inputValue()).toBe("");
		expect(await page.getByLabel("Username", { exact: true }).inputValue()).toBe("");
		await drainUntil(page, "live-browser.example was read");
		await expectAccessibleScreen(page, `Live Source connected (${theme})`);
		await press(page, "Continue to mapping");
		await page.getByRole("heading", { name: "Sample Entry" }).waitFor();
		await expectAccessibleScreen(page, `Live Map (${theme})`);
		await press(page, "Back");
		expect(await page.getByLabel("Site address", { exact: true }).inputValue()).toBe("https://live-browser.example");
		expect(await page.getByLabel("Site address", { exact: true }).isDisabled()).toBe(true);
		await press(page, "Continue to mapping");
		await press(page, "Preview");
		await drainUntil(page, /Entr(?:y as a Draft|ies as Drafts)/);
		await expectAccessibleScreen(page, `Live Preview (${theme})`);
		await press(page, "Start Import");
		await drainUntil(page, "Import report: Live browser import");
		await page.getByText("Some custom fields may only be in the export file.", { exact: false }).waitFor();
		await expectAccessibleScreen(page, `Live report (${theme})`);
		const again = page.getByRole("link", { name: "Run again", exact: true });
		await again.focus();
		await page.keyboard.press("Enter");
		await page.getByRole("heading", { name: "WordPress live site" }).waitFor();
		expect(await page.getByLabel("Application password", { exact: true }).inputValue()).toBe("");
		const admin = (await install.install.superadmin()).api;
		await admin.modules.setOnSite({ siteId, moduleId: "wordpress-import", on: false });
		await page.reload();
		await page.getByText("This Import's source isn't available", { exact: false }).waitFor();
		await expectAccessibleScreen(page, `Live Import with Module off (${theme})`);
		await press(page, "Remove Import and saved login");
		const dialog = page.getByRole("dialog", { name: "Remove Import and saved login" });
		await dialog.waitFor();
		await expectNoAxeViolations(page, `Remove live Import (${theme})`);
		await dialog.getByRole("button", { name: "Remove Import and saved login", exact: true }).focus();
		await page.keyboard.press("Enter");
		await page.getByRole("heading", { name: "Imports", exact: true }).waitFor();
		await admin.modules.setOnSite({ siteId, moduleId: "wordpress-import", on: true });
		await page.close();
	});
}
