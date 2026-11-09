// A bakery shop for the Filter tests: Products (a category select, a vegan switch, a price, a day
// they were first baked and a Relationship to their Baker), a paginated query Loop of them sorted by
// title, and the Filter `shop` with every kind of control, shown with the Loop on the Products'
// Archive page, `/shop`, on the Site's live domain.
import type { TestBrowser, TestInstall } from "../harness/index.ts";
import { goLive } from "../harness/staging.ts";

export type Shop = {
	staff: TestBrowser;
	siteId: string;
	workspaceId: string;
	origin: string;
	productsId: string;
	filterId: string;
	loopId: string;
	/** The Archive template's id, published. */
	templateId: string;
	/** Products by title. */
	products: Map<string, string>;
};

/** Every kind of control, as the Filter `shop` has them. */
export const SHOP_CONTROLS = [
	{ type: "search", label: "Search the shop", placeholder: "Search the shop" },
	{
		type: "checkboxes",
		key: "category",
		label: { text: "Category", translations: { fr: "Catégorie" } },
		source: { kind: "field", field: "category" },
	},
	{ type: "choice", key: "baker", label: "Baker", source: { kind: "field", field: "baker" } },
	{ type: "toggle", key: "vegan", label: "Vegan only", field: "vegan" },
	{ type: "range", key: "price", label: "Price", field: "price" },
	{ type: "range", key: "baked", label: "First baked", field: "baked" },
	{
		type: "sort",
		key: "sort",
		options: [
			{ value: "price-asc", label: "Price, low to high", by: "price", direction: "asc" },
			{ value: "price-desc", label: "Price, high to low", by: "price", direction: "desc" },
			{ value: "relevance", label: "Best match", by: "relevance", direction: "desc" },
		],
	},
	{ type: "chips" },
	{
		type: "count",
		one: "1 product",
		other: { text: "{count} products", translations: { fr: "{count} produits" } },
		none: "No products match",
	},
];

/** The Archive template showing the Filter beside its Loop. */
export const SHOP_MARKUP =
	'<aside>{{@filter shop for="products"}}</aside><ul>{{@loop products as p}}<li>{{ p.title }}</li>{{@empty}}<li>None</li>{{/loop}}</ul>{{@pagination products}}';

const PRODUCTS: [string, Record<string, unknown>][] = [
	["Country sourdough", { category: ["bread"], price: 6.5, vegan: false, baker: "Ada", baked: "2026-01-10" }],
	["Rye & caraway", { category: ["bread"], price: 7, vegan: false, baker: "Bruno", baked: "2026-02-01" }],
	["Rosemary focaccia", { category: ["bread"], price: 5, vegan: true, baker: "Ada", baked: "2026-02-15" }],
	["Butter croissant", { category: ["pastries"], price: 2.8, vegan: false, baker: "Bruno", baked: "2026-03-01" }],
	["Pain au chocolat", { category: ["pastries"], price: 3.2, vegan: false, baker: "Ada", baked: "2026-03-02" }],
	["Cinnamon bun", { category: ["pastries"], price: 3.5, vegan: true, baker: "Bruno", baked: "2026-03-03" }],
	["Birthday cake", { category: ["cakes"], price: 25, vegan: false, baker: null, baked: "2026-04-01" }],
];

/** Builds the shop on a new Site of the Install, live on its Primary domain. */
export async function buildShop(install: TestInstall, slug = "bakery"): Promise<Shop> {
	const workspaceId = (await install.createWorkspace(`Shop ${slug}`)).id;
	const siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug })).id;
	const origin = await goLive(install, siteId);
	const staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	const { postType: bakers } = await staff.api.postTypes.create({
		siteId,
		name: "Bakers",
		key: "bakers",
		urlPattern: "/bakers/{slug}",
	});
	const bakerIds = new Map<string, string>();
	for (const name of ["Ada", "Bruno"]) {
		const { entry } = await staff.api.entries.create({ siteId, postTypeId: bakers.id, title: name });
		await staff.api.entries.publish({ siteId, entryId: entry.id });
		bakerIds.set(name, entry.id);
	}
	const { postType } = await staff.api.postTypes.create({
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
					{ value: "cakes", label: "Cakes" },
					{ value: "gluten-free", label: "Gluten-free" },
				],
			},
			{ key: "vegan", label: "Vegan", type: "boolean" },
			{ key: "price", label: "Price", type: "number" },
			{ key: "baked", label: "First baked", type: "date", mode: "date" },
			{ key: "baker", label: "Baker", type: "relationship", postTypes: ["bakers"] },
		],
	});
	const products = new Map<string, string>();
	for (const [title, { baker, ...fields }] of PRODUCTS) {
		const { entry } = await staff.api.entries.create({
			siteId,
			postTypeId: postType.id,
			title,
			fields: { ...fields, baker: baker ? bakerIds.get(String(baker)) : null },
		});
		await staff.api.entries.publish({ siteId, entryId: entry.id });
		products.set(title, entry.id);
	}
	const { loop } = await staff.api.loops.create({
		siteId,
		name: "products",
		source: "query",
		query: { postTypes: ["products"], limit: 4, paginate: true, sort: [{ by: "title", direction: "asc" }] },
	});
	await staff.api.loops.publish({ siteId, loopId: loop.id });
	const { filter } = await staff.api.filters.create({
		siteId,
		name: "shop",
		loop: "products",
		controls: SHOP_CONTROLS as never,
	});
	await staff.api.filters.publish({ siteId, filterId: filter.id });
	const { template } = await staff.api.templates.saveArchiveTemplateMarkup({
		siteId,
		postTypeId: postType.id,
		markup: SHOP_MARKUP,
	});
	await staff.api.templates.publish({ siteId, templateId: template.id });
	return {
		staff,
		siteId,
		workspaceId,
		origin,
		productsId: postType.id,
		filterId: filter.id,
		loopId: loop.id,
		templateId: template.id,
		products,
	};
}

/** The Loop's items a page lists, in order. */
export function listed(html: string): string[] {
	const list = /<ul>((?:<!--[^>]*-->)?(?:<li>[^<]*<\/li>)*(?:<!--[^>]*-->)?)<\/ul>/.exec(html)?.[1] ?? "";
	return [...list.matchAll(/<li>([^<]*)<\/li>/g)].map(([, title = ""]) => title.replaceAll("&amp;", "&"));
}

/** A Filter's options for one key, as its form shows them: value, label, count, checked, disabled. */
export function optionsIn(html: string, name: string) {
	const pattern = new RegExp(
		`<input type="(?:checkbox|radio)" id="[^"]*" name="${name.replace(".", "\\.")}" value="([^"]*)"( checked)?( disabled)?><label for="[^"]*">([^<]*?)(?: <span class="wc-filter-option-count">(\\d+)</span>)?</label>`,
		"g",
	);
	return [...html.matchAll(pattern)].map(([, value = "", checked, disabled, label = "", count]) => ({
		value,
		label: label.replaceAll("&amp;", "&"),
		count: count === undefined ? null : Number(count),
		checked: checked !== undefined,
		disabled: disabled !== undefined,
	}));
}
