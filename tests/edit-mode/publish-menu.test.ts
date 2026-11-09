// The editing bar's view of a page and its Publish menu: the page's changes (each undoable), Discard,
// Publish page, the link to Publish all and the Site's pages for the page switcher. Authors see their
// changes Saved to Draft and can't publish.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type EditModeBrowser, openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let editor: TestBrowser;
let author: TestBrowser;
let workspaceId: string;

beforeAll(async () => {
	install = await createTestInstall();
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	editor = (await install.createMember({ workspaceId, role: "editor", name: "Erin Editor" })).browser;
	author = (await install.createMember({ workspaceId, role: "author", name: "Aidan Author" })).browser;
});

afterAll(async () => {
	await install.close();
});

let sites = 0;

type Bakery = { siteId: string; origin: string; entryId: string; otherId: string; postTypeId: string };

/**
 * A Site whose pages show a Global, with two published Blog posts (/blog/fresh-bread and
 * /blog/scones) and a published About Page chosen as the home page.
 */
async function bakery(): Promise<Bakery> {
	const slug = `bakery-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await staff.api.globals.setFields({ siteId, fields: [{ key: "tagline", label: "Tagline", type: "text" }] });
	await editor.api.globals.saveDraft({ siteId, fields: { tagline: "Baked daily" } });
	await editor.api.globals.publish({ siteId });
	const site = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<header><p>{{ site.tagline }}</p></header><main>{{@outlet}}</main>",
	});
	await staff.api.templates.publish({ siteId, templateId: site.template.id });
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		urlPattern: "/blog/{slug}",
		fields: [
			{ key: "subtitle", label: "Subtitle", type: "text" },
			{ key: "intro", label: "Intro", type: "richText" },
		],
	});
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: "<article><h1>{{ title }}</h1><p>{{ subtitle }}</p><div>{{ intro }}</div></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const post = async (title: string) => {
		const { entry } = await editor.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title,
			fields: { subtitle: "Out of the oven", intro: "<p>Baked at seven.</p>" },
		});
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		return entry.id;
	};
	const entryId = await post("Fresh bread");
	const otherId = await post("Scones");
	const { postTypes } = await staff.api.postTypes.list({ siteId });
	const pages = postTypes.find((candidate) => candidate.builtIn === "page");
	if (!pages) throw new Error("The Site has no Page Post Type.");
	const { entry: about } = await editor.api.entries.create({ siteId, postTypeId: pages.id, title: "About us" });
	await editor.api.entries.publish({ siteId, entryId: about.id });
	await staff.api.pages.setHomePage({ siteId, pageId: about.id });
	return { siteId, origin: `https://${slug}.sites.test`, entryId, otherId, postTypeId: postType.id };
}

async function json(response: Response): Promise<Record<string, unknown>> {
	expect(response.headers.get("content-type")).toContain("application/json");
	return (await response.json()) as Record<string, unknown>;
}

type PageState = {
	page: { title: string; path: string; item: string | null };
	canPublish: boolean;
	changes: {
		item: string;
		key: string;
		label: string | null;
		type: string;
		by: { name: string; you: boolean } | null;
	}[];
	publishAll: { url: string; otherDrafts: number };
	pages: { title: string; path: string }[];
	person: { name: string };
	language: { code: string };
};

async function stateOf(editing: EditModeBrowser, path: string): Promise<PageState> {
	const response = await editing.edit("state", { path });
	expect(response.status).toBe(200);
	return (await json(response)) as unknown as PageState;
}

