// Loop items in Edit mode (GLOSSARY.md › Loop item): a Loop's own items are Content, edited in place
// by everyone who edits the Site, in the Loop's Draft. Their text and images are regions like the
// page's own; each item can be moved, duplicated, removed (and put back) and new items added after
// it. A query Loop's items are Entries: each points at its Entry's own page. Publishing a Loop is
// Structure, so Staff publish the items' changes (the Publish menu says so to everyone else).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { type EditModeBrowser, openEditMode } from "../harness/edit-mode.ts";
import { photo, upload } from "../harness/images.ts";
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

type Bakes = {
	siteId: string;
	origin: string;
	loopId: string;
	queryLoopId: string;
	/** The ids of the Loop's items, in order: Country sourdough, Cardamom bun, Seeded rye. */
	items: string[];
	postIds: string[];
	menuId: string;
	loaf: string;
	rolls: string;
};

async function readyImage(siteId: string, name: string): Promise<string> {
	const { media } = await editor.api.media.upload({
		siteId,
		file: upload(await photo({ width: 400, height: 300 }), name),
	});
	expect((await install.drainJobs()).failed).toEqual([]);
	return media.id;
}

/**
 * A Site in English and Italian whose Recipes show the Loop "our-bakes" (its own items: a name, a
 * price, a photo, sold out today) and the query Loop "latest-posts" (the Blog's posts). The Recipe
 * "Menu" is at /recipes/menu.
 */
async function bakery(): Promise<Bakes> {
	const slug = `loops-${++sites}`;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	await goLive(install, siteId);
	await staff.api.languages.add({ siteId, code: "it" });
	const loaf = await readyImage(siteId, "loaf.jpg");
	const rolls = await readyImage(siteId, "rolls.jpg");
	const { loop } = await staff.api.loops.create({
		siteId,
		name: "our-bakes",
		source: "items",
		fields: [
			{ key: "name", label: "Name", type: "text", required: true },
			{ key: "price", label: "Price", type: "text", translatable: false },
			{ key: "photo", label: "Photo", type: "media" },
			{ key: "soldOut", label: "Sold out today", type: "boolean" },
		],
	});
	const saved = await editor.api.loops.saveItems({
		siteId,
		loopId: loop.id,
		items: [
			{ name: "Country sourdough", price: "€6.50", photo: loaf },
			{ name: "Cardamom bun", price: "€3.20" },
			{ name: "Seeded rye", price: "€5.90" },
		],
	});
	const items = saved.loop.draft.items.map((item) => String(item.id));
	await editor.api.loops.saveItems({
		siteId,
		loopId: loop.id,
		language: "it",
		items: [{ id: items[0], name: "Pagnotta di campagna" }, { id: items[1] }, { id: items[2] }],
	});
	await staff.api.loops.publish({ siteId, loopId: loop.id });
	const { postType: blog } = await staff.api.postTypes.create({
		siteId,
		name: "Blog posts",
		key: "blog",
		urlPattern: "/blog/{slug}",
		fields: [],
	});
	const blogTemplate = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: blog.id,
		markup: "<article><h1>{{ title }}</h1></article>",
	});
	await staff.api.templates.publish({ siteId, templateId: blogTemplate.template.id });
	const postIds: string[] = [];
	for (const title of ["Our starter, explained", "Spring menu"]) {
		await install.clock.advance(1000);
		const { entry } = await editor.api.entries.create({ siteId, postTypeId: blog.id, title });
		await editor.api.entries.publish({ siteId, entryId: entry.id });
		postIds.push(entry.id);
	}
	const { loop: latest } = await staff.api.loops.create({
		siteId,
		name: "latest-posts",
		source: "query",
		query: { postTypes: ["blog"] },
	});
	await staff.api.loops.publish({ siteId, loopId: latest.id });
	const { postType: recipes } = await staff.api.postTypes.create({
		siteId,
		name: "Recipes",
		urlPattern: "/recipes/{slug}",
		fields: [],
	});
	const template = await staff.api.templates.saveEntryTemplateMarkup({
		siteId,
		postTypeId: recipes.id,
		markup: [
			"<article><h1>{{ title }}</h1>",
			'<ul>{{@loop our-bakes as bake}}<li><h3>{{ bake.name }}</h3><p>{{ bake.price }}</p><img src="{{ bake.photo }}"></li>{{/loop}}</ul>',
			"{{@loop latest-posts as post}}<section><h3>{{ post.title }}</h3></section>{{/loop}}",
			"</article>",
		].join(""),
	});
	await staff.api.templates.publish({ siteId, templateId: template.template.id });
	const { entry: menu } = await editor.api.entries.create({ siteId, postTypeId: recipes.id, title: "Menu" });
	await editor.api.entries.publish({ siteId, entryId: menu.id });
	return {
		siteId,
		origin: `https://${slug}.live.test`,
		loopId: loop.id,
		queryLoopId: latest.id,
		items,
		postIds,
		menuId: menu.id,
		loaf,
		rolls,
	};
}

