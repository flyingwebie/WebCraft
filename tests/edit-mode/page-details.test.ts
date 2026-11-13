// The Page details drawer in Edit mode: the values of the page's Entry that don't show on the page
// (its title, its address, its SEO fields, its Summary, its social image and noindex), each in the
// page's language where it is translatable. The drawer shows what the page falls back to when a value
// is empty (the SEO title pattern, the Summary as description, the image Field or the Site's default
// image) and saves every change to the Draft as the admin's Entry editor does: a slug another Entry
// has is refused the same way.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type EditModeBrowser, openEditMode } from "../harness/edit-mode.ts";
import { pdf, photo, upload } from "../harness/images.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let author: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
	author = (await install.createMember({ workspaceId, role: "author" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type Bakery = {
	siteId: string;
	origin: string;
	postTypeId: string;
	entryId: string;
	homeId: string;
	loaf: string;
	rolls: string;
};

async function readyImage(siteId: string, name: string): Promise<string> {
	await install.clock.advance(1000);
	const { media } = await editor.api.media.upload({
		siteId,
		file: upload(await photo({ width: 1400, height: 800 }), name),
	});
	expect((await install.drainJobs()).failed).toEqual([]);
	return media.id;
}

/**
 * A Site in English and Italian with Recipes (a Summary field and a photo, the image Field) and a
 * published Recipe at /recipes/sourdough, and a published home page.
 */
async function bakery(): Promise<Bakery> {
	const slug = `details-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	await staff.api.languages.add({ siteId, code: "it" });
	const loaf = await readyImage(siteId, "loaf.jpg");
	const rolls = await readyImage(siteId, "rolls.jpg");
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "summary", label: "Summary", type: "text" },
			{ key: "photo", label: "Photo", type: "media" },
		],
		summaryField: "summary",
	});
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const { entry } = await editor.api.entries.create({
		siteId,
		postTypeId: postType.id,
		title: "Sourdough",
		fields: { summary: "Our country loaf, baked every morning.", photo: loaf },
	});
	await editor.api.entries.publish({ siteId, entryId: entry.id });
	const pagesId = (await staff.api.postTypes.list({ siteId })).postTypes.find((type) => type.builtIn === "page")?.id;
	const { entry: home } = await staff.api.entries.create({ siteId, postTypeId: pagesId ?? "", title: "Home" });
	await staff.api.entries.publish({ siteId, entryId: home.id });
	await staff.api.pages.setHomePage({ siteId, pageId: home.id });
	return {
		siteId,
		origin: `https://${slug}.live.test`,
		postTypeId: postType.id,
		entryId: entry.id,
		homeId: home.id,
		loaf,
		rolls,
	};
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

describe("the Page details drawer", () => {
	let site: Bakery;
	let editing: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		editing = await openEditMode(install, editor, site.siteId, "/recipes/sourdough");
	});

	test("shows the page's values that don't show on it, with what each falls back to", async () => {
		const response = await editing.edit("details", { item: `entry:${site.entryId}` });

		expect(response.status).toBe(200);
		expect(await json(response)).toMatchObject({
			item: `entry:${site.entryId}`,
			language: "en",
			title: "Sourdough",
			address: { slug: "sourdough", prefix: "/recipes/", path: "/recipes/sourdough", home: false },
			seo: { title: null, description: null, canonical: null, image: null, noindex: false },
			fallbacks: {
				title: "Sourdough · Acme Bakery",
				description: "Our country loaf, baked every morning.",
				image: { mediaId: site.loaf, from: "field" },
			},
			summary: { field: "summary", label: "Summary", type: "text", value: "Our country loaf, baked every morning." },
			translatable: { title: true, slug: true, seo: true, summary: true },
			image: { id: site.loaf, fileName: "loaf.jpg" },
		});
	});

	test("every change goes to the Draft; visitors see the published page until it is published", async () => {
		const item = `entry:${site.entryId}`;

		const response = await editing.edit("details/save", {
			item,
			title: "Country sourdough",
			seo: { title: "Sourdough loaves in Cork", description: "Fresh every day.", image: site.rolls, noindex: true },
			summary: "A loaf with a crackling crust.",
		});

		expect(response.status).toBe(200);
		expect(await json(response)).toMatchObject({
			details: {
				title: "Country sourdough",
				seo: { title: "Sourdough loaves in Cork", description: "Fresh every day.", image: site.rolls, noindex: true },
				summary: { value: "A loaf with a crackling crust." },
				image: { id: site.rolls },
			},
			problems: [],
		});
		const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.draft).toMatchObject({
			title: "Country sourdough",
			fields: { summary: "A loaf with a crackling crust." },
			seo: { title: "Sourdough loaves in Cork", noindex: true },
		});
		expect(entry.published?.title).toBe("Sourdough");
		const page = await (await editing.page("/recipes/sourdough")).text();
		expect(page).toContain("<title>Sourdough loaves in Cork</title>");
		expect(await (await install.request(`${site.origin}/recipes/sourdough`)).text()).toContain(
			"<title>Sourdough · Acme Bakery</title>",
		);
	});

	test("an empty value clears it: the page falls back again", async () => {
		const response = await editing.edit("details/save", {
			item: `entry:${site.entryId}`,
			seo: { title: "", description: null, image: null },
		});

		expect(await json(response)).toMatchObject({
			details: {
				seo: { title: null, description: null, image: null },
				fallbacks: { title: "Country sourdough · Acme Bakery", image: { mediaId: site.loaf, from: "field" } },
			},
		});
	});

	test("the social image is a shareable image of the Site's library", async () => {
		const { media: leaflet } = await editor.api.media.upload({ siteId: site.siteId, file: upload(pdf(), "menu.pdf") });

		const response = await editing.edit("details/save", { item: `entry:${site.entryId}`, seo: { image: leaflet.id } });

		expect({ status: response.status, body: await json(response) }).toMatchObject({
			status: 400,
			body: { code: "ENTRY_INVALID", data: { problems: [{ at: "seo.image" }] } },
		});
	});
});

