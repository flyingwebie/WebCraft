// Code mode in a real browser (ADR 0016): Staff press Code in the editing bar, and the page shows
// the Drafts of the Site's Structure with HTML, CSS and JS panels below it. The panels pass the
// accessibility checks in light and dark, suggestions are chosen and the panels reached from the
// keyboard alone, the page previews markup as it is typed (saving only on Save), selecting an
// element opens its Component with the breadcrumb and where it is used, a changed script runs only
// on Run with its errors in the console, and a save over someone else's gets the conflict prompt.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Cookie, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectAccessibleScreen, expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let postTypeId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";
const ENTRY_TEMPLATE = '<article><Hero heading="{{ title }}" /><p class="intro">{{ subtitle }}</p></article>';

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId] })).account;

	await api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	await api.globals.saveDraft({ siteId, fields: { tagline: "Open every day from seven." } });
	await api.globals.publish({ siteId });
	await api.designSystem.createClass({ siteId, name: "hero", styles: "padding: var(--space-m);" });
	await api.designSystem.createClass({ siteId, name: "hero-title", styles: "font-size: var(--text-xl);" });
	await api.designSystem.createClass({ siteId, name: "intro" });
	await api.designSystem.publish({ siteId });
	const { component } = await api.components.create({
		siteId,
		name: "Hero",
		props: [{ key: "heading", label: "Heading", type: "text", required: true }],
	});
	await api.components.saveMarkup({
		siteId,
		componentId: component.id,
		markup: '<section class="hero"><h1 class="hero-title">{{ props.heading }}</h1></section>',
	});
	await api.components.publish({ siteId, componentId: component.id });
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: [
			'<header><p>Welcome to <a href="/">Acme Bakery</a>.</p><nav aria-label="Main">',
			'<p>Read about <a href="/blog/fresh-bread">fresh bread</a>.</p>',
			"</nav></header>",
			"<main>{{@outlet}}</main>",
			"<footer><p>{{ site.tagline }}</p></footer>",
		].join(""),
	});
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

/** The edit and Code mode cookies from the first time Code mode opened, handed to later pages. */
let cookies: Cookie[] | undefined;

/** A page in Code mode: the first time through "Edit on site" in the admin, then Code in the editing bar. */
async function codeModePage(theme: Theme): Promise<Page> {
	const page = await install.newPage(theme);
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
	await page.getByRole("textbox", { name: "HTML of Blog posts · Entry template" }).waitFor();
	await page.getByRole("textbox", { name: /^JS: / }).waitFor();
	return page;
}

/** The accessible name of what has focus, followed into shadow roots. */
async function focused(page: Page): Promise<string> {
	return page.evaluate(() => {
		let element = document.activeElement as HTMLElement | null;
		while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement as HTMLElement;
		return (element?.getAttribute("aria-label") ?? element?.textContent ?? "").trim();
	});
}

/** The Entry template's Draft as Template markup, as the admin reads it. */
async function draftMarkup(): Promise<string> {
	const { api } = await install.install.superadmin();
	return (await api.templates.getEntryTemplateMarkup({ siteId, postTypeId })).markup?.draft ?? "";
}

for (const theme of THEMES) {
	describe(`Code mode, ${theme}`, () => {
		test("the page with its HTML, CSS and JS panels", async () => {
			const page = await codeModePage(theme);

			await expectAccessibleScreen(page, `Code mode (${theme})`);
		});

		test("suggestions open as {{ is typed and are chosen from the keyboard", async () => {
			const page = await codeModePage(theme);
			const html = page.getByRole("textbox", { name: /^HTML of / });

			await html.focus();
			await page.keyboard.press("ControlOrMeta+End");
			await page.keyboard.type("{{");
			const list = page.getByRole("listbox", { name: "Suggestions" });
			await list.waitFor();
			await expectNoAxeViolations(page, `Code mode › Suggestions (${theme})`);
			expect(await html.getAttribute("aria-activedescendant")).toBeTruthy();

			await page.keyboard.press("ArrowDown");
			await page.keyboard.press("Enter");

			await list.waitFor({ state: "hidden" });
			expect(await html.inputValue()).toEndWith("</article>{{ slug }}");
			expect(await html.getAttribute("aria-activedescendant")).toBeNull();
			expect(await focused(page)).toBe("HTML of Blog posts · Entry template");
		});
	});
}