async function json(response: Response): Promise<Record<string, unknown>> {
	return (await response.json()) as Record<string, unknown>;
}

/** The marks a page in Edit mode puts around Loops and their items, read back: `["loop", id, source, name]`, `["item", key]`. */
function marks(html: string): string[][] {
	return [...html.matchAll(/<!--wc-(loop|item) ([^>]*?)-->/g)].map((match) => [
		match[1] ?? "",
		...(match[2] ?? "").split(" ").map((part) => decodeURIComponent(part)),
	]);
}

/** The opening tags of the elements a page tags as regions of `item`. */
function regionsOf(html: string, item: string): string[] {
	return [...html.matchAll(/<[a-z0-9]+\b[^>]*>/g)]
		.map((match) => match[0])
		.filter((tag) => tag.includes(`data-wc-item="${item}"`));
}

/** The Loop's Draft items in a language, as Staff read them in the admin. */
async function draftItems(site: Bakes, language?: string) {
	return (await staff.api.loops.get({ siteId: site.siteId, loopId: site.loopId, language })).loop.draft.items;
}

describe("Loops on a page in Edit mode", () => {
	let site: Bakes;
	let editing: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		editing = await openEditMode(install, editor, site.siteId, "/recipes/menu");
	});

	test("each Loop and each of its items is marked, without changing what the page holds", async () => {
		const html = await (await editing.page("/recipes/menu")).text();

		expect(marks(html)).toEqual([
			["loop", `loop:${site.loopId}`, "items", "our-bakes"],
			...site.items.map((item) => ["item", `loop:${site.loopId}:${item}`]),
			["loop", `loop:${site.queryLoopId}`, "query", "latest-posts"],
			// A query Loop's items are Entries, newest first.
			["item", `entry:${site.postIds[1]}`],
			["item", `entry:${site.postIds[0]}`],
		]);
		expect(html).toContain("<!--/wc-item--><!--/wc-loop--></ul>");
		const visitors = await (await install.request(`${site.origin}/recipes/menu`)).text();
		expect(visitors).not.toContain("<!--wc-");
		expect(visitors).toContain("<ul><li><h3>Country sourdough</h3>");
	});

	test("a Loop item's text and images are regions of that item", async () => {
		const html = await (await editing.page("/recipes/menu")).text();
		const first = `loop:${site.loopId}:${site.items[0]}`;

		const [name, price, image] = regionsOf(html, first);
		expect(name).toStartWith("<h3 ");
		expect(name).toContain('data-wc-field="name"');
		expect(name).toContain('data-wc-type="text"');
		expect(name).toContain('data-wc-label="Name"');
		expect(price).toContain('data-wc-field="price"');
		expect(image).toStartWith("<img ");
		expect(image).toContain('data-wc-field="photo"');
		expect(image).toContain('data-wc-type="media"');
		expect(image).toContain(`data-wc-media="${site.loaf}"`);
		// The second item has no photo yet: an empty image region to choose one in.
		expect(regionsOf(html, `loop:${site.loopId}:${site.items[1]}`)[2]).toStartWith("<span ");
	});

	test("a query Loop's items aren't regions: they are Entries, changed on their own pages", async () => {
		const html = await (await editing.page("/recipes/menu")).text();

		expect(regionsOf(html, `entry:${site.postIds[0]}`)).toEqual([]);
		expect(html).toContain("<section><h3>Our starter, explained</h3></section>");
	});

	test("Edit mode shows the Loop's items from its Draft; visitors see what is published", async () => {
		await editor.api.loops.saveItems({
			siteId: site.siteId,
			loopId: site.loopId,
			items: [{ id: site.items[0] }, { id: site.items[1], name: "Cardamom knot" }, { id: site.items[2] }],
		});

		expect(await (await editing.page("/recipes/menu")).text()).toContain(">Cardamom knot</h3>");
		expect(await (await install.request(`${site.origin}/recipes/menu`)).text()).toContain("<h3>Cardamom bun</h3>");
	});
});

