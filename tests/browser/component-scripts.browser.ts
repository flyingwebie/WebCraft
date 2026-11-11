// Component scripts in a real browser (GLOSSARY.md, ADR 0022, ADR 0023): the function a Component's
// script exports runs once for each of its Placements' roots, each call on its own (one that throws
// doesn't stop the others), a Component placed inside another getting its own call; only exposed
// Props reach the root as `data-` attributes; the Site script runs first, then the Component scripts,
// then the page script; a script in a Consent category the visitor hasn't accepted doesn't run. In
// Edit mode it also runs for Placements added later, and Code mode's JS panel has a Component tab for
// the Placement selected, showing its errors in the console against that Placement.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Cookie, Page } from "playwright";

import type { TestAccount } from "../harness/index.ts";
import { expectNoAxeViolations } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES, type Theme } from "./harness.ts";

let install: BrowserInstall;
let staff: TestAccount;
let siteId: string;
let counterId: string;
const slug = "bakery";
const path = "/blog/fresh-bread";

const COUNTER = `(window.order ||= []).push("counter");
export default function (root) {
	root.dataset.calls = String(Number(root.dataset.calls || 0) + 1);
	root.dataset.seen = root.dataset.label + "|" + (root.dataset.secret ?? "none");
	if (root.dataset.label === "Broken") throw new Error("Counter broke");
}
`;

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	staff = (await local.createStaff({ workspaces: [workspaceId], name: "Ciara Byrne" })).account;

	const make = async (name: string, markup: string, code: string, consentCategory?: "marketing") => {
		const { component } = await api.components.create({ siteId, name });
		await api.components.saveMarkup({ siteId, componentId: component.id, markup });
		await api.components.saveScriptDraft({ siteId, componentId: component.id, code, consentCategory });
		await api.components.publish({ siteId, componentId: component.id });
		return component.id;
	};
	await make(
		"Badge",
		"<span>New</span>",
		'(window.order ||= []).push("badge");\nexport default (root) => { root.dataset.badge = String(Number(root.dataset.badge || 0) + 1); };',
	);
	counterId = await make(
		"Counter",
		"{{@props}}\nlabel: text exposed\nsecret: text\n{{/props}}\n<div><p>{{ props.label }}</p><Badge /></div>",
		COUNTER,
	);
	await make(
		"Tracker",
		"<aside><p>Tracked</p></aside>",
		'export default () => { document.documentElement.dataset.tracked = "yes"; };',
		"marketing",
	);
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup:
			'<header><p><a href="/">Acme Bakery</a></p></header><main>{{@outlet}}</main><footer><p>Open daily.</p></footer>',
	});
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const { template } = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup:
			'<article><h1>{{ title }}</h1><Counter label="One" secret="s1" /><Counter label="Broken" secret="s2" /><Counter label="Three" secret="s3" /><Tracker /></article>',
	});
	await api.templates.publish({ siteId, templateId: template.id });
	const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await api.entries.publish({ siteId, entryId: entry.id });
	for (const [entryId, name] of [
		[null, "site"],
		[entry.id, "page"],
	] as const) {
		const { script } = await api.scripts.saveDraft({
			siteId,
			entryId,
			code: `(window.order ||= []).push(${JSON.stringify(name)});`,
		});
		await api.scripts.publish({ siteId, scriptId: script.id });
	}
	await install.goLive(siteId);
});

afterAll(async () => {
	await install.close();
});

/** What each Counter's root says about its calls: its label, how often it ran, what it saw. */
async function counters(page: Page): Promise<string[]> {
	return page.$$eval("main [data-wc-component][data-label] > p:first-child", (labels) =>
		labels.map((label) => {
			const root = label.parentElement as HTMLElement;
			return `${root.dataset.label}: ${root.dataset.calls ?? 0} call(s), saw ${root.dataset.seen ?? "nothing"}`;
		}),
	);
}

