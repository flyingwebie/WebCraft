// Format in the admin's Design system, in a real browser (SPEC 5.1): the Site's custom CSS box, its
// Format button and note, ⇧⌥F, one Undo step, broken CSS left as typed with its line marked, and the
// accessibility checks in light and dark. Format in the building area's code panes (Prettier served
// from the Site's domain under its strict policy) is `building-area-code`'s and `-panes`' checks.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { format } from "@webcraft/server/code-format";
import type { Locator, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
const slug = "bakery";
const ENTRY_TEMPLATE = '<article><h1>{{ title }}</h1><p class="intro">{{ subtitle }}</p></article>';

const openedPages: Page[] = [];
async function testPage(theme: Theme) {
	const page = await install.newPage(theme);
	page.setDefaultTimeout(15000);
	openedPages.push(page);
	return page;
}
afterEach(async () => {
	await Promise.all(openedPages.splice(0).map((page) => page.close()));
	await (
		await install.install.superadmin()
	).api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId,
		markup: ENTRY_TEMPLATE,
	});
});

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId] })).account;
	await api.designSystem.createClass({ siteId, name: "intro" });
	await api.designSystem.publish({ siteId });
	const site = await api.templates.saveSiteTemplateMarkup({ siteId, markup: "<main>{{@outlet}}</main>" });
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [{ key: "subtitle", label: "Subtitle", type: "text" }],
	});
	postTypeId = postType.id;
	const entry = await api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup: ENTRY_TEMPLATE });
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: post } = await api.entries.create({
		siteId,
		postTypeId,
		title: "Fresh bread",
		fields: { subtitle: "Out of the oven at seven" },
	});
	await api.entries.publish({ siteId, entryId: post.id });
});

afterAll(async () => {
	await install.close();
});

/** What the module makes of a text: what every box must show after Format. */
async function formatted(text: string, language: "html" | "css" | "js"): Promise<string> {
	const result = await format(text, language);
	if (!result.ok) throw new Error(result.reason);
	return result.text;
}

/** Waits until `read` answers `expected`, then checks it (so a failure shows the last answer). */
async function settles<Value>(read: () => Promise<Value>, expected: Value, timeout = 5000): Promise<void> {
	const until = Date.now() + timeout;
	let value = await read();
	while (!Bun.deepEquals(value, expected) && Date.now() < until) {
		await Bun.sleep(50);
		value = await read();
	}
	expect(value as unknown).toEqual(expected as unknown);
}

function selection(box: Locator) {
	return box.evaluate((area: HTMLTextAreaElement) => ({ start: area.selectionStart, end: area.selectionEnd }));
}

describe("Format in the Design system", () => {
	/**
	 * The Custom CSS tab, from an empty custom CSS: each pass starts from the same Draft, whatever the
	 * pass before left in it (its last edit may still be saving when its page closes).
	 */
	async function customCss(theme: Theme): Promise<{ page: Page; css: Locator }> {
		const { api } = await install.install.superadmin();
		await api.designSystem.saveDraft({ siteId, customCss: "" });
		const page = await testPage(theme);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}/design-system?tab=css`));
		const css = page.getByLabel("The Site's custom CSS");
		await css.waitFor();
		// Type only once the page is live: the box is in the server's HTML first, and taking it over
		// sets its value again, which moves the caret to the end, so text typed over a selection
		// before then lands after it instead.
		await css.evaluate(
			(area) =>
				new Promise<void>((resolve) => {
					const live = () => Object.keys(area).some((key) => key.startsWith("__reactProps"));
					const check = () => (live() ? resolve() : requestAnimationFrame(check));
					check();
				}),
		);
		expect(await css.inputValue()).toBe("");
		return { page, css };
	}

	for (const theme of THEMES)
		test(`the Site's custom CSS: Format with its word, ⇧⌥F, Undo and broken CSS, ${theme}`, async () => {
			const { page, css } = await customCss(theme);
			const messy = ".notice{color:var(--primary-70);padding:var(--space-m)}";
			await css.fill(messy);
			await page.getByRole("button", { name: "Format", exact: true }).click();
			const expected = await formatted(messy, "css");
			await settles(() => css.inputValue(), expected);
			await page.getByText("Formatted · 4 lines changed").waitFor();
			await page.getByRole("button", { name: "Formatted", exact: true }).waitFor();
			await expectNoAxeViolations(page, `Design system › Custom CSS formatted (${theme})`, [], {
				exclude: ["iframe[data-design-preview]"],
			});

			// One step back: the CSS as it was typed.
			await css.focus();
			await page.keyboard.press("ControlOrMeta+z");
			await settles(() => css.inputValue(), messy);

			// ⇧⌥F, with the caret in the box: already tidy the second time.
			await css.press("Alt+Shift+KeyF");
			await settles(() => css.inputValue(), expected);
			await page.getByRole("button", { name: "Format", exact: true }).waitFor({ timeout: 4000 });
			await css.press("Alt+Shift+KeyF");
			await page.getByText("Already tidy").waitFor();
			// The Draft saves the formatted CSS like any other edit.
			const { api } = await install.install.superadmin();
			await settles(async () => (await api.designSystem.get({ siteId })).designSystem.draft.customCss, expected, 10000);

			const broken = ".a {\n  color: red;\n}}\n";
			await css.fill(broken);
			await page.getByRole("button", { name: "Format", exact: true }).click();
			await page.getByRole("button", { name: "Can't format: unexpected } on line 3" }).waitFor();
			expect(await css.inputValue()).toBe(broken);
			expect(await css.getAttribute("aria-invalid")).toBe("true");
			await expectNoAxeViolations(page, `Design system › Custom CSS can't be formatted (${theme})`, [], {
				exclude: ["iframe[data-design-preview]"],
			});
			// The note takes the caret to the line.
			await page.getByRole("button", { name: "Can't format: unexpected } on line 3" }).click();
			expect(await selection(css)).toEqual({ start: broken.indexOf("}}"), end: broken.indexOf("}}") });
		});
});
