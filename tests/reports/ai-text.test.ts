// A Report's AI text (#104): 1–3 sentences per Widget, "What happened" and suggestions that may point
// to the agency's Services list, written from the Report's totals only and paid by the Workspace's AI
// key, through its caps. No key, the cap reached or the provider failing: the Report goes without it
// and says so. Staff choose per Report whether it goes out at once or waits for someone to review it.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { createTestInstall, type TestBrowser, type TestInstall } from "../harness/index.ts";
import { attachedReport, mailTo, reportedSite, runUntil, views } from "./support.ts";

let install: TestInstall;
let places = 0;

beforeAll(async () => {
	// A Wednesday; each test's Report goes out on a later Monday.
	install = await createTestInstall({ now: new Date("2026-03-04T09:00:00Z") });
	await (await install.superadmin()).api.modules.approve({ moduleId: "site-analytics", version: "1.1.0" });
});

afterAll(async () => {
	await install.close();
});

/** A Workspace of its own (its AI key and cap are its own), with Staff and an Owner, and a reported Site. */
async function newPlace(
	options: { key?: boolean; price?: { input: number; output: number }; monthlyCap?: number } = {},
) {
	const n = ++places;
	const workspaceId = (await install.createWorkspace(`Client ${n}`)).id;
	const staffMember = await install.createStaff({ workspaces: [workspaceId], email: `staff-${n}@agency.example` });
	const ownerMember = await install.createMember({ workspaceId, role: "owner", email: `owner-${n}@client.example` });
	const staff = staffMember.browser;
	const owner = ownerMember.browser;
	if (options.key !== false) {
		await owner.api.aiKeys.setOwn({
			workspaceId,
			provider: "openai",
			model: "gpt-5-mini",
			endpoint: null,
			key: "sk-test-key-of-the-client-0123456789",
			...(options.price ? { price: options.price } : {}),
			...(options.monthlyCap ? { monthlyCap: options.monthlyCap } : {}),
		});
	}
	const site = await reportedSite(install, staff, workspaceId, `bakery-ai-${n}.example`);
	return {
		workspaceId,
		staff,
		owner,
		...site,
		/** Signs Staff and the Owner in again, after a week without using their sessions. */
		async again() {
			return { staff: await install.signIn(staffMember.account), owner: await install.signIn(ownerMember.account) };
		},
	};
}

async function weekly(
	staff: TestBrowser,
	site: { siteId: string; dashboardId: string },
	to: string,
	options: { review?: boolean; language?: "en" | "it" } = {},
) {
	const { report } = await staff.api.reports.create({
		siteId: site.siteId,
		dashboardId: site.dashboardId,
		name: "Weekly results",
		schedule: "weekly",
		language: options.language ?? "en",
		recipients: [to],
		review: options.review ?? false,
		active: true,
	});
	return report;
}

