// A Form with steps, conditions and a file field in a real browser, in light and dark, with the forms
// script: one step at a time with its progress, Next checking the step (errors next to their fields,
// focus on the first, a live region saying how many), conditions showing and hiding fields and a
// section as the visitor fills it in, and the Form sent without a reload, its message taking its
// place. Without the forms script, every step shows on one page. Each state is checked with axe-core and
// the keyboard. Then the Form builder's new settings: a step, a file field's formats, and a condition
// made from the keyboard.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import forms from "@webcraft/module-forms";

import type { Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, forgetPageErrors, pageErrors, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let owner: TestAccount;
let siteId: string;
let formId: string;
const slug = "bakery";
const PAGE = "/visit/order";
const PDF = Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n${"x".repeat(500)}\n%%EOF\n`);

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	await api.modules.approve({ moduleId: "forms", version: forms.manifest.version });
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await install.goLive(siteId);
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Ciara Byrne" })).account;
	owner = (await local.createMember({ workspaceId, role: "owner" })).account;
	const { form } = await api.forms.create({ siteId, name: "Cake order", key: "order" });
	formId = form.id;
	await api.forms.saveDraft({
		siteId,
		formId,
		form: {
			fields: [
				{ key: "about_you", type: "step", label: "About you" },
				{ key: "name", type: "text", label: "Your name", required: true, autocomplete: "name" },
				{
					key: "contact_by",
					type: "radio",
					label: "Contact me by",
					required: true,
					options: [
						{ value: "email", label: "Email" },
						{ value: "phone", label: "Phone" },
					],
				},
				{
					key: "email",
					type: "email",
					label: "Email address",
					required: true,
					condition: { match: "all", rules: [{ field: "contact_by", op: "is", value: "email" }] },
				},
				{
					key: "phone",
					type: "phone",
					label: "Phone number",
					required: true,
					condition: { match: "all", rules: [{ field: "contact_by", op: "is", value: "phone" }] },
				},
				{
					key: "the_cake",
					type: "step",
					label: "The cake",
					condition: { match: "all", rules: [{ field: "contact_by", op: "isNot", value: "email" }] },
				},
				{
					key: "cake",
					type: "select",
					label: "Cake",
					required: true,
					options: [
						{ value: "single", label: "Single tier" },
						{ value: "tiered", label: "Tiered" },
					],
				},
				{
					key: "tiers_section",
					type: "section",
					label: "Tiers",
					help: "Only for tiered cakes.",
					condition: { match: "all", rules: [{ field: "cake", op: "is", value: "tiered" }] },
				},
				{ key: "tiers", type: "number", label: "How many tiers", required: true, min: 2, max: 6, integer: true },
				{ key: "design_section", type: "section", label: "Your design" },
				{ key: "sketch", type: "file", label: "A sketch of your cake", accept: ["pdf", "png", "jpeg"] },
			],
			// The browser sends at once; the time trap is checked at seam 1.
			spam: { minFillSeconds: 0, perMinute: 100, perHour: 1000 },
		},
	});
	await api.forms.publish({ siteId, formId });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header><p><a href="/">Acme Bakery</a></p></header><main>{{@outlet}}</main><footer><p>Open every day.</p></footer>',
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({ siteId, name: "Visits", urlPattern: "/visit/{slug}" });
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1>{{@form order}}</article>",
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: order } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Order", slug: "order" });
	await api.entries.publish({ siteId, entryId: order.id });
	await api.designSystem.saveDraft({ siteId, darkMode: true });
	await api.designSystem.publish({ siteId });
});

afterAll(async () => {
	await install.close();
});

/**
 * The page as a browser sees it when the forms script doesn't run (switched off, or never loaded):
 * the Form is posted as the browser posts it.
 */
async function withoutFormsScript(page: Page): Promise<Page> {
	// WebCraft's scripts are hashed files under /_wc/js/: the forms script is the one sending its header.
	await page.route("**/_wc/js/*.js", async (route) => {
		const response = await route.fetch();
		if (!(await response.text()).includes("x-webcraft-form")) return route.fulfill({ response });
		return route.fulfill({ status: 200, contentType: "text/javascript", body: "" });
	});
	return page;
}

for (const theme of THEMES) {
	describe(`a Form with steps, ${theme}`, () => {
		test("with the forms script: one step at a time, Next checks it, conditions show what applies, sent in place", async () => {
			const page = await install.newPage(theme);
			await page.goto(install.liveUrl(slug, PAGE));
			await page.waitForLoadState("load");
			const progress = page.locator(".wc-form-progress");
			await progress.waitFor();

			// The first step shows, with the progress; the second waits.
			await expect(page.getByLabel("Your name").isVisible()).resolves.toBe(true);
			await expect(page.getByLabel(/^Cake/).isVisible()).resolves.toBe(false);
			await expect(page.getByRole("button", { name: "Send" }).isVisible()).resolves.toBe(false);
			await expect(progress.locator('[aria-current="step"]').textContent()).resolves.toBe("About you");
			// Neither the email nor the phone field shows until the visitor says how to contact them.
			await expect(page.getByLabel("Email address").isVisible()).resolves.toBe(false);
			await expect(page.getByLabel("Phone number").isVisible()).resolves.toBe(false);
			await expectAccessibleScreen(page, `a Form's first step (${theme})`);

			// Next checks the step: each error next to its field, focus on the first, a live region says how many.
			await page.getByRole("button", { name: "Next" }).focus();
			await page.keyboard.press("Enter");
			await expect(page.evaluate(() => document.activeElement?.id)).resolves.toBe("wc-form-1-name");
			await expect(page.locator("#wc-form-1-name-error").textContent()).resolves.toBe("Error: Enter a value.");
			await expect(page.getByLabel("Your name").getAttribute("aria-invalid")).resolves.toBe("true");
			await expect(page.getByLabel("Your name").getAttribute("aria-describedby")).resolves.toContain(
				"wc-form-1-name-error",
			);
			await expect(page.locator(".wc-form-status").textContent()).resolves.toBe("There is a problem: 2 errors.");
			await expectAccessibleScreen(page, `a Form's step with errors (${theme})`);

			await page.keyboard.type("Siobhán Murphy");
			await page.getByLabel("Phone", { exact: true }).check();
			await expect(page.getByLabel("Phone number").isVisible()).resolves.toBe(true);
			await expect(page.getByLabel("Email address").isVisible()).resolves.toBe(false);
			await page.getByLabel("Phone number").fill("+353 1 234 5678");
			await page.getByRole("button", { name: "Next" }).focus();
			await page.keyboard.press("Enter");

			// The next step takes focus, and the progress follows.
			await expect(page.evaluate(() => document.activeElement?.id)).resolves.toBe("wc-form-1-the_cake");
			await expect(progress.locator('[aria-current="step"]').textContent()).resolves.toBe("The cake");
			await expect(page.locator(".wc-form-status").textContent()).resolves.toBe("Step 2 of 2");
			await expect(page.getByRole("group", { name: "Tiers", exact: true }).isVisible()).resolves.toBe(false);
			await page.getByLabel(/^Cake/).selectOption("tiered");
			await expect(page.getByRole("group", { name: "Tiers", exact: true }).isVisible()).resolves.toBe(true);
			await page.getByLabel("How many tiers").fill("3");

			await page.getByLabel("A sketch of your cake").setInputFiles({
				name: "sketch.pdf",
				mimeType: "application/pdf",
				buffer: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'),
			});
			const errorsBeforeUpload = pageErrors(page).length;
			const refusedUpload = page.waitForResponse(
				(response) => response.url().includes("/_webcraft/forms/") && response.status() === 422,
			);
			await page.getByRole("button", { name: "Send" }).focus();
			await page.keyboard.press("Enter");
			await page.locator("#wc-form-1-sketch-error").waitFor();
			expect((await refusedUpload).status()).toBe(422);
			// Chromium reports the deliberately refused fetch as a resource error.
			forgetPageErrors(
				page,
				errorsBeforeUpload,
				(error) =>
					error === "Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)",
			);
			await expect(page.evaluate(() => document.activeElement?.id)).resolves.toBe("wc-form-1-sketch");
			await expect(page.getByLabel("A sketch of your cake").getAttribute("aria-describedby")).resolves.toContain(
				"wc-form-1-sketch-error",
			);
			await expectAccessibleScreen(page, `a server-refused upload (${theme})`);

			await page.getByLabel("A sketch of your cake").setInputFiles({
				name: "sketch.pdf",
				mimeType: "application/pdf",
				buffer: PDF,
			});
			await expectAccessibleScreen(page, `a Form's last step (${theme})`);

			// Sent without a reload: the Form's message takes its place, and focus.
			const before = page.url();
			await page.getByRole("button", { name: "Send" }).focus();
			await page.keyboard.press("Enter");
			await page.locator(".wc-form-sent").waitFor();
			expect(page.url()).toBe(before);
			await expect(page.getByRole("status").first().textContent()).resolves.toBe(
				"Thank you. We have received your message.",
			);
			await expect(page.evaluate(() => document.activeElement?.className)).resolves.toBe("wc-form-sent");
			await expectAccessibleScreen(page, `a Form sent by the forms script (${theme})`);
		});

		test("a conditional step leaves the progress and tab order, and Back restores the first step", async () => {
			const page = await install.newPage(theme);
			await page.goto(install.liveUrl(slug, PAGE));
			await page.locator(".wc-form-progress").waitFor();
			await page.getByLabel("Your name").fill("Siobhán");
			await page.getByLabel("Email", { exact: true }).check();
			await page.getByLabel("Email address").fill("siobhan@example.ie");
			await expect(page.locator(".wc-form-progress li:visible").count()).resolves.toBe(1);
			await expect(page.getByRole("button", { name: "Send" }).isVisible()).resolves.toBe(true);
			await expect(page.getByRole("button", { name: "Next" }).isVisible()).resolves.toBe(false);
			await expectAccessibleScreen(page, `a hidden conditional step (${theme})`);
			await page.getByLabel("Phone", { exact: true }).check();
			await page.getByLabel("Phone number").fill("+353 1 234 5678");
			await page.getByRole("button", { name: "Next" }).focus();
			await page.keyboard.press("Enter");
			await page.getByRole("button", { name: "Back" }).focus();
			await page.keyboard.press("Enter");
			await expect(page.evaluate(() => document.activeElement?.id)).resolves.toBe("wc-form-1-about_you");
			await expect(page.getByLabel("Phone number").inputValue()).resolves.toBe("+353 1 234 5678");
		});

		test("without the forms script, every step shows on one page", async () => {
			const page = await withoutFormsScript(await install.newPage(theme));
			await page.goto(install.liveUrl(slug, PAGE));
			await page.waitForLoadState("load");

			await expect(page.getByRole("group", { name: "About you" }).isVisible()).resolves.toBe(true);
			await expect(page.getByRole("group", { name: "The cake" }).isVisible()).resolves.toBe(true);
			await expect(page.getByLabel("A sketch of your cake").isVisible()).resolves.toBe(true);
			await expect(page.getByRole("button", { name: "Next" }).isVisible()).resolves.toBe(false);
			await expectAccessibleScreen(page, `a Form with steps, without JavaScript (${theme})`);
		});
	});

	describe(`the Form builder's new settings, ${theme}`, () => {
		for (const [item, label] of [
			["a step", "The cake"],
			["a file field", "A sketch of your cake"],
			["a field with a condition", "Phone number"],
		] as const) {
			test(`${item}, selected`, async () => {
				const page = await install.newPage(theme);
				await install.signIn(page, staff);
				await page.goto(install.adminUrl(`/sites/${siteId}/forms/${formId}?tab=build`));
				await page.waitForLoadState("networkidle");
				await page.getByRole("button", { name: new RegExp(`^${label}\\b`) }).click();
				await page.getByRole("group", { name: "When it shows" }).waitFor();

				await expectAccessibleScreen(page, `Site › Form, Build: ${item} (${theme})`);
			});
		}
	});
}