describe("the page's changes", () => {
	let site: Bakery;
	let editing: EditModeBrowser;
	const path = "/blog/fresh-bread";

	beforeAll(async () => {
		site = await bakery();
		editing = await openEditMode(install, editor, site.siteId, path);
	});

	test("a page with no changes says so", async () => {
		const state = await stateOf(editing, path);

		expect(state).toMatchObject({
			page: { title: "Fresh bread", path, item: `entry:${site.entryId}` },
			canPublish: true,
			changes: [],
			person: { name: "Erin Editor" },
			language: { code: "en" },
		});
	});

	test("lists each value of the page's Entry and of the Globals it shows that differs from what is published, and who changed it", async () => {
		const entry = `entry:${site.entryId}`;
		await editing.edit("save", { item: entry, field: "intro", value: "<p>Baked at six.</p>" });
		await editing.edit("save", { item: "globals", field: "tagline", value: "Baked twice daily" });
		const asAuthor = await openEditMode(install, author, site.siteId, path);
		await asAuthor.edit("save", { item: entry, field: "title", value: "Fresher bread" });

		const state = await stateOf(editing, path);

		expect(state.page.title).toBe("Fresher bread");
		expect(state.changes).toEqual([
			{ item: entry, key: "title", label: null, type: "text", by: { name: "Aidan Author", you: false } },
			{ item: entry, key: "intro", label: "Intro", type: "richText", by: { name: "Erin Editor", you: true } },
			{ item: "globals", key: "tagline", label: "Tagline", type: "text", by: { name: "Erin Editor", you: true } },
		]);
	});

	test("each change can be undone: the value goes back to what is published", async () => {
		const entry = `entry:${site.entryId}`;

		const response = await editing.edit("undo", { path, item: entry, key: "intro" });

		expect(response.status).toBe(200);
		const state = (await json(response)) as unknown as PageState;
		expect(state.changes.map((change) => change.key)).toEqual(["title", "tagline"]);
		const { entry: saved } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(saved.draft.fields.intro).toBe("<p>Baked at seven.</p>");
		expect(saved.draft.title).toBe("Fresher bread");
		expect(saved.status).toBe("changed");

		await editing.edit("undo", { path, item: entry, key: "title" });
		const { entry: undone } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(undone.status).toBe("published");
	});

	test("Discard puts every value of the page back as published, and nothing else", async () => {
		await editing.edit("save", { item: `entry:${site.entryId}`, field: "subtitle", value: "Still warm" });
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: site.otherId, title: "Scones, fresh" });

		const response = await editing.edit("discard", { path });

		expect(response.status).toBe(200);
		expect(((await json(response)) as unknown as PageState).changes).toEqual([]);
		const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.status).toBe("published");
		const { globals } = await editor.api.globals.get({ siteId: site.siteId });
		expect(globals.status).toBe("published");
		const { entry: other } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.otherId });
		expect(other.draft.title).toBe("Scones, fresh");
	});

	test("undoing something that isn't a change of the page is refused", async () => {
		const response = await editing.edit("undo", { path, item: `entry:${site.otherId}`, key: "title" });

		expect(response.status).toBe(400);
		expect(await json(response)).toMatchObject({ code: "EDIT_FIELD_INVALID" });
	});
});

