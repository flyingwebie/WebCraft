// By Site, on a Workspace's Dashboard: one row for each Site Site analytics counts, by name, with its
// visitors, their change on the period before and its Form Submissions, the Site with most visitors
// first. It lists Sites, so a Site's own Dashboard never offers it.
import { afterAll, beforeAll, expect, test } from "bun:test";

import { analyticsVisitor, DESKTOP_CHROME, liveSite } from "../harness/analytics.ts";
import { formVisitor } from "../harness/forms.ts";
import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { rejection } from "../harness/settled.ts";

let install: TestInstall;
let staff: TestBrowser;
let domains = 0;

beforeAll(async () => {
	install = await createTestInstall({ now: new Date("2026-03-06T09:00:00Z") });
	const admin = await install.superadmin();
	await admin.api.modules.approve({ moduleId: "site-analytics", version: "1.2.0" });
	await admin.api.modules.approve({ moduleId: "forms", version: "1.4.0" });
});

afterAll(async () => {
	await install.close();
});

async function analyticsSite(workspaceId: string, name: string) {
	const site = await liveSite(install, staff, workspaceId, `by-site-${++domains}.example`, name);
	await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });
	return site;
}

/** A published Form on every page of the Site, sent once from its home page. */
async function sendAForm(siteId: string, origin: string) {
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
	const visitor = formVisitor(install, "203.0.113.60");
	const headers = { "user-agent": DESKTOP_CHROME };
	const page = await visitor.open(`${origin}/`, headers);
	await install.clock.advance(5000);
	expect((await visitor.send(page, { email: "someone@example.org" }, { headers })).status).toBe(303);
	expect((await install.drainJobs()).failed).toEqual([]);
}

const visit = (origin: string, address: string) => analyticsVisitor(install, origin, { address }).view("/");

test("lists each counted Site by name: visitors, their change and Form Submissions, most visitors first", async () => {
	const workspace = await install.createWorkspace("Acme Ltd");
	const { account, browser } = await install.createStaff({ workspaces: [workspace.id] });
	staff = browser;
	const north = await analyticsSite(workspace.id, "Acme North");
	const south = await analyticsSite(workspace.id, "Acme South");
	await install.createSite(workspace.id, { name: "Acme Archive" });

	// The week before: North had one visitor, South two.
	await visit(north.origin, "203.0.113.1");
	await visit(south.origin, "203.0.113.2");
	await visit(south.origin, "203.0.113.3");
	// This week: North two and a Form sent, South one.
	await install.clock.set(new Date("2026-03-13T09:00:00Z"));
	// A week on, Staff sign in again.
	staff = await install.signIn(account);
	await visit(north.origin, "198.51.100.1");
	await visit(north.origin, "198.51.100.2");
	await visit(south.origin, "198.51.100.3");
	await sendAForm(north.siteId, north.origin);

	const place = { workspaceId: workspace.id };
	const { dashboard } = await staff.api.dashboards.create({ ...place, name: "All shops" });
	await staff.api.dashboards.update({ ...place, dashboardId: dashboard.id, range: { preset: "last7Days" } });
	const { widgetId } = await staff.api.dashboards.widgets.add({
		...place,
		dashboardId: dashboard.id,
		kind: "site-analytics:by-site",
	});

	const { widget } = await staff.api.dashboards.widgets.data({ ...place, dashboardId: dashboard.id, widgetId });
	expect(widget).toMatchObject({
		title: "By Site",
		sites: { counted: 2, of: 3 },
		data: {
			shape: "table",
			columns: [
				{ key: "site", label: "Site", kind: "site" },
				{ key: "visitors", label: "Visitors", kind: "count" },
				{ key: "change", label: "Change", kind: "change" },
				{ key: "submissions", label: "Submissions", kind: "count" },
			],
			rows: [
				{
					key: north.siteId,
					cells: { site: "Acme North", visitors: 2, change: { count: 2, of: 1 }, submissions: 1 },
				},
				{
					key: south.siteId,
					cells: { site: "Acme South", visitors: 1, change: { count: 1, of: 2 }, submissions: 0 },
				},
			],
		},
	});

	// A Site's own Dashboard never offers it.
	const catalog = await staff.api.dashboards.catalog({ siteId: north.siteId });
	expect(catalog.kinds.map((kind) => kind.kind)).not.toContain("site-analytics:by-site");
	const workspaceCatalog = await staff.api.dashboards.catalog(place);
	expect(workspaceCatalog.kinds.map((kind) => kind.kind)).toContain("site-analytics:by-site");
	const onSite = await staff.api.dashboards.create({ siteId: north.siteId, name: "North" });
	expect(
		await rejection(
			staff.api.dashboards.widgets.add({
				siteId: north.siteId,
				dashboardId: onSite.dashboard.id,
				kind: "site-analytics:by-site",
			}),
		),
	).toMatchObject({ code: "DASHBOARD_INVALID" });
});
