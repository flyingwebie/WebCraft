// Share links (#104): someone without an account explores a Dashboard through a link on the Install's
// Share link address (`share.<sites domain>`), never a Site's own domain. A link may have a password
// (kept as a hash) and an expiry, is revoked at once, is never indexed, and counts its opens with
// nothing about who opened it. Making one, or changing its password or expiry, is a Sensitive action.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { REPORT_PAGE_POLICY } from "@webcraft/core";

import { createTestInstall, fromAddress, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { reportedSite, views } from "./support.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let sites = 0;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-03-04T09:00:00Z") });
	await (await install.superadmin()).api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

const newSite = () => reportedSite(install, staff, workspaceId, `bakery-share-${++sites}.example`);

/** A visitor's request for a Share link's page, from an address of their own. */
function open(url: string, init: RequestInit = {}, address = "198.51.100.77") {
	return install.request(fromAddress(new Request(url, init), address));
}

/** A visitor's password, posted from the link's own page. */
function givePassword(url: string, password: string, headers: Record<string, string> = {}, address?: string) {
	return open(
		url,
		{
			method: "POST",
			headers: {
				"content-type": "application/x-www-form-urlencoded",
				origin: new URL(url).origin,
				"sec-fetch-site": "same-origin",
				...headers,
			},
			body: new URLSearchParams({ password }).toString(),
		},
		address,
	);
}

