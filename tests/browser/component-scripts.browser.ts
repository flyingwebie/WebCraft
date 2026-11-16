// Component scripts in a real browser (GLOSSARY.md, ADR 0022, ADR 0023): the function a Component's
// script exports runs once for each of its Placements' roots, each call on its own (one that throws
// doesn't stop the others), a Component placed inside another getting its own call; only exposed
// Props reach the root as `data-` attributes; the Site script runs first, then the Component scripts,
// then the page script; a script in a Consent category the visitor hasn't accepted doesn't run. In the
// building area, Component scripts running in the frame (also for Placements added later) and the JS
// pane's Component tab are `building-area-scripts`' checks.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Page } from "playwright";

import { type BrowserInstall, startBrowserInstall } from "./harness.ts";

let install: BrowserInstall;
let siteId: string;
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
	await make(
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
