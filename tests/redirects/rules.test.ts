// Redirect rules (GLOSSARY.md), kept by the Redirects and 404 log Module: Editors, Owners and Staff
// send visitors from one path of a Site to another (or to another site), with a 301 or a 302. The
// Site pipeline applies them right after Redirect domains, before the Site's own pages.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type redirects from "@webcraft/module-redirects";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { moduleApi } from "../harness/modules.ts";
import { expectSiteHeaders } from "../harness/site-safety.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let siteId: string;
const SITE = "https://bakery.sites.test";

/** The Redirects Module's rule procedures, as `browser` calls them. */
const rules = (browser: TestBrowser = editor) => moduleApi<typeof redirects>(browser, "redirects").rules;

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "redirects", version: "1.0.0" });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	const { postType } = await staff.api.postTypes.create({ siteId, name: "Blog posts", urlPattern: "/blog/{slug}" });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	const { entry: post } = await editor.api.entries.create({ siteId, postTypeId: postType.id, title: "Fresh bread" });
	await editor.api.entries.publish({ siteId, entryId: post.id });
	const pagesId = (await editor.api.postTypes.list({ siteId })).postTypes.find((each) => each.builtIn === "page")?.id;
	const { entry: about } = await editor.api.entries.create({ siteId, postTypeId: pagesId ?? "", title: "About" });
	await editor.api.entries.publish({ siteId, entryId: about.id });
});

afterAll(async () => {
	await install.close();
});

describe("a Redirect rule", () => {
	test("sends visitors from a path to its target, before the Site's own pages", async () => {
		await rules().add({ siteId, from: "/old-bread", to: "/blog/fresh-bread", status: 301 });
		await rules().add({ siteId, from: "/about", to: "/blog/fresh-bread", status: 302 });

		const moved = await install.request(`${SITE}/old-bread`);
		expect(moved.status).toBe(301);
		expect(moved.headers.get("location")).toBe("/blog/fresh-bread");
		// Browsers check again each time, so a changed rule shows at once.
		expect(moved.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");
		expect(moved.headers.get("x-robots-tag")).toBe("noindex");
		expectSiteHeaders(moved);

		// About is a published Page, yet the rule answers first.
		const about = await install.request(`${SITE}/about`);
		expect(about.status).toBe(302);
		expect(about.headers.get("location")).toBe("/blog/fresh-bread");
		expect((await install.request(`${SITE}/blog/fresh-bread`)).status).toBe(200);
	});
});