describe("on a visitor's page", () => {
	test("each Placement root gets one call of its own; nested Components their own; order is Site, Components, page", async () => {
		const page = await install.newPage("light");
		await page.goto(install.liveUrl(slug, path));
		await page.waitForFunction(() => (window as { order?: string[] }).order?.includes("page"));
		await page.waitForFunction(() => document.querySelectorAll("[data-badge]").length === 3);

		expect(await counters(page)).toEqual([
			"One: 1 call(s), saw One|none",
			"Broken: 1 call(s), saw Broken|none",
			// The Placement after the one that threw still ran.
			"Three: 1 call(s), saw Three|none",
		]);
		expect(
			await page.$$eval("[data-badge]", (badges) => badges.map((badge) => badge.getAttribute("data-badge"))),
		).toEqual(["1", "1", "1"]);
		expect(await page.evaluate(() => (window as { order?: string[] }).order)).toEqual([
			"site",
			"counter",
			"badge",
			"page",
		]);
		// Tracker's script waits for Marketing, which the visitor hasn't accepted.
		expect(await page.evaluate(() => document.documentElement.dataset.tracked ?? null)).toBeNull();
	});

	test("a script in a declined Consent category never runs; accepted, it does", async () => {
		const page = await install.newPage("light");
		await page.goto(install.liveUrl(slug, path));
		await page.waitForFunction(() => document.documentElement.hasAttribute("data-wc-consent-state"));

		await page.getByRole("button", { name: "Reject all", exact: true }).focus();
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => document.cookie.includes("webcraft.consent="));
		await page.reload();
		await page.waitForFunction(() => (window as { order?: string[] }).order?.includes("page"));
		expect(await page.evaluate(() => document.documentElement.dataset.tracked ?? null)).toBeNull();

		await page.context().clearCookies();
		await page.reload();
		await page.waitForFunction(() => document.documentElement.hasAttribute("data-wc-consent-state"));
		await page.getByRole("button", { name: "Accept all", exact: true }).focus();
		await page.keyboard.press("Enter");
		await page.waitForFunction(() => document.documentElement.dataset.tracked === "yes");
	});
});

/** The edit and Code mode cookies from the first time Edit mode opened, handed to later pages. */
let cookies: Cookie[] | undefined;

/** A page in Edit mode, through "Edit on site" in the admin the first time. */
async function editModePage(theme: Theme): Promise<Page> {
	const page = await install.newPage(theme);
	if (cookies) {
		await page.context().addCookies(cookies);
	} else {
		await install.signIn(page, staff);
		await page.goto(install.adminUrl(`/sites/${siteId}`));
		await page.getByRole("button", { name: "Edit on site" }).click();
		await page.waitForURL((url) => url.hostname !== new URL(install.adminUrl("/")).hostname);
		cookies = (await page.context().cookies()).filter((cookie) => cookie.name === "webcraft.edit");
	}
	await page.goto(install.liveUrl(slug, path));
	await page.getByRole("button", { name: "Publish", exact: true }).waitFor();
	return page;
}

describe("in Edit mode", () => {
	test("Component scripts run, also for a Placement added later; a call that fails shows in the bar", async () => {
		const page = await editModePage("light");
		await page.waitForFunction(() => document.querySelectorAll("[data-badge]").length === 3);
		const notice = page.getByRole("alert").filter({ hasText: "The Component script of Counter failed." });
		await notice.waitFor();
		expect(await notice.textContent()).toContain("Counter broke");

		// A Placement added to the page later gets its call too.
		await page.evaluate((id) => {
			const added = document.createElement("div");
			added.setAttribute("data-wc-component", id);
			added.setAttribute("data-label", "Added");
			added.innerHTML = "<p>Added</p>";
			document.querySelector("main article")?.append(added);
		}, counterId);
		await page.waitForFunction(
			() => document.querySelector('[data-label="Added"]')?.getAttribute("data-calls") === "1",
		);
		// One inside a Hidden placement gets none.
		await page.evaluate((id) => {
			const hidden = document.createElement("section");
			hidden.setAttribute("data-wc-hidden", "");
			hidden.innerHTML = `<div data-wc-component="${id}" data-label="Hidden"><p>Hidden</p></div>`;
			document.querySelector("main article")?.append(hidden);
		}, counterId);
		await page.waitForTimeout(300);
		expect(
			await page.evaluate(() => document.querySelector('[data-label="Hidden"]')?.getAttribute("data-calls") ?? null),
		).toBeNull();
		// The Marketing script runs: people editing are never asked for consent.
		expect(await page.evaluate(() => document.documentElement.dataset.tracked ?? null)).toBe("yes");
	});
});