describe("the address in Page details", () => {
	let site: Bakery;
	let editing: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		editing = await openEditMode(install, editor, site.siteId, "/recipes/sourdough");
	});

	test("a new slug goes to the Draft, and the address it will have shows", async () => {
		const response = await editing.edit("details/save", { item: `entry:${site.entryId}`, slug: "country-sourdough" });

		expect(await json(response)).toMatchObject({
			details: { address: { slug: "country-sourdough", path: "/recipes/country-sourdough" } },
		});
		const visitors = await install.request(`${site.origin}/recipes/sourdough`);
		expect(visitors.status).toBe(200);
	});

	test("a slug another Entry has is refused, as the admin refuses it", async () => {
		const { entry: rye } = await editor.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.postTypeId,
			title: "Rye",
		});

		const response = await editing.edit("details/save", { item: `entry:${rye.id}`, slug: "country-sourdough" });

		expect({ status: response.status, body: await json(response) }).toMatchObject({
			status: 409,
			body: { code: "ENTRY_SLUG_TAKEN", data: { slug: "country-sourdough" } },
		});
	});

	test("a slug that can't be one is refused", async () => {
		const response = await editing.edit("details/save", { item: `entry:${site.entryId}`, slug: "Not a slug!" });

		expect({ status: response.status, code: (await json(response)).code }).toEqual({
			status: 400,
			code: "ENTRY_INVALID",
		});
	});

	test("the home page is at the Site's root: its slug isn't part of its address", async () => {
		const response = await editing.edit("details", { item: `entry:${site.homeId}` });

		expect(await json(response)).toMatchObject({ address: { path: "/", home: true } });
	});
});

describe("Page details in a language", () => {
	let site: Bakery;
	let editing: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		editing = await openEditMode(install, editor, site.siteId, "/it/recipes/sourdough");
	});

	test("translatable values are the page's language's; noindex is one for every language", async () => {
		const item = `entry:${site.entryId}`;

		await editing.edit("details/save", {
			item,
			language: "it",
			title: "Pane a lievitazione naturale",
			slug: "pane",
			seo: { description: "Ogni mattina.", noindex: true },
		});

		const italian = await json(await editing.edit("details", { item, language: "it" }));
		expect(italian).toMatchObject({
			language: "it",
			title: "Pane a lievitazione naturale",
			address: { slug: "pane", prefix: "/it/recipes/", path: "/it/recipes/pane" },
			seo: { description: "Ogni mattina.", noindex: true },
		});
		const english = await json(await editing.edit("details", { item, language: "en" }));
		expect(english).toMatchObject({
			title: "Sourdough",
			address: { slug: "sourdough" },
			seo: { description: null, noindex: true },
		});
	});
});

describe("who may change Page details", () => {
	let site: Bakery;

	beforeAll(async () => {
		site = await bakery();
	});

	test("Authors change them: they are Content", async () => {
		const editing = await openEditMode(install, author, site.siteId, "/recipes/sourdough");

		const response = await editing.edit("details/save", { item: `entry:${site.entryId}`, seo: { title: "Bread" } });

		expect(response.status).toBe(200);
	});

	test("another Site's Entries can't be read or changed", async () => {
		const other = await bakery();
		const editing = await openEditMode(install, editor, site.siteId, "/recipes/sourdough");

		const read = await editing.edit("details", { item: `entry:${other.entryId}` });
		const changed = await editing.edit("details/save", { item: `entry:${other.entryId}`, title: "Stolen" });

		expect([read.status, changed.status]).toEqual([404, 404]);
		const { entry } = await editor.api.entries.get({ siteId: other.siteId, entryId: other.entryId });
		expect(entry.draft.title).toBe("Sourdough");
	});
});
