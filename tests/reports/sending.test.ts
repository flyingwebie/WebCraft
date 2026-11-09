// Reports (#104): a Dashboard sent as a PDF on its schedule, its period compared with the one before,
// to its recipients through the Site's own mail, in its language. The worker renders the PDF (here a
// fake that keeps the page's text; `chromium.test.ts` runs the real one) and the history keeps it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
	createTestInstall,
	TEST_PASSWORD,
	type TestAccount,
	type TestBrowser,
	type TestInstall,
} from "../harness/index.ts";
import { attachedReport, mailTo, reportedSite, runUntil, SITE_SERVER, views } from "./support.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;
let staffAccount: TestAccount;
/** Every Site with a Report, for the Workspace Dashboard that adds them up. */
const reported: { siteId: string; origin: string }[] = [];

beforeAll(async () => {
	// A Wednesday: the week of 2 March is under way.
	install = await createTestInstall({ now: new Date("2026-03-04T09:00:00Z") });
	await (await install.superadmin()).api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	const made = await install.createStaff({ workspaces: [workspaceId], email: "staff@agency.example" });
	staff = made.browser;
	staffAccount = made.account;
});

/** Staff, signed in again: sessions end after a week unused, and the clock moves by weeks here. */
async function staffNow(): Promise<TestBrowser> {
	staff = await install.signIn(staffAccount);
	return staff;
}

afterAll(async () => {
	await install.close();
});

describe("a weekly Report", () => {
	test("goes out on Monday morning with its PDF, through the Site's own mail, comparing the week with the one before", async () => {
		const site = await reportedSite(install, staff, workspaceId, "bakery-weekly.example");
		reported.push(site);
		await views(install, site.origin, 2);
		const { report } = await staff.api.reports.create({
			siteId: site.siteId,
			dashboardId: site.dashboardId,
			name: "Weekly results",
			schedule: "weekly",
			language: "en",
			recipients: ["Client@Bakery.example"],
			review: false,
			active: true,
		});
		expect(report).toMatchObject({
			name: "Weekly results",
			schedule: "weekly",
			recipients: ["client@bakery.example"],
			nextRunAt: new Date("2026-03-09T06:00:00Z"),
		});

		// Nothing goes out before its time.
		await runUntil(install, "2026-03-09T05:59:00Z");
		expect(mailTo(install, "client@bakery.example")).toEqual([]);

		await runUntil(install, "2026-03-09T06:00:30Z");
		const [email] = mailTo(install, "client@bakery.example");
		expect(email).toMatchObject({
			subject: "Weekly results: 2 March 2026 – 8 March 2026",
			from: { name: "Bakery", address: SITE_SERVER.fromAddress },
			smtp: { host: SITE_SERVER.host },
		});
		const pdf = attachedReport(email);
		expect(pdf.filename).toBe("weekly-results-2026-03-02-2026-03-08.pdf");
		expect(pdf.contentType).toBe("application/pdf");
		expect(pdf.text).toContain("Report for Bakery");
		expect(pdf.text).toContain("Compared with 23 February 2026 – 1 March 2026");
		expect(pdf.text).toContain("Page views 2 None the period before");
		expect(pdf.text).toContain("This Report has no AI text: the Workspace has no AI key.");

		const { sends } = await staff.api.reports.history({ siteId: site.siteId, reportId: report.id });
		expect(sends).toMatchObject([
			{
				kind: "scheduled",
				status: "sent",
				period: { from: new Date("2026-03-02T00:00:00Z"), to: new Date("2026-03-09T00:00:00Z") },
				recipients: [{ address: "client@bakery.example", status: "sent" }],
				ai: "noKey",
			},
		]);
		expect(sends[0]?.pdf?.bytes).toBeGreaterThan(0);

		// A week later, the next one compares with this one.
		await views(install, site.origin, 3);
		await runUntil(install, "2026-03-16T06:00:30Z");
		const next = attachedReport(mailTo(install, "client@bakery.example")[1]);
		expect(next.text).toContain("Page views 3 ▲ Up 50% on the period before (2)");
	});
});

