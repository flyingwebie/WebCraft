// Who receives a Report is a Sensitive action (`reportRecipients.change`), as Webhooks and Form
// recipients are: a Report sends a Dashboard's figures to any email address. Making a Report with
// recipients, changing them through `reports.update` or `reports.setRecipients`: a person in the
// admin after a recent identity check, never an API token or AI client. Every other Report change
// stays available to them.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createApiToken, type TokenClient, tokenClient } from "../harness/api-tokens.ts";
import { createTestInstall, TEST_PASSWORD, type TestBrowser, type TestInstall } from "../harness/index.ts";

const MINUTE = 60_000;

let install: TestInstall;
let staff: TestBrowser;
let owner: TestBrowser;
let script: TokenClient;
let siteId: string;
let dashboardId: string;
let reportId: string;

const report = { name: "Weekly results", schedule: "weekly", language: "en", review: false, active: true } as const;

beforeAll(async () => {
	install = await createTestInstall();
	const workspaceId = (await install.createWorkspace("Acme Ltd")).id;
	siteId = (await install.createSite(workspaceId, { name: "Acme Bakery", slug: "bakery" })).id;
	staff = (await install.createStaff({ workspaces: [workspaceId] })).browser;
	owner = (await install.createMember({ workspaceId, role: "owner" })).browser;
	dashboardId = (await staff.api.dashboards.create({ siteId, name: "Overview" })).dashboard.id;
	reportId = (await staff.api.reports.create({ siteId, dashboardId, ...report, recipients: ["client@bakery.example"] }))
		.report.id;
	script = tokenClient(
		install,
		(await createApiToken(staff, { workspaceId, name: "Reports script", toolsets: ["analytics"] })).secret,
	);
});

afterAll(async () => {
	await install.close();
});

describe("through an API token", () => {
	test("changing who receives a Report is refused, however it is asked", async () => {
		const refused = { code: "SENSITIVE_ACTION_REFUSED", data: { action: "reportRecipients.change" } };
		await expect(
			script.api.reports.setRecipients({ siteId, reportId, recipients: ["someone@elsewhere.example"] }),
		).rejects.toMatchObject(refused);
		await expect(
			script.api.reports.update({ siteId, reportId, recipients: ["client@bakery.example", "x@elsewhere.example"] }),
		).rejects.toMatchObject(refused);
		await expect(
			script.api.reports.create({ siteId, dashboardId, ...report, recipients: ["someone@elsewhere.example"] }),
		).rejects.toMatchObject(refused);

		const [kept] = (await staff.api.reports.list({ siteId, dashboardId })).reports.filter(
			(listed) => listed.id === reportId,
		);
		expect(kept?.recipients).toEqual(["client@bakery.example"]);
	});

	test("every other Report change stays available: its name, schedule, a Report going to nobody yet", async () => {
		const { report: renamed } = await script.api.reports.update({
			siteId,
			reportId,
			name: "Monthly results",
			schedule: "monthly",
			// The same addresses: nobody new receives it.
			recipients: ["client@bakery.example"],
		});
		expect(renamed).toMatchObject({ name: "Monthly results", schedule: "monthly" });
		const { report: empty } = await script.api.reports.create({ siteId, dashboardId, ...report, recipients: [] });
		expect(empty.recipients).toEqual([]);
	});
});

describe("in the admin", () => {
	test("Staff and Owners change recipients after a recent identity check", async () => {
		await install.clock.advance(11 * MINUTE);
		for (const [person, address] of [
			[staff, "staff-chose@bakery.example"],
			[owner, "owner-chose@bakery.example"],
		] as const) {
			await expect(person.api.reports.setRecipients({ siteId, reportId, recipients: [address] })).rejects.toMatchObject(
				{ code: "IDENTITY_CHECK_REQUIRED", data: { action: "reportRecipients.change" } },
			);
			await person.api.session.confirmIdentity({ password: TEST_PASSWORD });
			const { report: changed } = await person.api.reports.setRecipients({
				siteId,
				reportId,
				recipients: [address],
			});
			expect(changed.recipients).toEqual([address]);
		}
	});
});
