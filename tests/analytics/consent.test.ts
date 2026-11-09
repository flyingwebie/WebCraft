// What Site analytics counts before and after Analytics consent (ADR 0020): anonymous totals only
// (page views, sources, countries, devices) until the visitor accepts Analytics; then visitors and
// visits with a daily-salted id, and what Goals need (link clicks, custom events).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { analyticsApi, analyticsVisitor, dayOf, liveSite } from "../harness/analytics.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

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

const MINUTE = 60_000;
const newSite = () => liveSite(install, staff, workspaceId, `consent-${++domains}.example`);
const today = () => dayOf(install.clock.now());
const totalsOf = async (siteId: string, range = today()) =>
	(await analyticsApi(staff).stats.totals({ siteId, ...range })).totals;
const breakdownOf = async (
	siteId: string,
	dimension: Parameters<ReturnType<typeof analyticsApi>["stats"]["breakdown"]>[0]["dimension"],
) => (await analyticsApi(staff).stats.breakdown({ siteId, ...today(), dimension })).rows;

describe("with the Consent banner asking (Opt-in)", () => {
	test("a visitor who hasn't answered, or declined, is counted in page views only", async () => {
		const site = await newSite();
		const waiting = analyticsVisitor(install, site.origin, { address: "203.0.113.20" });
		const declined = analyticsVisitor(install, site.origin, { address: "203.0.113.21" });
		await declined.answer({ analytics: false, marketing: true, media: true });

		await waiting.view("/");
		await waiting.view("/menu");
		await declined.view("/");

		expect(await totalsOf(site.siteId)).toEqual({ pageviews: 3, visitors: 0, visits: 0, events: 0 });
	});

	test("once a visitor accepts Analytics, they count as a visitor, their pages within 30 minutes as one visit", async () => {
		const site = await newSite();
		const visitor = analyticsVisitor(install, site.origin, { address: "203.0.113.30" });
		await visitor.answer({ analytics: true });

		await visitor.view("/");
		await install.clock.advance(10 * MINUTE);
		await visitor.view("/menu");
		await install.clock.advance(29 * MINUTE);
		await visitor.view("/contact");
		expect(await totalsOf(site.siteId)).toEqual({ pageviews: 3, visitors: 1, visits: 1, events: 0 });

		await install.clock.advance(31 * MINUTE);
		await visitor.view("/");
		expect(await totalsOf(site.siteId)).toEqual({ pageviews: 4, visitors: 1, visits: 2, events: 0 });
	});

	test("visitors are told apart by their address and browser, and a new day gives everyone a new id", async () => {
		const site = await newSite();
		const first = analyticsVisitor(install, site.origin, { address: "203.0.113.40" });
		const second = analyticsVisitor(install, site.origin, { address: "203.0.113.41" });
		await first.answer({ analytics: true });
		await second.answer({ analytics: true });
		await install.clock.set(new Date("2026-03-02T22:00:00Z"));

		await first.view("/");
		await second.view("/");
		const firstDay = dayOf(install.clock.now());
		await install.clock.advance(3 * 60 * MINUTE);
		await first.view("/");

		expect(await totalsOf(site.siteId, firstDay)).toEqual({ pageviews: 2, visitors: 2, visits: 2, events: 0 });
		// A visitor's id changes at midnight (UTC): the next day they count again, with a visit of their own.
		const twoDays = { from: firstDay.from, to: new Date(firstDay.to.getTime() + 24 * 60 * MINUTE) };
		expect(await totalsOf(site.siteId, twoDays)).toEqual({ pageviews: 3, visitors: 3, visits: 3, events: 0 });
	});

	test("accepting on a page already counted starts the visit without counting the page again", async () => {
		const site = await newSite();
		const visitor = analyticsVisitor(install, site.origin, { address: "203.0.113.50" });
		await visitor.view("/");

		await visitor.answer({ analytics: true });
		await visitor.send({ t: "consent", p: "/", c: 1 });
		await visitor.send({ t: "consent", p: "/", c: 1 });

		expect(await totalsOf(site.siteId)).toEqual({ pageviews: 1, visitors: 1, visits: 1, events: 0 });
		expect(await breakdownOf(site.siteId, "page")).toEqual([
			{ value: "/", pageviews: 1, visitors: 1, visits: 1, events: 0 },
		]);
	});

	test("link clicks and custom events count only after consent", async () => {
		const site = await newSite();
		const visitor = analyticsVisitor(install, site.origin, { address: "203.0.113.60" });
		const clicks = async () => {
			await visitor.send({ t: "link", p: "/", n: "outbound", h: "https://partner.example/offers" });
			await visitor.send({ t: "link", p: "/", n: "download", h: "/_media/abc-menu.pdf" });
			await visitor.send({ t: "link", p: "/contact", n: "tel", h: "tel:+353123456" });
			await visitor.send({ t: "link", p: "/contact", n: "mailto", h: "mailto:hello@bakery.example" });
			await visitor.send({ t: "event", p: "/", n: "Booked a table" });
		};
		await clicks();
		expect(await totalsOf(site.siteId)).toEqual({ pageviews: 0, visitors: 0, visits: 0, events: 0 });

		await visitor.answer({ analytics: true });
		await clicks();

		expect(await totalsOf(site.siteId)).toMatchObject({ events: 5, visitors: 1 });
		expect(await breakdownOf(site.siteId, "outbound")).toEqual([
			{ value: "https://partner.example/offers", pageviews: 0, visitors: 1, visits: 0, events: 1 },
		]);
		expect((await breakdownOf(site.siteId, "download")).map((row) => row.value)).toEqual(["/_media/abc-menu.pdf"]);
		expect((await breakdownOf(site.siteId, "tel")).map((row) => row.value)).toEqual(["tel:+353123456"]);
		expect((await breakdownOf(site.siteId, "mailto")).map((row) => row.value)).toEqual(["mailto:hello@bakery.example"]);
		expect((await breakdownOf(site.siteId, "event")).map((row) => row.value)).toEqual(["Booked a table"]);
	});

	test("what the page says it saw doesn't count: only the visitor's answer on the banner does", async () => {
		const site = await newSite();
		const visitor = analyticsVisitor(install, site.origin, { address: "203.0.113.70" });

		await visitor.view("/", { c: 1 });
		await visitor.send({ t: "event", p: "/", n: "Signed up", c: 1 });

		expect(await totalsOf(site.siteId)).toEqual({ pageviews: 1, visitors: 0, visits: 0, events: 0 });
	});
});