describe("changing a Loop item's values", () => {
	let site: Bakes;
	let editing: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		editing = await openEditMode(install, editor, site.siteId, "/recipes/menu");
	});

	test("text typed in place goes to the Loop's Draft, in the page's language", async () => {
		const item = `loop:${site.loopId}:${site.items[1]}`;

		const english = await editing.edit("save", { item, field: "name", value: "Cardamom knot" });
		const italian = await editing.edit("save", { item, field: "name", value: "Nodo al cardamomo", language: "it" });

		expect(await json(english)).toEqual({ status: "changed", value: "Cardamom knot", problems: [] });
		expect(italian.status).toBe(200);
		expect((await draftItems(site))[1]).toMatchObject({ id: site.items[1], name: "Cardamom knot", price: "€3.20" });
		expect((await draftItems(site, "it"))[1]).toMatchObject({ name: "Nodo al cardamomo" });
		expect(await (await install.request(`${site.origin}/recipes/menu`)).text()).toContain("<h3>Cardamom bun</h3>");
	});

	test("a value that breaks a rule is kept and its problem comes back", async () => {
		const item = `loop:${site.loopId}:${site.items[2]}`;

		const emptied = await editing.edit("save", { item, field: "name", value: "" });

		expect(await json(emptied)).toMatchObject({ value: null, problems: [{ rule: "required" }] });
	});

	test("a Loop item's image is chosen as any image region's", async () => {
		const item = `loop:${site.loopId}:${site.items[1]}`;

		const response = await editing.edit("image", { item, field: "photo", media: site.rolls });

		expect(await json(response)).toMatchObject({ status: "changed", media: site.rolls });
		expect((await draftItems(site))[1]?.photo).toBe(site.rolls);
	});

	test("the item form reads and saves every Field of an item", async () => {
		const item = site.items[0] ?? "";

		const opened = await editing.edit("loop/get", { loop: site.loopId, item, language: "it" });
		expect(opened.status).toBe(200);
		expect(await json(opened)).toMatchObject({
			loop: { id: site.loopId, name: "our-bakes" },
			fields: [
				{ key: "name", label: "Name", type: "text", translatable: true },
				{ key: "price", label: "Price", type: "text", translatable: false },
				{ key: "photo", label: "Photo", type: "media" },
				{ key: "soldOut", label: "Sold out today", type: "boolean" },
			],
			item: { id: item, name: "Pagnotta di campagna", price: "€6.50", photo: site.loaf, soldOut: false },
		});

		const saved = await editing.edit("loop/save", {
			loop: site.loopId,
			item,
			values: { soldOut: true, price: "€6.80" },
		});
		expect(await json(saved)).toMatchObject({ item: { id: item, soldOut: true, price: "€6.80" }, problems: [] });
		expect((await draftItems(site))[0]).toMatchObject({ name: "Country sourdough", soldOut: true, price: "€6.80" });
	});

	test("refuses a Field the Loop's items don't have, and an item the Loop doesn't have", async () => {
		const missingField = await editing.edit("save", {
			item: `loop:${site.loopId}:${site.items[0]}`,
			field: "flavour",
			value: "Rye",
		});
		expect({ status: missingField.status, code: (await json(missingField)).code }).toEqual({
			status: 400,
			code: "EDIT_FIELD_INVALID",
		});
		const missingItem = await editing.edit("save", { item: `loop:${site.loopId}:nope`, field: "name", value: "Rye" });
		expect({ status: missingItem.status, code: (await json(missingItem)).code }).toEqual({
			status: 400,
			code: "EDIT_FIELD_INVALID",
		});
	});
});

