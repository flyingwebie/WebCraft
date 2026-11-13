// Funnels and filters (#103). A Funnel is two to five steps (Goals or page visits), counted per
// visitor within one day: how many reached each step, in order. Filters narrow any count to a page,
// a source, a country, a device, or the visitors who reached a Goal.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { analyticsApi, analyticsVisitor, dayOf, IPHONE_SAFARI, liveSite } from "../harness/analytics.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

const DAY = 24 * 60 * 60 * 1000;

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let domains = 0;

beforeAll(async () => {
	install = await createTestInstall();
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

const newSite = async () => {
	const site = await liveSite(install, staff, workspaceId, `funnels-${++domains}.example`);
	await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });
	return site;
};

describe("Funnels", () => {
	test("count the visitors reaching each step in order, each within one day", async () => {
		const site = await newSite();
		const { siteId } = site;
		const { goal } = await analyticsApi(staff).goals.create({
			siteId,
			name: "Signed up",
			definition: { kind: "event", event: "signup" },
		});
		const { funnel } = await analyticsApi(staff).funnels.create({
			siteId,
			name: "Sign-up",
			steps: [
				{ kind: "page", path: "/", match: "exact" },
				{ kind: "page", path: "/pricing", match: "exact" },
				{ kind: "goal", goalId: goal.id },
			],
		});
		expect(funnel.steps.map((step) => step.label)).toEqual(["/", "/pricing", "Signed up"]);
		const first = dayOf(install.clock.now());

		// The test clock stands still: each step comes a minute after the one before.
		const later = () => install.clock.advance(60_000);
		const all = analyticsVisitor(install, site.origin, { address: "203.0.113.51" });
		await all.view("/");
		await later();
		await all.view("/pricing", { i: 1 });
		await later();
		await all.send({ t: "event", p: "/pricing", n: "signup" });
		// Signing up before seeing the prices doesn't reach the last step.
		const early = analyticsVisitor(install, site.origin, { address: "203.0.113.52" });
		await early.view("/");
		await later();
		await early.send({ t: "event", p: "/", n: "signup" });
		await later();
		await early.view("/pricing", { i: 1 });
		// The prices before the home page: only the first step, reached at the home page.
		const backwards = analyticsVisitor(install, site.origin, { address: "203.0.113.53" });
		await backwards.view("/pricing");
		await later();
		await backwards.view("/", { i: 1 });
		// The next step on the next day is another day's visitor.
		const tomorrow = analyticsVisitor(install, site.origin, { address: "203.0.113.54" });
		await tomorrow.view("/");
		await install.clock.set(new Date(first.to.getTime() + 60 * 60 * 1000));
		await tomorrow.view("/pricing");

		const counted = await analyticsApi(staff).stats.funnel({
			siteId,
			from: first.from,
			to: new Date(first.to.getTime() + DAY),
			funnel: "sign-up",
		});

		expect(counted).toEqual({
			name: "Sign-up",
			steps: [
				{ label: "/", visitors: 4 },
				{ label: "/pricing", visitors: 2 },
				{ label: "Signed up", visitors: 1 },
			],
		});
	});

	test("a step reached after UTC midnight doesn't follow one reached before it: a day is a visitor's day", async () => {
		const site = await newSite();
		const { siteId } = site;
		await analyticsApi(staff).funnels.create({
			siteId,
			name: "Late",
			steps: [
				{ kind: "page", path: "/", match: "exact" },
				{ kind: "page", path: "/menu", match: "exact" },
			],
		});
		const day = dayOf(install.clock.now());
		const midnight = day.to;
		await install.clock.set(new Date(midnight.getTime() - 2 * 60_000));
		const owl = analyticsVisitor(install, site.origin, { address: "203.0.113.61" });
		await owl.view("/");
		await install.clock.set(new Date(midnight.getTime() + 3 * 60_000));
		await owl.view("/menu", { i: 1 });

		const counted = await analyticsApi(staff).stats.funnel({
			siteId,
			from: day.from,
			to: new Date(day.to.getTime() + DAY),
			funnel: "late",
		});

		expect(counted.steps).toEqual([
			{ label: "/", visitors: 1 },
			{ label: "/menu", visitors: 0 },
		]);
	});

	test("have two to five steps, names unique on the Site, and Goals the Site has", async () => {
		const { siteId } = await newSite();
		const funnels = analyticsApi(staff).funnels;
		const page = (path: string) => ({ kind: "page" as const, path, match: "exact" as const });
		await expect(funnels.create({ siteId, name: "One", steps: [page("/")] })).rejects.toMatchObject({ status: 400 });
		await expect(
			funnels.create({ siteId, name: "Six", steps: ["/1", "/2", "/3", "/4", "/5", "/6"].map(page) }),
		).rejects.toMatchObject({ status: 400 });
		await expect(
			funnels.create({
				siteId,
				name: "Ghost",
				steps: [page("/"), { kind: "goal", goalId: "00000000-0000-4000-8000-000000000000" }],
			}),
		).rejects.toMatchObject({ data: { code: "FUNNEL_STEP_INVALID" } });

		await funnels.create({ siteId, name: "Menu", steps: [page("/"), page("/menu")] });
		await expect(funnels.create({ siteId, name: "MENU", steps: [page("/"), page("/menu")] })).rejects.toMatchObject({
			data: { code: "FUNNEL_NAME_TAKEN" },
		});
		const { funnels: listed } = await funnels.list({ siteId });
		const asked = await funnels.delete({ siteId, funnelId: listed[0]?.id ?? "" });
		expect(asked).toMatchObject({ deleted: false, preview: { name: "Menu" } });
	});
});

