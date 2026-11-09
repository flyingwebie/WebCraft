// Dark mode (spec story 69): optional per Site. With it on, every colour has dark values over the
// same steps, which follow the visitor's device (`prefers-color-scheme`), and Staff may place a
// theme toggle, `{{@themeToggle}}`. Pages never carry inline scripts (ADR 0023): the toggle's script
// is a hashed file, linked only from pages that show a toggle.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { withoutStructuredData } from "../harness/seo.ts";
import { layerOf, pageWithStyles } from "../harness/site-styles.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;
let sites = 0;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

/** A new Site with a published post at /blog/fresh-bread, in a published Site template written as `siteTemplate`. */
async function newSite(siteTemplate = "<main>{{@outlet}}</main>") {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const site = await staff.api.templates.saveSiteTemplateMarkup({ siteId, markup: siteTemplate });
	await staff.api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const entry = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: post } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await staff.api.entries.publish({ siteId, entryId: post.id });
	return { siteId, origin: `https://${slug}.sites.test`, url: `https://${slug}.sites.test/blog/fresh-bread` };
}

/** The relative luminance of `#rrggbb` (WCAG). */
function luminance(hex: string): number {
	const [r, g, b] = [1, 3, 5].map((start) => {
		const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	}) as [number, number, number];
	return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The value a custom property is set to in CSS text. */
function propertyValue(css: string, property: string): string {
	return new RegExp(`${property}:([^;]+);`).exec(css)?.[1] ?? "";
}

describe("dark values", () => {
	test("are off until a Site turns dark mode on", async () => {
		const { url } = await newSite();

		const { html, css } = await pageWithStyles(install, url);

		expect(css).not.toContain("prefers-color-scheme");
		expect(css).not.toContain("data-wc-theme");
		expect(html).not.toContain("color-scheme");
	});

	test("follow the visitor's device, or the theme toggle's choice, once dark mode is on", async () => {
		const { siteId, url } = await newSite();
		await staff.api.designSystem.saveDraft({ siteId, darkMode: true });
		await staff.api.designSystem.publish({ siteId });

		const { html, css } = await pageWithStyles(install, url);
		const tokens = layerOf(css, "tokens");

		expect(html).toContain('<meta name="color-scheme" content="light dark">');
		const light = /^:root\{color-scheme:light;([^}]*)\}$/m.exec(tokens)?.[1] ?? "";
		const device =
			/^@media \(prefers-color-scheme:dark\)\{:root:not\(\[data-wc-theme=light\]\)\{color-scheme:dark;([^}]*)\}\}$/m.exec(
				tokens,
			)?.[1];
		const chosen = /^:root\[data-wc-theme=dark\]\{color-scheme:dark;([^}]*)\}$/m.exec(tokens)?.[1];
		expect(device).toBeDefined();
		expect(chosen).toBe(device);
		// Every colour step has a dark value; other tokens are the same in both.
		expect(device?.match(/--[a-z0-9-]+:/g)).toEqual(light.match(/--(?:primary|secondary|accent|neutral)-[a-z0-9]+:/g));
	});

	test("run the other way along the same steps: 10 is the page's background end in both", async () => {
		const { siteId, url } = await newSite();
		await staff.api.designSystem.saveDraft({ siteId, darkMode: true });
		await staff.api.designSystem.publish({ siteId });

		const tokens = layerOf((await pageWithStyles(install, url)).css, "tokens");
		const dark = /data-wc-theme=dark\]\{([^}]*)\}/.exec(tokens)?.[1] ?? "";
		const shades = ["10", "20", "30", "40", "50", "70", "80", "90", "95"];

		const lightLuminance = shades.map((step) => luminance(propertyValue(tokens, `--neutral-${step}`)));
		const darkLuminance = shades.map((step) => luminance(propertyValue(dark, `--neutral-${step}`)));
		expect(lightLuminance).toEqual([...lightLuminance].sort((a, b) => b - a));
		expect(darkLuminance).toEqual([...darkLuminance].sort((a, b) => a - b));
	});

	test("are edited over the same ramps: a dark base colour, and any dark step of its own", async () => {
		const { siteId, url } = await newSite();
		const { designSystem } = await staff.api.designSystem.get({ siteId });
		await staff.api.designSystem.saveDraft({
			siteId,
			darkMode: true,
			tokens: {
				...designSystem.draft.tokens,
				colours: designSystem.draft.tokens.colours.map((colour) =>
					colour.name === "primary" ? { ...colour, dark: { base: "#60a5fa", steps: { "10": "#0b1220" } } } : colour,
				),
			},
		});
		await staff.api.designSystem.publish({ siteId });

		const tokens = layerOf((await pageWithStyles(install, url)).css, "tokens");
		const dark = /data-wc-theme=dark\]\{([^}]*)\}/.exec(tokens)?.[1] ?? "";
		expect(propertyValue(dark, "--primary-60")).toBe("#60a5fa");
		expect(propertyValue(dark, "--primary-10")).toBe("#0b1220");
		expect(propertyValue(tokens, "--primary-60")).toBe("#2563eb");
	});
});

