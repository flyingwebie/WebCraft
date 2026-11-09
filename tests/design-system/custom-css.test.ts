// Custom CSS (spec story 68): per Class and Site-wide (per Component with #63), checked with a real
// CSS parser before it is saved, each problem with its line and column. Cascade layers order the
// stylesheet, so `!important` is never needed and is refused; nothing can leave its layer, load
// another stylesheet, or load files from another host (the Site's strict CSP, ADR 0023).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { layerOf, pageWithStyles } from "../harness/site-styles.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;
let siteId: string;
let sites = 0;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	siteId = (await newSite()).siteId;
});

afterAll(async () => {
	await install.close();
});

async function newSite() {
	const slug = `bakery-${++sites}`;
	const id = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	return { siteId: id, url: `https://${slug}.sites.test/` };
}

type Problem = { at: string; line?: number; column?: number; message: string };

/** The problems a save of the Draft was refused with (`DESIGN_SYSTEM_INVALID`). */
async function problemsOf(change: Promise<unknown>): Promise<Problem[]> {
	const error = await change.then(
		() => {
			throw new Error("The save was not refused.");
		},
		(refused: { code: string; data: { problems: Problem[] } }) => refused,
	);
	expect(error.code).toBe("DESIGN_SYSTEM_INVALID");
	return error.data.problems;
}

const siteCss = (customCss: string) => problemsOf(staff.api.designSystem.saveDraft({ siteId, customCss }));

describe("the Site-wide custom CSS", () => {
	test("is checked by a CSS parser: each problem says where it is", async () => {
		expect(await siteCss("main {\n  colour: red;\n}")).toEqual([
			{ at: "customCss", line: 2, column: 3, message: "colour isn't a CSS property." },
		]);
		expect(await siteCss("p { margin: lots; }")).toEqual([
			{ at: "customCss", line: 1, column: 13, message: "lots isn't a value margin takes." },
		]);
		const [unclosed] = await siteCss("p { color: red; }\n}\nbody { color: blue; }");
		expect(unclosed).toMatchObject({ at: "customCss", line: 2, column: 1 });
	});

	test("values using custom properties are left for the browser to work out", async () => {
		const { designSystem } = await staff.api.designSystem.saveDraft({
			siteId,
			customCss: "p { margin: var(--space-s) var(--my-gap, 1rem); --my-gap: 2rem; }",
		});
		expect(designSystem.draft.customCss).toBe("p { margin: var(--space-s) var(--my-gap, 1rem); --my-gap: 2rem; }");
	});

	test("never needs !important: it is refused", async () => {
		expect(await siteCss("p { color: red !important; }")).toEqual([
			{ at: "customCss", line: 1, column: 5, message: expect.stringContaining("!important isn't needed") },
		]);
	});

	test("can't load other stylesheets, nor leave its layer", async () => {
		expect(await siteCss('@import "/other.css";')).toEqual([
			{ at: "customCss", line: 1, column: 1, message: expect.stringContaining("@import isn't allowed") },
		]);
		expect(await siteCss("@layer reset { p { color: red; } }")).toEqual([
			{ at: "customCss", line: 1, column: 1, message: expect.stringContaining("@layer isn't needed") },
		]);
		expect(await siteCss("@charset 'utf-8';")).toHaveLength(1);
	});

	test("loads files only from the Site itself, wherever an address is written", async () => {
		const elsewhere = (address: string) =>
			`${address} isn't on this Site: styles may load only the Site's own files, such as /_media/….`;
		expect(await siteCss("body { background: url(https://cdn.example.com/bg.png); }")).toEqual([
			{ at: "customCss", line: 1, column: 20, message: elsewhere("https://cdn.example.com/bg.png") },
		]);
		expect(await siteCss('body { background-image: image-set("//cdn.example.com/a.png" 1x); }')).toEqual([
			{ at: "customCss", line: 1, column: 36, message: elsewhere("//cdn.example.com/a.png") },
		]);
		// A custom property's value is plain text to the parser, but still checked.
		expect(await siteCss("body { --bg: url('https://cdn.example.com/a.png'); }")).toEqual([
			{ at: "customCss", line: 1, column: 14, message: elsewhere("https://cdn.example.com/a.png") },
		]);
		// An escaped name is read as CSS reads it.
		expect(await siteCss("body { --bg: \\75 rl(https://cdn.example.com/a.png); }")).toEqual([
			{ at: "customCss", line: 1, column: 14, message: elsewhere("https://cdn.example.com/a.png") },
		]);
		expect(await siteCss("body { background: url(data:image/png;base64,AAAA); }")).toHaveLength(1);
		expect(await siteCss("@font-face { font-family: Brand; src: url(javascript:alert(1)); }")).toHaveLength(1);

		const { designSystem } = await staff.api.designSystem.saveDraft({
			siteId,
			customCss:
				'@font-face { font-family: Brand; src: url("/_media/3f9a1c2b7d4e5f60-brand.woff2") format("woff2"); }\nhr { border-image: url(/_media/3f9a1c2b7d4e5f60-rule.png) 30; }',
		});
		expect(designSystem.draft.customCss).toContain("/_media/3f9a1c2b7d4e5f60-brand.woff2");
	});

	test("refuses what only ever ran script", async () => {
		expect(await siteCss("p { behavior: url(/x.htc); }")).toHaveLength(1);
		expect(await siteCss("p { width: expression(alert(1)); }")).not.toHaveLength(0);
	});

	test("sits in the last cascade layer, written out by the parser, after the Classes and utilities", async () => {
		const site = await newSite();
		await staff.api.designSystem.saveDraft({
			siteId: site.siteId,
			customCss:
				"/* Brand tweaks */\n@media (min-width: 60rem) {\n  main { max-inline-size: var(--width-content); }\n}",
		});
		await staff.api.designSystem.publish({ siteId: site.siteId });

		const { css } = await pageWithStyles(install, site.url);
		expect(layerOf(css, "custom")).toBe("@media (min-width:60rem){main{max-inline-size:var(--width-content)}}");
		expect(css.indexOf("@layer custom {")).toBeGreaterThan(css.indexOf("@layer base {"));
		expect(css).not.toContain("Brand tweaks");
	});
});

