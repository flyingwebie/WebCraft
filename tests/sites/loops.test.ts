// What visitors see of Loops: a query Loop lists published Entries shown in the page's language,
// filtered, sorted, limited and offset as Staff set it; a Loop of its own items, a Repeater or a
// Relationship shows each item; Conditions test the items' values, their position and the time.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let recipesId: string;
let chefsId: string;
let showcaseId: string;
const ids = { ada: "", ben: "", crumble: "", brioche: "", tart: "", here: "" };

const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-04-01T09:00:00Z") });
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	await staff.api.languages.add({ siteId, code: "fr" });
	chefsId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Chefs",
			key: "chefs",
			urlPattern: "/chefs/{slug}",
			fields: [{ key: "bio", label: "Bio", type: "text" }],
		})
	).postType.id;
	recipesId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Recipes",
			key: "recipes",
			urlPattern: "/recipes/{slug}",
			fields: [
				{ key: "body", label: "Body", type: "body" },
				{ key: "minutes", label: "Minutes", type: "number" },
				{ key: "vegan", label: "Vegan", type: "boolean" },
				{
					key: "difficulty",
					label: "Difficulty",
					type: "select",
					options: [
						{ value: "easy", label: "Easy" },
						{ value: "hard", label: "Hard" },
					],
				},
				{ key: "cookedOn", label: "Cooked on", type: "date" },
				{ key: "summary", label: "Summary", type: "text" },
				{ key: "chef", label: "Chef", type: "relationship", postTypes: ["chefs"] },
				{
					key: "gallery",
					label: "Gallery",
					type: "repeater",
					fields: [{ key: "caption", label: "Caption", type: "text" }],
				},
			],
		})
	).postType.id;
	showcaseId = (
		await staff.api.postTypes.create({ siteId, name: "Showcase", key: "showcase", urlPattern: "/showcase/{slug}" })
	).postType.id;

	ids.ada = await published(chefsId, "Ada", { bio: "Pastry" });
	ids.ben = await published(chefsId, "Ben", { bio: "Bread" });
	await staff.api.entries.saveDraft({ siteId, entryId: ids.ada, language: "fr", fields: { bio: "Pâtisserie" } });
	await staff.api.entries.publish({ siteId, entryId: ids.ada });
	// One recipe a day, so the newest is the last: Apple tart, then Brioche, then Crumble.
	ids.crumble = await published(
		recipesId,
		"Crumble",
		{
			minutes: 10,
			vegan: false,
			difficulty: "easy",
			cookedOn: "2026-01-10",
			summary: "Apple crumble",
			chef: ids.ada,
			gallery: [],
		},
		["fr"],
	);
	install.clock.advance(DAY);
	ids.brioche = await published(recipesId, "Brioche", {
		body: [{ type: "paragraph", text: "Rich and buttery." }],
		minutes: 20,
		vegan: true,
		difficulty: "hard",
		cookedOn: "2026-02-10",
		summary: "Soft bread",
		chef: ids.ada,
		gallery: [{ caption: "Dough" }, { caption: "Proving" }, { caption: "Baked" }],
	});
	await staff.api.entries.saveDraft({ siteId, entryId: ids.brioche, language: "fr", title: "Brioche dorée" });
	await staff.api.entries.publish({ siteId, entryId: ids.brioche });
	install.clock.advance(DAY);
	ids.tart = await published(recipesId, "Apple tart", {
		minutes: 45,
		vegan: false,
		difficulty: "easy",
		cookedOn: "2025-12-01",
		summary: "With a vegan option",
		chef: ids.ben,
	});
	await staff.api.entries.create({ siteId, postTypeId: recipesId, title: "Draft pie", fields: { minutes: 5 } });
	ids.here = await published(showcaseId, "Here", {});
});

afterAll(async () => {
	await install.close();
});

async function published(
	postTypeId: string,
	title: string,
	fields: Record<string, unknown>,
	hiddenLanguages: string[] = [],
): Promise<string> {
	const { entry } = await staff.api.entries.create({ siteId, postTypeId, title, fields, hiddenLanguages });
	await staff.api.entries.publish({ siteId, entryId: entry.id });
	return entry.id;
}

let loops = 0;

/** A published query Loop over Recipes with `query`, named anew; answers its name. */
async function recipeLoop(query: Record<string, unknown> = {}): Promise<string> {
	const name = `recipes-${++loops}`;
	const { loop } = await staff.api.loops.create({
		siteId,
		name,
		source: "query",
		query: { postTypes: ["recipes"], ...query },
	});
	await staff.api.loops.publish({ siteId, loopId: loop.id });
	return name;
}

/** Saves and publishes `markup` as the Entry template of a Post Type. */
async function template(postTypeId: string, markup: string): Promise<void> {
	const saved = await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId, markup });
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
}

