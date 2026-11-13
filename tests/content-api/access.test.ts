// Who reaches a Site's Content API, and how often: browsers on other sites only from the exact
// origins a key lists (CORS, with preflights), 120 requests a minute per client address and 600 per
// key (429 with Retry-After), each key counting its use per day; and the Staging address, which
// answers published content to a key without its sign-in.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ipv6Network } from "../harness/addresses.ts";
import { createTestInstall, fromAddress, type TestInstall } from "../harness/index.ts";
import { type Bakery, bakery, contentClient } from "./support.ts";

let install: TestInstall;
let site: Bakery;
let shopKey: string;
const SHOP = "https://shop.example.com";

beforeAll(async () => {
	install = await createTestInstall();
	site = await bakery(install, "bakery");
	await site.publish(site.recipesId, "Sourdough");
	shopKey = (
		await site.staff.api.contentApi.keys.create({
			siteId: site.siteId,
			name: "Shop",
			origins: ["https://Shop.Example.com/"],
		})
	).secret;
});

afterAll(async () => {
	await install.close();
});

/** A browser's preflight from a page at `origin`. */
function preflight(origin: string, path = "/entries/recipes"): Promise<Response> {
	return contentClient(install, site.origin, null).request(path, {
		method: "OPTIONS",
		headers: { origin, "access-control-request-method": "GET", "access-control-request-headers": "authorization" },
	});
}

describe("browsers on other sites (CORS)", () => {
	test("a preflight from an origin a working key lists is allowed: GET and HEAD with Authorization, kept 10 minutes", async () => {
		const response = await preflight(SHOP);

		expect(response.status).toBe(204);
		expect(response.headers.get("access-control-allow-origin")).toBe(SHOP);
		expect(response.headers.get("access-control-allow-methods")).toBe("GET, HEAD");
		expect(response.headers.get("access-control-allow-headers")).toBe("Authorization, If-None-Match");
		expect(response.headers.get("access-control-max-age")).toBe("600");
		expect(response.headers.get("vary")).toBe("Origin, Authorization");
	});

	test("a preflight from any other origin is refused, with nothing that lets the page read on", async () => {
		for (const origin of ["https://evil.example", "http://shop.example.com", "https://shop.example.com:8443", "null"]) {
			const response = await preflight(origin);
			expect(response.status).toBe(403);
			expect(response.headers.get("access-control-allow-origin")).toBeNull();
			expect(await response.json()).toMatchObject({ code: "ORIGIN_NOT_ALLOWED" });
		}
	});

	test("a request from a listed origin with that key is answered, readable by the page, ETag and limits included", async () => {
		const response = await contentClient(install, site.origin, shopKey).get("/entries/recipes", {
			headers: { origin: SHOP },
		});

		expect(response.status).toBe(200);
		expect(response.headers.get("access-control-allow-origin")).toBe(SHOP);
		expect(response.headers.get("access-control-expose-headers")).toContain("ETag");
		expect(response.headers.get("vary")).toBe("Origin, Authorization");
	});

	test("a key works from the origins it lists only, even where another key of the Site lists the page's origin", async () => {
		const response = await site.frontend().get("/entries/recipes", { headers: { origin: SHOP } });

		expect(response.status).toBe(403);
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		expect(await response.json()).toMatchObject({ code: "ORIGIN_NOT_ALLOWED", data: { origin: SHOP } });
	});

	test("servers (no Origin) and the Site's own pages are answered whatever a key lists", async () => {
		expect((await site.frontend().get("/entries/recipes")).status).toBe(200);
		const own = await site.frontend().get("/entries/recipes", { headers: { origin: site.origin } });
		expect(own.status).toBe(200);
		expect(own.headers.get("access-control-allow-origin")).toBe(site.origin);
	});

	test("origins are exact: saved in their normal form; a wildcard, a path or anything but http(s) is refused", async () => {
		const { key } = await site.staff.api.contentApi.keys.create({
			siteId: site.siteId,
			name: "Origins",
			origins: ["HTTPS://App.Example.org:443", "http://localhost:5173/", "https://app.example.org"],
		});
		expect(key.origins).toEqual(["https://app.example.org", "http://localhost:5173"]);

		const refusal = await site.staff.api.contentApi.keys
			.update({
				siteId: site.siteId,
				keyId: key.id,
				origins: [
					"https://*.example.org",
					"https://app.example.org/app",
					"ftp://files.example.org",
					"app.example.org",
					"*",
				],
			})
			.catch((error: { code: string; data: { problems: { at: string }[] } }) => error);
		expect(refusal).toMatchObject({ code: "CONTENT_API_INVALID" });
		expect((refusal as { data: { problems: { at: string }[] } }).data.problems.map((problem) => problem.at)).toEqual([
			"origins[0]",
			"origins[1]",
			"origins[2]",
			"origins[3]",
			"origins[4]",
		]);
	});

	test("a key's origins change at once", async () => {
		const { key, secret } = await site.staff.api.contentApi.keys.create({ siteId: site.siteId, name: "Moving" });
		const browser = () =>
			contentClient(install, site.origin, secret).get("/languages", { headers: { origin: "https://new.example" } });
		expect((await browser()).status).toBe(403);

		await site.staff.api.contentApi.keys.update({
			siteId: site.siteId,
			keyId: key.id,
			origins: ["https://new.example"],
		});

		expect((await browser()).status).toBe(200);
		expect((await preflight("https://new.example", "/languages")).status).toBe(204);
	});
});

