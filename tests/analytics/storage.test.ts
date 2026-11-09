// How Site analytics keeps what it counts (ADR 0019): raw events in monthly partitions, made ahead
// of time and dropped once older than the Install keeps them (13 months unless the Superadmin sets
// otherwise); hourly and daily rollups, built by the hourly job and kept forever. One query interface
// answers from the rollups where they are built and from the raw events for the rest.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { analyticsApi, analyticsVisitor, dayOf, liveSite } from "../harness/analytics.ts";
import { createTestInstall, type TestAccount, type TestBrowser, type TestInstall } from "../harness/index.ts";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let install: TestInstall;
let workspaceId: string;
let staffAccount: TestAccount;
let domains = 0;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-03-02T09:00:00Z") });
	await (await install.superadmin()).api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staffAccount = (await install.createStaff({ workspaces: [workspaceId] })).account;
});

afterAll(async () => {
	await install.close();
});

/** Staff's browser, signed in again when the clock moved past their session. */
let staffBrowser: TestBrowser | undefined;
async function staff(): Promise<TestBrowser> {
	if (!staffBrowser || !(await staffBrowser.api.session.current()).person) {
		staffBrowser = await install.signIn(staffAccount);
	}
	return staffBrowser;
}

async function newSite() {
	const site = await liveSite(install, await staff(), workspaceId, `storage-${++domains}.example`);
	await (await staff()).api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });
	return site;
}

const stats = async () => analyticsApi(await staff()).stats;

/** The Module log's lines about partitions, as the Superadmin reads them: what happened to which month. */
async function partitionLines() {
	const { lines } = await (await install.superadmin()).api.modules.log({ moduleId: "site-analytics", limit: 200 });
	return lines
		.filter((line) => line.message.includes("partition"))
		.map((line) => `${line.message} ${(line.details as { month?: string }).month}`);
}

describe("rollups", () => {
	test("the hourly job builds hourly and daily rollups that answer like the raw events did", async () => {
		const site = await newSite();
		const day = dayOf(install.clock.now());
		const first = analyticsVisitor(install, site.origin, { address: "203.0.113.11" });
		const second = analyticsVisitor(install, site.origin, { address: "198.51.100.12" });
		await first.view("/", { r: "www.search.example" });
		await install.clock.advance(10 * 60_000);
		await first.view("/menu", { i: 1 });
		await install.clock.advance(HOUR);
		await second.view("/menu", { us: "Newsletter", um: "email" });
		const api = await stats();
		const live = {
			totals: await api.totals({ siteId: site.siteId, ...day }),
			hours: await api.series({ siteId: site.siteId, ...day, interval: "hour" }),
			sources: await api.breakdown({ siteId: site.siteId, ...day, dimension: "source" }),
		};
		expect(live.totals.totals).toEqual({ pageviews: 3, visitors: 2, visits: 2, events: 0 });
		// Sources count arrivals: the move from the home page to the menu has none.
		expect(live.sources.rows).toEqual([
			{ value: "newsletter", pageviews: 1, visitors: 1, visits: 1, events: 0 },
			{ value: "search.example", pageviews: 1, visitors: 1, visits: 1, events: 0 },
		]);
		expect(live.hours.points.filter((point) => point.pageviews > 0)).toEqual([
			{ start: new Date("2026-03-02T09:00:00Z"), pageviews: 2, visitors: 1, visits: 1, events: 0 },
			{ start: new Date("2026-03-02T10:00:00Z"), pageviews: 1, visitors: 1, visits: 1, events: 0 },
		]);

		await install.clock.set(new Date(day.to.getTime() + 8 * 60_000));
		expect((await install.drainJobs()).failed).toEqual([]);

		const built = (await (await stats()).coverage({ siteId: site.siteId })).rolledUp;
		expect(built).toEqual({ hours: new Date(day.to), days: new Date(day.to) });
		const after = await stats();
		expect(await after.totals({ siteId: site.siteId, ...day })).toEqual(live.totals);
		expect(await after.series({ siteId: site.siteId, ...day, interval: "hour" })).toEqual(live.hours);
		expect(await after.breakdown({ siteId: site.siteId, ...day, dimension: "source" })).toEqual(live.sources);
	});

	test("a range by day reads each day's rollup, and today's raw events", async () => {
		const site = await newSite();
		const visitor = analyticsVisitor(install, site.origin, { address: "203.0.113.13" });
		const yesterday = dayOf(install.clock.now());
		await visitor.view("/");
		await install.clock.set(new Date(yesterday.to.getTime() + 2 * HOUR + 8 * 60_000));
		await install.drainJobs();
		await visitor.view("/");
		await visitor.view("/about");

		const days = await (await stats()).series({
			siteId: site.siteId,
			from: yesterday.from,
			to: new Date(yesterday.to.getTime() + DAY),
			interval: "day",
		});

		expect(days.points).toEqual([
			{ start: yesterday.from, pageviews: 1, visitors: 1, visits: 1, events: 0 },
			{ start: yesterday.to, pageviews: 2, visitors: 1, visits: 1, events: 0 },
		]);
	});
});