describe("the theme toggle", () => {
	const header = "<header><p>Acme Bakery</p>{{@themeToggle}}</header><main>{{@outlet}}</main>";

	test("is a button that starts hidden, with its script as a file in the page's <head>", async () => {
		const { siteId, url, origin } = await newSite(header);
		await staff.api.designSystem.saveDraft({ siteId, darkMode: true });
		await staff.api.designSystem.publish({ siteId });

		const { html } = await pageWithStyles(install, url);

		expect(html).toContain(
			'<header><p>Acme Bakery</p><button type="button" class="wc-theme-toggle" aria-pressed="false" hidden>Dark theme</button></header>',
		);
		const head = /<head>([\s\S]*)<\/head>/.exec(html)?.[1] ?? "";
		const scripts = [...head.matchAll(/<script src="([^"]+)"><\/script>/g)].map((match) => match[1] ?? "");
		expect(scripts).toHaveLength(1);
		expect(scripts[0]).toMatch(/^\/_wc\/js\/[0-9a-f]{16}\.js$/);
		// No script is ever written into the page itself.
		expect([...withoutStructuredData(html).matchAll(/<script\b[^>]*>/g)].map((match) => match[0])).toEqual([
			`<script src="${scripts[0]}">`,
		]);

		const script = await install.request(`${origin}${scripts[0]}`);
		expect(script.status).toBe(200);
		expect(script.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
		expect(script.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(await script.text()).toContain("wc-theme-toggle");
		expect((await install.request(`${origin}/_wc/js/0000000000000000.js`)).status).toBe(404);
	});

	test("shows nothing, and no script comes, while the Site has no dark mode", async () => {
		const { url } = await newSite(header);

		const { html } = await pageWithStyles(install, url);

		expect(html).toContain("<header><p>Acme Bakery</p></header>");
		expect(withoutStructuredData(html)).not.toContain("<script");
	});

	test("pages without a toggle get no script", async () => {
		const { siteId, url } = await newSite("<main>{{@outlet}}</main>");
		await staff.api.designSystem.saveDraft({ siteId, darkMode: true });
		await staff.api.designSystem.publish({ siteId });

		expect(withoutStructuredData((await pageWithStyles(install, url)).html)).not.toContain("<script");
	});

	test("is written {{@themeToggle}} in markup and stored as its own node; it can't go inside a link", async () => {
		const { siteId } = await newSite();

		const saved = await staff.api.templates.saveSiteTemplateMarkup({
			siteId,
			markup: "<header>{{@themeToggle}}</header><main>{{@outlet}}</main>",
		});
		expect(saved.template.draft.nodes[0]).toMatchObject({ tag: "header", children: [{ type: "themeToggle" }] });
		expect(saved.markup).toStartWith("<header data-wc-id=");
		expect(saved.markup).toContain(">{{@themeToggle}}</header>");

		const refused = await staff.api.templates
			.saveSiteTemplateMarkup({ siteId, markup: '<a href="/">{{@themeToggle}}</a><main>{{@outlet}}</main>' })
			.then(
				() => undefined,
				(error: { code: string; data: unknown }) => error,
			);
		expect(refused).toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: { problems: [{ line: 1, column: 13, message: "{{@themeToggle}} is a button: it can't go inside <a>." }] },
		});
	});
});
