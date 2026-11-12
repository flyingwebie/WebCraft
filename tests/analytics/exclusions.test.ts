// What Site analytics leaves out: Edit mode, Staging addresses, anyone signed in to the Install
// (judged by WebCraft, never by the browser), programs (by user agent), a Site's excluded address
// ranges, and browsers sending Do Not Track or Global Privacy Control. Left out, an event still
// answers 204, so nobody learns what is counted. The collection path also takes posts only from the
// Site's own pages, refuses big bodies, and limits each address.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { ipv6Network } from "../harness/addresses.ts";
import { analyticsApi, analyticsVisitor, COLLECT_PATH, dayOf, liveSite } from "../harness/analytics.ts";
import { openEditMode } from "../harness/edit-mode.ts";
import { createTestInstall, fromAddress, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { expectSiteHeaders } from "../harness/site-safety.ts";
import { givePassword, stagingVisitor } from "../harness/staging.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let domains = 0;

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

const newSite = async () => {
	const site = await liveSite(install, staff, workspaceId, `exclude-${++domains}.example`);
	// Every visitor counts as one: the tests here are about what is left out, not about consent.
	await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });
	return site;
};
const totalsOf = async (siteId: string) =>
	(await analyticsApi(staff).stats.totals({ siteId, ...dayOf(install.clock.now()) })).totals;

describe("left out", () => {
	test("visits on the Staging address: nobody it doesn't know gets that far, and nobody it lets in is counted", async () => {
		const site = await newSite();
		expect((await analyticsVisitor(install, site.staging).view("/")).status).toBe(403);

		// Someone the Staging address lets in with its password, who isn't signed in.
		const owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
		await owner.api.staging.setPassword({ siteId: site.siteId, password: "a review password" });
		const reviewer = stagingVisitor(install, new URL(site.staging).hostname.split(".")[0] ?? "");
		await givePassword(reviewer, "a review password");
		const visitor = analyticsVisitor(install, site.staging);
		const name = "__Host-webcraft.staging-password";
		visitor.cookies.set(name, reviewer.browser.cookies.get(name) ?? "");
		const sent = await visitor.view("/");

		expect(sent.status).toBe(204);
		expect(sent.headers.get("x-robots-tag")).toBe("noindex");
		expect(await totalsOf(site.siteId)).toMatchObject({ pageviews: 0 });
	});

	test("anyone in Edit mode", async () => {
		const site = await newSite();
		const editing = await openEditMode(install, staff, site.siteId, "/");

		const sent = await editing.browser.request(
			new Request(`${site.origin}${COLLECT_PATH}`, {
				method: "POST",
				headers: { "content-type": "text/plain;charset=UTF-8", "user-agent": "Mozilla/5.0 Chrome/141.0" },
				body: JSON.stringify({ t: "pageview", p: "/" }),
			}),
		);

		expect(sent.status).toBe(204);
		expect(await totalsOf(site.siteId)).toMatchObject({ pageviews: 0 });
	});

	test("anyone signed in to the Install's admin, by their address, whatever their browser says", async () => {
		const site = await newSite();
		const signedIn = (await install.createStaff({ workspaces: [workspaceId] })).browser;
		const address = signedIn.address ?? "";

		await analyticsVisitor(install, site.origin, { address }).view("/");
		expect(await totalsOf(site.siteId)).toMatchObject({ pageviews: 0 });

		await signedIn.api.session.signOut();
		await analyticsVisitor(install, site.origin, { address }).view("/");
		expect(await totalsOf(site.siteId)).toMatchObject({ pageviews: 1 });
	});

	test("programs, by their user agent, and requests with none", async () => {
		const site = await newSite();
		const agents = [
			"Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
			"curl/8.7.1",
			"",
		];

		for (const userAgent of agents) {
			expect((await analyticsVisitor(install, site.origin, { userAgent }).view("/")).status).toBe(204);
		}

		expect(await totalsOf(site.siteId)).toMatchObject({ pageviews: 0 });
	});

	test("browsers sending Do Not Track or Global Privacy Control", async () => {
		const site = await newSite();
		const visitor = analyticsVisitor(install, site.origin);

		await visitor.send({ t: "pageview", p: "/" }, { headers: { dnt: "1" } });
		await visitor.send({ t: "pageview", p: "/" }, { headers: { "sec-gpc": "1" } });

		expect(await totalsOf(site.siteId)).toMatchObject({ pageviews: 0 });
	});

	test("the address ranges Staff exclude on a Site", async () => {
		const site = await newSite();
		const api = analyticsApi(staff).settings;

		await api.update({ siteId: site.siteId, excludedRanges: ["198.51.100.0/24", "2001:db8::1"] });
		await analyticsVisitor(install, site.origin, { address: "198.51.100.42" }).view("/");
		await analyticsVisitor(install, site.origin, { address: "2001:db8::1" }).view("/");
		await analyticsVisitor(install, site.origin, { address: "2001:db8::2" }).view("/");
		await analyticsVisitor(install, site.origin, { address: "203.0.113.42" }).view("/");

		expect(await totalsOf(site.siteId)).toMatchObject({ pageviews: 2 });
		expect(await api.get({ siteId: site.siteId })).toEqual({ excludedRanges: ["198.51.100.0/24", "2001:db8::1"] });
	});
});

