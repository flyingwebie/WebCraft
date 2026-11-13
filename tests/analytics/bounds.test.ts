// What anyone can make Site analytics keep is bounded: the collection path takes only values shaped
// like the ones its script sends (a path as a browser writes it, short campaign words without control
// characters), and a period keeps the biggest values of each dimension only (100 an hour, 500 a day),
// counting the rest together as `(other)`, so no flood of made-up paths or sources grows the rollups
// kept forever.
import { afterAll, beforeAll, expect, test } from "bun:test";

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

/** A live Site of its own counting every visitor (no Consent banner). */
async function newSite() {
	const site = await liveSite(install, await staff(), workspaceId, `bounds-${++domains}.example`);
	await (await staff()).api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });
	return site;
}

const stats = async () => analyticsApi(await staff()).stats;

/** Runs the hourly job. */
async function rollUp() {
	const { failed } = await install.drainJobs();
	expect(failed).toEqual([]);
}

test("the collection path refuses values its script never sends, and counts nothing of them", async () => {
	const site = await newSite();
	const visitor = analyticsVisitor(install, site.origin);
	const paths = [
		"/menu?utm_source=x",
		"/menu#top",
		"/me nu",
		"/menu\u0000",
		"/menu\\x",
		"//elsewhere.example/menu",
		"/<script>",
		`/${"a".repeat(600)}`,
	];
	for (const path of paths) expect({ path, status: (await visitor.view(path)).status }).toEqual({ path, status: 400 });
	expect((await visitor.view("/menu", { us: "x".repeat(150) })).status).toBe(400);
	expect((await visitor.view("/menu", { us: "news\u0007letter" })).status).toBe(400);
	expect((await visitor.view("/menu", { uc: "spring\nsale" })).status).toBe(400);
	expect((await visitor.send({ t: "event", p: "/menu", n: "sign\tup" })).status).toBe(400);
	expect(
		(await visitor.send({ t: "link", p: "/menu", n: "outbound", h: `https://x.example/${"a".repeat(600)}` })).status,
	).toBe(400);
	expect((await visitor.send({ t: "link", p: "/menu", n: "outbound", h: "https://x.example/a b" })).status).toBe(400);

	// What the script sends is counted as before: an encoded path, campaign words with spaces and accents.
	expect((await visitor.view("/caf%C3%A9/menu", { us: "Spring Sale 2026", um: "e-mail", uc: "été" })).status).toBe(204);
	expect((await visitor.send({ t: "event", p: "/caf%C3%A9/menu", i: 1, n: "Signed up (newsletter)" })).status).toBe(
		204,
	);

	const api = await stats();
	const day = dayOf(install.clock.now());
	expect((await api.totals({ siteId: site.siteId, ...day })).totals).toMatchObject({ pageviews: 1, events: 1 });
	expect(
		(await api.breakdown({ siteId: site.siteId, ...day, dimension: "page" })).rows.map((row) => row.value),
	).toEqual(["/caf%C3%A9/menu"]);
	expect(
		(await api.breakdown({ siteId: site.siteId, ...day, dimension: "source" })).rows.map((row) => row.value),
	).toEqual(["spring sale 2026"]);
});

