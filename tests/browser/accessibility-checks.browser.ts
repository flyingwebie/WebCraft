// The Site's open Checks, their editor links and placement settings, plus the optional Staff form.
import { afterAll, beforeAll, expect, test } from "bun:test";
import en from "../../apps/server/src/messages/en.json";
import { photo, upload } from "../harness/images.ts";
import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
let entryId: string;
let mediaId: string;
const template = () =>
	`<article><h1>{{ title }}</h1><img data-wc-id="photo" src="media:${mediaId}">{{ body }}</article>`;
beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const workspace = (await local.createWorkspace()).id;
	siteId = (await local.createSite(workspace, { slug: "checks" })).id;
	staff = (await local.createStaff({ workspaces: [workspace] })).account;
	const { api } = await local.superadmin();
	mediaId = (await api.media.upload({ siteId, file: upload(await photo({ width: 32, height: 32 }), "leaf.jpg") })).media
		.id;
	await local.drainJobs();
	postTypeId = (
		await api.postTypes.create({
			siteId,
			name: "Stories",
			urlPattern: "/stories/{slug}",
			fields: [{ key: "body", label: "Body", type: "body" }],
		})
	).postType.id;
	entryId = (
		await api.entries.create({
			siteId,
			postTypeId,
			title: "Leaves",
			fields: { body: [{ type: "image", media: mediaId }] },
		})
	).entry.id;
});
afterAll(async () => {
	await install.close();
});
for (const theme of THEMES) {
	test(`Checks open the affected image; Decorative works from the keyboard (${theme})`, async () => {
		const { api } = await install.install.superadmin();
		await api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: template() });
		await api.entries.saveDraft({ siteId, entryId, fields: { body: [{ type: "image", media: mediaId }] } });
		const page = await install.newPage(theme);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}/checks`));
		const link = page.locator(`a[href='/builder/${siteId}/entry-template/${postTypeId}?element=photo']`).first();
		await link.waitFor();
		await expectAccessibleScreen(page, `Checks with open warnings (${theme})`);
		await link.focus();
		await page.keyboard.press("Enter");
		const decorative = page.getByRole("checkbox", { name: en.checks.decorative });
		await decorative.waitFor();
		await expectAccessibleScreen(page, `Image placement settings (${theme})`, { exclude: ["iframe[title^='Canvas']"] });
		await decorative.focus();
		await page.keyboard.press("Space");
		expect(await decorative.isChecked()).toBe(true);
		await page.keyboard.press("ControlOrMeta+s");
		await page.getByRole("button", { name: "Save", exact: true }).and(page.locator("[disabled]")).waitFor();
		expect((await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft).toContain(
			'data-wc-decorative="true"',
		);
		await page.goto(install.adminUrl(`/sites/${siteId}/entries/${postTypeId}/${entryId}`));
		await page.waitForLoadState("networkidle");
		const bodyDecorative = page.getByRole("checkbox", { name: en.checks.decorative });
		await bodyDecorative.waitFor();
		await bodyDecorative.focus();
		await page.keyboard.press("Space");
		await page.getByText(en.body.checks.missingAlt, { exact: true }).waitFor({ state: "hidden" });
		await expectNoAxeViolations(page, `Body Decorative (${theme})`);
		await page.close();
	});
	test(`Staff generate and reopen the ordinary statement Draft (${theme})`, async () => {
		const page = await install.newPage(theme);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}/accessibility-statement`));
		await page.getByRole("button", { name: en.statement.generate }).waitFor();
		const values = {
			organisation: "Example Council",
			website: "https://example.test",
			standard: "Applicable national legislation",
			limitations: "Older PDFs need review.",
			burden: "None claimed.",
			excluded: "None identified.",
			alternatives: "Ask for a text copy.",
			preparedOn: "2026-11-10",
			reviewedOn: "2026-11-10",
			method: "Self assessment; manual audit pending.",
			feedback: "Contact the accessibility officer.",
			feedbackUrl: "mailto:access@example.test",
			enforcement: "Contact the national enforcement body.",
			enforcementUrl: "https://example.test/enforcement",
		};
		for (const key of Object.keys(values) as (keyof typeof values)[])
			await page.getByLabel(en.statement.fields[key], { exact: true }).fill(values[key]);
		await expectAccessibleScreen(page, `Accessibility statement form (${theme})`);
		await page.getByRole("button", { name: en.statement.generate }).focus();
		await page.keyboard.press("Enter");
		await page.getByText(en.statement.saved, { exact: true }).waitFor();
		await expectAccessibleScreen(page, `Accessibility statement saved (${theme})`);
		const { api } = await install.install.superadmin();
		const settings = (await api.accessibilityStatement.get({ siteId })).settings;
		expect(settings).not.toBeNull();
		const saved = await api.entries.get({ siteId, entryId: settings?.pageId ?? "" });
		expect(saved.entry.status).toBe("draft");
		expect(JSON.stringify(saved.entry.draft.fields)).toContain("aims for WCAG 2.2 AA");
		await page.getByRole("link", { name: en.statement.edit }).click();
		await page.getByRole("textbox", { name: /^Title/ }).waitFor();
		expect(await page.getByRole("textbox", { name: /^Title/ }).inputValue()).toBe("Accessibility statement");
		await page.close();
	});
}

