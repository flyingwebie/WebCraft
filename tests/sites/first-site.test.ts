// The first rendered Site, end to end: Staff define a Post Type with a text Field and its Entry
// template, a Member writes an Entry and publishes it, and visitors get the page on the Site's
// Staging address, from the page cache until the next publish.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { stylesheetIn } from "../harness/site-styles.ts";
import { element, tree, value } from "../harness/trees.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
let stagingUrl: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	stagingUrl = (await editor.api.sites.get({ siteId })).stagingUrl ?? "";
});

afterAll(async () => {
	await install.close();
});

describe("create → publish → render → cache → republish", () => {
	let postTypeId: string;
	let entryId: string;

	test("a published Entry renders as semantic HTML on the Site's Staging address", async () => {
		expect(stagingUrl).toBe("https://bakery.sites.test");
		const { postType } = await staff.api.postTypes.create({
			siteId,
			name: "Blog posts",
			key: "blog",
			urlPattern: "/blog/{slug}",
			fields: [{ key: "summary", label: "Summary", type: "text" }],
		});
		postTypeId = postType.id;
		const { template } = await staff.api.templates.saveEntryTemplate({
			siteId,
			postTypeId,
			tree: tree(element("article", [element("h1", [value("title")]), element("p", [value("summary")])])),
		});
		await staff.api.templates.publish({ siteId, templateId: template.id });
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId,
			title: "Fresh bread daily",
			fields: { summary: "Out of the oven at seven." },
		});
		entryId = entry.id;
		await editor.api.entries.publish({ siteId, entryId });

		const page = await install.request(`${stagingUrl}/blog/fresh-bread-daily`);

		expect(page.status).toBe(200);
		expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
		const html = await page.text();
		expect(html).toBe(
			[
				"<!doctype html>",
				'<html lang="en" dir="ltr">',
				"<head>",
				'<meta charset="utf-8">',
				'<meta name="viewport" content="width=device-width, initial-scale=1">',
				"<title>Fresh bread daily · Acme Bakery</title>",
				// The Site's stylesheet, named by the hash of what it holds.
				`<link rel="stylesheet" href="${stylesheetIn(html)}">`,
				"</head>",
				"<body>",
				'<a class="wc-skip-link" href="#wc-main">Skip to main content</a>',
				'<main id="wc-main" tabindex="-1"><article><h1>Fresh bread daily</h1><p>Out of the oven at seven.</p></article></main>',
				"</body>",
				"</html>",
				"",
			].join("\n"),
		);
	});

	test("the next visitor gets the same page from the page cache", async () => {
		const first = await install.request(`${stagingUrl}/blog/fresh-bread-daily`);
		const second = await install.request(`${stagingUrl}/blog/fresh-bread-daily`);

		expect(second.headers.get("x-cache")).toBe("HIT");
		expect(second.headers.get("etag")).toBe(first.headers.get("etag"));
		expect(second.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
		expect(await second.text()).toBe(await first.text());
	});

	test("a saved Draft changes nothing visitors see until it is published", async () => {
		await editor.api.entries.saveDraft({ siteId, entryId, fields: { summary: "Now out of the oven at six." } });

		const page = await install.request(`${stagingUrl}/blog/fresh-bread-daily`);

		expect(page.headers.get("x-cache")).toBe("HIT");
		expect(await page.text()).toContain("<p>Out of the oven at seven.</p>");
	});

	test("republishing clears the Site's page cache, so visitors get the new version at once", async () => {
		const before = await install.request(`${stagingUrl}/blog/fresh-bread-daily`);

		await editor.api.entries.publish({ siteId, entryId });
		const after = await install.request(`${stagingUrl}/blog/fresh-bread-daily`);

		expect(after.headers.get("x-cache")).toBe("MISS");
		expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
		expect(await after.text()).toContain("<p>Now out of the oven at six.</p>");
		expect((await install.request(`${stagingUrl}/blog/fresh-bread-daily`)).headers.get("x-cache")).toBe("HIT");
	});
});