describe("moving, duplicating, removing and adding Loop items", () => {
	let site: Bakes;
	let editing: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		editing = await openEditMode(install, editor, site.siteId, "/recipes/menu");
	});

	const ids = async (language?: string) => (await draftItems(site, language)).map((item) => item.id);

	test("an item moves to another place, in every language", async () => {
		const [sourdough, bun, rye] = site.items;

		const response = await editing.edit("loop/move", { loop: site.loopId, item: rye, to: 0 });

		expect(response.status).toBe(200);
		expect(await json(response)).toEqual({ items: [rye, sourdough, bun] });
		expect(await ids()).toEqual([rye, sourdough, bun]);
		expect(await ids("it")).toEqual([rye, sourdough, bun]);
		// Each keeps its values, in each language.
		expect((await draftItems(site, "it"))[1]).toMatchObject({ name: "Pagnotta di campagna", price: "€6.50" });
		await editing.edit("loop/move", { loop: site.loopId, item: rye, to: 2 });
		expect(await ids()).toEqual([sourdough, bun, rye]);
	});

	test("a duplicate comes right after its item, with its values in every language", async () => {
		const [sourdough, bun, rye] = site.items;

		const response = await editing.edit("loop/duplicate", { loop: site.loopId, item: sourdough });

		const { item: copy, items } = (await json(response)) as { item: string; items: string[] };
		expect(items).toEqual([sourdough, copy, bun, rye]);
		expect(copy).not.toBe(sourdough);
		expect((await draftItems(site))[1]).toMatchObject({ id: copy, name: "Country sourdough", photo: site.loaf });
		expect((await draftItems(site, "it"))[1]).toMatchObject({ id: copy, name: "Pagnotta di campagna" });
	});

	test("a removed item can be put back where it was, with its values, until the session ends", async () => {
		const before = await ids();
		const removedId = before[0] ?? "";

		const removed = await editing.edit("loop/remove", { loop: site.loopId, item: removedId });

		const answer = (await json(removed)) as { items: string[]; restore: string };
		expect(answer.items).toEqual(before.slice(1));
		expect(await ids("it")).toEqual(before.slice(1));
		const restored = await editing.edit("loop/restore", { restore: answer.restore });
		expect(await json(restored)).toEqual({ item: removedId, items: before });
		expect((await draftItems(site, "it"))[0]).toMatchObject({ id: removedId, name: "Pagnotta di campagna" });
		// Each removal is put back once.
		const again = await editing.edit("loop/restore", { restore: answer.restore });
		expect({ status: again.status, code: (await json(again)).code }).toEqual({
			status: 400,
			code: "EDIT_FIELD_INVALID",
		});
	});

	test("what is put back must be what was removed in this session: anything else is refused", async () => {
		const removed = (await json(await editing.edit("loop/remove", { loop: site.loopId, item: site.items[2] }))) as {
			restore: string;
		};
		const [payload = "", signature = ""] = removed.restore.split(".");
		const forged = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<string, unknown>;
		forged.row = { id: "forged", values: { name: { en: { value: "Free cake", by: { kind: "ai" } } } } };
		const tampered = `${Buffer.from(JSON.stringify(forged)).toString("base64url")}.${signature}`;

		const refused = await editing.edit("loop/restore", { restore: tampered });
		expect(refused.status).toBe(403);
		const elsewhere = await openEditMode(install, editor, site.siteId, "/recipes/menu");
		const otherSession = await elsewhere.edit("loop/restore", { restore: removed.restore });
		expect(otherSession.status).toBe(403);
		expect((await draftItems(site)).map((item) => item.name)).not.toContain("Free cake");
		await editing.edit("loop/restore", { restore: removed.restore });
	});

	test("a new item is added after one, with the Fields' defaults; at the start without one", async () => {
		const before = await ids();

		const added = (await json(await editing.edit("loop/add", { loop: site.loopId, after: before[0] }))) as {
			item: string;
			items: string[];
		};
		expect(added.items).toEqual([before[0], added.item, ...before.slice(1)]);
		expect((await draftItems(site))[1]).toEqual({
			id: added.item,
			name: null,
			price: null,
			photo: null,
			soldOut: false,
		});
		const first = (await json(await editing.edit("loop/add", { loop: site.loopId, after: null }))) as {
			items: string[];
			item: string;
		};
		expect(first.items[0]).toBe(first.item);
	});

	test("a Loop holds at most 200 items", async () => {
		const many = Array.from({ length: 200 }, (_, index) => ({ name: `Bake ${index}` }));
		await editor.api.loops.saveItems({ siteId: site.siteId, loopId: site.loopId, items: many });
		const [last] = (await ids()).slice(-1);

		const response = await editing.edit("loop/add", { loop: site.loopId, after: last });
		expect({ status: response.status, code: (await json(response)).code }).toEqual({
			status: 400,
			code: "LOOP_INVALID",
		});
		const duplicate = await editing.edit("loop/duplicate", { loop: site.loopId, item: last });
		expect(duplicate.status).toBe(400);
	});

	test("a query Loop's items aren't moved or added in place: they are Entries", async () => {
		for (const [action, body] of [
			["loop/add", { loop: site.queryLoopId, after: null }],
			["loop/move", { loop: site.queryLoopId, item: site.postIds[0], to: 0 }],
		] as const) {
			const response = await editing.edit(action, body);
			expect({ action, code: (await json(response)).code }).toEqual({ action, code: "EDIT_FIELD_INVALID" });
		}
	});
});