test("an hour keeps its 100 biggest pages and a day its 500, the rest counted together", async () => {
	const site = await newSite();
	const start = install.clock.now();
	const hour = { from: start, to: new Date(start.getTime() + HOUR) };
	const day = dayOf(start);
	const person = analyticsVisitor(install, site.origin, { address: "203.0.113.20" });
	for (const [path, views] of [
		["/", 5],
		["/menu", 4],
		["/contact", 3],
	] as const) {
		for (let viewed = 0; viewed < views; viewed++) await person.view(path, { i: 1 });
	}
	// Five addresses each ask for 110 pages nobody else has seen, inside what one address may send a minute.
	for (let bot = 0; bot < 5; bot++) {
		const visitor = analyticsVisitor(install, site.origin, { address: `198.51.100.${30 + bot}` });
		for (let made = 0; made < 110; made++) {
			const path = `/made-up-${bot}-${String(made).padStart(3, "0")}`;
			expect((await visitor.view(path, { i: 1 })).status).toBe(204);
		}
	}
	const api = await stats();
	const everyPage = { siteId: site.siteId, dimension: "page", limit: 1000 } as const;

	// Before the hourly job, counted from the raw events: the same bound as a day's.
	const live = (await api.breakdown({ ...everyPage, ...day })).rows;
	expect(live).toHaveLength(501);
	expect(live.slice(0, 3).map((row) => [row.value, row.pageviews])).toEqual([
		["/", 5],
		["/menu", 4],
		["/contact", 3],
	]);
	expect(live.at(-1)).toEqual({ value: "(other)", pageviews: 53, visitors: 1, visits: 0, events: 0 });

	await install.clock.advance(HOUR);
	await rollUp();
	const hourly = (await api.breakdown({ ...everyPage, ...hour })).rows;
	expect(hourly).toHaveLength(101);
	expect(hourly.slice(0, 3).map((row) => row.value)).toEqual(["/", "/menu", "/contact"]);
	expect(hourly.at(-1)).toMatchObject({ value: "(other)", pageviews: 562 - 100 - 9 });
	// Nothing is lost from the totals, and a short list never shows the rest.
	expect((await api.totals({ siteId: site.siteId, ...hour })).totals.pageviews).toBe(562);
	expect((await api.breakdown({ ...everyPage, ...hour, limit: 3 })).rows.map((row) => row.value)).toEqual([
		"/",
		"/menu",
		"/contact",
	]);

	await install.clock.advance(DAY);
	await rollUp();
	const daily = (await (await stats()).breakdown({ ...everyPage, ...day })).rows;
	expect(daily).toHaveLength(501);
	expect(daily.at(-1)).toMatchObject({ value: "(other)", pageviews: 53 });
	expect(daily.reduce((sum, row) => sum + row.pageviews, 0)).toBe(562);
}, 120_000);

test("custom events and sources are bounded the same way", async () => {
	const site = await newSite();
	const start = install.clock.now();
	const hour = { from: start, to: new Date(start.getTime() + HOUR) };
	const visitor = analyticsVisitor(install, site.origin, { address: "203.0.113.40" });
	await visitor.view("/", { us: "newsletter" });
	// Events on a page the visitor reached from within the Site (`i`): they have no source.
	for (let sent = 0; sent < 3; sent++) await visitor.send({ t: "event", p: "/", i: 1, n: "Signed up" });
	for (let made = 0; made < 105; made++) {
		await visitor.send({ t: "event", p: "/", i: 1, n: `made-up-${String(made).padStart(3, "0")}` });
	}
	const arrivals = analyticsVisitor(install, site.origin, { address: "198.51.100.41" });
	for (let made = 0; made < 105; made++) {
		await arrivals.view("/", { us: `made-up-${String(made).padStart(3, "0")}` });
	}
	await install.clock.advance(HOUR);
	await rollUp();
	const api = await stats();

	const events = (await api.breakdown({ siteId: site.siteId, ...hour, dimension: "event", limit: 1000 })).rows;
	expect(events).toHaveLength(101);
	expect(events[0]).toMatchObject({ value: "Signed up", events: 3 });
	expect(events.at(-1)).toEqual({ value: "(other)", pageviews: 0, visitors: 1, visits: 0, events: 6 });

	const sources = (await api.breakdown({ siteId: site.siteId, ...hour, dimension: "source", limit: 1000 })).rows;
	expect(sources).toHaveLength(101);
	expect(sources.at(-1)).toMatchObject({ value: "(other)", pageviews: 6 });
	expect(sources.reduce((sum, row) => sum + row.pageviews, 0)).toBe(106);
}, 120_000);
