// The Loops place's pure parts (BA-25): its address and view as the shell's address keeps them, the
// result's tree of values with the binding each key copies, the order choices, the markup that places
// a Loop, and the query model the admin's Loop screen and the place share.
import { describe, expect, test } from "bun:test";

import { printAddress, readAddress } from "../../apps/server/src/ui/building-area/documents.ts";
import {
	freshness,
	itemNameOf,
	loopIdOf,
	orderChoices,
	orderKey,
	placeOf,
	placingMarkup,
	printView,
	readView,
	resultRows,
	sortOf,
} from "../../apps/server/src/ui/building-area/places/loops/view.ts";
import {
	fieldFilter,
	filterOfType,
	newFilter,
	queryReads,
	withWindow,
} from "../../apps/server/src/ui/content/loop-query.ts";

describe("the place's address", () => {
	test("names the place alone or one Loop, and round-trips through the shell's address", () => {
		const id = "0b6f5f4e-6c39-4c84-9f36-1c7a4f2b8e11";
		expect(loopIdOf("loops")).toBeNull();
		expect(loopIdOf(placeOf(id))).toBe(id);
		expect(placeOf(null)).toBe("loops");
		const address = readAddress("/_webcraft/build/page/", `?wc-place=${placeOf(id)}&wc-view=mode%3Dmarkup`);
		expect(address.place).toBe(`loops/${id}`);
		const url = new URL(`https://bakery.example${printAddress(address)}`);
		expect(readAddress(url.pathname, url.search)).toMatchObject({ place: `loops/${id}`, view: "mode=markup" });
	});

	test("the view: the form unless it says markup", () => {
		expect(readView(null)).toEqual({ mode: "form" });
		expect(readView("mode=markup")).toEqual({ mode: "markup" });
		expect(readView("mode=other")).toEqual({ mode: "form" });
		expect(printView({ mode: "form" })).toBeNull();
		expect(printView(readView(printView({ mode: "markup" })))).toBe("mode=markup");
	});
});

describe("the result's tree", () => {
	test("opens Groups, choices and Entries into paths; a list copies the Loop over it", () => {
		const rows = resultRows({
			title: "Spring menu launches",
			minutes: 20,
			draft: false,
			cover: "media:1",
			url: null,
			author: { name: "Ada" },
			difficulty: { value: "easy", label: "Easy" },
			steps: [{ text: "Knead" }, { text: "Bake" }],
		});
		expect(rows).toEqual([
			{ path: "title", shown: '"Spring menu launches"', binding: "{{ item.title }}" },
			{ path: "minutes", shown: "20", binding: "{{ item.minutes }}" },
			{ path: "draft", shown: "false", binding: "{{ item.draft }}" },
			{ path: "cover", shown: '"media:1"', binding: "{{ item.cover }}" },
			{ path: "url", shown: "null", binding: "{{ item.url }}" },
			{ path: "author.name", shown: '"Ada"', binding: "{{ item.author.name }}" },
			{ path: "difficulty.value", shown: '"easy"', binding: "{{ item.difficulty.value }}" },
			{ path: "difficulty.label", shown: '"Easy"', binding: "{{ item.difficulty.label }}" },
			{ path: "steps", shown: "[2]", binding: "{{@loop item.steps as step}}" },
		]);
		expect(itemNameOf("tags")).toBe("tag");
		expect(itemNameOf("class")).toBe("classItem");
		expect(itemNameOf("ids")).toBe("idsItem");
	});

	test("says how long ago it was read", () => {
		expect(freshness(1_000, 30_000)).toEqual({ kind: "justNow" });
		expect(freshness(0, 3 * 60_000 + 5)).toEqual({ kind: "minutes", count: 3 });
	});
});

describe("the order and the markup", () => {
	test("each sortable thing each way, dates newest first; keys read back", () => {
		const choices = orderChoices([
			{ by: "title", label: "Title", kind: "text" },
			{ by: "publishedAt", label: "Published", kind: "date" },
		]);
		expect(choices.map((choice) => choice.key)).toEqual([
			"title:asc",
			"title:desc",
			"publishedAt:desc",
			"publishedAt:asc",
		]);
		expect(sortOf(orderKey({ by: "address.city", direction: "desc" }))).toEqual({
			by: "address.city",
			direction: "desc",
		});
		expect(sortOf("")).toBeNull();
		expect(sortOf("title:up")).toBeNull();
	});

	test("the markup that places a Loop, with its pagination when it goes page by page", () => {
		expect(
			placingMarkup("latest-posts", { bindings: ["{{ item.title }}"], emptyText: "No posts", paginate: true }),
		).toBe(
			[
				"{{@loop latest-posts as item}}",
				"  {{ item.title }}",
				"{{@empty}}",
				"  No posts",
				"{{/loop}}",
				"{{@pagination latest-posts}}",
			].join("\n"),
		);
		expect(placingMarkup("hours", { bindings: [], emptyText: "—", paginate: false })).not.toContain("@pagination");
	});
});

describe("the shared query model", () => {
	const postTypes = [
		{
			key: "blog",
			name: "Blog posts",
			fields: [
				{ key: "minutes", label: "Minutes", type: "number" },
				{ key: "tags", label: "Tags", type: "select", multiple: true, options: [{ value: "a", label: "A" }] },
				{ key: "day", label: "Day", type: "date", mode: "date" },
				{ key: "writer", label: "Writer", type: "relationship", postTypes: ["team"] },
				{ key: "address", label: "Address", type: "group", fields: [{ key: "city", label: "City", type: "text" }] },
			],
		},
		{ key: "team", name: "Team", fields: [{ key: "role", label: "Role", type: "text" }] },
	] as never;

	test("reads only the listed Post Types' Fields, Groups' by path", () => {
		const reads = queryReads(postTypes, { postTypes: ["blog"] });
		expect(reads.filterable.map((each) => each.path)).toEqual(["minutes", "tags", "day", "address.city"]);
		expect(reads.relationships.map((each) => each.path)).toEqual(["writer"]);
		expect(reads.dates.map((each) => each.path)).toEqual(["day"]);
		// A select holding several choices doesn't sort.
		expect(reads.sortable.map((each) => each.path)).toEqual(["minutes", "day", "address.city"]);
		expect(queryReads(postTypes, { postTypes: [] }).filterable).toEqual([]);
	});

	test("what a rule becomes as what it reads changes", () => {
		const reads = queryReads(postTypes, { postTypes: ["blog"] });
		expect(newFilter(reads.filterable)).toEqual({ type: "field", field: "minutes", operator: "equals", value: 0 });
		expect(newFilter([])).toEqual({ type: "status", statuses: ["published"] });
		expect(fieldFilter(reads.filterable[3])).toEqual({
			type: "field",
			field: "address.city",
			operator: "equals",
			value: "",
		});
		expect(filterOfType("relationship", reads)).toEqual({
			type: "relationship",
			field: "writer",
			to: "current",
			entries: [],
		});
		const date = filterOfType("date", reads);
		if (date.type !== "date") throw new Error("a date rule");
		expect(withWindow(date, "last")).toMatchObject({ window: "last", amount: 12, unit: "months", from: null });
		expect(withWindow(date, "between")).toMatchObject({ window: "between", amount: null, from: "2026-01-01" });
	});
});