describe("the AI text of a Report", () => {
	test("explains each Widget, says what happened and suggests services from the list, from totals only, paid by the Workspace's key", async () => {
		const place = await newPlace();
		const { services } = await place.staff.api.servicesList.update({
			services: [
				{ name: "Search engine optimisation", description: "Getting found on search engines." },
				{ name: "Landing pages" },
			],
		});
		const seo = services[0]?.id as string;
		await views(install, place.origin, 2);
		await weekly(place.staff, place, "client-1@bakery.example");
		install.ai.reportWith((request) => ({
			widgets: { [place.totalsId]: "Page views went from none to 2.", "not-a-widget": "Ignored." },
			whatHappened: "<b>More people</b> visited\u0007 this week.",
			suggestions: [
				{ text: "Write a page about your bread.", service: seo },
				{ text: "Ask visitors to sign up.", service: "a-service-nobody-listed" },
			],
			facts: request.facts,
		}));

		await runUntil(install, "2026-03-09T06:00:30Z");

		const pdf = attachedReport(mailTo(install, "client-1@bakery.example")[0]);
		expect(pdf.text).toContain("Page views 2 None the period before Page views went from none to 2.");
		// The AI's words are text, never markup: what it wrote shows as it wrote it.
		expect(pdf.text).toContain("What happened <b>More people</b> visited this week.");
		expect(pdf.text).toContain(
			"Suggestions Write a page about your bread. Related service: Search engine optimisation Ask visitors to sign up. Written by AI",
		);
		expect(pdf.text).not.toContain("Ignored.");

		const [request] = install.ai.reportRequests();
		expect(request?.language).toEqual({ code: "en", name: "English" });
		expect(request?.services.map((service) => service.name)).toEqual(["Search engine optimisation", "Landing pages"]);
		expect(JSON.parse(request?.facts ?? "{}")).toEqual({
			place: "Bakery",
			period: "2026-03-02 to 2026-03-08",
			periodBefore: "2026-02-23 to 2026-03-01",
			widgets: [
				{
					id: place.totalsId,
					title: "Totals",
					days: "2026-03-02 to 2026-03-08",
					counts: { "Page views": 2 },
					countsBefore: { "Page views": 0 },
				},
			],
		});
		// Nothing about a visitor: no address, no browser.
		expect(JSON.stringify(request)).not.toContain("203.0.113.7");
		expect(JSON.stringify(request)).not.toContain("Mozilla");

		const ai = await place.owner.api.aiKeys.get({ workspaceId: place.workspaceId });
		expect(ai.usage.sites).toMatchObject([{ siteId: place.siteId, calls: 1, inputTokens: 1000, outputTokens: 300 }]);
		const { sends } = await place.staff.api.reports.history({
			siteId: place.siteId,
			reportId: (await reportOf(place)).id,
		});
		expect(sends[0]).toMatchObject({ status: "sent", ai: "written" });
	});

	test("is left out, and the Report says so, at the Workspace's monthly cap", async () => {
		// $1,000 a million tokens and a $1 cap: the first Report's text uses the month up.
		const place = await newPlace({ price: { input: 1000, output: 1000 }, monthlyCap: 1 });
		await views(install, place.origin, 1);
		await weekly(place.staff, place, "client-2@bakery.example");
		install.ai.reportWith(() => ({ whatHappened: "Written while there was room.", widgets: {}, suggestions: [] }));

		await runUntil(install, "2026-03-16T06:00:30Z");
		expect(attachedReport(mailTo(install, "client-2@bakery.example")[0]).text).toContain(
			"Written while there was room.",
		);

		await runUntil(install, "2026-03-23T06:00:30Z");
		const pdf = attachedReport(mailTo(install, "client-2@bakery.example")[1]);
		expect(pdf.text).toContain("This Report has no AI text: this month's AI budget is used up.");
		expect(pdf.text).not.toContain("Written while there was room.");
	});

	test("is left out, and the Report says so, when the AI provider gives no usable answer", async () => {
		const place = await newPlace();
		await weekly(place.staff, place, "client-3@bakery.example");
		install.ai.reportWith(() => "Here is your report: it went well!");

		await runUntil(install, "2026-03-30T06:00:30Z");

		const [email] = mailTo(install, "client-3@bakery.example");
		expect(attachedReport(email).text).toContain("This Report has no AI text: the AI provider didn't answer.");
		expect(email?.text).toContain("This Report has no AI text this time.");
	});

	test("waits for review when the Report says so: Staff are told, edit it, approve it, and only then it goes out", async () => {
		const place = await newPlace();
		await views(install, place.origin, 4);
		const report = await weekly(place.staff, place, "client-4@bakery.example", { review: true });
		install.ai.reportWith(() => ({
			widgets: { [place.totalsId]: "Four page views." },
			whatHappened: "A quiet week.",
			suggestions: [{ text: "Post more often.", service: null }],
		}));

		await runUntil(install, "2026-04-06T06:00:30Z");
		const { staff, owner } = await place.again();
		expect(mailTo(install, "client-4@bakery.example")).toEqual([]);
		const told = await install.lastEmailTo("staff-4@agency.example");
		expect(told.subject).toBe("“Weekly results” is waiting for review");
		const [held] = (await staff.api.reports.history({ siteId: place.siteId, reportId: report.id })).sends;
		expect(held).toMatchObject({ status: "review", ai: "written" });
		expect(told.text).toContain(`/sites/${place.siteId}/dashboards/${place.dashboardId}/reports?review=${held?.id}`);

		// Owners see it, but only Staff review it.
		const { send } = await owner.api.reports.sends.get({ siteId: place.siteId, sendId: held?.id as string });
		expect(send.text).toEqual({
			widgets: { [place.totalsId]: "Four page views." },
			whatHappened: "A quiet week.",
			suggestions: [{ text: "Post more often.", service: null }],
		});
		await expect(
			owner.api.reports.sends.approve({ siteId: place.siteId, sendId: held?.id as string }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		await staff.api.reports.sends.editText({
			siteId: place.siteId,
			sendId: held?.id as string,
			text: {
				widgets: { [place.totalsId]: "Four page views, all on Tuesday." },
				whatHappened: "A quiet but steady week.",
				suggestions: [],
			},
		});
		await staff.api.reports.sends.approve({ siteId: place.siteId, sendId: held?.id as string });
		await install.drainJobs();

		const pdf = attachedReport(mailTo(install, "client-4@bakery.example")[0]);
		expect(pdf.text).toContain("Four page views, all on Tuesday.");
		expect(pdf.text).toContain("What happened A quiet but steady week.");
		expect(pdf.text).not.toContain("Post more often.");
		await expect(
			staff.api.reports.sends.approve({ siteId: place.siteId, sendId: held?.id as string }),
		).rejects.toMatchObject({ code: "REPORT_SEND_REFUSED", data: { reason: "notHeld" } });
	});

	test("a Report waiting for review can be discarded: it never goes out", async () => {
		const place = await newPlace();
		const report = await weekly(place.staff, place, "client-5@bakery.example", { review: true });
		install.ai.reportWith(() => ({ widgets: {}, whatHappened: "Nothing much.", suggestions: [] }));

		await runUntil(install, "2026-04-13T06:00:30Z");
		const { staff } = await place.again();
		const [held] = (await staff.api.reports.history({ siteId: place.siteId, reportId: report.id })).sends;
		await staff.api.reports.sends.discard({ siteId: place.siteId, sendId: held?.id as string });
		await install.drainJobs();

		expect(mailTo(install, "client-5@bakery.example")).toEqual([]);
		const [discarded] = (await staff.api.reports.history({ siteId: place.siteId, reportId: report.id })).sends;
		expect(discarded).toMatchObject({ status: "discarded", pdf: null });
	});

	test("is written in the Report's language", async () => {
		const place = await newPlace();
		await weekly(place.staff, place, "client-6@bakery.example", { language: "it" });
		install.ai.reportWith((request) => ({
			widgets: {},
			whatHappened: `Scritto in ${request.language.name}.`,
			suggestions: [],
		}));

		await runUntil(install, "2026-04-20T06:00:30Z");

		const [email] = mailTo(install, "client-6@bakery.example");
		expect(email?.subject).toBe("Weekly results: 13 aprile 2026 – 19 aprile 2026");
		const pdf = attachedReport(email);
		expect(pdf.text).toContain("Report per Bakery");
		expect(pdf.text).toContain("Cosa è successo Scritto in Italiano.");
	});
});

async function reportOf(place: { staff: TestBrowser; siteId: string; dashboardId: string }) {
	const { reports } = await place.staff.api.reports.list({ siteId: place.siteId, dashboardId: place.dashboardId });
	return reports[0] as { id: string };
}
