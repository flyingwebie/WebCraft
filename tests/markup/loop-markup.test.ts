// Loops, pagination and Conditions in Template markup (ADR 0017): `{{@loop name as x}} … {{@empty}} …
// {{/loop}}` over a Loop or a list on the Entry, `name.count` and `name.empty`, `loop.first` and the
// rest of a Loop's position, `{{@pagination name}}`, and the Condition operators. What a binding may
// read is checked where it is: an item's values only inside its Loop.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let siteId: string;
let recipesId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	await staff.api.postTypes.create({
		siteId,
		name: "Chefs",
		key: "chefs",
		urlPattern: "/chefs/{slug}",
		fields: [{ key: "bio", label: "Bio", type: "text" }],
	});
	const { postType } = await staff.api.postTypes.create({
		siteId,
		name: "Recipes",
		key: "recipes",
		urlPattern: "/recipes/{slug}",
		fields: [
			{ key: "minutes", label: "Minutes", type: "number" },
			{ key: "summary", label: "Summary", type: "text" },
			{
				key: "gallery",
				label: "Gallery",
				type: "repeater",
				fields: [
					{ key: "caption", label: "Caption", type: "text" },
					{ key: "photo", label: "Photo", type: "media" },
				],
			},
			{ key: "chefs", label: "Chefs", type: "relationship", postTypes: ["chefs"], multiple: true },
		],
	});
	recipesId = postType.id;
	await staff.api.loops.create({ siteId, name: "latest-recipes", source: "query", query: { postTypes: ["recipes"] } });
	await staff.api.loops.create({
		siteId,
		name: "opening-hours",
		source: "items",
		fields: [
			{ key: "day", label: "Day", type: "text" },
			{ key: "hours", label: "Hours", type: "text" },
		],
	});
});

afterAll(async () => {
	await install.close();
});

type Problem = { line: number; column: number; message: string };

/** Saves `markup` as the Recipes Entry template and answers it as stored, printed again. */
async function saved(markup: string): Promise<string> {
	return (await staff.api.templates.saveEntryTemplateMarkup({ siteId, postTypeId: recipesId, markup })).markup;
}

/** The problems saving `markup` as the Recipes Entry template is refused with. */
async function problemsOf(markup: string): Promise<Problem[]> {
	const error = await saved(markup).then(
		() => undefined,
		(refused: unknown) => refused,
	);
	expect(error).toMatchObject({ code: "TEMPLATE_MARKUP_INVALID" });
	return (error as { data: { problems: Problem[] } }).data.problems;
}

async function refuses(markup: string, line: number, column: number, says: string): Promise<void> {
	expect(await problemsOf(markup)).toEqual([{ line, column, message: expect.stringContaining(says) }]);
}

/** Markup with the element ids the printer adds taken out, to compare with what was written. */
function withoutIds(markup: string): string {
	return markup.replaceAll(/ data-wc-id="[^"]*"/g, "");
}