describe("Publish page", () => {
	test("publishes the page's Entry and the Globals it shows: visitors see them at once", async () => {
		const site = await bakery();
		const path = "/blog/fresh-bread";
		const editing = await openEditMode(install, editor, site.siteId, path);
		await editing.edit("save", { item: `entry:${site.entryId}`, field: "subtitle", value: "Still warm" });
		await editing.edit("save", { item: "globals", field: "tagline", value: "Baked twice daily" });
		await install.request(`${site.origin}${path}`);

		const response = await editing.edit("publish", { path });

		expect(response.status).toBe(200);
		expect(((await json(response)) as unknown as PageState).changes).toEqual([]);
		const html = await (await install.request(`${site.origin}${path}`)).text();
		expect(html).toContain("<p>Still warm</p>");
		expect(html).toContain("<header><p>Baked twice daily</p></header>");
		const admin = await install.superadmin();
		const { entries } = await admin.api.audit.list({ limit: 50 });
		const published = entries.filter(
			(entry) => entry.siteId === site.siteId && ["entry.publish", "globals.publish"].includes(entry.action),
		);
		expect(published.slice(0, 2).map((entry) => [entry.action, entry.via])).toEqual(
			expect.arrayContaining([
				["entry.publish", { kind: "editMode" }],
				["globals.publish", { kind: "editMode" }],
			]),
		);
	});

	test("refuses a Draft that can't be published yet, saying why, and publishes none of the page", async () => {
		const site = await bakery();
		const path = "/blog/fresh-bread";
		const editing = await openEditMode(install, editor, site.siteId, path);
		await editing.edit("save", { item: "globals", field: "tagline", value: "Baked twice daily" });
		await editing.edit("save", { item: `entry:${site.entryId}`, field: "title", value: "" });

		const response = await editing.edit("publish", { path });

		expect(response.status).toBe(400);
		expect(await json(response)).toMatchObject({ code: "ENTRY_INCOMPLETE", data: { missing: ["title"] } });
		const { globals } = await editor.api.globals.get({ siteId: site.siteId });
		expect(globals.status).toBe("changed");
	});

	test("Authors see their changes Saved to Draft, and can't publish them", async () => {
		const site = await bakery();
		const path = "/blog/fresh-bread";
		const editing = await openEditMode(install, author, site.siteId, path);
		await editing.edit("save", { item: `entry:${site.entryId}`, field: "subtitle", value: "Still warm" });

		const state = await stateOf(editing, path);
		expect(state.canPublish).toBe(false);
		expect(state.changes).toHaveLength(1);

		const response = await editing.edit("publish", { path });
		expect(response.status).toBe(403);
		expect(await json(response)).toMatchObject({ code: "FORBIDDEN" });
		const { entry } = await editor.api.entries.get({ siteId: site.siteId, entryId: site.entryId });
		expect(entry.published?.fields.subtitle).toBe("Out of the oven");

		// Undoing their own changes is still theirs to do.
		expect((await editing.edit("discard", { path })).status).toBe(200);
	});
});

describe("around the page", () => {
	test("links to Publish all in the admin, with how many other Drafts the Site has", async () => {
		const site = await bakery();
		const editing = await openEditMode(install, editor, site.siteId, "/blog/fresh-bread");
		await editor.api.entries.saveDraft({ siteId: site.siteId, entryId: site.otherId, title: "Scones, fresh" });

		const state = await stateOf(editing, "/blog/fresh-bread");

		expect(state.publishAll).toEqual({ url: `https://admin.test/sites/${site.siteId}`, otherDrafts: 1 });
	});

	test("lists the Site's pages for the page switcher, the home page first", async () => {
		const site = await bakery();
		await editor.api.entries.create({ siteId: site.siteId, postTypeId: site.postTypeId, title: "Never published" });
		const editing = await openEditMode(install, editor, site.siteId, "/");

		const state = await stateOf(editing, "/");

		expect(state.page.title).toBe("About us");
		expect(state.pages).toEqual([
			{ title: "About us", path: "/" },
			{ title: "Fresh bread", path: "/blog/fresh-bread" },
			{ title: "Scones", path: "/blog/scones" },
		]);
	});

	test("the 404 page has no Entry of its own; the Globals it shows are still the page's", async () => {
		const site = await bakery();
		const editing = await openEditMode(install, editor, site.siteId, "/");
		await editing.edit("save", { item: "globals", field: "tagline", value: "Baked twice daily" });

		const state = await stateOf(editing, "/no-such-page");

		expect(state.page).toMatchObject({ path: "/no-such-page", item: null });
		expect(state.changes.map((change) => change.item)).toEqual(["globals"]);
	});

	test("a path that isn't one on the Site is refused", async () => {
		const site = await bakery();
		const editing = await openEditMode(install, editor, site.siteId, "/");

		const response = await editing.edit("state", { path: "https://elsewhere.example/" });

		expect(response.status).toBe(400);
		expect(await json(response)).toMatchObject({ code: "EDIT_PATH_INVALID" });
	});
});
