// noindex Entries stay out of Site search (ADR 0021): what an Entry asks search engines not to index,
// the Site's own search doesn't list either. Their pages still answer, and other Loops still list them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let recipesId: string;
const SITE = "https://bakery.live.test";

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	await goLive(install, siteId);
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	recipesId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Recipes",
			key: "recipes",
			urlPattern: "/recipes/{slug}",
			fields: [{ key: "body", label: "Body", type: "body" }],
		})
	).postType.id;
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: recipesId,
		markup: "<h1>{{ title }}</h1>{{ body }}",
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	const pagesId = postTypes.find((candidate) => candidate.builtIn === "page")?.id ?? "";
	const { entry: search } = await staff.api.entries.create({ siteId, postTypeId: pagesId, title: "Search" });
	await staff.api.entries.publish({ siteId, entryId: search.id });
	await staff.api.pages.setSearchPage({ siteId, pageId: search.id });
});

afterAll(async () => {
	await install.close();
});

async function recipe(title: string, seo: Record<string, unknown> = {}): Promise<string> {
	const { entry } = await staff.api.entries.create({
		siteId,
		postTypeId: recipesId,
		title,
		fields: { body: [{ type: "paragraph", text: "A loaf of bread." }] },
		seo,
	});
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	return entry.id;
}

describe("Site search", () => {
	test("leaves noindex Entries out of its hits, while their pages still answer", async () => {
		await recipe("Country bread");
		const hiddenId = await recipe("Staff bread", { noindex: true });

		const html = await (await install.request(`${SITE}/search?q=bread`)).text();

		expect(html).toContain("Country bread");
		expect(html).not.toContain("Staff bread");
		expect((await install.request(`${SITE}/recipes/staff-bread`)).status).toBe(200);

		// Indexable again, it is found again.
		await staff.api.entries.saveDraft({ siteId, entryId: hiddenId, seo: { noindex: false } });
		await staff.api.entries.publish({ siteId, entryId: hiddenId });
		expect(await (await install.request(`${SITE}/search?q=bread`)).text()).toContain("Staff bread");
	});
});