describe("the keyboard alone", () => {
	test("moves from the HTML panel through the CSS panel to the JS panel and on", async () => {
		const page = await codeModePage("light");
		await page.getByRole("textbox", { name: /^HTML of / }).focus();

		const reached: string[] = [];
		for (let press = 0; press < 40 && !reached.some((name) => name.startsWith("JS: ")); press++) {
			await page.keyboard.press("Tab");
			reached.push(await focused(page));
		}

		const css = reached.findIndex((name) => name.startsWith("CSS: "));
		const js = reached.findIndex((name) => name.startsWith("JS: "));
		expect(css).toBeGreaterThan(-1);
		expect(js).toBeGreaterThan(css);
	});

	test("{{ offers the Components too, placed with their required Props", async () => {
		const page = await codeModePage("light");
		const html = page.getByRole("textbox", { name: /^HTML of / });

		await html.focus();
		await page.keyboard.press("ControlOrMeta+End");
		await page.keyboard.type("{{Her");
		await page.getByRole("option", { name: /<Hero>/ }).waitFor();
		await page.keyboard.press("Enter");

		expect(await html.inputValue()).toEndWith('</article><Hero heading="" />');
	});

	test("{{@ offers the Template commands and presets", async () => {
		const page = await codeModePage("light");
		const html = page.getByRole("textbox", { name: /^HTML of / });

		await html.focus();
		await page.keyboard.press("ControlOrMeta+End");
		await page.keyboard.type("{{@");
		await page.getByRole("option", { name: /\{\{@if\}\}/ }).waitFor();
		await page.keyboard.press("Enter");

		expect(await html.inputValue()).toEndWith("</article>{{@if }}\n{{/if}}");
	});
});

describe("previewing and saving", () => {
	test("the page previews the markup as it is typed; the Draft changes only on Save", async () => {
		const page = await codeModePage("light");
		const html = page.getByRole("textbox", { name: /^HTML of / });
		const typed = (await html.inputValue()).replace("</article>", "<p>Typed in Code mode</p></article>");

		await html.fill(typed);

		await page.locator("main p", { hasText: "Typed in Code mode" }).waitFor();
		expect(await draftMarkup()).not.toContain("Typed in Code mode");

		await page.getByRole("region", { name: "HTML" }).getByRole("button", { name: "Save", exact: true }).click();
		await page.getByText("Saved to Draft · Blog posts · Entry template").first().waitFor();
		expect(await draftMarkup()).toContain("Typed in Code mode");
		await (await install.install.superadmin()).api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup: ENTRY_TEMPLATE,
		});
	});

	test("selecting an element opens its Component, with the breadcrumb, where it is used and its Class", async () => {
		const page = await codeModePage("light");

		await page.locator("main h1").click();

		await page.getByRole("textbox", { name: "HTML of Hero · Component" }).waitFor();
		const crumbs = page.getByRole("navigation", { name: "Where this element comes from" });
		await expect(crumbs.getByRole("button", { name: "Blog posts · Entry template" }).count()).resolves.toBe(1);
		await expect(crumbs.getByRole("button", { name: "h1.hero-title" }).count()).resolves.toBe(1);
		await page.getByText("Hero is used on 1 page: changes apply to it").waitFor();
		await page.getByRole("textbox", { name: "CSS: .hero-title" }).waitFor();
		expect(await page.getByRole("textbox", { name: "CSS: .hero-title" }).inputValue()).toBe(
			"font-size: var(--text-xl);",
		);
		await expectNoAxeViolations(page, "Code mode › a Component selected");

		// Stepping out opens the Template that places it, at the Placement.
		await crumbs.getByRole("button", { name: "Blog posts · Entry template" }).click();
		await page.getByRole("textbox", { name: "HTML of Blog posts · Entry template" }).waitFor();
	});

	test("the layout buttons set declarations in the selected Class", async () => {
		const page = await codeModePage("light");
		await page.locator("main h1").click();
		const css = page.getByRole("textbox", { name: "CSS: .hero-title" });
		await css.waitFor();

		await page.getByRole("button", { name: "Display: flex" }).click();

		expect(await css.inputValue()).toBe("font-size: var(--text-xl);\ndisplay: flex;");
		expect(await page.getByRole("button", { name: "Display: flex" }).getAttribute("aria-pressed")).toBe("true");
	});

	test("a save over someone else's asks whether to reload theirs or overwrite it", async () => {
		const page = await codeModePage("light");
		const html = page.getByRole("textbox", { name: /^HTML of / });
		await (await install.install.superadmin()).api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup: ENTRY_TEMPLATE.replace("</article>", "<p>Theirs</p></article>"),
		});
		await html.fill((await html.inputValue()).replace("</article>", "<p>Mine</p></article>"));
		const save = page.getByRole("region", { name: "HTML" }).getByRole("button", { name: "Save", exact: true });

		await save.click();
		const prompt = page.getByRole("alertdialog", { name: "Someone else saved this" });
		await prompt.waitFor();
		await expectNoAxeViolations(page, "Code mode › conflict prompt");
		await page.keyboard.press("Escape");
		await prompt.waitFor({ state: "hidden" });
		expect(await focused(page)).toBe("Save");

		await save.click();
		await prompt.getByRole("button", { name: "Overwrite with mine" }).click();
		await page.getByText("Saved to Draft · Blog posts · Entry template").first().waitFor();
		expect(await draftMarkup()).toContain("Mine");
		expect(await draftMarkup()).not.toContain("Theirs");
		await (await install.install.superadmin()).api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup: ENTRY_TEMPLATE,
		});
	});
});