describe("excluded address ranges", () => {
	test("are addresses or CIDR blocks", async () => {
		const site = await newSite();

		for (const range of ["203.0.113.0/33", "office", "203.0.113.256", "2001:db8::/129"]) {
			await expect(
				analyticsApi(staff).settings.update({ siteId: site.siteId, excludedRanges: [range] }),
			).rejects.toMatchObject({ code: "BAD_REQUEST" });
		}
	});

	test("are a Site setting for Staff, which Owners can't change", async () => {
		const site = await newSite();
		const owner = await install.createMember({ workspaceId, role: "owner" });

		await expect(
			analyticsApi(owner.browser).settings.update({ siteId: site.siteId, excludedRanges: ["203.0.113.0/24"] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			analyticsApi(owner.browser).stats.totals({ siteId: site.siteId, ...dayOf(install.clock.now()) }),
		).resolves.toBeDefined();
	});
});

describe("the collection path", () => {
	test("takes posts only from the Site's own pages", async () => {
		const site = await newSite();

		const sent = await analyticsVisitor(install, site.origin).send(
			{ t: "pageview", p: "/" },
			{ headers: { "sec-fetch-site": "cross-site" } },
		);

		expect(sent.status).toBe(403);
		expectSiteHeaders(sent);
		expect(await totalsOf(site.siteId)).toMatchObject({ pageviews: 0 });
	});

	test("refuses a body bigger than an event, and anything that isn't one", async () => {
		const site = await newSite();
		const visitor = analyticsVisitor(install, site.origin);

		const big = await visitor.send({ t: "pageview", p: `/${"a".repeat(5000)}` });
		const notOne = await visitor.send({ t: "purchase", p: "/" } as never);

		expect(big.status).toBe(413);
		expect(notOne.status).toBe(400);
		expect(await totalsOf(site.siteId)).toMatchObject({ pageviews: 0 });
	});

	test("limits an IPv6 connection by its /64, whichever of its addresses each event comes from", async () => {
		const site = await newSite();
		const network = ipv6Network();

		for (let sent = 0; sent < 120; sent++) {
			const visitor = analyticsVisitor(install, site.origin, { address: network(sent + 1) });
			expect((await visitor.view("/")).status).toBe(204);
		}

		expect((await analyticsVisitor(install, site.origin, { address: network(121) }).view("/")).status).toBe(429);
		expect((await analyticsVisitor(install, site.origin, { address: ipv6Network()(1) }).view("/")).status).toBe(204);
	});

	test("limits each address, with Retry-After, and never keeps the address for it", async () => {
		const site = await newSite();
		const visitor = analyticsVisitor(install, site.origin, { address: "192.0.2.77" });

		for (let sent = 0; sent < 120; sent++) expect((await visitor.view("/")).status).toBe(204);
		const refused = await visitor.view("/");
		const other = await analyticsVisitor(install, site.origin, { address: "192.0.2.78" }).view("/");

		expect(refused.status).toBe(429);
		expect(refused.headers.get("retry-after")).toBe("60");
		expect(other.status).toBe(204);
		expect(await totalsOf(site.siteId)).toMatchObject({ pageviews: 121 });
		await install.clock.advance(61_000);
		expect((await visitor.view("/")).status).toBe(204);
	});

	test("answers nowhere Site analytics is off", async () => {
		const site = await newSite();
		await staff.api.modules.setOnSite({ siteId: site.siteId, moduleId: "site-analytics", on: false });

		const sent = await install.request(
			fromAddress(
				new Request(`${site.origin}${COLLECT_PATH}`, {
					method: "POST",
					headers: { "sec-fetch-site": "same-origin", "user-agent": "Mozilla/5.0 Chrome/141.0" },
					body: JSON.stringify({ t: "pageview", p: "/" }),
				}),
				"203.0.113.9",
			),
		);

		expect(sent.status).toBe(404);
	});
});
