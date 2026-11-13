// Goals (#103): what Staff count as a result on a Site, Structure kept by Site analytics. A Goal is a
// Form Submission, a page visit, a click on an outbound, download, phone or email link, or a custom
// event, counted from the events Site analytics already keeps, only after Analytics consent.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { analyticsApi, analyticsVisitor, DESKTOP_CHROME, dayOf, liveSite } from "../harness/analytics.ts";
import { formVisitor } from "../harness/forms.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let owner: TestBrowser;
let domains = 0;

beforeAll(async () => {
	install = await createTestInstall();
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
	await admin.api.modules.approve({ moduleId: "forms", version: "1.2.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
});

afterAll(async () => {
	await install.close();
});

const newSite = async () => {
	const site = await liveSite(install, staff, workspaceId, `goals-${++domains}.example`);
	await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });
	return site;
};

const goalsOf = (browser: TestBrowser) => analyticsApi(browser).goals;

/** A published Form `contact` on every page of the Site; answers its id. */
async function formOn(siteId: string): Promise<string> {
	const { form } = await staff.api.forms.create({ siteId, name: "Contact", key: "contact" });
	await staff.api.forms.saveDraft({
		siteId,
		formId: form.id,
		form: {
			fields: [{ key: "email", type: "email", label: "Email", required: true }],
			success: { kind: "message", message: "Thanks!" },
		},
	});
	await staff.api.forms.publish({ siteId, formId: form.id });
	const saved = await staff.api.templates.saveSiteTemplateMarkup({
		siteId,
		markup: "<main>{{@outlet}}{{@form contact}}</main>",
	});
	await staff.api.templates.publish({ siteId, templateId: saved.template.id });
	return form.id;
}

/** Sends the Form on the home page as the browser at `address` does (its user agent too). */
async function sendForm(origin: string, address: string, cookie?: string) {
	const visitor = formVisitor(install, address);
	const headers: Record<string, string> = { "user-agent": DESKTOP_CHROME, ...(cookie ? { cookie } : {}) };
	const page = await visitor.open(`${origin}/`, headers);
	await install.clock.advance(5000);
	const answer = await visitor.send(page, { email: `${address}@example.org` }, { headers });
	expect(answer.status).toBe(303);
	expect((await install.drainJobs()).failed).toEqual([]);
}

describe("Staff keep a Site's Goals", () => {
	test("of each kind, by name, each name once on the Site whatever its case", async () => {
		const { siteId } = await newSite();
		const formId = await formOn(siteId);
		const goals = goalsOf(staff);
		await goals.create({ siteId, name: "Signed up", definition: { kind: "event", event: "signup" } });
		await goals.create({ siteId, name: "Contact sent", definition: { kind: "form", formId } });
		await goals.create({ siteId, name: "Shop visit", definition: { kind: "page", path: "/shop", match: "prefix" } });
		await goals.create({
			siteId,
			name: "Brochure",
			definition: { kind: "link", link: "download", target: "*.pdf" },
		});

		const { goals: listed } = await goals.list({ siteId });
		expect(listed.map((goal) => [goal.name, goal.definition])).toEqual([
			["Brochure", { kind: "link", link: "download", target: "*.pdf" }],
			["Contact sent", { kind: "form", formId }],
			["Shop visit", { kind: "page", path: "/shop", match: "prefix" }],
			["Signed up", { kind: "event", event: "signup" }],
		]);
		await expect(
			goals.create({ siteId, name: "signed UP", definition: { kind: "event", event: "other" } }),
		).rejects.toMatchObject({ code: "MODULE_ERROR", data: { code: "GOAL_NAME_TAKEN" } });

		const shop = listed.find((goal) => goal.name === "Shop visit");
		const { goal } = await goals.update({ siteId, goalId: shop?.id ?? "", name: "Shop" });
		expect(goal).toMatchObject({ name: "Shop", definition: { kind: "page", path: "/shop", match: "prefix" } });
	});

	test("Owners see them and their counts, but only Staff change them (Structure)", async () => {
		const { siteId } = await newSite();
		await goalsOf(staff).create({ siteId, name: "Signed up", definition: { kind: "event", event: "signup" } });

		expect((await goalsOf(owner).list({ siteId })).goals.map((goal) => goal.name)).toEqual(["Signed up"]);
		await expect(
			goalsOf(owner).create({ siteId, name: "Mine", definition: { kind: "event", event: "mine" } }),
		).rejects.toMatchObject({ status: 403 });
	});

	test("are deleted in two steps, and never while a Funnel uses them", async () => {
		const { siteId } = await newSite();
		const goals = goalsOf(staff);
		const { goal } = await goals.create({ siteId, name: "Signed up", definition: { kind: "event", event: "signup" } });
		const funnels = analyticsApi(staff).funnels;
		const { funnel } = await funnels.create({
			siteId,
			name: "Sign-up",
			steps: [
				{ kind: "page", path: "/", match: "exact" },
				{ kind: "goal", goalId: goal.id },
			],
		});
		await expect(goals.delete({ siteId, goalId: goal.id })).rejects.toMatchObject({
			data: { code: "GOAL_IN_FUNNEL" },
		});
		await funnels.update({
			siteId,
			funnelId: funnel.id,
			steps: [
				{ kind: "page", path: "/", match: "exact" },
				{ kind: "page", path: "/thanks", match: "exact" },
			],
		});

		const asked = await goals.delete({ siteId, goalId: goal.id });
		expect(asked).toMatchObject({ deleted: false, preview: { name: "Signed up" } });
		expect((await goals.list({ siteId })).goals).toHaveLength(1);
		const confirmation = asked.deleted ? "" : asked.confirmation.id;
		expect(await goals.delete({ siteId, goalId: goal.id, confirmation })).toEqual({ deleted: true });
		expect((await goals.list({ siteId })).goals).toEqual([]);
	});
});