/** The cookie a password answer sets, as the browser sends it back. */
function cookieOf(answer: Response): string {
	return (answer.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
}

describe("a Share link", () => {
	test("opens the Dashboard on the Share link address to anyone holding it: never indexed, never kept, opens counted", async () => {
		const site = await newSite();
		await views(install, site.origin, 3);
		const { link, url } = await staff.api.shareLinks.create({
			siteId: site.siteId,
			dashboardId: site.dashboardId,
			name: "For the client",
		});
		expect(url).toMatch(/^https:\/\/share\.sites\.test\/[A-Za-z0-9_-]{43}$/);
		expect(link).toMatchObject({ name: "For the client", password: false, expiresAt: null, state: "active", opens: 0 });
		expect(url.endsWith(link.hint)).toBe(true);

		const answer = await open(url);
		expect(answer.status).toBe(200);
		expect(answer.headers.get("content-security-policy")).toBe(REPORT_PAGE_POLICY);
		expect(answer.headers.get("x-robots-tag")).toBe("noindex, nofollow");
		expect(answer.headers.get("cache-control")).toBe("private, no-store");
		expect(answer.headers.get("referrer-policy")).toBe("no-referrer");
		const html = await answer.text();
		expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
		expect(html).toContain("<h1>Overview</h1>");
		expect(html).toMatch(/<dt>Page views<\/dt><dd>3/);
		expect(html).not.toContain("<script");
		expect(html).toContain('<form class="explore" method="get">');

		// Exploring changes what it shows, and counts no open.
		const explored = await open(`${url}?range=yesterday&device=mobile`);
		expect(explored.status).toBe(200);
		expect(await explored.text()).toMatch(/<dt>Page views<\/dt><dd>0/);

		const { links } = await staff.api.shareLinks.list({ siteId: site.siteId, dashboardId: site.dashboardId });
		expect(links).toMatchObject([{ id: link.id, opens: 1, lastOpenedAt: new Date("2026-03-04T09:01:00Z") }]);
		// Nothing about who opened it is kept.
		expect(await install.tablesHolding("198.51.100.77")).toEqual([]);

		// Nothing can be changed from it, and the Site's own domain doesn't serve it.
		expect((await open(url, { method: "PUT" })).status).toBe(405);
		expect((await open(url.replace("https://share.sites.test", site.origin))).status).toBe(404);
		// Caddy may get a certificate for it.
		const asked = await install.request(install.adminUrl("/caddy/ask?domain=share.sites.test"));
		expect(asked.status).toBe(200);
	});

	test("with a password, shows only a form until the right password is given; a new password shuts out who it let in", async () => {
		const site = await newSite();
		await staff.api.dashboards.update({ siteId: site.siteId, dashboardId: site.dashboardId, name: "Secret figures" });
		const { url, link } = await staff.api.shareLinks.create({
			siteId: site.siteId,
			dashboardId: site.dashboardId,
			name: "Board",
			password: "the client's password",
		});
		expect(link.password).toBe(true);

		const locked = await open(url);
		expect(locked.status).toBe(401);
		const form = await locked.text();
		expect(form).toContain("This Dashboard is protected");
		expect(form).not.toContain("Secret figures");
		expect(form).not.toContain("Bakery");
		expect(
			(await staff.api.shareLinks.list({ siteId: site.siteId, dashboardId: site.dashboardId })).links[0]?.opens,
		).toBe(0);

		const wrong = await givePassword(url, "not the password");
		expect(wrong.status).toBe(403);
		expect(await wrong.text()).toContain("That isn't the password.");
		// Another site's page can't post it.
		expect(
			(
				await givePassword(url, "the client's password", {
					origin: "https://elsewhere.example",
					"sec-fetch-site": "cross-site",
				})
			).status,
		).toBe(403);

		// Its page sends no referrer, so browsers say `Origin: null`: their Sec-Fetch-Site says where it came from.
		expect((await givePassword(url, "not it either", { origin: "null" })).status).toBe(403);
		expect(await (await givePassword(url, "not it either", { origin: "null" })).text()).toContain("That isn't the password.");
		const forged = await open(url, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", origin: "null" },
			body: "password=guess",
		});
		expect(await forged.text()).toBe("Forbidden");

		const right = await givePassword(url, "the client's password");
		expect(right.status).toBe(303);
		expect(right.headers.get("location")).toBe(new URL(url).pathname);
		expect(right.headers.get("set-cookie")).toContain("HttpOnly");
		const cookie = cookieOf(right);
		const shown = await open(url, { headers: { cookie } });
		expect(shown.status).toBe(200);
		expect(await shown.text()).toContain("<h1>Secret figures</h1>");
		// The password is kept only as a hash.
		expect(await install.tablesHolding("the client's password")).toEqual([]);

		await staff.api.shareLinks.update({ siteId: site.siteId, shareLinkId: link.id, password: "a brand new password" });
		expect((await open(url, { headers: { cookie } })).status).toBe(401);
	});

	test("password guesses are limited per address and per link", async () => {
		const site = await newSite();
		const { url } = await staff.api.shareLinks.create({
			siteId: site.siteId,
			dashboardId: site.dashboardId,
			name: "Guessed",
			password: "the right password",
		});
		for (let tried = 0; tried < 10; tried++) {
			expect((await givePassword(url, `guess ${tried}`, {}, "198.51.100.20")).status).toBe(403);
		}
		const refused = await givePassword(url, "the right password", {}, "198.51.100.20");
		expect(refused.status).toBe(429);
		expect(await refused.text()).toContain("Too many tries.");
		// From many addresses, the link itself stops taking guesses after 50 an hour.
		for (let tried = 0; tried < 40; tried++) {
			await givePassword(url, `guess ${tried}`, {}, `198.51.100.${100 + tried}`);
		}
		expect((await givePassword(url, "the right password", {}, "198.51.100.200")).status).toBe(429);
	});

	test("stops working once it expires or is revoked, and says no more than that", async () => {
		const site = await newSite();
		const expiring = await staff.api.shareLinks.create({
			siteId: site.siteId,
			dashboardId: site.dashboardId,
			name: "Until tomorrow",
			expiresAt: new Date(install.clock.now().getTime() + 24 * 60 * 60 * 1000),
		});
		const revoked = await staff.api.shareLinks.create({
			siteId: site.siteId,
			dashboardId: site.dashboardId,
			name: "Wrong one",
		});
		expect((await open(expiring.url)).status).toBe(200);

		await staff.api.shareLinks.revoke({ siteId: site.siteId, shareLinkId: revoked.link.id });
		const gone = await open(revoked.url);
		expect(gone.status).toBe(404);
		expect(await gone.text()).toContain("This link doesn't work");
		await install.clock.advance(25 * 60 * 60 * 1000);
		expect((await open(expiring.url)).status).toBe(404);
		expect((await open(`https://share.sites.test/${"x".repeat(43)}`)).status).toBe(404);

		const fresh = await install.signIn((await install.createStaff({ workspaces: [workspaceId] })).account);
		const { links } = await fresh.api.shareLinks.list({ siteId: site.siteId, dashboardId: site.dashboardId });
		expect(links.map((each) => [each.name, each.state])).toEqual([
			["Until tomorrow", "expired"],
			["Wrong one", "revoked"],
		]);
		await expect(
			fresh.api.shareLinks.create({
				siteId: site.siteId,
				dashboardId: site.dashboardId,
				name: "Yesterday",
				expiresAt: new Date("2026-03-01T00:00:00Z"),
			}),
		).rejects.toMatchObject({ code: "SHARE_LINK_INVALID", data: { field: "expiresAt" } });
	});

	test("Owners see a Dashboard's Share links but don't make them; Editors don't see them", async () => {
		const fresh = await install.signIn((await install.createStaff({ workspaces: [workspaceId] })).account);
		staff = fresh;
		const site = await newSite();
		await staff.api.shareLinks.create({ siteId: site.siteId, dashboardId: site.dashboardId, name: "Seen" });
		const owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
		const editor = (await install.createMember({ workspaceId, role: "editor" })).browser;

		expect(
			(await owner.api.shareLinks.list({ siteId: site.siteId, dashboardId: site.dashboardId })).links,
		).toHaveLength(1);
		await expect(
			owner.api.shareLinks.create({ siteId: site.siteId, dashboardId: site.dashboardId, name: "Mine" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			editor.api.shareLinks.list({ siteId: site.siteId, dashboardId: site.dashboardId }),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("of a Workspace Dashboard adds up the Workspace's Sites", async () => {
		const { dashboard } = await staff.api.dashboards.create({ workspaceId, name: "Every bakery" });
		await staff.api.dashboards.widgets.add({
			workspaceId,
			dashboardId: dashboard.id,
			kind: "site-analytics:totals",
			settings: { measures: ["pageviews"] },
		});
		const { url } = await staff.api.shareLinks.create({ workspaceId, dashboardId: dashboard.id, name: "Everything" });
		const html = await (await open(url)).text();
		const count = (await staff.api.sites.list({ workspaceId })).sites.length;
		expect(html).toContain(`Added up over ${count} of ${count} Sites.`);
		expect(html).toMatch(/<dt>Page views<\/dt><dd>3/);
	});

	test("no Site can take the Share link address's name", async () => {
		await expect(install.createSite(workspaceId, { slug: "share" })).rejects.toMatchObject({ code: "SLUG_INVALID" });
	});

	test("an address asking for too many pages is told to wait", async () => {
		const unknown = `https://share.sites.test/${"y".repeat(43)}`;
		for (let asked = 0; asked < 120; asked++) await open(unknown, {}, "198.51.100.250");
		expect((await open(unknown, {}, "198.51.100.250")).status).toBe(429);
	});
});

describe("without a sites domain", () => {
	test("there is nowhere to serve Share links", async () => {
		const bare = await createTestInstall({ sitesDomain: null });
		try {
			const workspace = await bare.createWorkspace();
			const site = await bare.createSite(workspace.id);
			const superadmin = await bare.superadmin();
			const { dashboard } = await superadmin.api.dashboards.create({ siteId: site.id, name: "Overview" });
			await expect(
				superadmin.api.shareLinks.create({ siteId: site.id, dashboardId: dashboard.id, name: "Nowhere" }),
			).rejects.toMatchObject({ code: "SHARE_LINKS_UNAVAILABLE" });
		} finally {
			await bare.close();
		}
	});
});
