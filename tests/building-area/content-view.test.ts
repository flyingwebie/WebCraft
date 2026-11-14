// How the Content place shows a list (BA-20): its view (search, filters, sorting) read from and
// printed to the shell's address (`wc-view`, beside `wc-place`), the Entries it shows in its order,
// and the address a new Entry would have.
import { describe, expect, test } from "bun:test";

import { printAddress, readAddress } from "../../apps/server/src/ui/building-area/documents.ts";
import {
	type ListedEntry,
	newAddress,
	printView,
	readView,
	viewEntries,
} from "../../apps/server/src/ui/building-area/places/content/view.ts";

const POST_TYPE = "6f1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5";

function entry(title: string, change: Partial<ListedEntry> = {}): ListedEntry {
	return {
		title,
		slug: title.toLowerCase().replaceAll(" ", "-"),
		address: `/${title.toLowerCase().replaceAll(" ", "-")}`,
		status: "published",
		inReview: false,
		hiddenLanguages: [],
		author: "Davide",
		updatedAt: 0,
		...change,
	};
}

describe("a place's view in the shell's address", () => {
	test("goes with the place, after it, and reads back the same", () => {
		const address = `/_webcraft/build/page/menu?wc-place=content%2F${POST_TYPE}&wc-view=q%3Drye%26status%3Ddraft`;
		const url = new URL(address, "https://bakery.example");
		const shell = readAddress(url.pathname, url.search);

		expect(shell).toMatchObject({ place: `content/${POST_TYPE}`, view: "q=rye&status=draft" });
		expect(shell.document).toEqual({ kind: "page", page: "/menu" });
		expect(printAddress(shell)).toBe(address);
	});

	test("is dropped without a place, and is never the page's query", () => {
		const url = new URL("/_webcraft/build/page/menu?wc-view=q%3Drye", "https://bakery.example");
		const shell = readAddress(url.pathname, url.search);

		expect(shell.view ?? null).toBeNull();
		expect(shell.document).toEqual({ kind: "page", page: "/menu" });
		expect(printAddress({ ...shell, view: "q=rye" })).toBe("/_webcraft/build/page/menu");
	});

	test("the Globals and one Group of them are places; a Group key must be a Field's key", () => {
		for (const place of ["content/globals", "content/globals/openingHours"]) {
			const url = new URL(`/_webcraft/build/page/?wc-place=${encodeURIComponent(place)}`, "https://bakery.example");
			expect(readAddress(url.pathname, url.search).place).toBe(place);
		}
		const url = new URL("/_webcraft/build/page/?wc-place=content%2Fglobals%2FBad-key", "https://bakery.example");
		expect(readAddress(url.pathname, url.search).place).toBeNull();
	});
});

describe("a list's view", () => {
	test("prints only what differs from the default, and reads back the same", () => {
		expect(printView(readView(null, true), true)).toBeNull();
		const view = { q: "rye", status: "review" as const, language: "it", sort: "-title" as const };
		const printed = printView(view, false);

		expect(printed).toBe("q=rye&status=review&language=it&sort=-title");
		expect(readView(printed, false)).toEqual(view);
		// Pages go by address unless told, other Entries newest first.
		expect(readView(null, true).sort).toBe("address");
		expect(readView(null, false).sort).toBe("-updated");
	});

	test("leaves out what it doesn't know", () => {
		expect(readView("status=gone&sort=price&language=%3Cscript%3E&q=bread", false)).toEqual({
			q: "bread",
			status: null,
			language: null,
			sort: "-updated",
		});
	});

	test("filters by search, status and language, and sorts either way", () => {
		const entries = [
			entry("Rye loaf", { status: "draft", updatedAt: 3, author: "Marco" }),
			entry("Fresh bread", { updatedAt: 1, hiddenLanguages: ["it"] }),
			entry("Bread rolls", { status: "changed", inReview: true, updatedAt: 2 }),
		];
		const titles = (view: Parameters<typeof viewEntries>[1]) => viewEntries(entries, view, "en").map((e) => e.title);
		const base = readView(null, false);

		expect(titles(base)).toEqual(["Rye loaf", "Bread rolls", "Fresh bread"]);
		expect(titles({ ...base, sort: "title" })).toEqual(["Bread rolls", "Fresh bread", "Rye loaf"]);
		expect(titles({ ...base, sort: "-title" })).toEqual(["Rye loaf", "Fresh bread", "Bread rolls"]);
		expect(titles({ ...base, sort: "status" })).toEqual(["Rye loaf", "Bread rolls", "Fresh bread"]);
		expect(titles({ ...base, sort: "author" })).toEqual(["Fresh bread", "Bread rolls", "Rye loaf"]);
		expect(titles({ ...base, q: "BREAD" })).toEqual(["Bread rolls", "Fresh bread"]);
		expect(titles({ ...base, q: "/rye" })).toEqual(["Rye loaf"]);
		expect(titles({ ...base, status: "review" })).toEqual(["Bread rolls"]);
		expect(titles({ ...base, status: "draft" })).toEqual(["Rye loaf"]);
		expect(titles({ ...base, language: "it" })).toEqual(["Rye loaf", "Bread rolls"]);
	});
});

describe("a new Entry's address", () => {
	test("is its title as a slug, in the Post Type's URL pattern (a Page at the top level)", () => {
		expect(newAddress("Crème brûlée, 2 ways!", "/{path}", true)).toBe("/creme-brulee-2-ways");
		expect(newAddress("Spring menu", "/blog/{slug}", false)).toBe("/blog/spring-menu");
		expect(newAddress("!!!", "/blog/{slug}", false)).toBe("");
	});
});