test("Edit mode keeps Decorative placements empty when the shared Media alt text changes", async () => {
	const { api } = await install.install.superadmin();
	await api.media.update({ siteId, mediaId, alt: "" });
	const { template: saved } = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: `<h1>{{ title }}</h1><img src="media:${mediaId}" data-wc-decorative><div>{{ body }}</div>`,
	});
	await api.templates.publish({ siteId, templateId: saved.id });
	await api.entries.saveDraft({
		siteId,
		entryId,
		fields: {
			body: [
				{ id: "ornament", type: "image", media: mediaId },
				{ id: "meaning", type: "image", media: mediaId },
			],
		},
	});
	await api.entries.publish({ siteId, entryId });
	const page = await install.newPage("light");
	await install.signIn(page, staff);
	await page.goto(install.adminUrl(`/sites/${siteId}`));
	await page.getByRole("button", { name: "Edit on site" }).click();
	await page.waitForURL((url) => url.hostname === new URL(install.siteUrl("checks", "/")).hostname);
	await page.addInitScript(() => {
		localStorage.setItem("webcraft-edit-hint", "seen");
	});
	await page.goto(install.siteUrl("checks", "/stories/leaves"));
	await page.locator("webcraft-edit-bar").waitFor({ state: "attached" });
	await page.waitForLoadState("networkidle");
	await page.locator('[data-wc-block-id="ornament"]').focus();
	await page.keyboard.press("Alt+F10");
	await page
		.getByRole("toolbar", { name: /^Image, block 1: tools$/ })
		.getByRole("button", { name: "Image, block 1: actions" })
		.click();
	await page.getByRole("menuitem", { name: "Change image" }).click();
	const imageSettings = page.getByRole("dialog", { name: "Change image" });
	const decorative = imageSettings.getByRole("checkbox", { name: en.body.image.decorative });
	await decorative.focus();
	await page.keyboard.press("Space");
	await expectNoAxeViolations(page, "Edit mode Decorative image settings", ["region"]);
	await imageSettings.getByRole("button", { name: "Done", exact: true }).click();
	await page.locator('[data-wc-block-id="ornament"] img[data-wc-image-decorative="true"]').waitFor();
	const meaningful = page.locator('[data-wc-block-id="meaning"] img');
	await meaningful.click();
	await page.getByRole("textbox", { name: "Alt text · English" }).fill("A fresh leaf");
	await page.getByRole("textbox", { name: "Alt text · English" }).blur();
	await page.waitForFunction(() => [...document.querySelectorAll("img")].some((img) => img.alt === "A fresh leaf"));
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: "Preview", exact: true }).click();
	expect(await page.locator('main img[alt=""]').count()).toBe(2);
	expect(await page.locator('main img[alt="A fresh leaf"]').count()).toBe(1);
	await page.close();
});