/** What visitors get inside <main> at `path`. */
async function main(path: string): Promise<string> {
	const response = await install.request(`https://bakery.sites.test${path}`);
	expect(response.status).toBe(200);
	return /<main[^>]*>([\s\S]*)<\/main>/.exec(await response.text())?.[1] ?? "";
}

/** The Showcase page with `markup` as its Entry template: what <main> shows, ids taken out. */
async function showcase(markup: string, path = "/showcase/here"): Promise<string> {
	await template(showcaseId, markup);
	return main(path);
}

const titles = (name: string) => `{{@loop ${name} as r}}[{{ r.title }}]{{@empty}}None{{/loop}}`;

describe("a query Loop", () => {
	test("lists the published Entries of its Post Types, newest first, by its limit and offset", async () => {
		expect(await showcase(titles(await recipeLoop()))).toBe("[Apple tart][Brioche][Crumble]");
		expect(await showcase(titles(await recipeLoop({ limit: 2 })))).toBe("[Apple tart][Brioche]");
		expect(await showcase(titles(await recipeLoop({ offset: 1 })))).toBe("[Brioche][Crumble]");
		expect(
			await showcase(
				titles(await recipeLoop({ postTypes: ["chefs", "recipes"], sort: [{ by: "title", direction: "asc" }] })),
			),
		).toBe("[Ada][Apple tart][Ben][Brioche][Crumble]");
	});

	test("Field filters, matching all of them or any", async () => {
		const filtered = async (filters: unknown[], match = "all") =>
			showcase(titles(await recipeLoop({ filters, match })));

		expect(await filtered([{ type: "field", field: "minutes", operator: "atMost", value: 20 }])).toBe(
			"[Brioche][Crumble]",
		);
		expect(await filtered([{ type: "field", field: "vegan", operator: "equals", value: true }])).toBe("[Brioche]");
		expect(await filtered([{ type: "field", field: "difficulty", operator: "equals", value: "easy" }])).toBe(
			"[Apple tart][Crumble]",
		);
		expect(await filtered([{ type: "field", field: "summary", operator: "contains", value: "APPLE" }])).toBe(
			"[Crumble]",
		);
		expect(await filtered([{ type: "field", field: "cookedOn", operator: "lessThan", value: "2026-01-01" }])).toBe(
			"[Apple tart]",
		);
		expect(await filtered([{ type: "field", field: "body", operator: "notEmpty" }])).toBe("[Brioche]");
		expect(
			await filtered(
				[
					{ type: "field", field: "vegan", operator: "equals", value: true },
					{ type: "field", field: "minutes", operator: "atLeast", value: 40 },
				],
				"any",
			),
		).toBe("[Apple tart][Brioche]");
		expect(
			await filtered([
				{ type: "field", field: "difficulty", operator: "notEquals", value: "hard" },
				{ type: "field", field: "minutes", operator: "greaterThan", value: 10 },
			]),
		).toBe("[Apple tart]");
	});

	test("sorted by Fields and the title, each up or down", async () => {
		const sorted = async (sort: unknown[]) => showcase(titles(await recipeLoop({ sort })));

		expect(await sorted([{ by: "minutes", direction: "asc" }])).toBe("[Crumble][Brioche][Apple tart]");
		expect(await sorted([{ by: "title", direction: "asc" }])).toBe("[Apple tart][Brioche][Crumble]");
		expect(await sorted([{ by: "cookedOn", direction: "desc" }])).toBe("[Brioche][Crumble][Apple tart]");
		expect(
			await sorted([
				{ by: "vegan", direction: "desc" },
				{ by: "title", direction: "desc" },
			]),
		).toBe("[Brioche][Crumble][Apple tart]");
	});

	test("Relationship filters: related to the current Entry, sharing one with it, or chosen Entries", async () => {
		const byChef = await recipeLoop({ filters: [{ type: "relationship", field: "chef", to: "current" }] });
		await template(chefsId, `<h1>{{ title }}</h1>${titles(byChef)}`);
		expect(await main("/chefs/ada")).toBe("<h1>Ada</h1>[Brioche][Crumble]");
		expect(await main("/chefs/ben")).toBe("<h1>Ben</h1>[Apple tart]");

		const sameChef = await recipeLoop({
			filters: [{ type: "relationship", field: "chef", to: "sharedWithCurrent" }],
			excludeCurrent: true,
		});
		await template(recipesId, titles(sameChef));
		expect(await main("/recipes/brioche")).toBe("[Crumble]");
		expect(await main("/recipes/apple-tart")).toBe("None");

		const chosen = await recipeLoop({
			filters: [{ type: "relationship", field: "chef", to: "entries", entries: [ids.ben] }],
		});
		expect(await showcase(titles(chosen))).toBe("[Apple tart]");
		// The Showcase page has no chef: nothing is related to it.
		expect(await showcase(titles(byChef))).toBe("None");
	});

	test("date windows and status", async () => {
		const filtered = async (filters: unknown[]) => showcase(titles(await recipeLoop({ filters })));

		expect(await filtered([{ type: "date", field: "publishedAt", window: "last", amount: 1, unit: "days" }])).toBe(
			"[Apple tart][Brioche]",
		);
		expect(
			await filtered([{ type: "date", field: "cookedOn", window: "between", from: "2026-01-01", to: "2026-02-10" }]),
		).toBe("[Brioche][Crumble]");
		expect(await filtered([{ type: "date", field: "cookedOn", window: "past" }])).toBe(
			"[Apple tart][Brioche][Crumble]",
		);
		expect(await filtered([{ type: "date", field: "cookedOn", window: "future" }])).toBe("None");

		await staff.api.entries.saveDraft({ siteId, entryId: ids.crumble, fields: { summary: "Changed, not published" } });
		expect(await filtered([{ type: "status", statuses: ["changed"] }])).toBe("[Crumble]");
		expect(await filtered([{ type: "status", statuses: ["published"] }])).toBe("[Apple tart][Brioche]");
		expect(await filtered([{ type: "status", statuses: ["draft"] }])).toBe("None");
	});

	test("in another language: Entries hidden there are left out, values fall back one Field at a time", async () => {
		const name = await recipeLoop();
		const markup = `{{@loop ${name} as r}}[{{ r.title }} {{ r.chef.bio }}]{{/loop}}`;

		expect(await showcase(markup)).toBe("[Apple tart Bread][Brioche Pastry][Crumble Pastry]");
		expect(await main("/fr/showcase/here")).toBe("[Apple tart Bread][Brioche dorée Pâtisserie]");
	});

	test("an item reads its address, author, dates, body and what its Relationships point at", async () => {
		const name = await recipeLoop({ limit: 1, offset: 1 });

		expect(
			await showcase(
				`{{@loop ${name} as r}}<a href="{{ r.url }}">{{ r.title }}</a> {{ r.publishedAt | date: iso }} ` +
					"{{ r.chef.title }} ({{ r.chef.url }}) {{ r.body.excerpt }} {{ r.difficulty }}/{{ r.difficulty.value }} " +
					"{{ r.body.reading_time }}{{/loop}}",
			),
		).toBe('<a href="/recipes/brioche">Brioche</a> 2026-04-02 Ada (/chefs/ada) Rich and buttery. Hard/hard 1');
	});
});

