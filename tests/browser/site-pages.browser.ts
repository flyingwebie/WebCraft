// What every Site page gives visitors, in a real browser: axe-core finds nothing against WCAG 2.2 A
// and AA or its best practices, the first Tab reaches the skip link, following it moves focus into
// the page's <main>, and every link shows focus. Checked on an Entry's page and the 404 page, inside
// a Site template with a header, navigation and footer, the footer and the Entry's article each
// shown through a Component.
import { afterAll, beforeAll, describe, test } from "bun:test";

import { expectAccessibleScreen } from "./checks.ts";
import { type BrowserInstall, startBrowserInstall, THEMES } from "./harness.ts";

let install: BrowserInstall;
const slug = "bakery";

beforeAll(async () => {
	install = await startBrowserInstall();
	const local = install.install;
	const { api } = await local.superadmin();
	const workspaceId = (await local.createWorkspace("Acme Ltd")).id;
	const siteId = (await local.createSite(workspaceId, { name: "Acme Bakery", slug })).id;

	/** A published Component with Props and markup. */
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

	// Sites have no stylesheet until the Design system, so the header's links sit in sentences: a
	// list of bare links would be too close together to tap (target size), which Staff fix with Classes.
	const site = await api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: [
			'<header><p>Welcome to <a href="/">Acme Bakery</a>.</p><nav aria-label="Main">',
			'<p>Read about <a href="/blog/fresh-bread">fresh bread</a>, or find out more <a href="/about">about us</a>.</p>',
			"</nav></header>",
			"<main>{{@outlet}}</main>",
			'<footer><OpeningHours from="seven" /></footer>',
		].join(""),
	});
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
});

afterAll(async () => {
	await install.close();
});

for (const theme of THEMES) {
	describe(`Site pages, ${theme}`, () => {
		for (const [name, path] of [
			["an Entry's page", "/blog/fresh-bread"],
			["the built-in 404 page", "/no-such-page"],
		] as const) {
			test(name, async () => {
				const page = await install.newPage(theme);
				await page.goto(install.siteUrl(slug, path));
				await page.waitForLoadState("load");

				await expectAccessibleScreen(page, `${name} (${theme})`);
			});
		}
	});
}
