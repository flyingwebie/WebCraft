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

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let domains = 0;

beforeAll(async () => {
	install = await createTestInstall();
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "site-analytics", version: "1.0.0" });
	await admin.api.modules.approve({ moduleId: "forms", version: "1.0.0" });
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
	test("are counted for Goals by Form, once kept and never as spam, with nothing the visitor typed", async () => {
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
		expect(rows).toEqual([{ value: form.id, pageviews: 0, visitors: 0, visits: 0, events: 1 }]);
		expect(await install.tablesHolding("ada@example.org")).toEqual(["m_forms.submissions"]);
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
