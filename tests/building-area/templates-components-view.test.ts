// The Templates and Components places' own reading (BA-23): Templates grouped into the place's
// columns with what each "+" may make and where each shows; the Components place's view (filter,
// search, chosen Component) through the address, what it shows, a new Component's tag and a copy's
// free name.
import { describe, expect, test } from "bun:test";

import { isPlace, printAddress, readAddress } from "../../apps/server/src/ui/building-area/documents.ts";
import {
	copyName,
	printComponentsView,
	readComponentsView,
	tagOf,
	viewComponents,
} from "../../apps/server/src/ui/building-area/places/components/view.ts";
import {
	columnsOf,
	documentOf,
	type TemplateListing,
} from "../../apps/server/src/ui/building-area/places/templates/data.ts";

const blog = { id: "11111111-1111-4111-8111-111111111111", name: "Blog posts" };
const team = { id: "22222222-2222-4222-8222-222222222222", name: "Team" };
const made = (status: "draft" | "published" | "changed") => ({
	id: crypto.randomUUID(),
	status,
	updatedAt: new Date(),
});

describe("Templates in columns", () => {
	const listed: TemplateListing[] = [
		{ kind: "site", postType: null, template: made("published"), unavailable: null },
		{ kind: "search", postType: null, template: null, unavailable: null },
		{ kind: "entry", postType: blog, template: made("changed"), unavailable: null },
		{ kind: "archive", postType: blog, template: null, unavailable: null },
		{ kind: "entry", postType: team, template: made("draft"), unavailable: null },
		{ kind: "archive", postType: team, template: null, unavailable: "address" },
	];
	const columns = columnsOf(listed, new Map([[blog.id, 24]]));

	test("the Site's first, then one per Post Type, each with what it made and what its + may make", () => {
		expect(columns.map((column) => column.key)).toEqual(["site", blog.id, team.id]);
		expect(columns.map((column) => column.made.map((card) => card.kind))).toEqual([["site"], ["entry"], ["entry"]]);
		// An Archive template with no address can't be made: the + never offers it.
		expect(columns.map((column) => column.makeable.map((card) => card.kind))).toEqual([["search"], ["archive"], []]);
	});

	test("where each shows: every page, its Post Type's published Entries, or nowhere before its first publish", () => {
		expect(columns[0]?.made[0]?.shownOn).toBe("every");
		expect(columns[1]?.made[0]?.shownOn).toBe(24);
		expect(columns[2]?.made[0]?.shownOn).toBeNull();
	});

	test("each opens as its document", () => {
		expect(documentOf({ kind: "site", postType: null })).toEqual({ kind: "siteTemplate" });
		expect(documentOf({ kind: "search", postType: null })).toEqual({ kind: "searchTemplate" });
		expect(documentOf({ kind: "entry", postType: blog })).toEqual({
			kind: "entryTemplate",
			postTypeId: blog.id,
			entryId: null,
		});
		expect(documentOf({ kind: "archive", postType: blog })).toEqual({ kind: "archiveTemplate", postTypeId: blog.id });
	});
});

describe("the Components place's view", () => {
	test("round-trips through the address, and the default is no view", () => {
		const view = { filter: "allowed" as const, q: "hero", component: blog.id };
		expect(readComponentsView(printComponentsView(view))).toEqual(view);
		expect(printComponentsView({ filter: "all", q: "", component: null })).toBeNull();
		expect(readComponentsView("filter=nonsense")).toEqual({ filter: "all", q: "", component: null });
		const address = readAddress(
			"/_webcraft/build/page/menu",
			`?wc-place=components&wc-view=${encodeURIComponent("filter=unused&q=hero")}`,
		);
		expect(address.place).toBe("components");
		expect(readComponentsView(address.view ?? null)).toEqual({ filter: "unused", q: "hero", component: null });
		expect(printAddress(address)).toContain("wc-place=components");
		expect(isPlace("templates")).toBe(true);
	});

	test("filters by Allowed or Unused, then searches the name in any case", () => {
		const items = [
			{ id: "a", name: "HeroSplit", placed: true },
			{ id: "b", name: "CustomerQuote", placed: false },
			{ id: "c", name: "OpeningHours", placed: false },
		];
		const allowed = new Set(["a"]);
		const shown = (filter: "all" | "allowed" | "unused", q = "") =>
			viewComponents(items, { filter, q, component: null }, allowed).map((item) => item.id);
		expect(shown("all")).toEqual(["a", "b", "c"]);
		expect(shown("allowed")).toEqual(["a"]);
		expect(shown("unused")).toEqual(["b", "c"]);
		expect(shown("unused", "HOURS")).toEqual(["c"]);
		expect(shown("all", "quote cust")).toEqual(["b"]);
	});

	test("a new Component's tag comes from its words; a copy takes the first free name", () => {
		expect(tagOf("Price card")).toBe("PriceCard");
		expect(tagOf("  hero-split 2 ")).toBe("HeroSplit2");
		expect(tagOf("HeroSplit")).toBe("HeroSplit");
		expect(tagOf("   ")).toBe("");
		expect(copyName("Hero", new Set(["Hero"]))).toBe("HeroCopy");
		expect(copyName("Hero", new Set(["Hero", "HeroCopy", "HeroCopy2"]))).toBe("HeroCopy3");
	});
});