describe("a test, Owners and the history", () => {
	test("Send a test to me makes the Report now, for the last whole week, and sends it to the person alone", async () => {
		await staffNow();
		const site = await reportedSite(install, staff, workspaceId, "bakery-test.example");
		reported.push(site);
		const { report } = await staff.api.reports.create({
			siteId: site.siteId,
			dashboardId: site.dashboardId,
			name: "Weekly results",
			schedule: "weekly",
			language: "en",
			recipients: ["owner@bakery.example"],
			review: true,
			active: true,
		});

		const { send } = await staff.api.reports.sendTest({ siteId: site.siteId, reportId: report.id });
		expect(send).toMatchObject({ kind: "test", status: "preparing" });
		await install.drainJobs();

		const [email] = mailTo(install, "staff@agency.example");
		expect(email?.subject).toBe("Weekly results: 9 March 2026 – 15 March 2026");
		expect(email?.text).toContain("This is a test: only you were sent it.");
		expect(attachedReport(email).text).toContain("Report for Bakery");
		expect(mailTo(install, "owner@bakery.example")).toEqual([]);
		const { sends } = await staff.api.reports.history({ siteId: site.siteId, reportId: report.id });
		expect(sends).toMatchObject([
			{ kind: "test", status: "sent", recipients: [{ address: "staff@agency.example", status: "sent" }] },
		]);
	});

	test("Owners see Reports and their history and change who they go to, and nothing else; Editors see none", async () => {
		await staffNow();
		const site = reported[1] as { siteId: string };
		const owner = (await install.createMember({ workspaceId, role: "owner", email: "owner@acme.example" })).browser;
		const editor = (await install.createMember({ workspaceId, role: "editor" })).browser;
		const dashboardId = (await staff.api.dashboards.list({ siteId: site.siteId })).dashboards[0]?.id as string;
		const [report] = (await owner.api.reports.list({ siteId: site.siteId, dashboardId })).reports;

		const changed = await owner.api.reports.setRecipients({
			siteId: site.siteId,
			reportId: report?.id as string,
			recipients: ["owner@bakery.example", "Manager@Bakery.example", "manager@bakery.example"],
		});
		expect(changed.report.recipients).toEqual(["owner@bakery.example", "manager@bakery.example"]);
		await expect(
			owner.api.reports.setRecipients({
				siteId: site.siteId,
				reportId: report?.id as string,
				recipients: ["not an address"],
			}),
		).rejects.toMatchObject({ code: "REPORT_INVALID", data: { field: "recipients" } });
		await expect(
			owner.api.reports.update({ siteId: site.siteId, reportId: report?.id as string, schedule: "monthly" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		await expect(
			owner.api.reports.sendTest({ siteId: site.siteId, reportId: report?.id as string }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(
			(await owner.api.reports.history({ siteId: site.siteId, reportId: report?.id as string })).sends,
		).toHaveLength(1);
		await expect(editor.api.reports.list({ siteId: site.siteId, dashboardId })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});

		const superadmin = await install.superadmin();
		const { entries } = await superadmin.api.audit.list({ limit: 20 });
		expect(entries.find((entry) => entry.action === "reportRecipients.change")).toMatchObject({
			details: { reportId: report?.id, added: ["manager@bakery.example"], removed: [] },
		});
	});
});

describe("making the PDF", () => {
	test("a PDF that can't be made is tried again, then recorded as failed, and nothing is sent without it; Resend makes it again", async () => {
		await staffNow();
		const site = await reportedSite(install, staff, workspaceId, "bakery-render.example");
		reported.push(site);
		const { report } = await staff.api.reports.create({
			siteId: site.siteId,
			dashboardId: site.dashboardId,
			name: "Weekly results",
			schedule: "weekly",
			language: "en",
			recipients: ["render@bakery.example"],
			review: false,
			active: true,
		});
		install.pdf.fail("timeout");

		await runUntil(install, "2026-03-23T06:00:30Z");
		await runUntil(install, "2026-03-23T06:03:00Z");
		await staffNow();
		const tried = (await staff.api.reports.history({ siteId: site.siteId, reportId: report.id })).sends;
		expect(tried).toMatchObject([{ status: "rendering", problem: "Its PDF couldn't be made (timeout)." }]);
		await runUntil(install, "2026-03-23T06:08:00Z");

		expect(install.pdf.rendered.length).toBeGreaterThanOrEqual(3);
		expect(mailTo(install, "render@bakery.example")).toEqual([]);
		const [failed] = (await staff.api.reports.history({ siteId: site.siteId, reportId: report.id })).sends;
		expect(failed).toMatchObject({ status: "failed", problem: "Its PDF couldn't be made (timeout).", pdf: null });
		await expect(
			staff.api.reports.sends.pdf({ siteId: site.siteId, sendId: failed?.id as string }),
		).rejects.toMatchObject({ code: "REPORT_SEND_REFUSED", data: { reason: "noPdf" } });

		install.pdf.work();
		await staff.api.reports.sends.resend({ siteId: site.siteId, sendId: failed?.id as string });
		await install.drainJobs();
		expect(mailTo(install, "render@bakery.example")).toHaveLength(1);
		const { base64, filename } = await staff.api.reports.sends.pdf({
			siteId: site.siteId,
			sendId: failed?.id as string,
		});
		expect(filename).toBe("weekly-results-2026-03-16-2026-03-22.pdf");
		expect(Buffer.from(base64, "base64").toString().startsWith("%PDF-")).toBe(true);

		// A Report that was sent goes out again to its recipients with Resend.
		await staff.api.reports.sends.resend({ siteId: site.siteId, sendId: failed?.id as string });
		await install.drainJobs();
		expect(mailTo(install, "render@bakery.example")).toHaveLength(2);
	});
});

describe("a monthly Report of a Workspace Dashboard", () => {
	test("adds up every Site, goes out on the 1st through the Install SMTP under the Workspace's name, in its language", async () => {
		await staffNow();
		const superadmin = await install.superadmin();
		await superadmin.api.session.confirmIdentity({ password: TEST_PASSWORD });
		await superadmin.api.install.smtp.update({
			host: "smtp.agency.example",
			port: 587,
			security: "starttls",
			username: null,
			fromAddress: "reports@agency.example",
			replyTo: null,
		});
		const { dashboard } = await staff.api.dashboards.create({ workspaceId, name: "All sites" });
		await staff.api.dashboards.widgets.add({
			workspaceId,
			dashboardId: dashboard.id,
			kind: "site-analytics:totals",
			settings: { measures: ["pageviews"] },
		});
		const { report } = await staff.api.reports.create({
			workspaceId,
			dashboardId: dashboard.id,
			name: "Mese",
			schedule: "monthly",
			language: "it",
			recipients: ["board@acme.example"],
			review: false,
			active: true,
		});
		expect(report.nextRunAt).toEqual(new Date("2026-04-01T06:00:00Z"));
		// Owners who don't see every Site of the Workspace don't see its Reports.
		const partial = (
			await install.createMember({ workspaceId, role: "owner", sites: [(reported[0] as { siteId: string }).siteId] })
		).browser;
		await expect(partial.api.reports.list({ workspaceId, dashboardId: dashboard.id })).rejects.toMatchObject({
			code: "FORBIDDEN",
		});

		await runUntil(install, "2026-04-01T06:00:30Z");
		await staffNow();

		const [email] = mailTo(install, "board@acme.example");
		expect(email).toMatchObject({
			subject: "Mese: 1 marzo 2026 – 31 marzo 2026",
			from: { name: "Acme Ltd", address: "reports@agency.example" },
			smtp: { host: "smtp.agency.example" },
		});
		const sites = (await staff.api.sites.list({ workspaceId })).sites.length;
		const pdf = attachedReport(email);
		expect(pdf.text).toContain("Report per Acme Ltd");
		expect(pdf.text).toContain(`Sommato su ${sites} di ${sites} siti.`);
		// The first Site's 5 page views in March, added up with the others' none.
		expect(pdf.text).toMatch(/ 5 Nessuno nel periodo precedente/);
	});
});

describe("the history", () => {
	test("is kept for a bounded time", async () => {
		const site = reported[0] as { siteId: string };
		await runUntil(install, "2027-06-01T07:00:00Z");
		const fresh = await staffNow();
		const dashboardId = (await fresh.api.dashboards.list({ siteId: site.siteId })).dashboards[0]?.id as string;
		const [report] = (await fresh.api.reports.list({ siteId: site.siteId, dashboardId })).reports;
		const { sends } = await fresh.api.reports.history({
			siteId: site.siteId,
			reportId: report?.id as string,
			limit: 50,
		});
		expect(sends.every((send) => send.createdAt.getTime() > new Date("2026-05-01T00:00:00Z").getTime())).toBe(true);
	});
});
