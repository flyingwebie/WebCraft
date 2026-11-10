import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Cookie, Page } from "playwright";
import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, pageErrors, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let siteId: string;
let staff: TestAccount;
const slug = "promotions";
let consentCookies: Cookie[] = [];
// Revisit with the real choice made in the first browser, like the ordinary visitor lifecycle.
// Repeated new contexts otherwise hit the consent receipt rate limit on this one Site/address.
async function visit(page: Page, layout: string) {
	if (consentCookies.length) await page.context().addCookies(consentCookies);
	await page.goto(install.liveUrl(slug, `/offers/${layout}`));
	if (!consentCookies.length) {
		const recorded = page.waitForResponse((r) => r.url().endsWith("/_wc/consent") && r.status() === 201);
		await page.getByRole("button", { name: "Reject all", exact: true }).click();
		await recorded;
		consentCookies = await page.context().cookies();
	}
}
const layouts = ["modal", "slide-in", "bar", "full-screen"] as const;
beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	await api.modules.approve({ moduleId: "popups", version: "1.0.0" });
	await api.modules.approve({ moduleId: "forms", version: "1.2.0" });
	const ws = await local.createWorkspace();
	siteId = (await local.createSite(ws.id, { slug })).id;
	await install.goLive(siteId);
	staff = (await local.createStaff({ workspaces: [ws.id] })).account;
	const { form } = await api.forms.create({ siteId, name: "Enquiry", key: "enquiry" });
	await api.forms.saveDraft({
		siteId,
		formId: form.id,
		form: {
			fields: [
				{ key: "first", type: "step", label: "Contact" },
				{ key: "name", type: "text", label: "Your name", required: true },
				{ key: "next", type: "step", label: "Details" },
				{ key: "email", type: "email", label: "Email", required: true },
				{
					key: "attachment",
					type: "select",
					label: "Attach a document",
					options: [
						{ value: "no", label: "No document" },
						{ value: "yes", label: "Add document" },
					],
				},
				{
					key: "file",
					type: "file",
					label: "Document",
					accept: ["pdf"],
					condition: { match: "all", rules: [{ field: "attachment", op: "is", value: "yes" }] },
				},
			],
			spam: { minFillSeconds: 0 },
		},
	});
	await api.forms.publish({ siteId, formId: form.id });
	const { postType } = await api.postTypes.create({ siteId, name: "Offers", urlPattern: "/offers/{slug}", fields: [] });
	let commands = "";
	for (const layout of layouts) {
		const { popup } = await api.popups.create({ siteId, name: layout, key: layout });
		await api.components.saveMarkup({
			siteId,
			componentId: popup.componentId,
			markup: "<p>{{ props.text }}</p>{{@form enquiry}}",
		});
		await api.components.publish({ siteId, componentId: popup.componentId });
		await api.popups.saveDraft({
			siteId,
			popupId: popup.id,
			popup: {
				layout,
				rules: {
					paths: [`/offers/${layout}`],
					postTypeIds: [],
					entryIds: [],
					languages: [],
					devices: ["phone", "desktop"],
					visitors: "all",
				},
			},
		});
		await api.popups.saveContent({
			siteId,
			popupId: popup.id,
			values: { title: `Offer ${layout}`, text: "Ask about our offer.", enabled: true },
		});
		await api.popups.publish({ siteId, popupId: popup.id });
		await api.popups.publishContent({ siteId, popupId: popup.id });
		commands += `{{@popup ${layout}}}`;
		const { entry } = await api.entries.create({
			siteId,
			postTypeId: postType.id,
			title: `Page ${layout}`,
			slug: layout,
			fields: {},
		});
		await api.entries.publish({ siteId, entryId: entry.id });
	}
	const saved = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: `<h1>{{ title }}</h1>${commands}{{@consentSettings}}`,
	});
	await api.templates.publish({ siteId, templateId: saved.template.id });
});
afterAll(async () => {
	await install.close();
});
for (const theme of THEMES)
	for (const phone of [false, true])
		for (const layout of layouts)
			test(`${layout} opens and closes from the keyboard (${theme}, ${phone ? "phone" : "desktop"})`, async () => {
				const page = await install.newPage(theme);
				if (phone) await page.setViewportSize({ width: 390, height: 844 });
				await visit(page, layout);
				const link = page.getByRole("link", { name: `Offer ${layout}`, exact: true });
				await link.focus();
				await page.keyboard.press("Enter");
				const dialog = page.getByRole("dialog", { name: `Offer ${layout}`, exact: true });
				await dialog.waitFor({ state: "visible" });
				expect(await dialog.isVisible()).toBe(true);
				if (layout === "modal" || layout === "full-screen")
					for (let n = 0; n < 8; n++) {
						await page.keyboard.press("Tab");
						expect(
							await dialog.evaluate(
								(e) => e.contains(document.activeElement) || document.activeElement === document.body,
							),
						).toBe(true);
					}
				await expectNoAxeViolations(page, `opened ${layout} ${theme} ${phone}`);
				await dialog.getByLabel("Your name", { exact: false }).fill("Visitor");
				await dialog.getByRole("button", { name: "Next", exact: true }).click();
				await expectNoAxeViolations(page, `Popup Form step ${layout} ${theme}`);
				await dialog.getByLabel("Email", { exact: false }).focus();
				await page.keyboard.press("Escape");
				await dialog.waitFor({ state: "detached" });
				expect(await link.evaluate((e) => e === document.activeElement)).toBe(true);
				expect(pageErrors(page)).toEqual([]);
				await page.close();
			});
