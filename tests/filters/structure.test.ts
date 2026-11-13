// Filters as Structure (GLOSSARY.md › Filter): Staff build one for a query Loop of the Site, with a
// Draft and a published version, through the Management API; Template markup places it next to its
// Loop with `{{@filter <name> for="<loop>"}}`. Members never reach them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let siteId: string;
let productsId: string;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	await staff.api.postTypes.create({ siteId, name: "Bakers", key: "bakers", urlPattern: "/bakers/{slug}" });
	productsId = (
		await staff.api.postTypes.create({
			siteId,
			name: "Products",
			key: "products",
			urlPattern: "/shop/{slug}",
			fields: [
				{
					key: "category",
					label: "Category",
					type: "select",
					multiple: true,
					options: [
						{ value: "bread", label: "Bread" },
						{ value: "pastries", label: "Pastries" },
					],
				},
				{ key: "vegan", label: "Vegan", type: "boolean" },
				{ key: "price", label: "Price", type: "number" },
				{ key: "baked", label: "Baked", type: "date", mode: "date" },
				{ key: "time", label: "Time", type: "date", mode: "time" },
				{ key: "summary", label: "Summary", type: "text" },
				{ key: "baker", label: "Baker", type: "relationship", postTypes: ["bakers"] },
			],
		})
	).postType.id;
	const { loop } = await staff.api.loops.create({
		siteId,
		name: "products",
		source: "query",
		query: { postTypes: ["products"], limit: 6, paginate: true },
	});
	await staff.api.loops.publish({ siteId, loopId: loop.id });
	await staff.api.loops.create({ siteId, name: "openings", source: "items" });
});

afterAll(async () => {
	await install.close();
});

const CONTROLS = [
	{ type: "search", label: "Search the shop" },
	{
		type: "checkboxes",
		key: "category",
		label: "Category",
		source: { kind: "field", field: "category" },
	},
	{ type: "toggle", key: "vegan", label: "Vegan only", field: "vegan" },
	{ type: "range", key: "price", label: "Price", field: "price" },
	{
		type: "sort",
		key: "sort",
		options: [
			{ value: "price-asc", label: "Price, low to high", by: "price", direction: "asc" },
			{ value: "relevance", label: "Best match", by: "relevance", direction: "desc" },
		],
	},
	{ type: "chips" },
	{ type: "count", other: "{count} products", one: "1 product", none: "No products match" },
];

let made = 0;

/** A new query Loop of Products, published, for a Filter of its own. */
async function newLoop(): Promise<string> {
	const name = `listing-${++made}`;
	const { loop } = await staff.api.loops.create({ siteId, name, source: "query", query: { postTypes: ["products"] } });
	await staff.api.loops.publish({ siteId, loopId: loop.id });
	return name;
}

