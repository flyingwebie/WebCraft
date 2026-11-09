// Filtered pages in the page cache (GLOSSARY.md › Filter): each choice of a page's Filters is kept
// under its normal address (keys sorted, unknown parameters dropped), a Site keeps a limited number of
// them (past it they are answered without being kept), and a search is never kept.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, fromAddress, type TestInstall } from "../harness/index.ts";
import { buildShop, listed, type Shop } from "./shop.ts";

let install: TestInstall;
let shop: Shop;

beforeAll(async () => {
	install = await createTestInstall({ filterVariants: 3 });
	shop = await buildShop(install);
});

afterAll(async () => {
	await install.close();
});

const get = (path: string, address = "198.51.100.7") =>
	install.request(fromAddress(new Request(`${shop.origin}${path}`, { redirect: "manual" }), address));

describe("the page cache", () => {
	test("keeps a filtered page under its normal address: the same choices in any order find it", async () => {
		const first = await get("/shop?vegan=1&category=bread");
		expect(first.status).toBe(200);
		expect(first.headers.get("x-cache")).toBe("MISS");
		expect(first.headers.get("cache-control")).toBe("public, max-age=0, must-revalidate");

		for (const path of ["/shop?category=bread&vegan=1", "/shop?vegan=1&category=bread&utm_source=news"]) {
			const again = await get(path);
			expect(again.headers.get("x-cache"), path).toBe("HIT");
			expect(again.headers.get("etag"), path).toBe(first.headers.get("etag"));
		}
		expect(listed(await (await get("/shop?category=bread&vegan=1")).text())).toEqual(["Rosemary focaccia"]);
	});

	test("each page of a filtered Loop is kept on its own; a publish clears them all", async () => {
		await get("/shop?category=bread,pastries&page=2");
		expect((await get("/shop?category=bread,pastries&page=2")).headers.get("x-cache")).toBe("HIT");

		await shop.staff.api.filters.saveDraft({ siteId: shop.siteId, filterId: shop.filterId, mode: "submit" });
		await shop.staff.api.filters.publish({ siteId: shop.siteId, filterId: shop.filterId });
		const after = await get("/shop?category=bread,pastries&page=2");
		expect(after.headers.get("x-cache")).toBe("MISS");
		expect(await after.text()).toContain('data-wc-mode="submit"');
	});

	test("a Site keeps a limited number of filtered pages: past it they are answered and kept by nobody", async () => {
		// Since the publish above the Site keeps one variant (the second page asked for): two more fill it.
		for (const choice of ["category=bread", "category=pastries"]) {
			expect((await get(`/shop?${choice}`)).headers.get("x-cache")).toBe("MISS");
			expect((await get(`/shop?${choice}`)).headers.get("x-cache")).toBe("HIT");
		}
		const past = await get("/shop?vegan=1");
		expect(past.status).toBe(200);
		expect(past.headers.get("cache-control")).toBe("no-store");
		expect((await get("/shop?vegan=1")).headers.get("x-cache")).toBe("MISS");
		// The page without choices, and a page of its Loop, aren't variants: they are still kept.
		await get("/shop");
		expect((await get("/shop")).headers.get("x-cache")).toBe("HIT");
		await get("/shop?page=2");
		expect((await get("/shop?page=2")).headers.get("x-cache")).toBe("HIT");
	});

	test("a search is never kept, and counts as a search of the visitor's address", async () => {
		const address = "198.51.100.200";
		for (let n = 0; n < 30; n++) {
			const searched = await get("/shop?q=bread&category=bread", address);
			expect(searched.status).toBe(200);
			expect(searched.headers.get("cache-control")).toBe("no-store");
			expect(searched.headers.get("x-cache")).toBeNull();
		}
		const tooMany = await get("/shop?q=rye", address);
		expect(tooMany.status).toBe(429);
		expect(tooMany.headers.get("retry-after")).toBe("60");
		// Choices without a search are pages like any other.
		expect((await get("/shop?category=bread", address)).status).toBe(200);
	});
});
