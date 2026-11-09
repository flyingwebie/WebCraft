// AI translation in a real browser: Site › Translations with the Review queue (a line opened),
// Site settings › AI translation, Workspace › Protected terms and a term's menu, Workspace › AI keys
// and the dialog removing the key, Install settings › AI and the dialog adding a shared key, and the
// Entry editor showing an Outdated translation, each in light and dark, with axe and the keyboard.
// The data is prepared in the test process, where the fake AI provider translates.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { taggedTranslation } from "../harness/fake-ai.ts";
import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let owner: TestAccount;
let workspaceId: string;
let siteId: string;
let postTypeId: string;
let entryId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	const local = install.install;
	const admin = await local.superadmin();
	workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const member = await local.createMember({ workspaceId, role: "owner", name: "Sinéad Byrne" });
	owner = member.account;
	const api = member.browser.api;
	await admin.api.languages.add({ siteId, code: "it" });
	await admin.api.languages.add({ siteId, code: "fr" });
	await api.translations.setMode({ siteId, language: "it", mode: "review" });
	await api.aiKeys.setOwn({
		workspaceId,
		provider: "anthropic",
		model: "claude-haiku-5-5",
		endpoint: null,
		key: "sk-ant-browser-test-key-0123456789abcd",
		monthlyCap: 10,
	});
	const { key } = await admin.api.sharedAiKeys.add({
		name: "Northwind shared key",
		provider: "openrouter",
		model: "anthropic/claude-haiku-5-5",
		endpoint: null,
		key: "sk-or-browser-shared-key-9876543210",
	});
	await admin.api.sharedAiKeys.assign({ workspace: workspaceId, keyId: key.id, monthlyCap: 5 });
	await api.protectedTerms.add({ workspaceId, siteId: null, terms: [{ term: "Acme", matchCase: true }] });
	await api.protectedTerms.add({ workspaceId, siteId, terms: [{ term: "Panettone Sunday", matchCase: false }] });

	const { postType } = await admin.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "intro", label: "Intro", type: "text" },
		],
	});
	postTypeId = postType.id;
	const { entry } = await api.entries.create({
		siteId,
		postTypeId,
		title: "Spring menu 2027",
		fields: { summary: "Our spring menu brings back the Acme Sourdough Loaf.", intro: "Baked every morning." },
	});
	entryId = entry.id;
	local.ai.translateWith(taggedTranslation);
	await api.entries.publish({ siteId, entryId });
	expect((await local.drainJobs()).failed).toEqual([]);
	// A person writes the Italian intro; then its English source changes: an Outdated translation.
	await api.entries.saveDraft({ siteId, entryId, language: "it", fields: { intro: "Sfornato ogni mattina." } });
	await api.entries.saveDraft({ siteId, entryId, fields: { intro: "Baked fresh every morning." } });
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`AI translation, ${theme}`, () => {
		const open = async (account: TestAccount, path: string) => {
			const page = await install.newPage(theme);
			await install.signIn(page, account);
			await page.goto(install.adminUrl(path));
			await page.waitForLoadState("networkidle");
			return page;
		};

		test("Site › Translations: each language, and the Review queue with a line opened", async () => {
			const page = await open(owner, `/sites/${siteId}/translations`);
			await page.getByRole("heading", { name: "Review queue" }).waitFor();
			await page.getByRole("heading", { name: /Italiano/ }).waitFor();
			await expectAccessibleScreen(page, `Translations (${theme})`);

			await page.getByRole("button", { name: "Spring menu 2027" }).first().click();
			await page.getByRole("button", { name: "Approve", exact: true }).waitFor();
			await expectAccessibleScreen(page, `Translations › a line opened (${theme})`);
		});

		test("Site settings › AI translation", async () => {
			const page = await open(owner, `/sites/${siteId}/ai-translation`);
			await page.getByRole("heading", { name: "Translation mode per language" }).waitFor();
			await expectAccessibleScreen(page, `AI translation (${theme})`);
		});

		test("Workspace › Protected terms, and a term's menu", async () => {
			const page = await open(owner, `/workspaces/${workspaceId}/protected-terms`);
			await page.getByRole("cell", { name: "Panettone Sunday" }).first().waitFor();
			await expectAccessibleScreen(page, `Protected terms (${theme})`);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Actions for Panettone Sunday" }),
				"menu",
				`Protected terms › a term's menu (${theme})`,
			);
		});

		test("Workspace › AI keys, and the dialog removing the own key", async () => {
			const page = await open(owner, `/workspaces/${workspaceId}/ai-keys`);
			await page.getByRole("heading", { name: "Shared Install key" }).waitFor();
			await expectAccessibleScreen(page, `AI keys (${theme})`);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Remove key" }),
				"dialog",
				`AI keys › remove the key (${theme})`,
			);
		});

		test("Install settings › AI, and the dialog adding a shared key", async () => {
			const page = await open(superadmin, "/settings/ai");
			await page.getByRole("cell", { name: "Northwind shared key" }).first().waitFor();
			await expectAccessibleScreen(page, `Install settings › AI (${theme})`);
			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Add shared key" }),
				"dialog",
				`Install settings › AI › add a shared key (${theme})`,
			);
		});

		test("the Entry editor shows an Outdated translation next to its old and new source", async () => {
			const page = await open(owner, `/sites/${siteId}/entries/${postTypeId}/${entryId}?language=it`);
			await page.getByRole("heading", { name: "1 Outdated translation" }).waitFor();
			await page.getByText("Baked fresh every morning.").first().waitFor();
			await expectAccessibleScreen(page, `Entry editor › Outdated translation (${theme})`);
		});
	});
}
