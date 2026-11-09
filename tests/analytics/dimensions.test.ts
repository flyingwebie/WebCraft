// What Site analytics counts each page view and visit by (pages, sources, countries, devices,
// browsers, operating systems), what Goals will count (#103: Form Submissions besides link clicks and
// custom events), and what it never keeps: the visitor's address is used to work out the country
// and the day's id, and is held in no table and no log line.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
	analyticsApi,
	analyticsVisitor,
	DESKTOP_CHROME,
	dayOf,
	IPHONE_SAFARI,
	liveSite,
} from "../harness/analytics.ts";
import { formVisitor } from "../harness/forms.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { givePassword, stagingVisitor } from "../harness/staging.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let domains = 0;

beforeAll(async () => {
	install = await createTestInstall();
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "site-analytics", version: "1.0.0" });
	await admin.api.modules.approve({ moduleId: "forms", version: "1.1.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

const newSite = async () => {
	const site = await liveSite(install, staff, workspaceId, `dimension-${++domains}.example`);
	await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });
	return site;
};
type Dimension = Parameters<ReturnType<typeof analyticsApi>["stats"]["breakdown"]>[0]["dimension"];
const valuesOf = async (siteId: string, dimension: Dimension) =>
	(await analyticsApi(staff).stats.breakdown({ siteId, ...dayOf(install.clock.now()), dimension })).rows.map((row) => [
		row.value,
		row.pageviews,
	]);

describe("page views and visits are counted by", () => {
	test("page, country (from the address, unknown where the Install can't tell), device, browser and system", async () => {
		const site = await newSite();
		await analyticsVisitor(install, site.origin, { address: "203.0.113.1", userAgent: DESKTOP_CHROME }).view("/");
		await analyticsVisitor(install, site.origin, { address: "198.51.100.1", userAgent: IPHONE_SAFARI }).view("/menu");
		await analyticsVisitor(install, site.origin, { address: "2001:db8::7", userAgent: DESKTOP_CHROME }).view("/menu");
		await analyticsVisitor(install, site.origin, { address: "10.9.9.9", userAgent: IPHONE_SAFARI }).view("/menu", {
			w: 390,
		});

		expect(await valuesOf(site.siteId, "page")).toEqual([
			["/menu", 3],
			["/", 1],
		]);
		expect(await valuesOf(site.siteId, "country")).toEqual([
			["", 1],
			["DE", 1],
			["IE", 1],
			["IT", 1],
		]);
		expect(await valuesOf(site.siteId, "device")).toEqual([
			["desktop", 2],
			["mobile", 2],
		]);
		expect(await valuesOf(site.siteId, "browser")).toEqual([
			["Chrome", 2],
			["Safari", 2],
		]);
		expect(await valuesOf(site.siteId, "os")).toEqual([
			["iOS", 2],
			["macOS", 2],
		]);
	});

	test("source: a campaign's utm_source, else the referring site without www., else direct (empty)", async () => {
		const site = await newSite();
		const visitor = (address: string) => analyticsVisitor(install, site.origin, { address });
		await visitor("203.0.113.2").view("/", { r: "www.Search.Example" });
		await visitor("203.0.113.3").view("/", { r: "search.example", us: "Spring-Sale", um: "email", uc: "Spring" });
		await visitor("203.0.113.4").view("/");
		await visitor("203.0.113.4").view("/menu", { i: 1 });

		expect(await valuesOf(site.siteId, "source")).toEqual([
			["", 1],
			["search.example", 1],
			["spring-sale", 1],
		]);
	});
});