describe("a query Loop's items", () => {
	let site: Bakes;
	let editing: EditModeBrowser;

	beforeAll(async () => {
		site = await bakery();
		editing = await openEditMode(install, editor, site.siteId, "/recipes/menu");
	});

	test("each links to its Entry's own page, in the page's language, where it is changed in Edit mode", async () => {
		const response = await editing.edit("loop/entries", { entries: site.postIds, language: "it" });

		expect(response.status).toBe(200);
		expect(await json(response)).toEqual({
			entries: [
				{ id: site.postIds[0], title: "Our starter, explained", href: "/it/blog/our-starter-explained", page: true },
				{ id: site.postIds[1], title: "Spring menu", href: "/it/blog/spring-menu", page: true },
			],
		});
	});

	test("an Entry with no page of its own links to its editor in the admin; another Site's Entries to nothing", async () => {
		const { postType } = await staff.api.postTypes.create({
			siteId: site.siteId,
			name: "Suppliers",
			urlPattern: "/suppliers/{slug}",
			fields: [],
		});
		const { entry } = await editor.api.entries.create({ siteId: site.siteId, postTypeId: postType.id, title: "Mill" });
		const other = await bakery();

		const answer = (await json(await editing.edit("loop/entries", { entries: [entry.id, other.postIds[0]] }))) as {
			entries: { id: string; href: string; page: boolean }[];
		};

		expect(answer.entries).toEqual([
			{
				id: entry.id,
				title: "Mill",
				href: install.adminUrl(`/sites/${site.siteId}/entries/${postType.id}/${entry.id}`),
				page: false,
			},
		]);
	});
});

type Change = { item: string; key: string; label: string | null; type: string; structure?: boolean };
type State = { changes: Change[]; canPublish: boolean };