describe("rate limits", () => {
	test("an IPv6 connection is counted by its /64, whichever of its addresses each request comes from", async () => {
		const network = ipv6Network();
		for (let count = 0; count < 120; count++) {
			expect((await site.frontend({ address: network(count + 1) }).get("/languages")).status).toBe(200);
		}

		const refused = await site.frontend({ address: network(121) }).get("/languages");

		expect(refused.status).toBe(429);
		expect(await refused.json()).toMatchObject({ code: "TOO_MANY_REQUESTS", data: { limit: "address" } });
		expect((await site.frontend({ address: ipv6Network()(1) }).get("/languages")).status).toBe(200);
		await install.clock.advance(60_000);
	});

	test("120 requests a minute per client address and Site, whatever the key; then 429 with Retry-After until the minute ends", async () => {
		const address = "203.0.113.120";
		const frontend = site.frontend({ address });
		for (let count = 0; count < 120; count++) {
			const response = await frontend.get("/languages");
			expect(response.status).toBe(200);
		}
		const refused = await frontend.get("/languages");
		expect(refused.status).toBe(429);
		expect(refused.headers.get("retry-after")).toBe("60");
		expect(await refused.json()).toMatchObject({ code: "TOO_MANY_REQUESTS", data: { limit: "address" } });
		// A request without a key counts against the address too, and is refused the same way.
		expect((await contentClient(install, site.origin, null, { address }).get("/languages")).status).toBe(429);
		expect((await site.frontend({ address: "203.0.113.121" }).get("/languages")).status).toBe(200);

		await install.clock.advance(60_000);
		expect((await frontend.get("/languages")).status).toBe(200);
	});

	test("600 requests a minute per key, from however many addresses", async () => {
		const { key, secret } = await site.staff.api.contentApi.keys.create({ siteId: site.siteId, name: "Busy" });
		for (let address = 0; address < 6; address++) {
			const frontend = contentClient(install, site.origin, secret, { address: `198.51.100.${address}` });
			for (let count = 0; count < 100; count++) expect((await frontend.get("/languages")).status).toBe(200);
		}
		const refused = await contentClient(install, site.origin, secret, { address: "198.51.100.50" }).get("/languages");
		expect(refused.status).toBe(429);
		expect(await refused.json()).toMatchObject({ data: { limit: "key" } });
		expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
		expect((await site.frontend({ address: "198.51.100.50" }).get("/languages")).status).toBe(200);
		expect(
			(await site.staff.api.contentApi.get({ siteId: site.siteId })).keys.find((found) => found.id === key.id)?.usage
				.today,
		).toBe(601);
	});

	test("every answer says where the limit closest to running out stands", async () => {
		const response = await site.frontend({ address: "203.0.113.77" }).get("/languages");

		expect(response.headers.get("ratelimit-limit")).toBe("120");
		expect(response.headers.get("ratelimit-remaining")).toBe("119");
		expect(Number(response.headers.get("ratelimit-reset"))).toBeGreaterThan(0);
	});
});

describe("usage", () => {
	test("each key counts its requests per day (UTC) and when it was last used, which Staff see", async () => {
		const { key, secret } = await site.staff.api.contentApi.keys.create({ siteId: site.siteId, name: "Counted" });
		const frontend = contentClient(install, site.origin, secret);
		for (let count = 0; count < 3; count++) await frontend.get("/entries/recipes");
		const usage = async () =>
			(await site.staff.api.contentApi.get({ siteId: site.siteId })).keys.find((found) => found.id === key.id);

		const today = await usage();
		expect(today?.usage).toMatchObject({ today: 3, last7Days: 3, last30Days: 3 });
		expect(today?.usage.days).toHaveLength(30);
		expect(today?.usage.days.at(-1)).toEqual({ day: install.clock.now().toISOString().slice(0, 10), requests: 3 });
		expect(today?.lastUsedAt).toEqual(install.clock.now());

		await install.clock.advance(24 * 60 * 60_000);
		await frontend.get("/entries/recipes");
		const tomorrow = await usage();
		expect(tomorrow?.usage).toMatchObject({ today: 1, last7Days: 4, last30Days: 4 });
		expect(tomorrow?.usage.days.slice(-2).map((day) => day.requests)).toEqual([3, 1]);
	});
});

describe("the Staging address", () => {
	test("answers the Content API to a key without its sign-in, with published content only (never Drafts), never indexed", async () => {
		await site.staff.api.entries.saveDraft({
			siteId: site.siteId,
			entryId: site.ids.Sourdough ?? "",
			title: "Sourdough (draft)",
		});
		const { entry } = await site.staff.api.entries.create({
			siteId: site.siteId,
			postTypeId: site.recipesId,
			title: "Unpublished",
		});
		const staging = contentClient(install, "https://bakery.sites.test", site.key);

		const { response, body } = await staging.json<{ items: { id: string; title: string; url: string }[] }>(
			"/entries/recipes",
		);
		expect(response.status).toBe(200);
		expect(response.headers.get("x-robots-tag")).toBe("noindex");
		expect(body.items.map((item) => item.title)).toEqual(["Sourdough"]);
		expect(body.items.map((item) => item.id)).not.toContain(entry.id);
		// Addresses are where visitors find the Site: its Primary domain.
		expect(body.items[0]?.url).toBe(`${site.origin}/recipes/sourdough`);
		const withoutKey = await contentClient(install, "https://bakery.sites.test", null).get("/entries/recipes");
		expect(withoutKey.status).toBe(401);
	});

	test("an unknown hostname is no Site's: the plain 404", async () => {
		const response = await install.request(
			fromAddress(new Request("https://nobody.example/_content/v1/languages"), "10.0.0.1"),
		);
		expect(response.status).toBe(404);
		expect(await response.text()).toBe("Not Found");
	});

	test("only GET, HEAD and OPTIONS are answered", async () => {
		const response = await site.frontend().get("/entries/recipes", { method: "POST" });
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
		expect(await response.json()).toMatchObject({ code: "METHOD_NOT_ALLOWED" });
	});
});