describe("building a Filter", () => {
	test("Staff create one for a query Loop: a Draft with its controls in canonical form", async () => {
		const { filter } = await staff.api.filters.create({ siteId, name: "shop", loop: "products", controls: CONTROLS });

		expect(filter).toMatchObject({ name: "shop", loop: "products", status: "draft", published: null });
		expect(filter.draft.mode).toBe("live");
		expect(filter.draft.controls.map((control) => control.type)).toEqual([
			"search",
			"checkboxes",
			"toggle",
			"range",
			"sort",
			"chips",
			"count",
		]);
		expect(filter.draft.controls[1]).toMatchObject({
			key: "category",
			label: { text: "Category" },
			source: { kind: "field", field: "category" },
			match: "any",
			counts: true,
			empty: "disable",
			order: "source",
			showFirst: 10,
		});
		expect(filter.draft.controls[3]).toMatchObject({ kind: "number", minLabel: null, maxLabel: null });
		// Every control has an id the builder selects it by.
		expect(new Set(filter.draft.controls.map((control) => control.id)).size).toBe(7);
		const { filters } = await staff.api.filters.list({ siteId });
		expect(filters.map((each) => each.name)).toContain("shop");
	});

	test("labels are words in every language; saving the Draft replaces the parts given", async () => {
		const { filter } = await staff.api.filters.create({ siteId, name: "labelled", loop: await newLoop() });
		const { filter: saved } = await staff.api.filters.saveDraft({
			siteId,
			filterId: filter.id,
			mode: "submit",
			applyLabel: { text: "Show results", translations: { it: "Mostra i risultati" } },
			controls: [{ type: "toggle", key: "vegan", label: "Vegan", field: "vegan" }],
		});

		expect(saved.draft).toMatchObject({
			mode: "submit",
			applyLabel: { text: "Show results", translations: { it: "Mostra i risultati" } },
			controls: [{ type: "toggle", key: "vegan", label: { text: "Vegan" } }],
		});
		const { filter: again } = await staff.api.filters.saveDraft({ siteId, filterId: filter.id, mode: "live" });
		expect(again.draft.controls).toHaveLength(1);
		expect(again.draft.applyLabel).toEqual(saved.draft.applyLabel);
	});

	test("its name is lower-case words joined by dashes, its own on the Site", async () => {
		await expect(
			staff.api.filters.create({ siteId, name: "Shop Filter", loop: await newLoop() }),
		).rejects.toMatchObject({ code: "FILTER_INVALID", data: { problems: [{ at: "name" }] } });
		await expect(staff.api.filters.create({ siteId, name: "shop", loop: await newLoop() })).rejects.toMatchObject({
			code: "FILTER_NAME_TAKEN",
			data: { name: "shop" },
		});
	});

	test("it narrows one query Loop, which has one Filter at most", async () => {
		const refused = (loop: string) => staff.api.filters.create({ siteId, name: `for-${loop}`, loop });

		await expect(refused("products")).rejects.toMatchObject({
			code: "FILTER_INVALID",
			data: { problems: [{ at: "loop", message: expect.stringContaining("already has a Filter") }] },
		});
		await expect(refused("nothing")).rejects.toMatchObject({
			code: "FILTER_INVALID",
			data: { problems: [{ at: "loop", message: "The Site has no Loop named nothing." }] },
		});
		await expect(refused("openings")).rejects.toMatchObject({
			code: "FILTER_INVALID",
			data: { problems: [{ at: "loop", message: expect.stringContaining("only a Loop with a query") }] },
		});
	});

	test("each control is checked against the Loop's Post Types, every problem where it is", async () => {
		const loop = await newLoop();
		const refused = (controls: unknown[]) =>
			staff.api.filters.create({ siteId, name: `checked-${loop}`, loop, controls: controls as never });

		await expect(
			refused([
				{ type: "checkboxes", key: "category", label: "Category", source: { kind: "field", field: "summary" } },
				{ type: "toggle", key: "vegan", label: "Vegan", field: "price" },
				{ type: "range", key: "time", label: "Time", field: "time" },
				{ type: "range", key: "price", label: "", field: "price" },
				{ type: "sort", key: "sort", options: [{ value: "x", label: "X", by: "summary-nope", direction: "asc" }] },
				{ type: "chips", key: "nope" },
				{ type: "wizard" },
			]),
		).rejects.toMatchObject({
			code: "FILTER_INVALID",
			data: {
				problems: expect.arrayContaining([
					expect.objectContaining({ at: "controls[0].source.field" }),
					expect.objectContaining({ at: "controls[1].field" }),
					expect.objectContaining({ at: "controls[2].field" }),
					expect.objectContaining({ at: "controls[3].label" }),
					expect.objectContaining({ at: "controls[4].options[0].by" }),
					expect.objectContaining({ at: "controls[5].key" }),
					expect.objectContaining({ at: "controls[6].type" }),
				]),
			},
		});
		await expect(
			refused([
				{ type: "toggle", key: "q", label: "Q", field: "vegan" },
				{ type: "toggle", key: "Vegan Only", label: "V", field: "vegan" },
				{ type: "toggle", key: "same", label: "A", field: "vegan" },
				{ type: "range", key: "same", label: "B", field: "price" },
				{ type: "count" },
				{ type: "count" },
			]),
		).rejects.toMatchObject({
			code: "FILTER_INVALID",
			data: {
				problems: [
					expect.objectContaining({ at: "controls[0].key" }),
					expect.objectContaining({ at: "controls[1].key" }),
					expect.objectContaining({ at: "controls[3].key", message: expect.stringContaining("Another control") }),
					expect.objectContaining({ at: "controls[5].type" }),
				],
			},
		});
		// Sorting by relevance needs a search box to rank by.
		await expect(
			refused([
				{ type: "sort", key: "sort", options: [{ value: "best", label: "Best", by: "relevance", direction: "desc" }] },
			]),
		).rejects.toMatchObject({ data: { problems: [{ at: "controls[0].options[0].by" }] } });
		// Options come from a select or Relationship Field, or the Loop's Post Types.
		const { filter } = await staff.api.filters.create({
			siteId,
			name: `sources-${loop}`,
			loop,
			controls: [
				{ type: "choice", key: "baker", label: "Baker", source: { kind: "field", field: "baker" } },
				{ type: "checkboxes", key: "kind", label: "Kind", source: { kind: "postType" } },
				{ type: "range", key: "baked", label: "Baked", field: "baked" },
			],
		});
		expect(filter.draft.controls).toMatchObject([
			{ type: "choice", display: "radio", allLabel: null },
			{ type: "checkboxes", source: { kind: "postType" } },
			{ type: "range", kind: "date" },
		]);
	});

	test("publishing makes it what visitors use, logged in the Audit log", async () => {
		const loop = await newLoop();
		const { filter } = await staff.api.filters.create({ siteId, name: `published-${loop}`, loop, controls: CONTROLS });
		const { published, filter: after } = await staff.api.filters.publish({ siteId, filterId: filter.id });

		expect(published.kind).toBe("filter");
		expect(after.status).toBe("published");
		expect(after.published).toEqual(after.draft);
		await staff.api.filters.saveDraft({ siteId, filterId: filter.id, mode: "submit" });
		expect((await staff.api.filters.get({ siteId, filterId: filter.id })).filter.status).toBe("changed");
		const superadmin = await install.superadmin();
		const { entries } = await superadmin.api.audit.list({});
		expect(entries.map((entry) => entry.action)).toEqual(expect.arrayContaining(["filter.create", "filter.publish"]));
	});

	test("a Filter whose Loop isn't published, or no longer fits it, can't be published", async () => {
		const { loop } = await staff.api.loops.create({
			siteId,
			name: "unpublished",
			source: "query",
			query: { postTypes: ["products"] },
		});
		const { filter } = await staff.api.filters.create({ siteId, name: "early", loop: loop.name, controls: CONTROLS });
		await expect(staff.api.filters.publish({ siteId, filterId: filter.id })).rejects.toMatchObject({
			code: "FILTER_INVALID",
			data: { problems: [{ at: "loop", message: expect.stringContaining("isn't published yet") }] },
		});
		// The Loop's published query lists Bakers only: the Products' Fields are gone.
		await staff.api.loops.saveDraft({ siteId, loopId: loop.id, query: { postTypes: ["bakers"] } });
		await staff.api.loops.publish({ siteId, loopId: loop.id });
		await expect(staff.api.filters.publish({ siteId, filterId: filter.id })).rejects.toMatchObject({
			code: "FILTER_INVALID",
			data: { problems: expect.arrayContaining([expect.objectContaining({ at: "controls[1].source.field" })]) },
		});
	});

	test("Publish all lists a Filter's Draft with Structure, and publishes it after its Loop", async () => {
		const { loop } = await staff.api.loops.create({
			siteId,
			name: "together",
			source: "query",
			query: { postTypes: ["products"] },
		});
		const { filter } = await staff.api.filters.create({
			siteId,
			name: "together",
			loop: "together",
			controls: CONTROLS,
		});
		const { drafts } = await staff.api.publishing.drafts({ siteId });
		expect(drafts.find((draft) => draft.item.kind === "filter" && draft.item.id === filter.id)).toMatchObject({
			group: "structure",
			name: "together",
			status: "new",
			canPublish: true,
		});

		const items = [
			{ kind: "filter", id: filter.id },
			{ kind: "loop", id: loop.id },
		] as const;
		const preview = await staff.api.publishing.publishAll({ siteId, items: [...items] });
		expect(preview.published).toBe(false);
		if (preview.published) return;
		expect(preview.preview.items.map((item) => item.item.kind)).toEqual(["loop", "filter"]);
		const done = await staff.api.publishing.publishAll({
			siteId,
			items: [...items],
			confirmation: preview.confirmation.id,
		});
		expect(done.published).toBe(true);
		expect((await staff.api.filters.get({ siteId, filterId: filter.id })).filter.status).toBe("published");
	});

	test("Members can't see or change Filters: they are Structure", async () => {
		await expect(owner.api.filters.list({ siteId })).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(owner.api.filters.create({ siteId, name: "members", loop: await newLoop() })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});
});

describe("placing a Filter in Template markup", () => {
	let filterId: string;

	beforeAll(async () => {
		const { filter } = await staff.api.filters
			.create({
				siteId,
				name: "placed",
				loop: "listing-placed",
				controls: CONTROLS,
			})
			.catch(async () => {
				const { loop } = await staff.api.loops.create({
					siteId,
					name: "listing-placed",
					source: "query",
					query: { postTypes: ["products"] },
				});
				await staff.api.loops.publish({ siteId, loopId: loop.id });
				return staff.api.filters.create({ siteId, name: "placed", loop: "listing-placed", controls: CONTROLS });
			});
		filterId = filter.id;
	});

	const save = (markup: string) =>
		staff.api.templates.saveArchiveTemplateMarkup({ siteId, postTypeId: productsId, markup });
	const LOOP = "{{@loop listing-placed as p}}<p>{{ p.title }}</p>{{/loop}}";

	test('{{@filter <name> for="<loop>"}} saves and prints back as written', async () => {
		const markup = `<aside>{{@filter placed for="listing-placed"}}</aside>${LOOP}`;
		const saved = await save(markup);

		expect(saved.markup.replaceAll(/ data-wc-id="[^"]*"/g, "")).toBe(markup);
		const { template } = await staff.api.templates.getArchiveTemplate({ siteId, postTypeId: productsId });
		expect(template?.draft.nodes[0]).toMatchObject({
			children: [{ type: "filter", filter: filterId, loop: "listing-placed" }],
		});
	});

	test("it names a Filter of the Site and the Loop that Filter narrows, shown in the same tree", async () => {
		const problems = async (markup: string) => {
			const error = await save(markup).catch((caught) => caught);
			expect(error).toMatchObject({ code: "TEMPLATE_MARKUP_INVALID" });
			return (error.data.problems as { message: string }[]).map((problem) => problem.message);
		};

		expect(await problems(`{{@filter nothing for="listing-placed"}}${LOOP}`)).toEqual([
			"There is no Filter named nothing on this Site.",
		]);
		expect(await problems(`{{@filter placed for="products"}}${LOOP}`)).toEqual([
			'The Filter placed narrows the Loop listing-placed: write for="listing-placed".',
		]);
		expect(await problems(`{{@filter placed}}${LOOP}`)).toEqual([
			'{{@filter}} names the Filter and the Loop it narrows, such as {{@filter shop for="products"}}.',
		]);
		expect(await problems('<div>{{@filter placed for="listing-placed"}}</div>')).toEqual([
			"{{@filter}} narrows the Loop listing-placed: show it in the same Template or Component, with {{@loop listing-placed}}.",
		]);
	});

	test("it is a form of its own: never in a paragraph, a link, another form or a Loop's items", async () => {
		const problems = async (markup: string) => {
			const error = await save(`${markup}${LOOP}`).catch((caught) => caught);
			return (error?.data?.problems as { message: string }[] | undefined)?.map((problem) => problem.message) ?? [];
		};

		expect(await problems('<p>{{@filter placed for="listing-placed"}}</p>')).toEqual([
			"{{@filter}} is a form of its own: it can't go inside <p>.",
		]);
		expect(await problems('<ul>{{@filter placed for="listing-placed"}}</ul>')).toEqual([
			"{{@filter}} goes inside an <li>, not directly in a list.",
		]);
		expect(await problems('{{@loop listing-placed as x}}{{@filter placed for="listing-placed"}}{{/loop}}')).toEqual([
			expect.stringContaining("{{@filter}} can't go inside a Loop's items"),
		]);
	});

	test("a published Template places only a published Filter", async () => {
		const saved = await save(`{{@filter placed for="listing-placed"}}${LOOP}`);
		await expect(staff.api.templates.publish({ siteId, templateId: saved.template.id })).rejects.toMatchObject({
			code: "TEMPLATE_INVALID",
			data: {
				problems: [expect.objectContaining({ message: "The Filter placed isn't published yet: publish it first." })],
			},
		});
		await staff.api.filters.publish({ siteId, filterId });
		await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	});
});
