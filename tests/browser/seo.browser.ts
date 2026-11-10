// The SEO screens in a real browser, in the device's light and dark themes, each checked with axe-core
// and the keyboard: the Entry editor's SEO & sharing card (with the SEO check's warnings), a Post
// Type's SEO tab (title pattern tokens, its Summary, the sitemap switch, the Schema type and its
// properties), Site › SEO, and Site › Crawlers (the AI crawler setting and Staff's robots.txt lines).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let owner: TestAccount;
let author: TestAccount;
let siteId: string;
let postTypeId: string;
let entryId: string;

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Ciara Byrne" })).account;
	author = (await local.createMember({ workspaceId, role: "author", name: "Aoife Kelly" })).account;
	owner = (await local.createMember({ workspaceId, role: "owner", name: "Niamh Walsh" })).account;
	await api.globals.setFields({ siteId, fields: [{ key: "phone", label: "Phone", type: "text" }] });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "body", label: "Body", type: "body" },
			{ key: "cover", label: "Cover image", type: "media" },
			{ key: "summary", label: "Summary", type: "richText" },
		],
	});
	postTypeId = postType.id;
	const { entry } = await api.entries.create({
		siteId,
		postTypeId,
		title: "A very long title about our seven-day rye loaves and why they take a week",
		fields: { body: [{ type: "paragraph", text: "Dense." }] },
	});
	entryId = entry.id;
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`the SEO & sharing card, ${theme}`, () => {
		test("shows each SEO field with what it falls back to, and the SEO check's warnings", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, author);
			await page.goto(install.adminUrl(`/sites/${siteId}/entries/${postTypeId}/${entryId}`));
			await page.waitForLoadState("networkidle");
			await page.getByRole("heading", { level: 2, name: "SEO & sharing" }).waitFor();
			await page.getByRole("heading", { level: 3, name: "SEO check" }).waitFor();

			await expectAccessibleScreen(page, `the Entry editor with its SEO card (${theme})`);
			expect(await page.getByText("There's no social image: shared links will show without a picture.").count()).toBe(
				1,
			);
		});
	});
}

describe("writing SEO fields from the keyboard", () => {
	test("an Author types a description and hides the page from search engines; both save to the Draft", async () => {
		const page = await install.newPage("light");
		await install.signIn(page, author);
		await page.goto(install.adminUrl(`/sites/${siteId}/entries/${postTypeId}/${entryId}`));
		await page.waitForLoadState("networkidle");
		const description = page.getByRole("textbox", { name: "Description" });
		await description.focus();
		await page.keyboard.type(
			"Seven days from flour to shelf: how our rye loaves are made, and why it is worth the wait.",
		);
		expect(await page.getByText(/^9\d of 160 characters$/).count()).toBe(1);
		const noindex = page.getByRole("checkbox", { name: "Hide from search engines" });
		await noindex.focus();
		await page.keyboard.press("Space");

		// The Draft saves by itself a moment after the last change.
		const { api } = await install.install.superadmin();
		let draft = (await api.entries.get({ siteId, entryId })).entry.draft.seo;
		for (let look = 0; look < 100 && !draft.noindex; look++) {
			await page.waitForTimeout(100);
			draft = (await api.entries.get({ siteId, entryId })).entry.draft.seo;
		}
		expect(draft.noindex).toBe(true);
		expect(draft.description).toContain("Seven days from flour to shelf");
	});
});

for (const theme of THEMES) {
	describe(`a Post Type's SEO tab, ${theme}`, () => {
		test("Staff add a token, choose a Schema type (its properties guessed), and save, from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, staff);
			await page.goto(install.adminUrl(`/sites/${siteId}/post-types/${postTypeId}?tab=seo`));
			await page.waitForLoadState("networkidle");
			await page.getByRole("heading", { level: 2, name: "SEO" }).waitFor();
			await expectAccessibleScreen(page, `a Post Type's SEO tab (${theme})`);

			const pattern = page.getByRole("textbox", { name: "Title pattern" });
			await pattern.focus();
			// To the end of the text, whatever the platform (End doesn't move the caret on every one).
			await page.keyboard.press("ArrowRight");
			await page.keyboard.type(" ");
			await page.getByRole("button", { name: "Add {postType} to the title pattern" }).click();
			expect(await pattern.inputValue()).toBe("{title} {separator} {site} {postType}");
			// Adding a token puts the caret back in the pattern on the next frame: let it land first.
			await page.waitForFunction(() => document.activeElement instanceof HTMLInputElement);
			await page.getByRole("combobox", { name: "Schema type" }).selectOption("blogPosting");
			expect(await page.getByRole("combobox", { name: "Where headline comes from" }).inputValue()).toBe("title");
			await page.getByRole("combobox", { name: "Summary" }).selectOption("summary");
			const sitemap = page.getByRole("checkbox", { name: "List in sitemaps and llms.txt" });
			await sitemap.focus();
			expect(await sitemap.evaluate((element) => element === document.activeElement)).toBe(true);
			await page.keyboard.press("Space");
			// The switch shows its new state once the screen has it, so Save sends it.
			for (let look = 0; look < 100 && (await sitemap.isChecked()); look++) await page.waitForTimeout(50);
			expect(await sitemap.isChecked()).toBe(false);
			await page.getByRole("button", { name: "Save" }).click();
			await page.getByText("SEO settings saved.").first().waitFor();
			await expectAccessibleScreen(page, `a Post Type's SEO tab, saved (${theme})`);

			const { api } = await install.install.superadmin();
			const { postType } = await api.postTypes.get({ siteId, postTypeId });
			expect(postType.seo).toMatchObject({
				titlePattern: "{title} {separator} {site} {postType}",
				schema: { type: "blogPosting", properties: { headline: "title", author: "author" } },
			});
			expect(postType.summaryField).toBe("summary");
			expect(postType.sitemap).toBe(false);
			await api.postTypes.update({
				siteId,
				postTypeId,
				summaryField: null,
				sitemap: true,
				seo: { titlePattern: "{title} {separator} {site}", schema: { type: "webPage" } },
			});
		});

		test("a refused setting is said in the summary, which takes focus", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, staff);
			await page.goto(install.adminUrl(`/sites/${siteId}/post-types/${postTypeId}?tab=seo`));
			await page.waitForLoadState("networkidle");
			const pattern = page.getByRole("textbox", { name: "Title pattern" });
			await pattern.fill("{title} {sitename}");
			await page.getByRole("button", { name: "Save" }).click();
			const alert = page.getByRole("alert").filter({ hasText: "The SEO settings weren't saved" });
			await alert.waitFor();
			// Focus moves to the summary once it is drawn.
			await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "alert", undefined, {
				timeout: 5_000,
			});
			expect(await alert.evaluate((element) => element === document.activeElement)).toBe(true);
			await expectAccessibleScreen(page, `a Post Type's SEO tab, refused (${theme})`);
		});
	});
}