describe("CSS and Format", () => {
	test("the page previews unsaved CSS under its strict policy, as the Class will look", async () => {
		const page = await codeModePage("light");
		await page.locator("main h1").click();
		const css = page.getByRole("textbox", { name: "CSS: .hero-title" });
		await css.waitFor();

		await css.fill("font-size: var(--text-xl);\ncolor: rgb(1, 2, 3);");

		await page.waitForFunction(
			() => getComputedStyle(document.querySelector("main h1") as Element).color === "rgb(1, 2, 3)",
		);
		const { api } = await install.install.superadmin();
		const { designSystem } = await api.designSystem.get({ siteId });
		expect(designSystem.draft.classes.find((each) => each.name === "hero-title")?.styles).toBe(
			"font-size: var(--text-xl);",
		);
	});

	test("Format puts block elements on lines of their own, and saving keeps it exactly", async () => {
		const page = await codeModePage("light");
		const html = page.getByRole("textbox", { name: /^HTML of / });
		const region = page.getByRole("region", { name: "HTML" });

		await region.getByRole("button", { name: "Format" }).click();
		const formatted = await html.inputValue();
		expect(formatted).toMatch(/^<article data-wc-id="[^"]+">\n {2}<Hero /);
		expect(formatted).toMatch(/<\/p>\n<\/article>$/);

		await region.getByRole("button", { name: "Save", exact: true }).click();
		await page.getByText("Saved to Draft · Blog posts · Entry template").first().waitFor();
		expect(await draftMarkup()).toBe(formatted);
		expect(await html.inputValue()).toBe(formatted);
		await (await install.install.superadmin()).api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId,
			markup: ENTRY_TEMPLATE,
		});
	});
});

describe("scripts", () => {
	test("a changed script runs only when Run is pressed, with its errors in the console", async () => {
		const page = await codeModePage("light");
		const js = page.getByRole("textbox", { name: /^JS: / });

		await js.fill('document.body.dataset.ran = "yes";\nthrow new Error("Oops from the page script");');
		await page.waitForTimeout(500);
		expect(await page.evaluate(() => document.body.dataset.ran ?? null)).toBeNull();

		await page.getByRole("button", { name: "Run", exact: true }).click();

		const log = page.getByRole("log", { name: "Console" });
		await log.getByText(/Oops from the page script/).waitFor();
		expect(await page.evaluate(() => document.body.dataset.ran ?? null)).toBe("yes");
		await expectNoAxeViolations(page, "Code mode › the console with an error");
	});
});