describe("filters narrow counts", () => {
	test("to a page, a source, a country, a device, or the visitors who reached a Goal", async () => {
		const site = await newSite();
		const { siteId } = site;
		await analyticsApi(staff).goals.create({
			siteId,
			name: "Signed up",
			definition: { kind: "event", event: "signup" },
		});
		const fromSearch = analyticsVisitor(install, site.origin, { address: "203.0.113.61" });
		await fromSearch.view("/", { r: "www.search.example" });
		await fromSearch.view("/menu", { i: 1 });
		await fromSearch.send({ t: "event", p: "/menu", n: "signup" });
		await analyticsVisitor(install, site.origin, { address: "198.51.100.62", userAgent: IPHONE_SAFARI }).view(
			"/menu/bread",
			{ us: "Newsletter" },
		);
		await analyticsVisitor(install, site.origin, { address: "10.0.0.63" }).view("/");

		const stats = analyticsApi(staff).stats;
		const day = dayOf(install.clock.now());
		const totals = async (filters: Parameters<typeof stats.totals>[0]["filters"]) =>
			(await stats.totals({ siteId, ...day, filters })).totals;

		expect(await totals({})).toEqual({ pageviews: 4, visitors: 3, visits: 3, events: 1 });
		// A source counts the whole visit that came from it, not only its first page.
		expect(await totals({ source: "search.example" })).toEqual({ pageviews: 2, visitors: 1, visits: 1, events: 1 });
		expect(await totals({ source: "" })).toEqual({ pageviews: 1, visitors: 1, visits: 1, events: 0 });
		expect(await totals({ country: "it" })).toEqual({ pageviews: 1, visitors: 1, visits: 1, events: 0 });
		expect(await totals({ country: "" })).toEqual({ pageviews: 1, visitors: 1, visits: 1, events: 0 });
		expect(await totals({ device: "mobile" })).toEqual({ pageviews: 1, visitors: 1, visits: 1, events: 0 });
		expect(await totals({ page: { path: "/menu", match: "prefix" } })).toMatchObject({ pageviews: 2, visitors: 2 });
		expect(await totals({ page: { path: "/menu", match: "exact" } })).toMatchObject({ pageviews: 1, visitors: 1 });
		expect(await totals({ goal: "signed up" })).toEqual({ pageviews: 2, visitors: 1, visits: 1, events: 1 });
		expect(await totals({ country: "IE", device: "mobile" })).toEqual({
			pageviews: 0,
			visitors: 0,
			visits: 0,
			events: 0,
		});

		const pages = await stats.breakdown({ siteId, ...day, dimension: "page", filters: { country: "IE" } });
		expect(pages.rows.map((row) => [row.value, row.pageviews])).toEqual([
			["/", 1],
			["/menu", 1],
		]);
		const series = await stats.series({ siteId, ...day, interval: "day", filters: { device: "mobile" } });
		expect(series.points).toEqual([{ start: day.from, pageviews: 1, visitors: 1, visits: 1, events: 0 }]);
		await expect(totals({ goal: "Nope" })).rejects.toMatchObject({ data: { code: "GOAL_NOT_FOUND" } });
	});
});
