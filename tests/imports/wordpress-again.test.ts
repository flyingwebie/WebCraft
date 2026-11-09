// Before and after a WordPress import's run: the Map step's live sample and the Preview (real
// Entries with their Blocks, leftovers and Redirect rules, without writing or fetching anything);
// Run again by Source id (looked up within each item's Post Type, so a type mapped elsewhere comes
// in anew); Undo of a whole run, Redirect rules and created Post Types included; rules that never
// hide a live page; and a Site whose Redirects Module is off.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { photo } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { approveModules, runImport, serveOldSite, surveyedExport, WORDPRESS } from "./wordpress.ts";

let install: TestInstall;
let staff: TestBrowser;
let workspaceId: string;

const LOAF = "https://oldmill.example/wp-content/uploads/2024/03/loaf.jpg";
const OVEN = "https://oldmill.example/wp-content/uploads/2023/11/oven.png";

type Settings = Parameters<TestBrowser["api"]["imports"]["create"]>[0]["settings"];
type SourceSettings = Extract<Settings, { types: unknown }>;

beforeAll(async () => {
	install = await createTestInstall();
	await approveModules(install);
	workspaceId = (await install.createWorkspace()).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	serveOldSite(install, {
		[LOAF]: await photo({ width: 640, height: 480 }),
		[OVEN]: await photo({ width: 320, height: 240, format: "png" }),
	});
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

/** A new Site with the export file surveyed on it. */
async function siteWithFile() {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { slug })).id;
	const file = await surveyedExport(install, staff.api, siteId);
	return {
		siteId,
		origin: `https://${slug}.sites.test`,
		file,
		settings: structuredClone(file.suggested) as SourceSettings,
	};
}

const oldSiteCalls = () =>
	install.http.requests.filter((request) => request.url.startsWith("https://oldmill.example/")).length;

async function postTypeNamed(siteId: string, name: string) {
	return (await staff.api.postTypes.list({ siteId })).postTypes.find((postType) => postType.name === name);
}

describe("before a run", () => {
	test("the live sample Entry reads one of the file's items with the mapping as it is", async () => {
		const { siteId, file, settings } = await siteWithFile();
		const { sample } = await staff.api.imports.sample({ siteId, fileId: file.id, settings, type: "post", index: 0 });
		expect(sample).toMatchObject({ of: 3, count: 3 });
		expect(sample.entry).toMatchObject({
			title: "Spring opening hours",
			action: "create",
			postType: { name: "Posts", isNew: true },
			path: "/posts/spring-opening-hours",
			redirect: { from: "/2024/03/spring-opening-hours", to: "/posts/spring-opening-hours" },
			sourceId: "wp:post:10",
			seo: { title: "Spring hours | Old Mill", description: "Earlier mornings from April." },
		});
		expect(sample.entry?.body?.blocks.map((block) => block.type)).toContain("image");
		expect(sample.entry?.leftovers.map((leftover) => leftover.markup)).toEqual(['[order_form id="7"]']);
		expect(sample.entry?.fields.find((field) => field.key === "image")?.value).toBe(LOAF);

		// Mapping the content nowhere: the sample has no body, and says the key is skipped.
		const post = settings.types.find((type) => type.type === "post");
		const content = post?.keys.find((key) => key.key === "content");
		if (content) content.to = null;
		const { sample: without } = await staff.api.imports.sample({
			siteId,
			fileId: file.id,
			settings,
			type: "post",
			index: 0,
		});
		expect(without.entry?.body).toBeNull();
		expect(without.entry?.skippedKeys).toContain("content");
	});

	test("the Preview shows real Entries with their Blocks, leftovers and Redirect rules, writing and fetching nothing", async () => {
		const { siteId, file, settings } = await siteWithFile();
		const typesBefore = (await staff.api.postTypes.list({ siteId })).postTypes.length;
		const calls = oldSiteCalls();
		const { preview: working } = await staff.api.imports.previewSource({ siteId, fileId: file.id, settings });
		expect(working.status).toBe("working");
		expect((await install.drainJobs()).failed).toEqual([]);
		const { preview } = await staff.api.imports.previewSource({ siteId, fileId: file.id, settings });

		expect(preview).toMatchObject({
			status: "ready",
			progress: { done: 13, total: 13 },
			counts: { create: 11, update: 0, skip: 0 },
			files: 2,
			redirects: 5,
			redirectsOn: true,
			leftovers: 4,
		});
		expect(preview.newPostTypes.sort()).toEqual(["Categories", "Flavour", "Posts", "Product", "Tags"]);
		expect(preview.skippedKeys.find((each) => each.type === "post")?.keys).toEqual(["modified", "_edit_lock"]);
		const rye = preview.entries.find((entry) => entry.title === "Rye week");
		expect(rye?.body?.blocks.map((block) => block.type)).toEqual(["paragraph", "video", "paragraph"]);
		expect(rye?.leftovers).toHaveLength(2);
		expect(preview.media.map((item) => item.address).sort()).toEqual([OVEN, LOAF].sort());

		// Nothing was written or fetched.
		expect((await staff.api.postTypes.list({ siteId })).postTypes.length).toBe(typesBefore);
		expect((await staff.api.media.list({ siteId })).items).toEqual([]);
		expect(oldSiteCalls()).toBe(calls);
	});

	test("says when the Redirects Module is off: a run then makes no rules", async () => {
		const { siteId, file, settings } = await siteWithFile();
		await staff.api.modules.setOnSite({ siteId, moduleId: "redirects", on: false });
		expect((await staff.api.imports.sources({ siteId })).redirectsOn).toBe(false);
		await staff.api.imports.previewSource({ siteId, fileId: file.id, settings });
		await install.drainJobs();
		const { preview } = await staff.api.imports.previewSource({ siteId, fileId: file.id, settings });
		expect(preview).toMatchObject({ status: "ready", redirectsOn: false, redirects: 0 });
		const { run } = await runImport(install, staff.api, siteId, file.id, settings);
		expect(run.redirects).toEqual({ on: false, count: 0, rules: [] });
	});
});