for (const theme of THEMES)
	for (const phone of [false, true])
		test(`Popup Content and Structure controls (${theme}, ${phone ? "phone" : "desktop"})`, async () => {
			const page = await install.newPage(theme);
			if (phone) await page.setViewportSize({ width: 390, height: 844 });
			await install.signIn(page, staff);
			await page.goto(install.adminUrl(`/sites/${siteId}/popups`));
			await page.getByRole("heading", { name: "Popups", exact: true }).waitFor();
			await expectAccessibleScreen(page, `Popup editor ${theme}`);
			if (phone)
				expect(
					await page.evaluate(() =>
						[...document.querySelectorAll<HTMLElement>("main *")]
							.filter((e) => e.getBoundingClientRect().right > innerWidth + 1 && e.getBoundingClientRect().width > 0)
							.map((e) => ({
								tag: e.tagName,
								slot: e.dataset.slot,
								name: e.getAttribute("aria-label"),
								text: e.textContent?.slice(0, 60),
							})),
					),
				).toEqual([]);
			await page.getByLabel("Trigger", { exact: true }).selectOption("delay");
			await page.getByLabel("Seconds", { exact: true }).fill("8");
			await page.getByRole("button", { name: "Save Draft", exact: true }).last().click();
			await page.getByRole("status").filter({ hasText: "Draft saved" }).waitFor();
			await page.close();
		});
test("click Popup remains useful without JavaScript", async () => {
	const page = await install.newPage("light", { javaScript: false });
	await page.goto(install.liveUrl(slug, "/offers/modal"));
	await page.getByRole("link", { name: "Offer modal", exact: true }).click();
	expect(await page.getByRole("heading", { name: "Offer modal", exact: true }).isVisible()).toBe(true);
	expect(await page.locator("#popup-modal").getByLabel("Email", { exact: false }).isVisible()).toBe(true);
	await page.close();
});

for (const theme of THEMES)
	test(`Popup Forms validate steps, conditions and private uploads, then keep success visible (${theme})`, async () => {
		const page = await install.newPage(theme);
		await page.setViewportSize({ width: 390, height: 844 });
		await visit(page, "modal");
		await page.getByRole("link", { name: "Offer modal", exact: true }).click();
		const dialog = page.getByRole("dialog", { name: "Offer modal", exact: true });
		await dialog.waitFor();
		await dialog.getByRole("button", { name: "Next", exact: true }).click();
		expect(await dialog.getByLabel("Your name", { exact: false }).getAttribute("aria-invalid")).toBe("true");
		await expectNoAxeViolations(page, `Popup Form validation ${theme}`);
		await dialog.getByLabel("Your name", { exact: false }).fill("A visitor");
		await dialog.getByRole("button", { name: "Next", exact: true }).click();
		expect(await dialog.getByLabel("Document", { exact: true }).isVisible()).toBe(false);
		await dialog.getByLabel("Attach a document", { exact: false }).selectOption("yes");
		expect(await dialog.getByLabel("Document", { exact: true }).isVisible()).toBe(true);
		await dialog.getByLabel("Email", { exact: false }).fill("visitor@example.test");
		await dialog
			.getByLabel("Document", { exact: true })
			.setInputFiles({ name: "offer.pdf", mimeType: "application/pdf", buffer: Buffer.from("Not a PDF") });
		const refused = page.waitForResponse((r) => r.url().includes("/_webcraft/forms/") && r.status() === 422);
		await dialog.getByRole("button", { name: "Send", exact: true }).click();
		await refused;
		await dialog.locator('[aria-invalid="true"]').waitFor();
		await expectNoAxeViolations(page, `Popup upload error ${theme}`);
		await dialog.getByLabel("Document", { exact: true }).setInputFiles({
			name: "offer.pdf",
			mimeType: "application/pdf",
			buffer: Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n${"x".repeat(500)}\n%%EOF\n`),
		});
		await dialog.getByRole("button", { name: "Send", exact: true }).click();
		await dialog.locator(".wc-form-sent").waitFor();
		expect(await dialog.textContent()).toContain("Thank you. We have received your message.");
		await expectNoAxeViolations(page, `Popup submission success ${theme}`);
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "detached" });
		await page.close();
	});
