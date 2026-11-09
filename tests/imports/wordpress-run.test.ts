// A WordPress import's run, from the made-up bakery's export file with the mapping the Map step
// suggests (plus a key mapped by hand): posts, a custom post type, pages with their hierarchy and
// terms as related Entries come in as Drafts with their Source ids; bodies become core Blocks, with
// what no Block reads kept as plain text and listed as Import leftovers; Media comes in once per
// address through the guarded fetcher, with alt text and captions; and Redirect rules send the old
// addresses (posts, products, Media files) to the new ones, never over a live page.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { photo } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { approveModules, OLD_SITE_ADDRESS, runImport, serveOldSite, surveyedExport } from "./wordpress.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let origin: string;
let report: Awaited<ReturnType<typeof runImport>>["run"];

const LOAF = "https://oldmill.example/wp-content/uploads/2024/03/loaf.jpg";
const OVEN = "https://oldmill.example/wp-content/uploads/2023/11/oven.png";

type Settings = Parameters<TestBrowser["api"]["imports"]["create"]>[0]["settings"];

beforeAll(async () => {
	install = await createTestInstall();
	await approveModules(install);
	const workspaceId = (await install.createWorkspace()).id;
	const site = await install.createSite(workspaceId, { slug: "old-mill" });
	siteId = site.id;
	origin = "https://old-mill.sites.test";
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	serveOldSite(install, {
		[LOAF]: await photo({ width: 640, height: 480 }),
		[OVEN]: await photo({ width: 320, height: 240, format: "png" }),
	});
	const file = await surveyedExport(install, staff.api, siteId);
	const settings = structuredClone(file.suggested) as Settings & {
		types: { type: string; keys: { key: string; to: unknown }[] }[];
	};
	// A key the suggestion skips (a system's own, by its `_`), mapped by hand to a new number Field.
	const product = settings.types.find((type) => type.type === "product");
	const price = product?.keys.find((key) => key.key === "_price");
	if (price) price.to = { newField: { key: "price", label: "Price", type: "number" } };
	({ run: report } = await runImport(install, staff.api, siteId, file.id, settings));
});

afterAll(async () => {
	await install.close();
});

async function postTypeNamed(name: string) {
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	const found = postTypes.find((postType) => postType.name === name);
	if (!found) throw new Error(`No Post Type ${name}: ${postTypes.map((each) => each.name).join(", ")}`);
	return found;
}

async function entriesOf(name: string) {
	return (await staff.api.entries.list({ siteId, postTypeId: (await postTypeNamed(name)).id })).entries;
}