describe("a Goal counts", () => {
	test("what visitors who accepted Analytics did: pages, link clicks by target, custom events", async () => {
		const site = await newSite();
		const { siteId } = site;
		const goals = goalsOf(staff);
		await goals.create({ siteId, name: "Thanks page", definition: { kind: "page", path: "/thanks" } });
		await goals.create({ siteId, name: "Shop", definition: { kind: "page", path: "/shop/", match: "prefix" } });
		await goals.create({
			siteId,
			name: "Partner shop",
			definition: { kind: "link", link: "outbound", target: "https://*SHOP.example/*" },
		});
		await goals.create({ siteId, name: "Any download", definition: { kind: "link", link: "download" } });
		await goals.create({ siteId, name: "Signed up", definition: { kind: "event", event: "signup" } });

		const ada = analyticsVisitor(install, site.origin, { address: "203.0.113.41" });
		await ada.view("/");
		await ada.view("/thanks", { i: 1 });
		await ada.view("/thanks", { i: 1 });
		await ada.send({ t: "link", p: "/thanks", n: "outbound", h: "https://www.shop.example/cart" });
		await ada.send({ t: "link", p: "/thanks", n: "outbound", h: "https://elsewhere.example/" });
		const bo = analyticsVisitor(install, site.origin, { address: "198.51.100.42" });
		await bo.view("/shop");
		await bo.view("/shop/bread", { i: 1 });
		await bo.view("/shopping", { i: 1 });
		await bo.send({ t: "link", p: "/shop", n: "download", h: "/menu.pdf" });
		await bo.send({ t: "event", p: "/shop", n: "signup" });
		await analyticsVisitor(install, site.origin, { address: "192.0.2.43" }).view("/");

		const counted = await analyticsApi(staff).stats.goals({ siteId, ...dayOf(install.clock.now()) });

		expect(counted).toEqual({
			goals: [
				{ name: "Any download", kind: "link", conversions: 1, visitors: 1 },
				{ name: "Partner shop", kind: "link", conversions: 1, visitors: 1 },
				{ name: "Shop", kind: "page", conversions: 2, visitors: 1 },
				{ name: "Signed up", kind: "event", conversions: 1, visitors: 1 },
				{ name: "Thanks page", kind: "page", conversions: 2, visitors: 1 },
			],
			visitors: 3,
		});
	});

	test("nothing a visitor did before accepting Analytics", async () => {
		const site = await newSite();
		await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "optIn", layout: "bar" });
		await goalsOf(staff).create({ siteId: site.siteId, name: "Thanks", definition: { kind: "page", path: "/thanks" } });
		const visitor = analyticsVisitor(install, site.origin, { address: "203.0.113.44" });
		await visitor.view("/thanks");

		const api = analyticsApi(staff).stats;
		const day = dayOf(install.clock.now());
		expect((await api.totals({ siteId: site.siteId, ...day })).totals.pageviews).toBe(1);
		expect((await api.goals({ siteId: site.siteId, ...day })).goals).toEqual([
			{ name: "Thanks", kind: "page", conversions: 0, visitors: 0 },
		]);

		await visitor.answer({ analytics: true });
		await visitor.view("/thanks");
		expect((await api.goals({ siteId: site.siteId, ...day })).goals).toEqual([
			{ name: "Thanks", kind: "page", conversions: 1, visitors: 1 },
		]);
	});

	test("a Form's Submissions, linked to the visit of the visitor who sent it", async () => {
		const site = await newSite();
		const formId = await formOn(site.siteId);
		await goalsOf(staff).create({ siteId: site.siteId, name: "Contact sent", definition: { kind: "form", formId } });
		const visitor = analyticsVisitor(install, site.origin, { address: "203.0.113.45" });
		await visitor.view("/", { r: "search.example" });
		await sendForm(site.origin, "203.0.113.45");
		// Sent without a visit counted on the Site: the Goal counts it, with nobody to link it to.
		await sendForm(site.origin, "203.0.113.46");

		const day = dayOf(install.clock.now());
		expect((await analyticsApi(staff).stats.goals({ siteId: site.siteId, ...day })).goals).toEqual([
			{ name: "Contact sent", kind: "form", conversions: 2, visitors: 1 },
		]);
		// Linked to the visit, it counts where the visit came from.
		const fromSearch = await analyticsApi(staff).stats.goals({
			siteId: site.siteId,
			...day,
			filters: { source: "search.example" },
		});
		expect(fromSearch.goals).toEqual([{ name: "Contact sent", kind: "form", conversions: 1, visitors: 1 }]);
	});

	test("refuses a Goal the Site doesn't have", async () => {
		const { siteId } = await newSite();
		await expect(
			analyticsApi(staff).stats.goals({ siteId, ...dayOf(install.clock.now()), goals: ["Nope"] }),
		).rejects.toMatchObject({ data: { code: "GOAL_NOT_FOUND" } });
	});
});
