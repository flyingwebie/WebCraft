// Forms in a real browser, in the device's light and dark themes: a Form on a Site's page, the same
// page sent back with errors, and the message once it is sent, each checked with axe-core and the
// keyboard; the error summary takes focus and its links move focus to their fields. Then the Form
// builder in the admin, from the keyboard.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectOverlayUsable } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let formId: string;
const slug = "bakery";
const PAGE = "/visit/contact";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	await api.modules.approve({ moduleId: "forms", version: "1.1.0" });
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Ciara Byrne" })).account;
	const { form } = await api.forms.create({ siteId, name: "Wedding cake enquiry", key: "contact" });
	formId = form.id;
	await api.forms.saveDraft({
		siteId,
		formId,
		form: {
			fields: [
				{ key: "name", type: "text", label: "Your name", required: true, autocomplete: "name" },
				{ key: "email", type: "email", label: "Email", required: true, help: "We reply here." },
				{ key: "phone", type: "phone", label: "Phone" },
				{ key: "website", type: "url", label: "Your website" },
				{
					key: "cake",
					type: "select",
					label: "Cake",
					options: [
						{ value: "single", label: "Single tier" },
						{ value: "tiered", label: "Tiered" },
					],
				},
				{ key: "tiers", type: "number", label: "Tiers", min: 2, max: 6, integer: true },
				{ key: "date", type: "date", label: "Wedding date" },
				{
					key: "venue",
					type: "radio",
					label: "Venue",
					required: true,
					options: [
						{ value: "hotel", label: "Hotel" },
						{ value: "home", label: "Home" },
					],
				},
				{
					key: "extras",
					type: "checkboxes",
					label: "Extras",
					options: [
						{ value: "candles", label: "Candles" },
						{ value: "topper", label: "Topper" },
					],
				},
				{ key: "message", type: "textarea", label: "Message", hideLabel: true },
				{ key: "consent", type: "consent", label: "I agree to be contacted about my order", required: true },
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
		markup: "<article><h1>{{ title }}</h1>{{@form contact}}</article>",
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: contact } = await api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Contact",
		slug: "contact",
	});
	await api.entries.publish({ siteId, entryId: contact.id });
	await api.designSystem.saveDraft({ siteId, darkMode: true });
	await api.designSystem.publish({ siteId });
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`a Form on a Site's page, ${theme}`, () => {
		test("the page with the Form", async () => {
			const page = await install.newPage(theme);
			await page.goto(install.siteUrl(slug, PAGE));
			await page.waitForLoadState("load");

			await expectAccessibleScreen(page, `a page with a Form (${theme})`);
		});

		test("sent back with errors: the summary takes focus, and each of its links goes to its field", async () => {
			const page = await install.newPage(theme);
			await page.goto(install.siteUrl(slug, PAGE));
			await page.getByRole("button", { name: "Send" }).focus();
			await Promise.all([page.waitForURL(`**/_webcraft/forms/${formId}`), page.keyboard.press("Enter")]);
			await page.waitForLoadState("load");

			expect(await page.title()).toBe("Error: Contact · Acme Bakery");
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("wc-form-1-errors");
			await expectAccessibleScreen(page, `a Form sent back with errors (${theme})`);

			await page.getByRole("link", { name: "Email: Enter a value." }).focus();
			await page.keyboard.press("Enter");
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("wc-form-1-email");
			await page.getByRole("link", { name: "Venue: Choose an option." }).focus();
			await page.keyboard.press("Enter");
			expect(await page.evaluate(() => document.activeElement?.id)).toBe("wc-form-1-venue-0");
		});

		test("sent: the message shows in place of the Form", async () => {
			const page = await install.newPage(theme);
			await page.goto(install.siteUrl(slug, PAGE));
			await page.getByLabel("Your name").fill("Ada");
			await page.getByLabel("Email").fill("ada@example.com");
			await page.getByLabel("Hotel").check();
			await page.getByLabel("I agree to be contacted about my order").check();
			await Promise.all([
				page.waitForURL(/\/visit\/contact\?wc-sent=1#wc-form-1$/),
				page.getByRole("button", { name: "Send" }).click(),
			]);
			await page.waitForLoadState("load");

			await expect(page.getByRole("status").textContent()).resolves.toBe("Thank you. We have received your message.");
			expect(await page.evaluate(() => document.activeElement?.className)).toBe("wc-form-sent");
			await expectAccessibleScreen(page, `a Form once sent (${theme})`);
		});
	});

	describe(`the Form builder, ${theme}`, () => {
		test("the Site's Forms", async () => {
			const page = await install.newPage(theme);
			await install.signIn(page, staff);
			await page.goto(install.adminUrl(`/sites/${siteId}/forms`));
			await page.waitForLoadState("networkidle");

			await expectAccessibleScreen(page, `Site › Forms (${theme})`);
		});

		for (const tab of ["Build", "Settings", "Translations"]) {
			test(`a Form, its ${tab} tab`, async () => {
				const page = await install.newPage(theme);
				await install.signIn(page, staff);
				await page.goto(install.adminUrl(`/sites/${siteId}/forms/${formId}`));
				await page.waitForLoadState("networkidle");
				await page.getByRole("tab", { name: tab }).click();

				await expectAccessibleScreen(page, `Site › Form, ${tab} (${theme})`);
			});
		}
	});
}

describe("building a Form from the keyboard", () => {
	test("a field is added from the palette, chosen, and moved from its menu", async () => {
		const page = await install.newPage("light");
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}/forms/${formId}`));
		await page.waitForLoadState("networkidle");

		await page.getByRole("button", { name: "Add Phone" }).focus();
		await page.keyboard.press("Enter");
		const added = page.getByRole("button", { name: /^Phone\b/ }).last();
		await expect(added.getAttribute("aria-current")).resolves.toBe("true");
		expect(await page.getByLabel("Field key").inputValue()).toBe("phone_2");
		await page.getByLabel("Label", { exact: true }).fill("Mobile");
		await expectOverlayUsable(
			page,
			page.getByRole("button", { name: "Actions for Mobile" }),
			"menu",
			"a field's menu (light)",
		);

		await page.getByRole("button", { name: "Actions for Mobile" }).focus();
		await page.keyboard.press("Enter");
		await page.getByRole("menuitem", { name: "Move up" }).focus();
		await page.keyboard.press("Enter");
		const labels = await page.locator("ol > li").evaluateAll((items) => items.map((item) => item.textContent ?? ""));
		expect(labels.at(-2)).toContain("Mobile");
		expect(await page.getByText("Unsaved changes").isVisible()).toBe(true);
	});
});