describe("building a richer Form from the keyboard", () => {
	test("a step and a file field are added from the palette; a condition is made for a field", async () => {
		const page = await install.newPage("light");
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}/forms/${formId}?tab=build`));
		await page.waitForLoadState("networkidle");

		await page.getByRole("button", { name: "Add Step" }).focus();
		await page.keyboard.press("Enter");
		expect(await page.getByLabel("Field key").inputValue()).toBe("step");
		await page.getByRole("button", { name: "Add File upload" }).focus();
		await page.keyboard.press("Enter");
		expect(await page.getByLabel("Field key").inputValue()).toBe("file");
		await expect(page.getByRole("checkbox", { name: ".pdf", exact: true }).isChecked()).resolves.toBe(true);
		await page.getByRole("checkbox", { name: ".docx", exact: true }).focus();
		await page.keyboard.press("Space");
		await expect(page.getByRole("checkbox", { name: ".docx", exact: true }).isChecked()).resolves.toBe(true);

		await page.getByRole("button", { name: "Add a rule" }).focus();
		await page.keyboard.press("Enter");
		await page.getByLabel("Field", { exact: true }).selectOption({ label: "Cake" });
		await page.getByLabel("Comparison").selectOption({ label: "is" });
		await page.getByLabel("Value").selectOption({ label: "Tiered" });
		await expect(page.getByRole("group", { name: "Rule 1" }).isVisible()).resolves.toBe(true);
		expect(await page.getByText("Unsaved changes").isVisible()).toBe(true);
		await page.getByRole("button", { name: "Save Draft", exact: true }).focus();
		await page.keyboard.press("Enter");
		await page.getByText("Unsaved changes").waitFor({ state: "hidden" });
		await page.reload();
		await page.getByRole("button", { name: /^File upload/ }).click();
		await expect(page.getByRole("checkbox", { name: ".docx", exact: true }).isChecked()).resolves.toBe(true);
		expect(await page.getByLabel("Field", { exact: true }).inputValue()).toBe("cake");
		expect(await page.getByLabel("Value").inputValue()).toBe("tiered");
	});

	for (const theme of THEMES) {
		test(`an Owner changes the Notification attachment cap from the keyboard, ${theme}`, async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, owner);
			await page.goto(install.adminUrl(`/sites/${siteId}/forms/${formId}?tab=emails`));
			const cap = page.getByLabel("Attach files to Notifications up to (MB)");
			await cap.fill(theme === "light" ? "4" : "0");
			await expectAccessibleScreen(page, `Notification attachment settings (${theme})`);
			await page.getByRole("button", { name: "Save Draft", exact: true }).focus();
			await page.keyboard.press("Enter");
			await page.getByText("Unsaved changes").waitFor({ state: "hidden" });
			await page.reload();
			await cap.waitFor();
			expect(await cap.inputValue()).toBe(theme === "light" ? "4" : "0");
		});
	}

	test("a Submission's file is a link to download it", async () => {
		const reader = await install.install.signIn(owner);
		const { submissions } = await moduleApi<typeof forms>(reader, "forms").submissions.list({ siteId, formId });
		const sent = submissions.find((one) => one.values.some((value) => value.key === "sketch"));
		expect(sent).toBeDefined();
		const page = await install.newPage("light");
		await install.signIn(page, owner);
		await page.goto(install.adminUrl(`/sites/${siteId}/forms/${formId}?tab=submissions&submission=${sent?.id}`));

		const link = page.getByRole("link", { name: "Download sketch.pdf" });
		await link.waitFor();
		await expectAccessibleScreen(page, "Site › Form, a Submission with a file (light)");
		const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
		expect(download.suggestedFilename()).toBe("sketch.pdf");
	});
});
