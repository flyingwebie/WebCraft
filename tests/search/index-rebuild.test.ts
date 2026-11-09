// Rebuilding a Site's search index (ADR 0021): publishing keeps each Entry's documents up to date at
// once; a change to what they are built from (Searched fields, weights, the Site's languages) asks
// for the whole index to be rebuilt by a job, which runs within a minute. Until then search answers
// from the index as it was.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, fromAddress, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSafePage } from "../harness/site-safety.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let recipesId: string;
const SITE = "https://bakery.sites.test";
/** Searches come from visitors of their own: each address may search 30 times a minute. */
let visitors = 0;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	recipesId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Recipes",
			key: "recipes",
			urlPattern: "/recipes/{slug}",
			fields: [
				{ key: "summary", label: "Summary", type: "text" },
				{ key: "body", label: "Body", type: "body" },
			],
		})
	).postType.id;
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: recipesId,
		markup: "<h1>{{ title }}</h1>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	const pages = postTypes.find((postType) => postType.builtIn === "page");
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: pages?.id ?? "", title: "Search" });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	await staff.api.pages.setSearchPage({ siteId, pageId: entry.id });
	await recipe("Brioche", { summary: "Flaky and golden", body: [{ type: "paragraph", text: "Rich dough." }] });
	await recipe("Rye", { summary: "With walnut pieces" });
	await recipe("Walnut cake", {});
	await settle();
});

afterAll(async () => {
	await install.close();
});

async function recipe(title: string, fields: Record<string, unknown>): Promise<string> {
	const { entry } = await staff.api.entries.create({ siteId, postTypeId: recipesId, title, fields });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	return entry.id;
}

/** Lets a minute go by and runs the jobs that are due then, as the worker would. */
async function settle() {
	await install.clock.advance(60_000);
	return install.drainJobs();
}

async function found(query: string, path = "/search"): Promise<string[]> {
	const url = `${SITE}${path}?q=${encodeURIComponent(query)}`;
	const html = await expectSafePage(
		await install.request(fromAddress(new Request(url), `203.0.113.${++visitors % 250}`)),
	);
	return [...html.matchAll(/<li><h2><a href="[^"]*">([^<]*)<\/a><\/h2>/g)].map(([, title = ""]) => title);
}

describe("changing Searched fields", () => {
	test("a Field Staff add is searched once the Site's index is rebuilt, within a minute", async () => {
		expect(await found("flaky")).toEqual([]);

		await staff.api.postTypes.update({
			siteId,
			postTypeId: recipesId,
			searchedFields: [
				{ field: "title", weight: "A" },
				{ field: "body", weight: "B" },
				{ field: "summary", weight: "C" },
			],
		});
		expect(await found("flaky")).toEqual([]);

		const drained = await settle();
		expect(drained.completed.map((run) => run.name)).toContain("search.rebuild");
		expect(drained.failed).toEqual([]);
		expect(await found("flaky")).toEqual(["Brioche"]);
	});

	test("a Field Staff take out is no longer searched once the index is rebuilt", async () => {
		expect(await found("dough")).toEqual(["Brioche"]);

		await staff.api.postTypes.update({
			siteId,
			postTypeId: recipesId,
			searchedFields: [
				{ field: "title", weight: "A" },
				{ field: "summary", weight: "C" },
			],
		});
		await settle();

		expect(await found("dough")).toEqual([]);
	});

	test("weights decide which hits come first", async () => {
		expect(await found("walnut")).toEqual(["Walnut cake", "Rye"]);

		await staff.api.postTypes.update({
			siteId,
			postTypeId: recipesId,
			searchedFields: [
				{ field: "summary", weight: "A" },
				{ field: "title", weight: "D" },
			],
		});
		await settle();

		expect(await found("walnut")).toEqual(["Rye", "Walnut cake"]);
	});

	test("every Site whose index is behind is rebuilt in the same minute", async () => {
		const workspaceId = (await install.createWorkspace("Other Ltd")).id;
		const admin = await install.superadmin();
		const others: string[] = [];
		for (const slug of ["mill", "dairy"]) {
			const otherId = (await install.createSite(workspaceId, { name: slug, slug })).id;
			const { postType } = await admin.api.postTypes.create({
				siteId: otherId,
				name: "Notes",
				urlPattern: "/notes/{slug}",
				fields: [{ key: "summary", label: "Summary", type: "text" }],
			});
			others.push(otherId);
			await admin.api.postTypes.update({
				siteId: otherId,
				postTypeId: postType.id,
				searchedFields: [{ field: "summary", weight: "A" }],
			});
		}
		await staff.api.postTypes.update({
			siteId,
			postTypeId: recipesId,
			searchedFields: [
				{ field: "title", weight: "A" },
				{ field: "summary", weight: "B" },
			],
		});

		const drained = await settle();

		const rebuilt = drained.completed.filter((run) => run.name === "search.rebuild").map((run) => run.data);
		expect(rebuilt).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ siteId }),
				expect.objectContaining({ siteId: others[0] }),
				expect.objectContaining({ siteId: others[1] }),
			]),
		);
		expect(drained.failed).toEqual([]);
	});

	test("a change that searches the same as before rebuilds nothing", async () => {
		await staff.api.postTypes.update({ siteId, postTypeId: recipesId, name: "Our recipes" });
		await staff.api.postTypes.update({ siteId, postTypeId: recipesId, searchable: false });
		await staff.api.postTypes.update({ siteId, postTypeId: recipesId, searchable: true });

		const drained = await settle();

		expect(drained.completed.map((run) => run.name)).not.toContain("search.rebuild");
	});
});

describe("rebuilds that don't finish", () => {
	test("a Site whose rebuild hasn't finished an hour after it was queued is queued again", async () => {
		await staff.api.postTypes.update({
			siteId,
			postTypeId: recipesId,
			searchedFields: [{ field: "title", weight: "A" }],
		});
		// The minute's sweep queues a rebuild, which doesn't run (as when it keeps failing).
		await install.clock.advance(60_000);
		await install.drainJobs({ only: ["search.rebuild-due"] });
		await install.clock.advance(61 * 60_000);
		await install.drainJobs({ only: ["search.rebuild-due"] });

		const drained = await install.drainJobs();

		const rebuilds = drained.completed.filter(
			(run) => run.name === "search.rebuild" && (run.data as { siteId: string }).siteId === siteId,
		);
		expect(rebuilds).toHaveLength(2);
		expect(drained.failed).toEqual([]);
		expect(await found("walnut")).toEqual(["Walnut cake"]);
	});
});
