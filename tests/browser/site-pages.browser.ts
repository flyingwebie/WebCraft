// What every Site page gives visitors, in a real browser: axe-core finds nothing against WCAG 2.2 A
// and AA or its best practices, the first Tab reaches the skip link, following it moves focus into
// the page's <main>, and every link shows focus. Checked on an Entry's page and the 404 page, inside
// a Site template with a header, navigation and footer, styled by the default Design system, the
// footer and the Entry's article each shown through a Component; on an Archive page listing the posts
// through a paginated Loop with its pagination; and on a Site with dark mode and a theme toggle, in the
// device's light and dark themes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
const slug = "bakery";
const darkSlug = "night-bakery";

/** The Site template both Sites use: a header with the Site's name and a list of links, and a footer. */
const SITE_TEMPLATE = [
	'<header><p><a href="/">Acme Bakery</a></p><nav aria-label="Main"><ul>',
	'<li><a href="/blog/fresh-bread">Fresh bread</a></li><li><a href="/about">About us</a></li><li><a href="/contact">Contact</a></li>',
	"</ul></nav>{{@themeToggle}}</header>",
	"<main>{{@outlet}}</main>",
	'<footer><OpeningHours from="seven" /></footer>',
].join("");

/** A Site with the Site template above and a published post at /blog/fresh-bread. */
async function siteWithPost(siteSlug: string, darkMode: boolean): Promise<void> {
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace(`Acme ${siteSlug}`)).id;
	const siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug: siteSlug })).id;
	// Visitors see the Site on its domain; its Staging address is for the people reviewing it.
	await install.goLive(siteId);
	/** A published Component with required text Props and its markup. */
	const component = async (name: string, props: { key: string; label: string }[], markup: string) => {
		const made = await api.components.create({
			siteId,
			name,
			props: props.map((prop) => ({ ...prop, type: "text" as const, required: true })),
		});
		await api.components.saveMarkup({ siteId, componentId: made.component.id, markup });
		await api.components.publish({ siteId, componentId: made.component.id });
	};
	await component("OpeningHours", [{ key: "from", label: "From" }], "<p>Open every day from {{ props.from }}.</p>");
	await component(
		"Post",
		[{ key: "heading", label: "Heading" }],
		'<article><h1>{{ props.heading }}</h1><p>Out of the oven at seven. <a href="/about">About us</a></p></article>',
	);
	const site = await api.templates.saveSiteTemplateMarkup({ siteId, markup: SITE_TEMPLATE });
	await api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const entry = await api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: '<Post heading="{{ title }}" />',
	});
	await api.templates.publish({ siteId, templateId: entry.template.id });
	const { entry: post } = await api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await api.entries.publish({ siteId, entryId: post.id });
	for (const title of ["Sourdough starter", "Wedding cakes"]) {
		const { entry: more } = await api.entries.create({ siteId, postTypeId: postType.id, title });
		await api.entries.publish({ siteId, entryId: more.id });
	}
	// The Archive page at /blog: its posts two at a time, with links to its pages.
	const { loop } = await api.loops.create({
		siteId,
		name: "posts",
		source: "query",
		query: { postTypes: [postType.key], limit: 2, paginate: true, sort: [{ by: "title", direction: "asc" }] },
	});
	await api.loops.publish({ siteId, loopId: loop.id });
	const archive = await api.templates.saveArchiveTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup:
			'<h1>Journal</h1><ul>{{@loop posts as post}}<li><a href="{{ post.url }}">{{ post.title }}</a></li>{{/loop}}</ul>{{@pagination posts}}',
	});
	await api.templates.publish({ siteId, templateId: archive.template.id });
	if (darkMode) {
		await api.designSystem.saveDraft({ siteId, darkMode: true });
		await api.designSystem.publish({ siteId });
	}
}

beforeAll(async () => {
	install = await startBrowserInstall();
	await siteWithPost(slug, false);
	await siteWithPost(darkSlug, true);
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Site pages, ${theme}`, () => {
		for (const [name, siteSlug, path] of [
			["an Entry's page", slug, "/blog/fresh-bread"],
			["the built-in 404 page", slug, "/no-such-page"],
			["an Archive page with pagination", slug, "/blog"],
			["the second page of an Archive page", slug, "/blog?page=2"],
			["an Entry's page with dark mode and a theme toggle", darkSlug, "/blog/fresh-bread"],
		] as const) {
			test(name, async () => {
				const page = await install.newPage(theme);
				await page.goto(install.liveUrl(siteSlug, path));
				await page.waitForLoadState("load");

				await expectAccessibleScreen(page, `${name} (${theme})`);
			});
		}
	});
}

describe("the Design system's page parts", () => {
	test("the skip link stays out of sight until it has focus, then shows at the top of the page", async () => {
		const page = await install.newPage("light");
		await page.goto(install.liveUrl(slug, "/blog/fresh-bread"));
		const link = page.getByRole("link", { name: "Skip to main content" });

		const hidden = await link.boundingBox();
		await page.keyboard.press("Tab");
		const shown = await link.boundingBox();

		expect(hidden?.width ?? 0).toBeLessThanOrEqual(1);
		expect(shown?.width ?? 0).toBeGreaterThan(24);
		expect(shown?.height ?? 0).toBeGreaterThanOrEqual(24);
		expect(shown?.y ?? -1).toBeGreaterThanOrEqual(0);
	});

	test("the theme toggle switches the page's theme from the keyboard, and the choice is kept", async () => {
		const page = await install.newPage("light");
		await page.goto(install.liveUrl(darkSlug, "/blog/fresh-bread"));
		const toggle = page.getByRole("button", { name: "Dark theme" });
		// The colour people see: read after the next paint, once any change has been drawn.
		const background = () =>
			page.evaluate(
				() =>
					new Promise<string>((resolve) =>
						requestAnimationFrame(() =>
							requestAnimationFrame(() => resolve(getComputedStyle(document.body).backgroundColor)),
						),
					),
			);
		const light = await background();

		await expect(toggle.getAttribute("aria-pressed")).resolves.toBe("false");
		await toggle.focus();
		await page.keyboard.press("Enter");

		await expect(toggle.getAttribute("aria-pressed")).resolves.toBe("true");
		const dark = await background();
		expect(dark).not.toBe(light);
		await expectAccessibleScreen(page, "a page switched to the dark theme");

		await page.reload();
		await expect(page.getByRole("button", { name: "Dark theme" }).getAttribute("aria-pressed")).resolves.toBe("true");
		expect(await background()).toBe(dark);

		await page.getByRole("button", { name: "Dark theme" }).focus();
		await page.keyboard.press("Space");
		// A button pressed with Space acts when the key comes up, a moment after the press.
		await page.waitForFunction(
			() => document.querySelector(".wc-theme-toggle")?.getAttribute("aria-pressed") === "false",
		);
		expect(await background()).toBe(light);
	});

	test("without dark mode, pages carry no script and no toggle", async () => {
		const page = await install.newPage("dark");
		await page.goto(install.liveUrl(slug, "/blog/fresh-bread"));

		// No script that runs: the page's structured data is a data block, never run.
		expect(await page.locator('script:not([type="application/ld+json"])').count()).toBe(0);
		expect(await page.getByRole("button").count()).toBe(0);
	});
});
