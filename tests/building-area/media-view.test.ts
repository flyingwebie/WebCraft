// The Media place's part of the library and its view, as the shell's address keeps them (BA-22): the
// place names All files, Unfiled, the Trash or a folder; the view the search, the kind, the grid, the
// file open and its language. They read back exactly what they print, and nothing unknown gets in.
import { describe, expect, test } from "bun:test";

import { printAddress, readAddress } from "../../apps/server/src/ui/building-area/documents.ts";
import {
	defaultView,
	listQuery,
	partOf,
	placeOf,
	printView,
	readView,
	viewFor,
} from "../../apps/server/src/ui/building-area/places/media/view.ts";

const FOLDER = "0f8d5c1e-3b2a-4c6d-9e8f-1a2b3c4d5e6f";
const FILE = "9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d";

describe("the Media place's address", () => {
	test("every part of the library is a place of the shell, and reads back as itself", () => {
		for (const place of ["media", "media/unfiled", "media/trash", `media/${FOLDER}`]) {
			const address = readAddress("/_webcraft/build/page/", `?wc-place=${encodeURIComponent(place)}`);
			expect(address.place).toBe(place);
			expect(placeOf(partOf(place))).toBe(place);
		}
		expect(partOf(`media/${FOLDER}`)).toEqual({ kind: "folder", folderId: FOLDER });
	});

	test("anything else under media is no place", () => {
		for (const place of ["media/elsewhere", "media/trash/more", "media/0F8D5C1E", "mediax"]) {
			const address = readAddress("/_webcraft/build/page/", `?wc-place=${encodeURIComponent(place)}`);
			expect({ place, read: address.place }).toEqual({ place, read: null });
		}
	});

	test("a view prints only what differs from the default, and reads back the same", () => {
		expect(printView(defaultView())).toBeNull();
		const view = { q: "loaf", kind: "image" as const, layout: "grid" as const, file: FILE, language: "it" };
		const printed = printView(view);
		expect(printed).toBe(`q=loaf&kind=image&view=grid&file=${FILE}&language=it`);
		expect(readView(printed)).toEqual(view);
		const address = { document: { kind: "page" as const, page: "/menu" }, place: "media", view: printed, select: null };
		const url = new URL(`https://bakery.example${printAddress(address)}`);
		expect(readAddress(url.pathname, url.search).view).toBe(printed);
	});

	test("the layout: the address names it when it isn't the one the person last chose (FX-03)", () => {
		// The person last chose the grid: an address naming no layout shows the grid.
		expect(readView(null, "grid").layout).toBe("grid");
		expect(printView({ ...defaultView(), layout: "grid" }, "grid")).toBeNull();
		// A list asked for by the address wins over the grid remembered, and reads back.
		const printed = printView({ ...defaultView(), layout: "list" }, "grid");
		expect(printed).toBe("view=list");
		expect(readView(printed, "grid").layout).toBe("list");
	});

	test("a view leaves out what it doesn't know, and a language goes only with a file", () => {
		expect(readView("kind=spreadsheet&view=table&file=not-an-id&language=../x&q=")).toEqual(defaultView());
		expect(printView({ ...defaultView(), language: "it" })).toBeNull();
	});

	test("another part of the library keeps the search, kind and layout, not the open file; the Trash only the layout", () => {
		const view = { q: "loaf", kind: "image" as const, layout: "grid" as const, file: FILE, language: "it" };
		expect(viewFor({ kind: "unfiled" }, view)).toEqual({ ...view, file: null, language: null });
		expect(viewFor({ kind: "trash" }, view)).toEqual({ ...defaultView(), layout: "grid" });
	});

	test("each part asks `media.list` for its files", () => {
		const view = { ...defaultView(), q: " rye ", kind: "image" as const };
		expect(listQuery({ kind: "all" }, view)).toEqual({ search: "rye", kind: "image" });
		expect(listQuery({ kind: "unfiled" }, defaultView())).toEqual({
			folderId: "none",
			search: undefined,
			kind: undefined,
		});
		expect(listQuery({ kind: "folder", folderId: FOLDER }, defaultView())).toMatchObject({ folderId: FOLDER });
		expect(listQuery({ kind: "trash" }, defaultView())).toMatchObject({ trash: true });
	});
});