describe("a Loop's items in the Publish menu", () => {
	let site: Bakes;

	beforeAll(async () => {
		site = await bakery();
	});

	const pageState = async (editing: EditModeBrowser) =>
		(await json(await editing.edit("state", { path: "/recipes/menu" }))) as unknown as State;

	test("the page's changes list its Loops' item changes, one for each Loop, published by Staff", async () => {
		const editing = await openEditMode(install, editor, site.siteId, "/recipes/menu");
		await editing.edit("save", { item: `loop:${site.loopId}:${site.items[0]}`, field: "name", value: "Rye loaf" });

		const state = await pageState(editing);

		expect(state.changes).toEqual([
			{
				item: `loop:${site.loopId}`,
				key: "items",
				label: "our-bakes",
				type: "loopItems",
				structure: true,
				by: { name: expect.any(String) as unknown as string, you: true },
			},
		]);
	});

	test("Editors publish the page's own changes; the Loop's items wait for Staff", async () => {
		const editing = await openEditMode(install, editor, site.siteId, "/recipes/menu");
		await editing.edit("save", { item: `entry:${site.menuId}`, field: "title", value: "Our menu" });

		const published = await editing.edit("publish", { path: "/recipes/menu" });

		expect(published.status).toBe(200);
		const state = (await json(published)) as unknown as State;
		expect(state.changes.map((change) => change.item)).toEqual([`loop:${site.loopId}`]);
		const visitors = await (await install.request(`${site.origin}/recipes/menu`)).text();
		expect(visitors).toContain("<h1>Our menu</h1>");
		expect(visitors).toContain("<h3>Country sourdough</h3>");
	});

	test("Staff publish the Loop's items with the page", async () => {
		const editing = await openEditMode(install, staff, site.siteId, "/recipes/menu");

		const published = await editing.edit("publish", { path: "/recipes/menu" });

		expect(((await json(published)) as unknown as State).changes).toEqual([]);
		expect(await (await install.request(`${site.origin}/recipes/menu`)).text()).toContain("<h3>Rye loaf</h3>");
	});

	test("Undo and Discard put the Loop's items back as published, for everyone who edits", async () => {
		const editing = await openEditMode(install, author, site.siteId, "/recipes/menu");
		const item = `loop:${site.loopId}:${site.items[1]}`;
		const saved = await editing.edit("save", { item, field: "name", value: "Bun" });
		expect(saved.status).toBe(200);

		const undone = await editing.edit("undo", { path: "/recipes/menu", item: `loop:${site.loopId}`, key: "items" });
		expect(((await json(undone)) as unknown as State).changes).toEqual([]);
		expect((await draftItems(site))[1]?.name).toBe("Cardamom bun");

		await editing.edit("loop/add", { loop: site.loopId, after: null });
		await editing.edit("discard", { path: "/recipes/menu" });
		expect(await draftItems(site)).toHaveLength(3);
	});

	test("a Loop's items aren't submitted for Review: Staff publish them", async () => {
		const editing = await openEditMode(install, author, site.siteId, "/recipes/menu");
		await editing.edit("save", { item: `loop:${site.loopId}:${site.items[1]}`, field: "name", value: "Bun" });

		const submitted = await editing.edit("review/submit", { path: "/recipes/menu" });

		expect({ status: submitted.status, code: (await json(submitted)).code }).toEqual({
			status: 400,
			code: "REVIEW_INVALID",
		});
		await editing.edit("discard", { path: "/recipes/menu" });
	});
});

describe("Loop items and who may change them", () => {
	let site: Bakes;

	beforeAll(async () => {
		site = await bakery();
	});

	test("Authors change a Loop's items in place: they are Content", async () => {
		const editing = await openEditMode(install, author, site.siteId, "/recipes/menu");

		const saved = await editing.edit("save", {
			item: `loop:${site.loopId}:${site.items[0]}`,
			field: "name",
			value: "Country loaf",
		});
		const moved = await editing.edit("loop/move", { loop: site.loopId, item: site.items[0], to: 1 });

		expect([saved.status, moved.status]).toEqual([200, 200]);
		await editing.edit("discard", { path: "/recipes/menu" });
	});

	test("another Site's Loops can't be reached from this Site's Edit mode", async () => {
		const other = await bakery();
		const editing = await openEditMode(install, editor, site.siteId, "/recipes/menu");

		for (const [action, body] of [
			["save", { item: `loop:${other.loopId}:${other.items[0]}`, field: "name", value: "Stolen" }],
			["loop/get", { loop: other.loopId, item: other.items[0] }],
			["loop/save", { loop: other.loopId, item: other.items[0], values: { name: "Stolen" } }],
			["loop/move", { loop: other.loopId, item: other.items[0], to: 2 }],
			["loop/duplicate", { loop: other.loopId, item: other.items[0] }],
			["loop/remove", { loop: other.loopId, item: other.items[0] }],
			["loop/add", { loop: other.loopId, after: null }],
		] as const) {
			const response = await editing.edit(action, body);
			expect({ action, status: response.status, code: (await json(response)).code }).toEqual({
				action,
				status: 404,
				code: "LOOP_NOT_FOUND",
			});
		}
		const items = (await staff.api.loops.get({ siteId: other.siteId, loopId: other.loopId })).loop.draft.items;
		expect(items.map((item) => item.name)).toEqual(["Country sourdough", "Cardamom bun", "Seeded rye"]);
	});
});