describe("other sources", () => {
	test("a Loop of its own items, in the page's language with fallback", async () => {
		const { loop } = await staff.api.loops.create({
			siteId,
			name: "opening-hours",
			source: "items",
			fields: [
				{ key: "day", label: "Day", type: "text" },
				{ key: "hours", label: "Hours", type: "text" },
			],
		});
		const { loop: saved } = await staff.api.loops.saveItems({
			siteId,
			loopId: loop.id,
			items: [
				{ day: "Monday", hours: "8–18" },
				{ day: "Sunday", hours: "Closed" },
			],
		});
		await staff.api.loops.saveItems({
			siteId,
			loopId: loop.id,
			language: "fr",
			items: saved.draft.items.map((item, index) => ({ id: item.id, day: ["Lundi", "Dimanche"][index] ?? "" })),
		});
		await staff.api.loops.publish({ siteId, loopId: loop.id });

		const markup = "<dl>{{@loop opening-hours as hour}}<dt>{{ hour.day }}</dt><dd>{{ hour.hours }}</dd>{{/loop}}</dl>";
		expect(await showcase(markup)).toBe("<dl><dt>Monday</dt><dd>8–18</dd><dt>Sunday</dt><dd>Closed</dd></dl>");
		expect(await main("/fr/showcase/here")).toBe(
			"<dl><dt>Lundi</dt><dd>8–18</dd><dt>Dimanche</dt><dd>Closed</dd></dl>",
		);
	});

	test("a Repeater and a Relationship of the Entry, each item with its position", async () => {
		await template(
			recipesId,
			"{{@loop gallery as shot}}{{ loop.index }}/{{ loop.count }} {{ shot.caption }}" +
				"{{@if loop.first}} first{{/if}}{{@if loop.last}} last{{/if}}{{@if loop.odd}} odd{{/if}}{{@if loop.even}} even{{/if}};" +
				"{{@empty}}No photos;{{/loop}}{{@loop chef as cook}} by {{ cook.title }}{{/loop}}",
		);

		expect(await main("/recipes/brioche")).toBe("1/3 Dough first odd;2/3 Proving even;3/3 Baked last odd; by Ada");
		expect(await main("/recipes/apple-tart")).toBe("No photos; by Ben");
	});

	test("a Loop's count and whether it is empty, outside it", async () => {
		const all = await recipeLoop();
		const none = await recipeLoop({ filters: [{ type: "date", field: "cookedOn", window: "future" }] });

		expect(
			await showcase(
				`{{ ${all}.count }} recipes{{@if ${none}.empty}}, none to come{{/if}}{{@if ${all}.count > 2}}, many{{/if}}`,
			),
		).toBe("3 recipes, none to come, many");
	});

	test("Components: an item passed in through Props, and a Loop inside a Component", async () => {
		const { component: card } = await staff.api.components.create({
			siteId,
			name: "RecipeCard",
			props: [{ key: "heading", label: "Heading", type: "text" }],
		});
		await staff.api.components.saveMarkup({ siteId, componentId: card.id, markup: "<h3>{{ props.heading }}</h3>" });
		await staff.api.components.publish({ siteId, componentId: card.id });
		const name = await recipeLoop({ limit: 2 });
		const { component: list } = await staff.api.components.create({ siteId, name: "LatestList" });
		await staff.api.components.saveMarkup({
			siteId,
			componentId: list.id,
			markup: `<ul>{{@loop ${name} as r}}<li>{{ r.title }}</li>{{/loop}}</ul>`,
		});
		await staff.api.components.publish({ siteId, componentId: list.id });

		expect(await showcase(`{{@loop ${name} as r}}<RecipeCard heading="{{ r.title }}" />{{/loop}}<LatestList />`)).toBe(
			"<h3>Apple tart</h3><h3>Brioche</h3><ul><li>Apple tart</li><li>Brioche</li></ul>",
		);
	});
});