describe("a run", () => {
	test("ends done, with its counts, the Post Types and Fields it made, and nothing published", async () => {
		expect(report).toMatchObject({
			status: "done",
			progress: { done: 13, total: 13 },
			source: "wordpress-import.export",
		});
		// 3 posts, 2 pages, 1 product, 2 categories, 2 tags, 1 flavour.
		expect(report.counts).toMatchObject({ created: 11, updated: 0, skipped: 0 });
		expect(report.structure.postTypes.map((postType) => postType.name).sort()).toEqual([
			"Categories",
			"Flavour",
			"Posts",
			"Product",
			"Tags",
		]);
		// Pages have no Body field: their content goes into a rich text Field added for it.
		expect(report.structure.fields).toEqual([
			{ postType: "Pages", key: "author_name", label: "Author name" },
			{ postType: "Pages", key: "content", label: "Content" },
		]);
		for (const name of ["Posts", "Pages", "Product", "Categories"]) {
			for (const entry of await entriesOf(name)) expect(entry.status).toBe("draft");
		}
	});

	test("brings posts in with their values, SEO fields, author name, date and Source id", async () => {
		const posts = await entriesOf("Posts");
		expect(posts.map((post) => post.draft.title).sort()).toEqual([
			"A draft we never finished",
			"Rye week",
			"Spring opening hours",
		]);
		const spring = posts.find((post) => post.draft.title === "Spring opening hours");
		expect(spring?.draft).toMatchObject({
			slug: "spring-opening-hours",
			fields: {
				excerpt: "We open an hour earlier from April.",
				published: "2024-03-12T09:30:00Z",
				author_name: "Mara Quinn",
				subtitle: "Earlier mornings",
			},
			seo: { title: "Spring hours | Old Mill", description: "Earlier mornings from April." },
		});
		// The draft that never had a slug gets one from its title.
		expect(posts.find((post) => post.draft.title === "A draft we never finished")?.draft.slug).toBe(
			"a-draft-we-never-finished",
		);
		expect(report.created.find((change) => change.title === "Spring opening hours")).toBeDefined();
	});

	test("turns a body's HTML into core Blocks, keeping what no Block reads as a plain paragraph, and never a script or event handler", async () => {
		const spring = (await entriesOf("Posts")).find((post) => post.draft.title === "Spring opening hours");
		const blocks = (spring?.draft.fields.body ?? []) as Record<string, unknown>[];
		expect(blocks.map((block) => block.type)).toEqual([
			"paragraph",
			"heading",
			"list",
			"image",
			"paragraph",
			"quote",
			"paragraph",
		]);
		expect(blocks[0]).toMatchObject({
			text: [
				{ text: "From April we open " },
				{ text: "an hour earlier", marks: ["bold"] },
				{ text: ", so the first loaves are on the shelf at seven. See the " },
				{ text: "about page", link: "https://oldmill.example/about/" },
				{ text: "." },
			],
		});
		expect(blocks[1]).toMatchObject({ level: 2, text: [{ text: "When we bake" }] });
		expect(blocks[4]).toMatchObject({ text: [{ text: '[order_form id="7"]' }] });
		expect(blocks[6]).toMatchObject({ text: [{ text: "Come early." }] });
		expect(JSON.stringify(blocks)).not.toMatch(/script|steal|onclick|never/);
		const rye = (await entriesOf("Posts")).find((post) => post.draft.title === "Rye week");
		expect(((rye?.draft.fields.body ?? []) as Record<string, unknown>[]).map((block) => block.type)).toEqual([
			"paragraph",
			"video",
			"paragraph",
		]);
	});

	test("lists the Import leftovers in the report, with the Entry and Post Type each is in", async () => {
		const leftovers = report.leftovers.map((leftover) => [leftover.title, leftover.postType?.name, leftover.markup]);
		expect(leftovers).toEqual([
			["Spring opening hours", "Posts", '[order_form id="7"]'],
			["Rye week", "Posts", '<div class="pb-row">'],
			["Rye week", "Posts", '<iframe src="https://maps.example/embed?place=mill">'],
			["About us", "Pages", "[contact_box]"],
		]);
		expect(report.leftoversTotal).toBe(4);
		expect(report.leftovers[1]?.text).toBe("Two kinds\nof rye");
	});

	test("fetches each file once through the guarded fetcher, pinned to the address it checked, with its texts", async () => {
		const fetched = install.http.requests.filter((request) => request.url.startsWith("https://oldmill.example/"));
		expect(fetched.map((request) => [request.url, request.address]).sort()).toEqual([
			[OVEN, OLD_SITE_ADDRESS],
			[LOAF, OLD_SITE_ADDRESS],
		]);
		expect((await install.drainJobs()).failed).toEqual([]);
		const { items } = await staff.api.media.list({ siteId });
		const loaf = items.find((item) => item.fileName === "loaf.jpg");
		expect(loaf).toMatchObject({ title: "Loaf", alt: "A sourdough loaf on a board", caption: "Our sourdough loaf" });
		expect(items.map((item) => item.fileName).sort()).toEqual(["loaf.jpg", "oven.png"]);
		expect(report.files).toBe(2);

		// The featured image and the body's resized copy both point at the one file.
		const spring = (await entriesOf("Posts")).find((post) => post.draft.title === "Spring opening hours");
		expect(spring?.draft.fields.image).toBe(loaf?.id);
		const image = ((spring?.draft.fields.body ?? []) as Record<string, unknown>[]).find(
			(block) => block.type === "image",
		);
		expect(image?.media).toBe(loaf?.id);
	});

	test("brings pages in under their parent, even when a child comes first in the file", async () => {
		const pages = await entriesOf("Pages");
		const about = pages.find((page) => page.draft.title === "About us");
		const team = pages.find((page) => page.draft.title === "Our team");
		expect(about?.draft.parentId).toBeNull();
		expect(team?.draft.parentId).toBe(about?.id);
		// Pages have no Body field: their content is rich text, cleaned.
		expect(about?.draft.fields.content).toBe("<p>We have baked by the river since 1921.</p><p>[contact_box]</p>");
	});

	test("brings terms in as Entries the posts are related to", async () => {
		const categories = await entriesOf("Categories");
		expect(categories.map((entry) => entry.draft.title).sort()).toEqual(["News", "Recipes"]);
		const tags = await entriesOf("Tags");
		const spring = (await entriesOf("Posts")).find((post) => post.draft.title === "Spring opening hours");
		expect(spring?.draft.fields.categories).toEqual([
			categories.find((entry) => entry.draft.title === "News")?.id ?? "",
		]);
		expect(((spring?.draft.fields.tags ?? []) as string[]).length).toBe(tags.length);
		const product = (await entriesOf("Product"))[0];
		const nutty = (await entriesOf("Flavour"))[0];
		expect(product?.draft.fields).toMatchObject({ price: 5.2, serves: "8", flavour: [nutty?.id ?? ""] });
	});

	test("makes Redirect rules where paths changed, Media files included, and visitors follow them", async () => {
		const rules = report.redirects.rules.map((rule) => [rule.from, rule.to.replace(/^media:.*/, "media")]).sort();
		expect(rules).toEqual(
			[
				["/wp-content/uploads/2023/11/oven.png", "media"],
				["/2024/03/spring-opening-hours", "/posts/spring-opening-hours"],
				["/2024/04/rye-week", "/posts/rye-week"],
				["/products/seeded-rye", "/product/seeded-rye"],
				["/wp-content/uploads/2024/03/loaf.jpg", "media"],
			].sort(),
		);
		expect(report.redirects).toMatchObject({ on: true, count: 5 });

		const moved = await install.request(`${origin}/2024/03/spring-opening-hours/`);
		expect(moved.status).toBe(301);
		expect(moved.headers.get("location")).toBe("/posts/spring-opening-hours");
		const file = await install.request(`${origin}/wp-content/uploads/2024/03/loaf.jpg`);
		expect(file.status).toBe(301);
		expect(file.headers.get("location")).toMatch(/^\/_media\/[0-9a-f]{16}-loaf\.jpg$/);
	});

	test("makes no rule where the new path is the old one", async () => {
		expect(report.redirects.rules.map((rule) => rule.from)).not.toContain("/about");
		expect(report.redirects.rules.map((rule) => rule.from)).not.toContain("/about/team");
	});
});