describe("{{@loop}}", () => {
	test("a Loop by name, its items named with as, and what shows when it has none", async () => {
		const markup =
			'<ul>{{@loop latest-recipes as recipe}}<li><a href="{{ recipe.url }}">{{ recipe.title }}</a> ' +
			"{{ recipe.minutes }} {{ recipe.chefs.title }}</li>{{@empty}}<li>No recipes yet.</li>{{/loop}}</ul>";

		expect(withoutIds(await saved(markup))).toBe(markup);
	});

	test("items are named item when as is left out; a Loop of Loop items reads its Fields", async () => {
		expect(
			withoutIds(
				await saved("<dl>{{@loop opening-hours}}<dt>{{ item.day }}</dt><dd>{{ item.hours }}</dd>{{/loop}}</dl>"),
			),
		).toBe("<dl>{{@loop opening-hours}}<dt>{{ item.day }}</dt><dd>{{ item.hours }}</dd>{{/loop}}</dl>");
		expect(withoutIds(await saved("<p>{{@loop opening-hours as item}}{{ item.day }}{{/loop}}</p>"))).toBe(
			"<p>{{@loop opening-hours}}{{ item.day }}{{/loop}}</p>",
		);
	});

	test("a Repeater or Relationship of the Entry, by its name, and lists inside an item", async () => {
		const markup =
			'{{@loop gallery as shot}}<figure><img src="{{ shot.photo }}" alt=""><figcaption>{{ shot.caption }}</figcaption></figure>{{/loop}}' +
			"{{@loop chefs as chef}}<p>{{ chef.title }}: {{ chef.bio }}</p>{{/loop}}" +
			"{{@loop latest-recipes as recipe}}{{@loop recipe.chefs as cook}}<p>{{ cook.bio }}</p>{{/loop}}{{/loop}}";

		expect(withoutIds(await saved(markup))).toBe(markup);
	});

	test("a Loop's count and whether it is empty, anywhere; an item's position inside it", async () => {
		const markup =
			"{{@if latest-recipes.empty}}<p>Nothing yet</p>{{@else}}<p>{{ latest-recipes.count }} recipes</p>{{/if}}" +
			"<ol>{{@loop latest-recipes as recipe}}<li>{{@if loop.first}}<strong>New</strong>{{/if}}" +
			"{{ loop.index }} of {{ loop.count }}{{@if loop.odd and not loop.last}}, odd{{@else if loop.even}}, even{{/if}}</li>{{/loop}}</ol>";

		expect(withoutIds(await saved(markup))).toBe(markup);
	});

	test("an item's values are read only inside its Loop, and only those its Loop has", async () => {
		await refuses("<p>{{ recipe.title }}</p>", 1, 7, "There is no value named recipe.title");
		await refuses(
			"{{@loop latest-recipes as recipe}}<p>{{ recipe.colour }}</p>{{/loop}}",
			1,
			41,
			"latest-recipes items have no colour",
		);
		await refuses(
			"{{@loop opening-hours as hour}}<p>{{ hour.day }}</p>{{@empty}}<p>{{ hour.day }}</p>{{/loop}}",
			1,
			69,
			"There is no value named hour.day",
		);
		await refuses("<p>{{ loop.index }}</p>", 1, 7, "loop. values are read inside a Loop");
	});

	test("a Loop or list it names must exist; its items' name can't hide another value", async () => {
		await refuses("{{@loop nowhere as x}}<p>{{ x }}</p>{{/loop}}", 1, 9, "There is no Loop or list named nowhere");
		await refuses("{{@loop latest-recipes as summary}}<p>x</p>{{/loop}}", 1, 27, "summary already names a value");
		await refuses(
			"{{@loop latest-recipes as recipe}}{{@loop recipe.chefs as recipe}}<p>x</p>{{/loop}}{{/loop}}",
			1,
			59,
			"recipe already names the items of a Loop around this one",
		);
		await refuses(
			"{{@loop latest-recipes}}{{@loop item.chefs}}<p>x</p>{{/loop}}{{/loop}}",
			1,
			33,
			"item already names the items of a Loop around this one",
		);
		await refuses("{{@loop latest-recipes as site}}<p>x</p>{{/loop}}", 1, 27, "site");
		await refuses("{{@loop latest-recipes as}}<p>x</p>{{/loop}}", 1, 24, "as");
	});

	test("{{@empty}} once, after the items, and Loops nest at most 4 deep", async () => {
		await refuses(
			"{{@loop gallery as a}}<p>x</p>{{@empty}}<p>y</p>{{@empty}}<p>z</p>{{/loop}}",
			1,
			49,
			"{{@empty}} once",
		);
		await refuses("{{@empty}}<p>x</p>", 1, 1, "{{@empty}} belongs inside {{@loop}}");
		await refuses(
			"{{@loop gallery as a}}<p>{{@empty}}</p>{{/loop}}",
			1,
			26,
			"{{@empty}} must be directly inside {{@loop}}",
		);
		const deep = (depth: number): string =>
			depth === 0 ? "<p>x</p>" : `{{@loop latest-recipes as r${depth}}}${deep(depth - 1)}{{/loop}}`;
		await saved(deep(4));
		await refuses(deep(5), 1, 121, "Loops nest at most 4 deep");
	});
});

describe("{{@pagination}}", () => {
	test("names a Loop; it renders a <nav>, so it goes where one can", async () => {
		const markup =
			"<section>{{@loop latest-recipes as recipe}}<p>{{ recipe.title }}</p>{{/loop}}{{@pagination latest-recipes}}</section>";

		expect(withoutIds(await saved(markup))).toBe(markup);
		await refuses("<p>{{@pagination latest-recipes}}</p>", 1, 4, "can't go inside <p>");
		await refuses("{{@pagination gallery}}", 1, 15, "There is no Loop named gallery");
		await refuses("{{@pagination}}", 1, 1, "{{@pagination}} names the Loop");
	});
});

describe("Conditions", () => {
	test("compare, contains, the page's language and a date window", async () => {
		const markup =
			"{{@if minutes < 30 and minutes >= 5}}<p>Quick</p>{{/if}}" +
			"{{@if minutes > 60 or minutes <= 0}}<p>Slow</p>{{/if}}" +
			'{{@if summary contains "vegan"}}<p>Vegan</p>{{/if}}' +
			'{{@if site.language == "fr"}}<p>Bonjour</p>{{/if}}' +
			'{{@if now >= "2026-12-01" and now < "2027-01-01"}}<p>Festive</p>{{/if}}' +
			"{{@if publishedAt > now}}<p>Soon</p>{{/if}}";

		expect(withoutIds(await saved(markup))).toBe(markup);
	});

	test("an operator needs a value on each side", async () => {
		await refuses("{{@if minutes <}}<p>x</p>{{/if}}", 1, 16, "Expected a value here");
		await refuses("{{@if contains summary}}<p>x</p>{{/if}}", 1, 7, "Expected a value before contains");
		await refuses("{{@if now}}<p>x</p>{{/if}}", 1, 7, "now is compared with a date");
	});
});

describe("in a Component", () => {
	test("a Component loops over a Loop of the Site and over its own list Props", async () => {
		const { component } = await staff.api.components.create({
			siteId,
			name: "HoursCard",
			props: [
				{ key: "lines", label: "Lines", type: "repeater", fields: [{ key: "text", label: "Text", type: "text" }] },
			],
		});
		const markup =
			"<ul>{{@loop opening-hours as hour}}<li>{{ hour.day }}</li>{{/loop}}{{@loop props.lines as line}}<li>{{ line.text }}</li>{{/loop}}</ul>";

		const { markup: stored } = await staff.api.components.saveMarkup({ siteId, componentId: component.id, markup });

		expect(withoutIds(stored)).toBe(markup);
	});
});
