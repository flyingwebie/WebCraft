// Reports (#104): a Dashboard sent as a PDF on its schedule, its period compared with the one before,
// to its recipients through the Site's own mail, in its language. The worker renders the PDF (here a
// fake that keeps the page's text; `chromium.test.ts` runs the real one) and the history keeps it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { attachedReport, mailTo, reportedSite, runUntil, SITE_SERVER, views } from "./support.ts";

let install: TestInstall;
let workspaceId: string;
let staff: TestBrowser;

beforeAll(async () => {
	// A Wednesday: the week of 2 March is under way.
	install = await createTestInstall({ now: new Date("2026-03-04T09:00:00Z") });
	await (await install.superadmin()).api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
	workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
});

afterAll(async () => {
	await install.close();
});

describe("a weekly Report", () => {
	test("goes out on Monday morning with its PDF, through the Site's own mail, comparing the week with the one before", async () => {
		const site = await reportedSite(install, staff, workspaceId, "bakery-weekly.example");
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
