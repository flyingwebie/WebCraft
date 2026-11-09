// The collection script as Sites serve it, run in a small stand-in for a browser page (the page,
// its links, the consent script's `webcraft.consent`, `navigator.sendBeacon`): what it sends before
// and after Analytics consent, and nothing at all for a browser asking not to be tracked. What it
// sends goes on to the Site, as a browser's beacon would.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { analyticsApi, analyticsVisitor, type CollectedEvent, dayOf, liveSite } from "../harness/analytics.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let site: { siteId: string; origin: string };
let code: string;

beforeAll(async () => {
	install = await createTestInstall();
	await (await install.superadmin()).api.modules.approve({ moduleId: "site-analytics", version: "1.0.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	site = await liveSite(install, staff, workspaceId, "script.example");
	const html = await (await install.request(`${site.origin}/`)).text();
	const src = /<script src="([^"]+)" defer data-wc-module="site-analytics">/.exec(html)?.[1];
	code = await (await install.request(`${site.origin}${src}`)).text();
});

afterAll(async () => {
	await install.close();
});

type Link = { href: string; download?: boolean };

/** A page running the script: what it sent, and ways to click, accept and track. */
function runPage(options: {
	url: string;
	referrer?: string;
	consent?: { mode: string; analytics: boolean } | null;
	doNotTrack?: boolean;
}) {
	const sent: CollectedEvent[] = [];
	const listeners = new Map<string, ((event: unknown) => void)[]>();
	const page = new URL(options.url);
	let accepted = options.consent?.analytics ?? false;
	const document = {
		referrer: options.referrer ?? "",
		cookie: "",
		addEventListener: (type: string, listener: (event: unknown) => void) =>
			listeners.set(type, [...(listeners.get(type) ?? []), listener]),
	};
	const window: Record<string, unknown> = {
		webcraft: options.consent
			? { consent: { mode: options.consent.mode, has: (category: string) => category === "analytics" && accepted } }
			: undefined,
	};
	const navigator = {
		doNotTrack: options.doNotTrack ? "1" : null,
		sendBeacon: (_url: string, body: string) => sent.push(JSON.parse(body)),
	};
	const location = { pathname: page.pathname, search: page.search, host: page.host };
	new Function("document", "window", "navigator", "location", "innerWidth", "setTimeout", code)(
		document,
		window,
		navigator,
		location,
		1280,
		(callback: () => void) => callback(),
	);
	const fire = (type: string, event: unknown) => {
		for (const listener of listeners.get(type) ?? []) listener(event);
	};
	return {
		sent,
		click(link: Link) {
			const url = new URL(link.href, page);
			const anchor = {
				href: url.href,
				protocol: url.protocol,
				host: url.host,
				origin: url.origin,
				pathname: url.pathname,
				hasAttribute: (name: string) => name === "download" && link.download === true,
			};
			fire("click", { target: { closest: () => anchor } });
		},
		accept() {
			accepted = true;
			document.cookie = "webcraft.consent=1";
			fire("webcraft:consent", {});
		},
		track: (name: string) => (window.webcraft as { analytics: { track(name: string): void } }).analytics.track(name),
	};
}

describe("the collection script", () => {
	test("sends one page view on load, with the arrival's source and the campaign, and nothing else before consent", () => {
		const page = runPage({
			url: "https://script.example/menu?utm_source=Newsletter&utm_medium=email&utm_campaign=spring&email=ada%40example.org",
			referrer: "https://www.search.example/results?q=bakery",
			consent: { mode: "optIn", analytics: false },
		});
		page.click({ href: "https://partner.example/offers?ref=1" });
		page.track("Booked a table");

		expect(page.sent).toEqual([
			{
				t: "pageview",
				p: "/menu",
				r: "www.search.example",
				i: 0,
				us: "Newsletter",
				um: "email",
				uc: "spring",
				w: 1280,
				c: 0,
			},
		]);
	});

	test("after consent: marks the visit's start, then sends link clicks by kind and custom events", () => {
		const page = runPage({
			url: "https://script.example/contact",
			referrer: "https://script.example/",
			consent: { mode: "optIn", analytics: false },
		});
		page.accept();
		page.click({ href: "https://partner.example/offers?ref=1" });
		page.click({ href: "/_media/abc-menu.pdf" });
		page.click({ href: "/files/price-list", download: true });
		page.click({ href: "tel:+353123456" });
		page.click({ href: "mailto:hello@bakery.example" });
		page.click({ href: "/about" });
		page.track("Booked a table");

		expect(page.sent.map(({ t, n, h, i, c }) => ({ t, n, h, i, c }))).toEqual([
			{ t: "pageview", n: undefined, h: undefined, i: 1, c: 0 },
			{ t: "consent", n: undefined, h: undefined, i: 1, c: 1 },
			{ t: "link", n: "outbound", h: "https://partner.example/offers", i: 1, c: 1 },
			{ t: "link", n: "download", h: "/_media/abc-menu.pdf", i: 1, c: 1 },
			{ t: "link", n: "download", h: "/files/price-list", i: 1, c: 1 },
			{ t: "link", n: "tel", h: "tel:+353123456", i: 1, c: 1 },
			{ t: "link", n: "mailto", h: "mailto:hello@bakery.example", i: 1, c: 1 },
			{ t: "event", n: "Booked a table", h: undefined, i: 1, c: 1 },
		]);
	});

	test("sends nothing for a browser sending Do Not Track", () => {
		const page = runPage({
			url: "https://script.example/",
			doNotTrack: true,
			consent: { mode: "none", analytics: true },
		});
		page.track("Booked a table");

		expect(page.sent).toEqual([]);
	});

	test("what it sends is counted by the Site", async () => {
		const page = runPage({ url: "https://script.example/", consent: { mode: "optIn", analytics: false } });
		const visitor = analyticsVisitor(install, site.origin, { address: "203.0.113.120" });
		await visitor.answer({ analytics: true });
		page.accept();
		page.track("Booked a table");

		for (const event of page.sent) expect((await visitor.send(event)).status).toBe(204);

		expect(
			(await analyticsApi(staff).stats.totals({ siteId: site.siteId, ...dayOf(install.clock.now()) })).totals,
		).toEqual({ pageviews: 1, visitors: 1, visits: 1, events: 1 });
	});
});