for (const theme of THEMES) {
	describe(`Site › SEO, ${theme}`, () => {
		test("Staff set the Site's name in titles, the separator and the organisation, from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, staff);
			await page.goto(install.adminUrl(`/sites/${siteId}/seo`));
			await page.waitForLoadState("networkidle");
			await page.getByRole("heading", { level: 1, name: "SEO" }).waitFor();
			await expectAccessibleScreen(page, `Site › SEO (${theme})`);

			await page.getByRole("textbox", { name: "Site name in titles" }).fill("Acme");
			await page.getByRole("textbox", { name: "Separator" }).fill("|");
			await page.getByRole("combobox", { name: "Kind" }).selectOption("localBusiness");
			await page.getByRole("combobox", { name: "Telephone from" }).selectOption("phone");
			await page.getByRole("button", { name: "Save" }).click();
			await page.getByText("SEO settings saved.").first().waitFor();

			const { api } = await install.install.superadmin();
			const { settings } = await api.seoSettings.get({ siteId });
			expect(settings).toMatchObject({
				siteName: "Acme",
				separator: "|",
				organization: { kind: "localBusiness", telephone: "phone" },
			});
			await api.seoSettings.update({
				siteId,
				siteName: null,
				separator: "·",
				organization: { kind: "organization", telephone: null },
			});
		});
	});
}

for (const theme of THEMES) {
	describe(`Site › Crawlers, ${theme}`, () => {
		test("an Owner chooses what AI crawlers may read, from the keyboard", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, owner);
			await page.goto(install.adminUrl(`/sites/${siteId}/crawlers`));
			await page.waitForLoadState("networkidle");
			await page.getByRole("heading", { level: 1, name: "Crawlers" }).waitFor();
			// Owners choose the AI crawler setting; Staff's own robots.txt lines aren't theirs.
			expect(await page.getByRole("textbox", { name: "Lines" }).count()).toBe(0);

			const allowAll = page.getByRole("radio", { name: "Allow all" });
			await allowAll.focus();
			await page.keyboard.press("ArrowDown");
			expect(await page.getByRole("radio", { name: "Allow search, block training" }).isChecked()).toBe(true);
			const save = page.getByRole("button", { name: "Save", exact: true });
			await save.click();
			await page.getByText("Saved. The Site's robots.txt says so now.").first().waitFor();
			// Nothing to save until the choice changes again.
			await page.waitForFunction(
				() =>
					[...document.querySelectorAll("button")].find((button) => button.textContent?.trim() === "Save")?.disabled,
			);
			await expectAccessibleScreen(page, `Site › Crawlers, saved (${theme})`);

			const { api } = await install.install.superadmin();
			expect((await api.seoSettings.get({ siteId })).settings.aiCrawlers).toBe("allowSearch");
			await api.seoSettings.setAiCrawlers({ siteId, aiCrawlers: "allowAll" });
		});

		test("Staff's refused robots.txt line is said beside the field, which keeps what they typed", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, staff);
			await page.goto(install.adminUrl(`/sites/${siteId}/crawlers`));
			await page.waitForLoadState("networkidle");
			const lines = page.getByRole("textbox", { name: "Lines" });
			await lines.fill("Disallow: /private");
			await page.getByRole("button", { name: "Save lines" }).click();
			const alert = page
				.getByRole("alert")
				.filter({ hasText: "Line 1 is a rule without a User-agent line before it." });
			await alert.waitFor();
			await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "alert", undefined, {
				timeout: 5_000,
			});
			expect(await lines.inputValue()).toBe("Disallow: /private");
			await expectAccessibleScreen(page, `Site › Crawlers, a refused line (${theme})`);
		});
	});
}