describe("Form Submissions", () => {
	/** A Site whose every page shows the Form `contact`; answers the Site and the Form's id. */
	const siteWithForm = async () => {
		const site = await newSite();
		const { form } = await staff.api.forms.create({ siteId: site.siteId, name: "Contact", key: "contact" });
		await staff.api.forms.saveDraft({
			siteId: site.siteId,
			formId: form.id,
			form: {
				fields: [{ key: "email", type: "email", label: "Email", required: true }],
				success: { kind: "message", message: "Thanks!" },
			},
		});
		await staff.api.forms.publish({ siteId: site.siteId, formId: form.id });
		const saved = await staff.api.templates.saveSiteTemplateMarkup({
			siteId: site.siteId,
			markup: "<main>{{@outlet}}{{@form contact}}</main>",
		});
		await staff.api.templates.publish({ siteId: site.siteId, templateId: saved.template.id });
		return { ...site, formId: form.id };
	};
	/** Sends the Form on the home page at `origin`, from `address`, with `headers`; answers its status. */
	const sendForm = async (origin: string, address: string, headers: Record<string, string> = {}) => {
		const visitor = formVisitor(install, address);
		const page = await visitor.open(`${origin}/`, headers.cookie ? { cookie: headers.cookie } : {});
		await install.clock.advance(5000);
		return (await visitor.send(page, { email: `${address}@example.org` }, { headers })).status;
	};
	const formEvents = async (siteId: string) => {
		expect((await install.drainJobs()).failed).toEqual([]);
		const { rows } = await analyticsApi(staff).stats.breakdown({
			siteId,
			...dayOf(install.clock.now()),
			dimension: "form",
		});
		return rows.reduce((total, row) => total + row.events, 0);
	};

	test("are counted for Goals by Form, once kept and never as spam, with nothing the visitor typed", async () => {
		const site = await siteWithForm();
		const visitor = formVisitor(install, "203.0.113.5");
		const page = await visitor.open(`${site.origin}/`);
		await install.clock.advance(5000);

		expect((await visitor.send(page, { email: "ada@example.org" })).status).toBe(303);
		await visitor.send(page, { email: "spam@example.org", "wc-website": "https://spam.example" });
		expect((await install.drainJobs()).failed).toEqual([]);

		const rows = (
			await analyticsApi(staff).stats.breakdown({
				siteId: site.siteId,
				...dayOf(install.clock.now()),
				dimension: "form",
			})
		).rows;
		expect(rows).toEqual([{ value: site.formId, pageviews: 0, visitors: 0, visits: 0, events: 1 }]);
		expect(await install.tablesHolding("ada@example.org")).toEqual(["m_forms.submissions"]);
	});

	test("are counted only once the visitor accepted Analytics, and never with Do Not Track or Global Privacy Control", async () => {
		const site = await siteWithForm();
		await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "optIn", layout: "bar" });
		const accepted = analyticsVisitor(install, site.origin, { address: "203.0.113.21" });
		await accepted.answer({ analytics: true });
		const declined = analyticsVisitor(install, site.origin, { address: "203.0.113.22" });
		await declined.answer({ analytics: false });
		const cookieOf = (visitor: typeof accepted) =>
			[...visitor.cookies].map(([name, value]) => `${name}=${value}`).join("; ");

		expect(await sendForm(site.origin, "203.0.113.20")).toBe(303);
		expect(await sendForm(site.origin, "203.0.113.22", { cookie: cookieOf(declined) })).toBe(303);
		expect(await sendForm(site.origin, "203.0.113.21", { cookie: cookieOf(accepted), dnt: "1" })).toBe(303);
		expect(await sendForm(site.origin, "203.0.113.21", { cookie: cookieOf(accepted), "sec-gpc": "1" })).toBe(303);
		expect(await formEvents(site.siteId)).toBe(0);

		expect(await sendForm(site.origin, "203.0.113.21", { cookie: cookieOf(accepted) })).toBe(303);
		expect(await formEvents(site.siteId)).toBe(1);
	});

	test("are never counted from the Staging address or from someone signed in to the Install", async () => {
		const site = await siteWithForm();
		const signedIn = (await install.createStaff({ workspaces: [workspaceId] })).browser;

		// Someone the Staging address lets in with its password, who isn't signed in.
		const owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
		await owner.api.staging.setPassword({ siteId: site.siteId, password: "a review password" });
		const reviewer = stagingVisitor(install, new URL(site.staging).hostname.split(".")[0] ?? "");
		await givePassword(reviewer, "a review password");
		const cookie = `__Host-webcraft.staging-password=${reviewer.browser.cookies.get("__Host-webcraft.staging-password")}`;
		expect(await sendForm(site.staging, "203.0.113.31", { cookie })).toBe(303);
		expect(await sendForm(site.origin, signedIn.address ?? "")).toBe(303);
		expect(await formEvents(site.siteId)).toBe(0);

		expect(await sendForm(site.origin, "203.0.113.32")).toBe(303);
		expect(await formEvents(site.siteId)).toBe(1);
	});
});

describe("the visitor's address", () => {
	test("is held in no table and no log line, whatever was counted", async () => {
		const site = await newSite();
		await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "optIn", layout: "bar" });
		const address = "203.0.113.199";
		const visitor = analyticsVisitor(install, site.origin, { address });
		await visitor.view("/");
		await visitor.answer({ analytics: true });
		await visitor.view("/menu");
		await visitor.send({ t: "event", p: "/menu", n: "Ordered" });
		await install.clock.advance(2 * 60 * 60_000);
		expect((await install.drainJobs()).failed).toEqual([]);

		expect(
			(await analyticsApi(staff).stats.totals({ siteId: site.siteId, ...dayOf(install.clock.now()) })).totals,
		).toEqual({
			pageviews: 2,
			visitors: 1,
			visits: 1,
			events: 1,
		});
		expect(await install.tablesHolding(address)).toEqual([]);
		expect(JSON.stringify(install.logs)).not.toContain(address);
	});
});