describe("limits", () => {
	test("a page runs at most 20 Loops of the Site; the rest show nothing", async () => {
		const names: string[] = [];
		for (let index = 0; index < 21; index++) names.push(await recipeLoop({ limit: 1 }));

		const shown = await showcase(names.map((name) => `{{@loop ${name} as r}}x{{@empty}}-{{/loop}}`).join(""));

		expect(shown).toBe(`${"x".repeat(20)}-`);
	});
});

describe("Conditions", () => {
	test("compare, contains and the page's language", async () => {
		await template(
			recipesId,
			'{{@if minutes < 30}}quick {{/if}}{{@if minutes >= 20}}long {{/if}}{{@if summary contains "BREAD"}}bread {{/if}}' +
				'{{@if site.language == "fr"}}fr{{@else}}en{{/if}}',
		);

		expect(await main("/recipes/brioche")).toBe("quick long bread en");
		expect(await main("/fr/recipes/brioche")).toBe("quick long bread fr");
	});

	test("a date window: the page is rendered again when the window opens", async () => {
		await template(showcaseId, '{{@if now >= "2026-04-05"}}Open{{@else}}Soon{{/if}}');
		const get = () => install.request("https://bakery.sites.test/showcase/here");

		expect(await (await get()).text()).toContain("Soon");
		expect((await get()).headers.get("x-cache")).toBe("HIT");
		install.clock.advance(2 * DAY);
		const later = await get();
		expect(later.headers.get("x-cache")).toBe("MISS");
		expect(await later.text()).toContain("Open");
	});

	test("publishing a Loop changes the pages showing it at once", async () => {
		const { loop } = await staff.api.loops.create({
			siteId,
			name: "changing",
			source: "query",
			query: { postTypes: ["recipes"], limit: 1 },
		});
		await staff.api.loops.publish({ siteId, loopId: loop.id });
		expect(await showcase(titles("changing"))).toBe("[Apple tart]");

		await staff.api.loops.saveDraft({ siteId, loopId: loop.id, query: { postTypes: ["recipes"], limit: 2 } });
		expect(await main("/showcase/here")).toBe("[Apple tart]");
		await staff.api.loops.publish({ siteId, loopId: loop.id });
		expect(await main("/showcase/here")).toBe("[Apple tart][Brioche]");
	});
});

describe("Edit mode", () => {
	test("a Loop shows its published items, and what sits inside it isn't tagged as an editable region", async () => {
		const name = await recipeLoop({ limit: 2 });
		await template(
			recipesId,
			`<h1>{{ title }}</h1><ul>{{@loop ${name} as r}}<li>{{ r.title }}</li><li>{{ title }}</li>{{/loop}}</ul>`,
		);
		const editing = await openEditMode(install, staff, siteId, "/recipes/crumble");

		const html = await (await editing.page("/recipes/crumble")).text();

		const main = /<main[^>]*>([\s\S]*)<\/main>/.exec(html)?.[1] ?? "";
		expect(main).toMatch(/^<h1 data-wc-item="entry:[^"]+" data-wc-field="title"/);
		expect(main).toContain("<ul><li>Apple tart</li><li>Crumble</li><li>Brioche</li><li>Crumble</li></ul>");
	});
});
