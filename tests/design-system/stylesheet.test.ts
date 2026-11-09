// Each Site's styling is one stylesheet (ADR 0009): every page links it, it is served from the Site's
// own domain under a content-hashed name, cached for good, and ordered by cascade layers
// (reset → tokens → base → classes → utilities → custom). A Site that never touched its Design
// system gets the default one, so the skip link and the focus style work from the first page.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
const origin = "https://bakery.sites.test";

beforeAll(async () => {
	install = await createTestInstall();
	const { api } = await install.superadmin();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const template = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await api.entries.publish({ siteId, entryId: entry.id });
});

afterAll(async () => {
	await install.close();
});

/** The address of the stylesheet a page links, from its <head>. */
async function stylesheetOf(path: string): Promise<string> {
	const html = await (await install.request(`${origin}${path}`)).text();
	const head = /<head>([\s\S]*)<\/head>/.exec(html)?.[1] ?? "";
	const links = [...head.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map((match) => match[1] ?? "");
	expect(links).toHaveLength(1);
	return links[0] ?? "";
}

describe("every page links the Site's stylesheet", () => {
	test("an Entry's page and the 404 page link the same content-hashed file under /_wc/css/", async () => {
		const href = await stylesheetOf("/blog/fresh-bread");

		expect(href).toMatch(/^\/_wc\/css\/[0-9a-f]{16}\.css$/);
		expect(await stylesheetOf("/no-such-page")).toBe(href);
	});

	test("the stylesheet is served from the Site's domain as CSS, cached for good", async () => {
		const response = await install.request(`${origin}${await stylesheetOf("/blog/fresh-bread")}`);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
		expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("x-robots-tag")).toBe("noindex");
	});

	test("its name is the hash of what it holds: another name answers 404", async () => {
		const href = await stylesheetOf("/blog/fresh-bread");
		const other = href.replace(/[0-9a-f]{16}/, "0000000000000000");

		expect((await install.request(`${origin}${other}`)).status).toBe(404);
		expect((await install.request(`${origin}/_wc/css/style.css`)).status).toBe(404);
		expect((await install.request(`https://elsewhere.sites.test${href}`)).status).toBe(404);
	});

	test("HEAD answers the same headers without the body", async () => {
		const response = await install.request(`${origin}${await stylesheetOf("/")}`, { method: "HEAD" });

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("text/css; charset=utf-8");
		expect(await response.text()).toBe("");
	});
});

describe("the default Design system", () => {
	let css: string;
	beforeAll(async () => {
		css = await (await install.request(`${origin}${await stylesheetOf("/blog/fresh-bread")}`)).text();
	});

	test("declares its cascade layers first, in order, and puts every rule in one of them", async () => {
		expect(css).toStartWith("@layer reset, tokens, base, classes, utilities, custom;\n");
		const layers = [...css.matchAll(/^@layer ([a-z]+)\s*\{/gm)].map((match) => match[1]);
		expect(layers).toEqual(["reset", "tokens", "base"]);
	});

	test("sets the tokens as custom properties: colour shades, fluid spacing and type, fonts, radius, shadow, widths", () => {
		const tokens = /@layer tokens\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
		// The base colour of each ramp is its 60 step.
		expect(tokens).toContain("--primary-60:#2563eb;");
		expect(tokens).toContain("--neutral-60:#71717a;");
		for (const step of ["10", "20", "30", "40", "50", "70", "80", "90", "95", "a10", "a50", "a90"]) {
			expect(tokens).toContain(`--primary-${step}:#`);
		}
		// 16 px at a 360 px viewport to 20 px at 1440 px, in between in proportion.
		expect(tokens).toContain("--space-m:clamp(1rem, 0.9167rem + 0.3704vw, 1.25rem);");
		// 16 px to 18 px.
		expect(tokens).toContain("--text-m:clamp(1rem, 0.9583rem + 0.1852vw, 1.125rem);");
		expect(tokens).toMatch(/--font-body:system-ui,[^;]*sans-serif;/);
		expect(tokens).toContain("--radius-m:8px;");
		expect(tokens).toMatch(/--shadow-s:0 1px 2px 0 #[0-9a-f]{8}/);
		expect(tokens).toContain("--width-content:72rem;");
		// Dark mode is off until a Site turns it on.
		expect(css).not.toContain("prefers-color-scheme");
	});

	test("fills the focus style's custom properties from tokens, and keeps the skip link out of sight until focused", () => {
		const base = /@layer base\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
		expect(base).toContain("--wc-focus-color:var(--primary-70);");
		expect(base).toContain("--wc-focus-width:2px;");
		expect(base).toContain("--wc-focus-offset:2px;");
		expect(base).toContain(
			":focus-visible{outline:var(--wc-focus-width) solid var(--wc-focus-color);outline-offset:var(--wc-focus-offset)}",
		);
		expect(base).toMatch(/\.wc-skip-link:not\(:focus\)\{[^}]*clip-path:inset\(50%\)/);
	});

	test("respects reduced motion, and links in navigation are big enough to tap", () => {
		expect(css).toMatch(/@media \(prefers-reduced-motion:reduce\)\{[^}]*transition-duration:0\.01ms!important/);
		expect(css).toMatch(/nav a\{[^}]*min-block-size:24px/);
	});
});