describe("Run again", () => {
	test("updates untouched Entries, skips hand-edited ones, and fetches no file twice", async () => {
		const { siteId, file, settings } = await siteWithFile();
		const { importId } = await runImport(install, staff.api, siteId, file.id, settings);
		const posts = await postTypeNamed(siteId, "Posts");
		const { entries } = await staff.api.entries.list({ siteId, postTypeId: posts?.id ?? "" });
		const rye = entries.find((entry) => entry.draft.title === "Rye week");
		await staff.api.entries.saveDraft({ siteId, entryId: rye?.id ?? "", fields: { subtitle: "Edited by hand" } });
		const calls = oldSiteCalls();

		const again = await surveyedExport(install, staff.api, siteId);
		const { run } = await staff.api.imports.start({ siteId, importId, fileId: again.id });
		expect((await install.drainJobs()).failed).toEqual([]);
		const { run: report } = await staff.api.imports.report({ siteId, runId: run.id });
		expect(report.counts).toMatchObject({ created: 0, skipped: 1 });
		expect(report.counts.unchanged + report.counts.updated).toBe(10);
		expect(report.skipped.map((change) => [change.title, change.reason])).toEqual([["Rye week", "edited"]]);
		expect(oldSiteCalls()).toBe(calls);
		// The Import now names the Post Types and Fields its first run made.
		const { import: kept } = await staff.api.imports.get({ siteId, importId });
		const post = (kept.settings as SourceSettings).types.find((type) => type.type === "post");
		expect(post?.to).toEqual({ postTypeId: posts?.id });
		expect(post?.keys.find((key) => key.key === "content")?.to).toBe("fields.body");
	});

	test("brings a type mapped to another Post Type in anew there, its Source ids looked up within that Post Type", async () => {
		const { siteId, file, settings } = await siteWithFile();
		const { importId } = await runImport(install, staff.api, siteId, file.id, settings);
		const product = await postTypeNamed(siteId, "Product");
		const { postType: shop } = await staff.api.postTypes.create({
			siteId,
			name: "Shop",
			urlPattern: "/shop/{slug}",
			fields: [{ key: "serves", label: "Serves", type: "text" }],
		});
		const { import: kept } = await staff.api.imports.get({ siteId, importId });
		const changed = structuredClone(kept.settings) as SourceSettings;
		const products = changed.types.find((type) => type.type === "product");
		if (products) {
			products.to = { postTypeId: shop.id };
			products.keys = [
				{ key: "title", to: "title" },
				{ key: "slug", to: "slug" },
				{ key: "serves", to: "fields.serves" },
			];
		}
		await staff.api.imports.update({ siteId, importId, settings: changed });

		const again = await surveyedExport(install, staff.api, siteId);
		const { run } = await staff.api.imports.start({ siteId, importId, fileId: again.id });
		expect((await install.drainJobs()).failed).toEqual([]);
		const { run: report } = await staff.api.imports.report({ siteId, runId: run.id });
		expect(report.counts.created).toBe(1);
		const inShop = (await staff.api.entries.list({ siteId, postTypeId: shop.id })).entries;
		expect(inShop.map((entry) => [entry.draft.title, entry.draft.fields.serves])).toEqual([["Seeded rye", "8"]]);
		// The Entry the first run made stays where it was.
		expect((await staff.api.entries.list({ siteId, postTypeId: product?.id ?? "" })).entries).toHaveLength(1);
	});
});