describe("other ways of asking", () => {
	test("Opt-out: visitors count until they decline", async () => {
		const site = await newSite();
		await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "optOut", layout: "bar" });
		const counted = analyticsVisitor(install, site.origin, { address: "203.0.113.80" });
		const declined = analyticsVisitor(install, site.origin, { address: "203.0.113.81" });
		await declined.answer({ analytics: false });

		await counted.view("/");
		await declined.view("/");

		expect(await totalsOf(site.siteId)).toEqual({ pageviews: 2, visitors: 1, visits: 1, events: 0 });
	});

	test("No banner: every visitor counts", async () => {
		const site = await newSite();
		await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });

		await analyticsVisitor(install, site.origin, { address: "203.0.113.90" }).view("/");

		expect(await totalsOf(site.siteId)).toEqual({ pageviews: 1, visitors: 1, visits: 1, events: 0 });
	});

	test("an outside consent service: only the page can read its answer, so its word counts", async () => {
		const site = await newSite();
		await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "outside", layout: "bar" });

		await analyticsVisitor(install, site.origin, { address: "203.0.113.100" }).view("/", { c: 0 });
		await analyticsVisitor(install, site.origin, { address: "203.0.113.101" }).view("/", { c: 1 });

		expect(await totalsOf(site.siteId)).toEqual({ pageviews: 2, visitors: 1, visits: 1, events: 0 });
	});
});