describe("raw events", () => {
	test("are kept in monthly partitions, made ahead of time and dropped after 13 months, while rollups stay", async () => {
		const site = await newSite();
		const start = install.clock.now();
		const day = dayOf(start);
		await analyticsVisitor(install, site.origin, { address: "203.0.113.14" }).view("/");
		await install.clock.set(new Date(day.to.getTime() + 3 * HOUR));
		await install.drainJobs();
		const lines = await partitionLines();
		const month = (offset: number) => {
			const at = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1));
			return at.toISOString().slice(0, 7);
		};
		expect(lines).toContain(`Made a month's partition. ${month(1)}`);
		expect(lines).toContain(`Made a month's partition. ${month(2)}`);
		expect((await (await stats()).coverage({ siteId: site.siteId })).rawEventsFrom).toEqual(start);

		// Thirteen months on, part of the month is still that young: it stays.
		await install.clock.set(new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth() + 1, 1, 3)));
		await install.drainJobs();
		expect((await (await stats()).coverage({ siteId: site.siteId })).rawEventsFrom).toEqual(start);

		// Once all of it is older than 13 months, the month goes, raw events and all.
		await install.clock.set(new Date(Date.UTC(start.getUTCFullYear() + 1, start.getUTCMonth() + 2, 1, 3)));
		await install.drainJobs();
		expect(await partitionLines()).toContain(`Dropped a month's partition, past keeping. ${month(0)}`);
		const coverage = await (await stats()).coverage({ siteId: site.siteId });
		expect(coverage.rawEventsFrom).toBeNull();
		expect((await (await stats()).totals({ siteId: site.siteId, ...day })).totals).toEqual({
			pageviews: 1,
			visitors: 1,
			visits: 1,
			events: 0,
		});
	});

	test("the Superadmin sets how many months the Install keeps them", async () => {
		const keeping = async () =>
			(await (await install.superadmin()).api.modules.list()).modules.find((module) => module.id === "site-analytics")
				?.partitions;
		expect(await keeping()).toEqual([{ table: "events", label: "Raw events", keepMonths: 13, defaultMonths: 13 }]);

		await (await install.superadmin()).api.modules.setKeepMonths({
			moduleId: "site-analytics",
			table: "events",
			months: 2,
		});
		const site = await newSite();
		const start = install.clock.now();
		await analyticsVisitor(install, site.origin, { address: "203.0.113.15" }).view("/");
		await install.clock.set(new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 3, 1, 3)));
		await install.drainJobs();

		expect(await keeping()).toEqual([{ table: "events", label: "Raw events", keepMonths: 2, defaultMonths: 13 }]);
		expect((await (await stats()).coverage({ siteId: site.siteId })).rawEventsFrom).toBeNull();
		const admin = await install.superadmin();
		await expect(
			admin.api.modules.setKeepMonths({ moduleId: "site-analytics", table: "events", months: 0 }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		await expect(
			admin.api.modules.setKeepMonths({ moduleId: "site-analytics", table: "rollups", months: 2 }),
		).rejects.toMatchObject({ code: "MODULE_NOT_FOUND" });
		await expect(
			(await staff()).api.modules.setKeepMonths({ moduleId: "site-analytics", table: "events", months: 24 }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		const { entries } = await admin.api.audit.list({});
		expect(entries.find((entry) => entry.action === "module.changeKeep")?.details).toEqual({
			moduleId: "site-analytics",
			table: "events",
			from: 13,
			to: 2,
		});
	});
});