describe("a Class's CSS", () => {
	test("its styles are declarations only; its own CSS nests rules with &", async () => {
		const declarations = await problemsOf(
			staff.api.designSystem.createClass({ siteId, name: "badge", styles: "p { color: red; }" }),
		);
		expect(declarations).toEqual([
			{
				at: expect.stringMatching(/^classes\[\d+\]\.styles$/),
				line: 1,
				column: expect.any(Number),
				message: expect.stringContaining("Write declarations only"),
			},
		]);

		const nested = await problemsOf(
			staff.api.designSystem.createClass({ siteId, name: "badge", css: "&:hover { color: red; } @import '/x.css';" }),
		);
		expect(nested).toHaveLength(1);

		const { class: badge } = await staff.api.designSystem.createClass({
			siteId,
			name: "badge",
			styles: "display: inline-block;",
			css: "&:hover { color: var(--primary-80); }\n@media (min-width: 40rem) { & { display: inline-flex; } }",
		});
		expect(badge.css).toBe(
			"&:hover { color: var(--primary-80); }\n@media (min-width: 40rem) { & { display: inline-flex; } }",
		);
	});

	test("inline styles in Template markup are checked the same way before they become a Class", async () => {
		const site = await newSite();
		const { postType } = await staff.api.postTypes.create({
			siteId: site.siteId,
			name: "Posts",
			urlPattern: "/posts/{slug}",
		});
		const refused = await staff.api.templates
			.saveEntryTemplateMarkup({
				siteId: site.siteId,
				postTypeId: postType.id,
				markup: '<p style="background: url(https://cdn.example.com/a.png)">{{ title }}</p>',
			})
			.then(
				() => undefined,
				(error: { code: string; data: unknown }) => error,
			);
		expect(refused).toMatchObject({
			code: "TEMPLATE_MARKUP_INVALID",
			data: { problems: [{ line: 1, column: 11, message: expect.stringContaining("isn't on this Site") }] },
		});
	});
});
