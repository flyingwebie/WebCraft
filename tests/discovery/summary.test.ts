// A Post Type's Summary field (GLOSSARY.md › Summary): the Field that says in short what each Entry is
// about. It is one setting with the SEO settings' description Field (its older name): pages'
// descriptions fall back to it, and llms.txt and the Markdown copies show it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { metaName } from "../harness/seo.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

async function newSite(): Promise<{ siteId: string; postTypeId: string; origin: string }> {
	const slug = `summary-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const origin = await goLive(install, siteId);
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Recipes",
		key: "recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "intro", label: "Intro", type: "richText" },
			{ key: "body", label: "Body", type: "body" },
			{ key: "serves", label: "Serves", type: "number" },
		],
	});
	const saved = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	return { siteId, postTypeId: postType.id, origin };
}

describe("one setting", () => {
	test("set as the Summary field, it is the description Field too, and the other way round", async () => {
		const site = await newSite();

		const set = await staff.api.postTypes.update({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			summaryField: "summary",
		});
		expect(set.postType.summaryField).toBe("summary");
		expect(set.postType.seo.descriptionField).toBe("summary");

		const older = await staff.api.postTypes.update({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			seo: { descriptionField: "intro" },
		});
		expect(older.postType.summaryField).toBe("intro");

		const cleared = await staff.api.postTypes.update({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			summaryField: null,
		});
		expect(cleared.postType.summaryField).toBeNull();
		expect(cleared.postType.seo.descriptionField).toBeNull();
	});

	test("is refused where it is given: a Field of another kind, or two different Fields at once", async () => {
		const site = await newSite();
		const refused = (change: Record<string, unknown>) =>
			staff.api.postTypes
				.update({ siteId: site.siteId, postTypeId: site.postTypeId, ...change })
				.catch((error: unknown) => error);

		expect(await refused({ summaryField: "serves" })).toMatchObject({
			code: "POST_TYPE_INVALID",
			data: { problems: [{ at: "summaryField", rule: "summaryField", params: { field: "serves" } }] },
		});
		expect(await refused({ summaryField: "summary", seo: { descriptionField: "intro" } })).toMatchObject({
			data: { problems: [{ at: "summaryField", rule: "summaryFieldTwice" }] },
		});
		// The same Field given both ways is one change.
		const same = await staff.api.postTypes.update({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			summaryField: "summary",
			seo: { descriptionField: "summary" },
		});
		expect(same.postType.summaryField).toBe("summary");
	});

	test("a page without a description of its own takes its Entry's Summary, cut at a word", async () => {
		const site = await newSite();
		await staff.api.postTypes.update({ siteId: site.siteId, postTypeId: site.postTypeId, summaryField: "summary" });
		const { entry } = await staff.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Sourdough",
			fields: {
				summary: "A slow loaf with a crackling crust.",
				body: [{ type: "paragraph", text: "Start the night before." }],
			},
		});
		await staff.api.entries.publish({ siteId: site.siteId, entryId: entry.id });

		const html = await (await install.request(`${site.origin}/recipes/sourdough`)).text();
		expect(metaName(html, "description")).toBe("A slow loaf with a crackling crust.");
	});

	test("an Entry whose Summary is empty describes itself with the start of its Body field", async () => {
		const site = await newSite();
		await staff.api.postTypes.update({ siteId: site.siteId, postTypeId: site.postTypeId, summaryField: "summary" });
		const { entry } = await staff.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Rye",
			fields: { body: [{ type: "paragraph", text: "Rye takes three days." }] },
		});
		await staff.api.entries.publish({ siteId: site.siteId, entryId: entry.id });

		const html = await (await install.request(`${site.origin}/recipes/rye`)).text();
		expect(metaName(html, "description")).toBe("Rye takes three days.");
	});
});