/** A page in Code mode: Edit mode, then Code in the editing bar. */
async function codeModePage(theme: Theme): Promise<Page> {
	const page = await editModePage(theme);
	if (!(await page.getByRole("textbox", { name: /^JS: / }).count())) {
		await page.getByRole("button", { name: "Code", exact: true }).click();
	}
	await page.getByRole("textbox", { name: /^JS: / }).waitFor();
	return page;
}

for (const theme of THEMES) {
	describe(`Code mode's JS panel, ${theme}`, () => {
		test("a Placement selected shows its Component tab, with where it is used, its Consent category and Libraries", async () => {
			const page = await codeModePage(theme);
			const tab = page
				.getByRole("group", { name: "Which script", exact: true })
				.getByRole("button", { name: "Component", exact: true });
			expect(await tab.isVisible()).toBe(false);

			await page.locator("main [data-label='One'] > p").click();
			await tab.waitFor();
			await tab.click();

			const js = page.getByRole("textbox", { name: "JS: Counter · Component script" });
			await js.waitFor();
			expect(await js.inputValue()).toBe(COUNTER);
			await page.getByText("Counter is used on 1 page: changes apply to it").last().waitFor();
			const consent = page.getByRole("combobox", { name: "Consent category" });
			expect(await consent.inputValue()).toBe("necessary");
			await page.getByText("The Site has no Libraries: add them in Site › Libraries.").waitFor();
			await expectNoAxeViolations(page, `Code mode › Component tab (${theme})`);
		});
	});
}

describe("Code mode's JS panel from the keyboard", () => {
	test("saves the Component script and its category, runs it, and shows a failing call against its Placement", async () => {
		const page = await codeModePage("light");
		await page.locator("main [data-label='Three'] > p").click();
		const tab = page
			.getByRole("group", { name: "Which script", exact: true })
			.getByRole("button", { name: "Component", exact: true });
		await tab.waitFor();
		await tab.focus();
		await page.keyboard.press("Enter");
		const js = page.getByRole("textbox", { name: "JS: Counter · Component script" });
		await js.waitFor();

		const consent = page.getByRole("combobox", { name: "Consent category" });
		await consent.focus();
		await consent.selectOption("analytics");
		await js.focus();
		await page.keyboard.press("ControlOrMeta+End");
		await page.keyboard.type("// saved from the keyboard\n");
		await page.keyboard.press("ControlOrMeta+s");
		await page.getByText("Saved to Draft · Counter · Component script").first().waitFor();
		const { api } = await install.install.superadmin();
		const { script } = await api.components.getScript({ siteId, componentId: counterId });
		expect(script?.draft.consentCategory).toBe("analytics");
		expect(script?.draft.code).toContain("// saved from the keyboard");

		await page.getByRole("button", { name: "Run", exact: true }).click();
		const log = page.getByRole("log", { name: "Console" });
		await log.getByText("Counter failed on a Placement: Counter broke").first().waitFor();
		// Each Placement on the freshly rendered page ran the new Draft once.
		await page.waitForFunction(() =>
			[...document.querySelectorAll("main [data-label]")].every((root) => root.getAttribute("data-calls") === "1"),
		);
		await expectNoAxeViolations(page, "Code mode › a Component script failing");

		await log.getByRole("button", { name: "Show on the page" }).first().click();
		await page.getByRole("textbox", { name: "HTML of Counter · Component" }).waitFor();
		await api.components.saveScriptDraft({
			siteId,
			componentId: counterId,
			code: COUNTER,
			consentCategory: "necessary",
		});
	});
});

describe("Code mode's JS panel while Staff type", () => {
	test("selecting a Placement keeps unsaved text in the Page tab; its Component tab just appears", async () => {
		const page = await codeModePage("light");
		await page.getByRole("button", { name: "Page", exact: true }).click();
		const js = page.getByRole("textbox", { name: "JS: Page script" });
		await js.waitFor();
		const typed = `${await js.inputValue()}\n// not saved yet`;
		await js.fill(typed);

		await page.locator("main [data-label='One'] > p").click();
		await page
			.getByRole("group", { name: "Which script", exact: true })
			.getByRole("button", { name: "Component", exact: true })
			.waitFor();
		await page.getByRole("textbox", { name: "HTML of Counter · Component" }).waitFor();

		expect(await js.inputValue()).toBe(typed);
	});
});
