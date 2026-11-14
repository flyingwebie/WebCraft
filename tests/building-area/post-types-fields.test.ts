// A Post Type's Fields in the Content place (BA-21): the list the place draws (Fields inside a Group
// or Repeater under it), the changes it saves as a whole list (moving among siblings, adding,
// removing), the kinds a new Field may be, where a refused setting is, and the places' addresses of a
// Post Type's Fields and Settings with the chosen Field in the view.
import { describe, expect, test } from "bun:test";
import type { FieldDefinition } from "@webcraft/core";

import { isPlace, printAddress, readAddress } from "../../apps/server/src/ui/building-area/documents.ts";
import {
	addTo,
	freeKey,
	made,
	moveTo,
	offeredKinds,
	problemPlace,
	removeAt,
	replaceAt,
	rowsOf,
} from "../../apps/server/src/ui/building-area/places/content/post-types/fields.ts";
import {
	fieldOfView,
	viewOfField,
} from "../../apps/server/src/ui/building-area/places/content/post-types/PostTypePane.tsx";

const POST_TYPE = "6f1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5";

const text = (key: string): FieldDefinition => made("text", key, key, "");

/** A Group or Repeater holding `fields`. */
function holding(type: "group" | "repeater", key: string, fields: FieldDefinition[]): FieldDefinition {
	const field = made(type, key, key, "first");
	return field.type === "group" || field.type === "repeater" ? { ...field, fields } : field;
}

const FIELDS: FieldDefinition[] = [
	text("title"),
	made("relationship", "author", "Author", ""),
	holding("repeater", "gallery", [made("media", "image", "Image", ""), text("caption")]),
	holding("group", "seo", [text("meta_title"), text("meta_description")]),
];

const paths = (fields: readonly FieldDefinition[]) => rowsOf(fields).map((row) => row.path);

describe("the Fields as the place lists them", () => {
	test("in order, those inside a Group or Repeater right after it, one level deeper", () => {
		expect(
			rowsOf(FIELDS).map(({ path, depth, index, siblings, parent }) => ({ path, depth, index, siblings, parent })),
		).toEqual([
			{ path: "title", depth: 1, index: 0, siblings: 4, parent: null },
			{ path: "author", depth: 1, index: 1, siblings: 4, parent: null },
			{ path: "gallery", depth: 1, index: 2, siblings: 4, parent: null },
			{ path: "gallery.image", depth: 2, index: 0, siblings: 2, parent: "gallery" },
			{ path: "gallery.caption", depth: 2, index: 1, siblings: 2, parent: "gallery" },
			{ path: "seo", depth: 1, index: 3, siblings: 4, parent: null },
			{ path: "seo.meta_title", depth: 2, index: 0, siblings: 2, parent: "seo" },
			{ path: "seo.meta_description", depth: 2, index: 1, siblings: 2, parent: "seo" },
		]);
	});

	test("a Field moves among its siblings only, kept in range", () => {
		expect(paths(moveTo(FIELDS, "seo", 0)).slice(0, 4)).toEqual([
			"seo",
			"seo.meta_title",
			"seo.meta_description",
			"title",
		]);
		expect(paths(moveTo(FIELDS, "seo.meta_description", 0))).toContain("seo.meta_description");
		expect(
			rowsOf(moveTo(FIELDS, "seo.meta_description", 0)).find((row) => row.path === "seo.meta_description")?.index,
		).toBe(0);
		expect(paths(moveTo(FIELDS, "title", 99)).at(-1)).toBe("title");
		// The list it came from is left as it was.
		expect(paths(FIELDS)[0]).toBe("title");
	});

	test("added at the end of its list, changed and removed by path", () => {
		const added = addTo(FIELDS, "gallery", text("credit"));
		expect(paths(added)).toContain("gallery.credit");
		expect(rowsOf(added).find((row) => row.path === "gallery.credit")?.index).toBe(2);
		const renamed = replaceAt(FIELDS, "seo.meta_title", (field) => ({ ...field, label: "Title for search" }));
		expect(rowsOf(renamed).find((row) => row.path === "seo.meta_title")?.field.label).toBe("Title for search");
		expect(paths(removeAt(FIELDS, "gallery"))).toEqual([
			"title",
			"author",
			"seo",
			"seo.meta_title",
			"seo.meta_description",
		]);
	});

	test("a new Group or Repeater starts with its first Field; keys are made free from labels", () => {
		expect(made("group", "credits", "Credits", "Photographer")).toMatchObject({
			type: "group",
			fields: [{ key: "photographer", label: "Photographer", type: "text" }],
		});
		expect(freeKey("Cover image", ["title"])).toBe("cover_image");
		expect(freeKey("Title", ["title", "title_2"])).toBe("title_3");
		expect(freeKey("123", [])).toBe("field");
	});

	test("the kinds a new Field may be: no Body field on Pages or inside a Group, one at most; nesting 3 deep", () => {
		expect(offeredKinds(FIELDS, null, false)).toContain("body");
		expect(offeredKinds(FIELDS, null, true)).not.toContain("body");
		expect(offeredKinds(FIELDS, "seo", false)).not.toContain("body");
		expect(offeredKinds([...FIELDS, made("body", "body", "Body", "")], null, false)).not.toContain("body");
		expect(offeredKinds(FIELDS, "seo", false)).toContain("group");
		const deep = [holding("group", "a", [made("group", "b", "B", "y")])];
		expect(offeredKinds(deep, "a.b", false)).not.toContain("group");
		expect(offeredKinds(deep, "a.b", false)).not.toContain("repeater");
	});

	test("a refused setting is found by the path the server names", () => {
		expect(problemPlace(FIELDS, "fields[3].fields[1].label")).toEqual({
			path: "seo.meta_description",
			setting: "label",
		});
		expect(problemPlace(FIELDS, "fields[2].options[1].value")).toEqual({
			path: "gallery",
			setting: "options[1].value",
		});
		expect(problemPlace(FIELDS, "urlPattern")).toEqual({ path: null, setting: "urlPattern" });
	});
});

describe("the addresses of a Post Type's Fields and Settings", () => {
	test("are places, with the chosen Field in the view", () => {
		for (const place of [`content/${POST_TYPE}/fields`, `content/${POST_TYPE}/settings`, "content/post-types"])
			expect([place, isPlace(place)]).toEqual([place, true]);
		for (const place of [`content/${POST_TYPE}/entries`, `content/${POST_TYPE}/fields/title`, "content/pages/fields"])
			expect([place, isPlace(place)]).toEqual([place, false]);

		const address = readAddress(
			"/_webcraft/build/page/menu",
			`?wc-place=content%2F${POST_TYPE}%2Ffields&wc-view=${encodeURIComponent(viewOfField("seo.meta_title") ?? "")}`,
		);
		expect(address.place).toBe(`content/${POST_TYPE}/fields`);
		expect(fieldOfView(address.view ?? null)).toBe("seo.meta_title");
		expect(
			readAddress(
				new URL(printAddress(address), "https://x.test").pathname,
				new URL(printAddress(address), "https://x.test").search,
			),
		).toEqual(address);
		expect(fieldOfView("field=..%2Fx")).toBeNull();
		expect(viewOfField(null)).toBeNull();
	});
});
