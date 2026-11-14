// The building area's shell addresses (ADR 0037 › Addresses, BA-06): the document, then the shell's
// own parameters (the place, the selection), read and printed back the same, and never mixed up
// with a page's own query.
import { describe, expect, test } from "bun:test";

import {
	isPlace,
	printAddress,
	readAddress,
	type ShellAddress,
	sameDocument,
} from "../../apps/server/src/ui/building-area/documents.ts";

const POST_TYPE = "6f1c2d3e-4a5b-4c6d-8e7f-8091a2b3c4d5";
const ENTRY = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";

/** A shell address as `location` has it. */
function read(address: string): ShellAddress {
	const url = new URL(address, "https://bakery.example");
	return readAddress(url.pathname, url.search);
}

describe("shell addresses", () => {
	test("read every document, with the place and the selection, and print back the same", () => {
		for (const address of [
			"/_webcraft/build/page/",
			"/_webcraft/build/page/blog/fresh-bread",
			"/_webcraft/build/page/blog?page=2",
			"/_webcraft/build/site-template",
			"/_webcraft/build/search-template",
			`/_webcraft/build/entry-template/${POST_TYPE}`,
			`/_webcraft/build/entry-template/${POST_TYPE}?entry=${ENTRY}`,
			`/_webcraft/build/archive-template/${POST_TYPE}`,
			`/_webcraft/build/component/${ENTRY}`,
			`/_webcraft/build/form/${ENTRY}`,
			"/_webcraft/build/page/blog?page=2&wc-place=media",
			`/_webcraft/build/entry-template/${POST_TYPE}?entry=${ENTRY}&wc-place=styles%2Fclasses&wc-select=content%23abc`,
			"/_webcraft/build/site-template?wc-select=site%23header",
		]) {
			const shell = read(address);
			expect([address, shell.document === null]).toEqual([address, false]);
			expect(printAddress(shell)).toBe(address);
		}
	});

	test("keep a page's own query the page's, whatever names it uses", () => {
		expect(read("/_webcraft/build/page/search?q=rye&place=cork&select=1&wc-place=templates")).toEqual({
			document: { kind: "page", page: "/search?q=rye&place=cork&select=1" },
			place: "templates",
			select: null,
		});
	});

	test("name no document for anything else, and drop a place or selection they don't know", () => {
		for (const address of [
			"/_webcraft/build/elsewhere",
			"/_webcraft/build/page//evil.example",
			"/_webcraft/build/page/_webcraft/edit/api/state",
			"/_webcraft/build/component/nope",
			`/_webcraft/build/component/${ENTRY}/more`,
			`/_webcraft/build/archive-template/${POST_TYPE}?entry=${ENTRY}`,
			`/_webcraft/build/entry-template/${POST_TYPE}?entry=nope`,
			"/elsewhere",
		]) {
			expect([address, read(address).document]).toEqual([address, null]);
		}
		expect(read("/_webcraft/build/site-template?wc-place=attic&wc-select=%3Cscript%3E")).toMatchObject({
			place: null,
			select: null,
		});
	});

	test("know the places", () => {
		for (const place of [
			"content/pages",
			"content/post-types",
			`content/${POST_TYPE}`,
			"templates",
			"media",
			`media/${ENTRY}`,
			"styles/site-css",
			`loops/${ENTRY}`,
			"components",
			`forms/${ENTRY}/build`,
		]) {
			expect([place, isPlace(place)]).toEqual([place, true]);
		}
		for (const place of ["content", "styles/everything", "media/folder", "forms/x/build", "templates/"]) {
			expect([place, isPlace(place)]).toEqual([place, false]);
		}
	});

	test("an Entry template previewing another Entry is the same document", () => {
		const entryTemplate = (entryId: string | null) =>
			({ kind: "entryTemplate", postTypeId: POST_TYPE, entryId }) as const;
		expect(sameDocument(entryTemplate(null), entryTemplate(ENTRY))).toBe(true);
		expect(sameDocument({ kind: "page", page: "/" }, { kind: "page", page: "/menu" })).toBe(false);
		expect(sameDocument(null, null)).toBe(true);
	});
});
