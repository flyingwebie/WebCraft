// The Templates screen's list (Staff only): every Template a Site can have, made or not, so Staff
// open each in the builder. Pages have none; a URL pattern starting with {slug} has no Archive.
import { afterAll, beforeAll, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;
let siteId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

test("lists the Site template, the Search results template, then each Post Type's Entry and Archive templates", async () => {
	const { postType: blog } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
	});
	const { postType: team } = await staff.api.postTypes.create({ siteId, name: "Team", urlPattern: "/{slug}" });
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: blog.id,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });

	const { templates } = await staff.api.templates.list({ siteId });

	expect(templates).toEqual([
		{ kind: "site", postType: null, template: null, unavailable: null },
		{ kind: "search", postType: null, template: null, unavailable: null },
		{
			kind: "entry",
			postType: { id: blog.id, name: "Blog posts" },
			template: { id: saved.template.id, status: "published", updatedAt: expect.any(Date) },
			unavailable: null,
		},
		{ kind: "archive", postType: { id: blog.id, name: "Blog posts" }, template: null, unavailable: null },
		{ kind: "entry", postType: { id: team.id, name: "Team" }, template: null, unavailable: null },
		{ kind: "archive", postType: { id: team.id, name: "Team" }, template: null, unavailable: "address" },
	]);
});

test("is Staff's only", async () => {
	const { browser: owner } = await install.createMember({ workspaceId, role: "owner" });
	await expect(owner.api.templates.list({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
});