describe("Undo", () => {
	test("removes the run's Drafts, Media, Redirect rules and the Post Types it made", async () => {
		const { siteId, origin, file, settings } = await siteWithFile();
		const { importId, run } = await runImport(install, staff.api, siteId, file.id, settings);
		expect((await install.drainJobs()).failed).toEqual([]);
		expect((await install.request(`${origin}/2024/03/spring-opening-hours`)).status).toBe(301);
		expect(run.undo).toEqual({ available: true, reason: null });

		const first = await staff.api.imports.undo({ siteId, runId: run.id });
		expect(first).toMatchObject({
			undone: false,
			preview: { removes: 11, restores: 0, files: 2, rules: 5 },
		});
		expect((first.preview.postTypes as string[]).sort()).toEqual(["Categories", "Flavour", "Posts", "Product", "Tags"]);
		const done = await staff.api.imports.undo({ siteId, runId: run.id, confirmation: first.confirmation?.id });
		expect(done).toMatchObject({ undone: true, run: { status: "undone" } });

		const names = (await staff.api.postTypes.list({ siteId })).postTypes.map((postType) => postType.name);
		expect(names).toEqual(["Pages"]);
		const pages = (await staff.api.postTypes.list({ siteId })).postTypes[0];
		expect((await staff.api.entries.list({ siteId, postTypeId: pages?.id ?? "" })).entries).toEqual([]);
		expect((await staff.api.media.list({ siteId })).items).toEqual([]);
		expect((await staff.api.media.list({ siteId, trash: true })).items).toHaveLength(2);
		expect((await install.request(`${origin}/2024/03/spring-opening-hours`)).status).toBe(404);
		// The Import names what it would make again, so it can run again from scratch.
		const { import: kept } = await staff.api.imports.get({ siteId, importId });
		expect((kept.settings as SourceSettings).types.find((type) => type.type === "post")?.to).toEqual({
			newPostType: { name: "Posts" },
		});
	});
});

describe("Redirect rules", () => {
	test("never hide a live page: where a page answers an old path, the page shows", async () => {
		const { siteId, origin, file, settings } = await siteWithFile();
		const { postType } = await staff.api.postTypes.create({ siteId, name: "Old shop", urlPattern: "/products/{slug}" });
		const saved = await staff.api.templates.saveEntryTemplateMarkup({
			siteId,
			postTypeId: postType.id,
			markup: "<article><h1>{{ title }}</h1></article>",
		});
		await staff.api.templates.publish({ siteId, templateId: saved.template.id });
		const { entry } = await staff.api.entries.create({ siteId, postTypeId: postType.id, title: "Seeded rye" });
		await staff.api.entries.publish({ siteId, entryId: entry.id });

		const { run } = await runImport(install, staff.api, siteId, file.id, settings);
		expect(run.redirects.rules.map((rule) => rule.from)).toContain("/products/seeded-rye");
		const page = await install.request(`${origin}/products/seeded-rye`);
		expect(page.status).toBe(200);
		expect(await page.text()).toContain("<h1>Seeded rye</h1>");
	});

	test("never take a path a rule already has", async () => {
		const { siteId, file, settings } = await siteWithFile();
		const rules = (staff.api as unknown as { m: { redirects: { rules: { add(input: unknown): Promise<unknown> } } } }).m
			.redirects.rules;
		await rules.add({ siteId, from: "/2024/04/rye-week", to: "/somewhere-else", status: 302 });
		const { run } = await runImport(install, staff.api, siteId, file.id, settings);
		expect(run.redirects.rules.map((rule) => rule.from)).not.toContain("/2024/04/rye-week");
	});
});

describe("an Import of the source", () => {
	test("refuses a file of another source, and settings of another kind", async () => {
		const { siteId, file, settings } = await siteWithFile();
		const { postTypes } = await staff.api.postTypes.list({ siteId });
		await expect(
			staff.api.imports.create({
				siteId,
				name: "Mixed",
				source: WORDPRESS,
				settings: { postTypeId: postTypes[0]?.id ?? "", language: null, match: "title", columns: [] },
			}),
		).rejects.toMatchObject({ code: "IMPORT_INVALID" });
		const { import: csv } = await staff.api.imports.create({
			siteId,
			name: "Products",
			source: "csv",
			settings: {
				postTypeId: postTypes[0]?.id ?? "",
				language: null,
				match: "title",
				columns: [{ column: "Title", to: "title" }],
			},
		});
		await expect(staff.api.imports.start({ siteId, importId: csv.id, fileId: file.id })).rejects.toMatchObject({
			code: "IMPORT_FILE_NOT_READY",
		});
		expect(settings.types.length).toBeGreaterThan(0);
	});
});
