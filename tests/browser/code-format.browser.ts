// Format in the code boxes, in a real browser (SPEC 5.1): in Code mode on the Site (Prettier served from
// the Site's domain under its strict policy) and in the admin's Design system. The { } button and its
// note under the box, ⇧⌥F with the caret in the box (the caret stays on its word), a selection
// formatting only its lines, one Undo step, broken code left as typed with its line marked, the
// Command menu's Format commands, and the accessibility checks in light and dark.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { format } from "@webcraft/server/code-format";
import type { Cookie, Locator, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, pageErrors, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";
const ENTRY_TEMPLATE = '<article><p class="intro">{{ subtitle }}</p></article>';

const openedPages: Page[] = [];
async function testPage(theme: Theme) {
	const page = await install.newPage(theme);
	page.setDefaultTimeout(15000);
	openedPages.push(page);
	return page;
}
afterEach(async () => {
	await Promise.all(openedPages.splice(0).map((page) => page.close()));
	await (await install.install.superadmin()).api.templates.saveEntryTemplateMarkup({
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

let cookies: Cookie[] | undefined;

/** A page in Code mode: the first time through "Edit on site" in the admin, then Code in the editing bar. */
async function codeModePage(theme: Theme): Promise<Page> {
	const page = await testPage(theme);
	if (cookies) {
		await page.context().addCookies(cookies);
		await page.goto(install.siteUrl(slug, path));
	} else {
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname === new URL(install.siteUrl(slug, "/")).hostname);
		await page.goto(install.siteUrl(slug, path));
		await page.getByRole("button", { name: "Code", exact: true }).click();
		await page.getByRole("textbox", { name: /^HTML of / }).waitFor();
		cookies = (await page.context().cookies()).filter((cookie) => cookie.name.startsWith("webcraft."));
	}
	await page.getByRole("textbox", { name: /^JS: / }).waitFor();
	await page
		.getByRole("textbox", { name: /^HTML of / })
		.and(page.locator(":not([readonly])"))
		.waitFor();
	return page;
}

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

/** Reports of the page's policy refusing something: Format must load and run without any. */
function policyReports(page: Page): string[] {
	return pageErrors(page).filter((error) => /Content Security Policy|unsafe-eval|unsafe-inline/i.test(error));
}

describe("Format in Code mode", () => {
	test("the { } button formats the HTML panel with Prettier, says how many lines changed, and Undo is one step", async () => {
		const page = await codeModePage("light");
		const html = page.getByRole("textbox", { name: /^HTML of / });
		const region = page.getByRole("region", { name: "HTML" });
		const messy = '<article><p class="intro">{{ subtitle }}</p><p>{{ title }}</p></article>';
		await html.fill(messy);
		await page.waitForTimeout(400);

		const button = region.getByRole("button", { name: "Format", exact: true });
		expect(await button.getAttribute("aria-keyshortcuts")).toBe("Alt+Shift+F");
		await button.click();
		const expected = await formatted(messy, "html");
		await settles(() => html.inputValue(), expected);
		const note = region.locator("[data-format-note]");
		await note.getByText(/^Formatted · \d+ lines changed$/).waitFor();
		await region.locator('[data-format-button][data-format-phase="done"]').waitFor();
		// The check and the line under the box stay 2 s.
		await region.locator('[data-format-button][data-format-phase="rest"]').waitFor({ timeout: 4000 });
		expect((await note.textContent())?.trim() ?? "").toBe("");

		await html.focus();
		await page.keyboard.press("ControlOrMeta+z");
		await settles(() => html.inputValue(), messy);
		expect(policyReports(page)).toEqual([]);
	});

	test("⇧⌥F in the JS panel keeps the caret on its word; a selection formats only its lines", async () => {
		const page = await codeModePage("light");
		const js = page.getByRole("textbox", { name: /^JS: / });
		const messy = "const hero=document.querySelector('.hero');if(hero){hero.classList.add('is-ready')}";
		await js.fill(messy);
		const at = messy.indexOf("classList");
		await js.evaluate((area: HTMLTextAreaElement, offset) => area.setSelectionRange(offset, offset), at + 3);
		await js.press("Alt+Shift+KeyF");
		const expected = await formatted(messy, "js");
		await settles(() => js.inputValue(), expected);
		const caret = (await selection(js)).start;
		expect(expected.slice(caret - 3, caret + 6)).toBe("classList");

		const lines = ["let a=1", "let b=2", "let c=3"] as const;
		await js.fill(lines.join("\n"));
		const start = lines[0].length + 1;
		await js.evaluate((area: HTMLTextAreaElement, [from, to]) => area.setSelectionRange(from, to), [
			start,
			start + lines[1].length,
		] as const);
		await js.press("Alt+Shift+KeyF");
		await settles(() => js.inputValue(), "let a=1\nlet b = 2;\nlet c=3");
		await page.getByRole("region", { name: "JS" }).getByText("Formatted · 1 line changed").waitFor();
	});

	test("broken markup: nothing changes, the line is marked, and the reason with its line; the Draft keeps it as typed", async () => {
		const page = await codeModePage("light");
		const html = page.getByRole("textbox", { name: /^HTML of / });
		const region = page.getByRole("region", { name: "HTML" });
		const broken = '<article>\n  <p class="intro">{{ subtitle }}\n</article>';
		await html.fill(broken);
		await region.getByRole("button", { name: "Format", exact: true }).click();
		await region.getByText(/^Can't format: .+ on line 3$/).waitFor();
		expect(await html.inputValue()).toBe(broken);
		expect(await region.locator('[data-format-button][data-format-phase="failed"]').count()).toBe(1);
		expect(await region.locator(".gutter .has-problem").allTextContents()).toEqual(["3"]);
		await expectNoAxeViolations(page, "Code mode › Format couldn't read the markup");

		// Typing clears the mark.
		await html.press("End");
		await html.pressSequentially(" ");
		await region.locator('[data-format-button][data-format-phase="rest"]').waitFor();
		expect(await region.locator(".gutter .has-problem").count()).toBe(0);
	});

	test("the Command menu formats each panel and all three", async () => {
		const page = await codeModePage("dark");
		const js = page.getByRole("textbox", { name: /^JS: / });
		await js.fill("const a=1");
		await page.locator("main p").first().click();
		await page.keyboard.press("ControlOrMeta+k");
		const menu = page.getByRole("dialog", { name: "Command menu" });
		await menu.waitFor();
		await menu.getByRole("combobox").fill("Format");
		for (const name of ["Format HTML", "Format CSS", "Format JS", "Format all three"])
			await menu.getByRole("option", { name: new RegExp(`^${name}`) }).waitFor();
		await expectNoAxeViolations(page, "Code mode › the Command menu's Format commands (dark)");
		await menu.getByRole("option", { name: /^Format JS/ }).click();
		await settles(() => js.inputValue(), "const a = 1;");
		expect(policyReports(page)).toEqual([]);
	});

	for (const theme of THEMES)
		test(`the button and the line under the box pass the checks, ${theme}`, async () => {
			const page = await codeModePage(theme);
			const html = page.getByRole("textbox", { name: /^HTML of / });
			await html.fill('<article><p class="intro">{{ subtitle }}</p><p>{{ title }}</p></article>');
			await page.getByRole("region", { name: "HTML" }).getByRole("button", { name: "Format", exact: true }).click();
			await page
				.getByRole("region", { name: "HTML" })
				.getByText(/^Formatted · /)
				.waitFor();
			await expectNoAxeViolations(page, `Code mode › formatted (${theme})`);
		});
});

describe("Format in the Design system", () => {
	async function customCss(theme: Theme): Promise<{ page: Page; css: Locator }> {
		const page = await testPage(theme);
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}/design-system?tab=css`));
		const css = page.getByLabel("The Site's custom CSS");
		await css.waitFor();
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

			const broken = ".a {\n  color: red;\n}}\n";
			await css.fill(broken);
			await page.getByRole("button", { name: "Format", exact: true }).click();
			await page.getByRole("button", { name: "Can't format: unexpected } on line 3" }).waitFor();
			expect(await css.inputValue()).toBe(broken);
			expect(await css.getAttribute("aria-invalid")).toBe("true");
			await expectNoAxeViolations(page, `Design system › Custom CSS can't be formatted (${theme})`, [], {
				exclude: ["iframe[data-design-preview]"],
			});
			// The note takes the caret to the line; the Draft saves the CSS as typed.
			await page.getByRole("button", { name: "Can't format: unexpected } on line 3" }).click();
			expect(await selection(css)).toEqual({ start: broken.indexOf("}}"), end: broken.indexOf("}}") });
			const { api } = await install.install.superadmin();
			await settles(async () => (await api.designSystem.get({ siteId })).designSystem.draft.customCss, broken, 10000);
		});
});
