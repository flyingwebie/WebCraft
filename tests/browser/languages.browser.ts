// Languages in a real browser: Site › Languages with its menus and its two-step dialogs, used from the
// keyboard; and Site pages with the Language switcher, in a left-to-right and a right-to-left language.
import { afterAll, beforeAll, describe, test } from "bun:test";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let superadmin: TestAccount;
let siteId: string;
const slug = "bakery";

beforeAll(async () => {
	install = await startBrowserInstall();
	superadmin = await install.createSuperadmin();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	// Visitors see the Site on its domain; its Staging address is for the people reviewing it.
	await install.goLive(siteId);
	await api.languages.add({ siteId, code: "fr" });
	await api.languages.add({ siteId, code: "ar" });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: [
			'<header><p><a href="/">Acme Bakery</a></p>{{@languageSwitcher}}</header>',
			"<main>{{@outlet}}</main>",
			'<footer><p>{{ "Open every day from seven." fr: "Ouvert tous les jours dès sept heures." ar: "مفتوح كل يوم من السابعة." }}</p></footer>',
		].join(""),
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: post } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await api.entries.saveDraft({ siteId, entryId: post.id, language: "fr", title: "Pain frais", slug: "pain-frais" });
	await api.entries.saveDraft({ siteId, entryId: post.id, language: "ar", title: "خبز طازج" });
	await api.entries.publish({ siteId, entryId: post.id });
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Site › Languages, ${theme}`, () => {
		test("a language's menu opens and closes from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/sites/${siteId}/languages`));
			await page.waitForLoadState("networkidle");

			await expectOverlayUsable(
				page,
				page.getByRole("button", { name: "Actions for Français" }),
				"menu",
				`Languages › a language's menu (${theme})`,
			);
		});

		test("making a language the Default language warns, then shows what changes before it is confirmed", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/sites/${siteId}/languages`));
			await page.waitForLoadState("networkidle");
			await page.getByRole("button", { name: "Actions for Français" }).click();
			await page.getByRole("menuitem", { name: "Make Default language" }).click();
			const dialog = page.getByRole("dialog");
			await dialog.waitFor();
			await expectNoAxeViolations(page, `Languages › Make Default language (${theme})`, ["region"]);

			await dialog.getByRole("button", { name: "Check what changes" }).click();
			await dialog.getByText("published addresses change").waitFor();
			await expectNoAxeViolations(page, `Languages › Make Default language, what changes (${theme})`, ["region"]);
			await page.keyboard.press("Escape");
		});

		test("removing a language shows its pages before it is confirmed", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, superadmin);
			await page.goto(install.adminUrl(`/sites/${siteId}/languages`));
			await page.waitForLoadState("networkidle");
			await page.getByRole("button", { name: "Actions for العربية" }).click();
			await page.getByRole("menuitem", { name: "Remove" }).click();
			const dialog = page.getByRole("dialog");
			await dialog.getByRole("button", { name: "Check what changes" }).click();
			await dialog.getByText("published page").waitFor();
			await expectNoAxeViolations(page, `Languages › Remove (${theme})`, ["region"]);
			await page.keyboard.press("Escape");
		});
	});

	describe(`Site pages with the Language switcher, ${theme}`, () => {
		for (const [name, path] of [
			["in French", "/fr/blog/pain-frais"],
			["in Arabic, right to left", "/ar/blog/fresh-bread"],
		] as const) {
			test(name, async () => {
				const page = await install.newPage(theme);
				await page.goto(install.liveUrl(slug, path));
				await page.waitForLoadState("networkidle");

				await expectAccessibleScreen(page, `Site page ${name} (${theme})`);
			});
		}
	});
}
