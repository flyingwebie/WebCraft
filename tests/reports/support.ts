import { analyticsVisitor, liveSite } from "../harness/analytics.ts";
import type { SentEmail, TestBrowser, TestInstall } from "../harness/index.ts";
import { pdfText } from "../harness/index.ts";

/** A Site's own mail server, which its mail (Reports among it) goes through. */
export const SITE_SERVER = {
	host: "smtp.bakery.example",
	port: 587,
	security: "starttls",
	username: null,
	fromAddress: "hello@bakery.example",
} as const;

/**
 * A live Site with Site analytics counting every page view (no Consent banner), its own mail server,
 * and a Dashboard of totals: what a Report is made from.
 */
export async function reportedSite(
	install: TestInstall,
	staff: TestBrowser,
	workspaceId: string,
	domain: string,
): Promise<{ siteId: string; origin: string; dashboardId: string; totalsId: string }> {
	const site = await liveSite(install, staff, workspaceId, domain);
	await staff.api.consentBanner.setSettings({ siteId: site.siteId, mode: "none", layout: "bar" });
	await staff.api.siteSmtp.update({ siteId: site.siteId, fromName: null, replyTo: null, server: SITE_SERVER });
	const { dashboard } = await staff.api.dashboards.create({ siteId: site.siteId, name: "Overview" });
	const added = await staff.api.dashboards.widgets.add({
		siteId: site.siteId,
		dashboardId: dashboard.id,
		kind: "site-analytics:totals",
		settings: { measures: ["pageviews"] },
	});
	return { siteId: site.siteId, origin: site.origin, dashboardId: dashboard.id, totalsId: added.widgetId };
}

/** `count` page views of `path` on the Site, now (by the test clock). */
export async function views(install: TestInstall, origin: string, count: number, path = "/"): Promise<void> {
	const visitor = analyticsVisitor(install, origin);
	for (let sent = 0; sent < count; sent++) {
		const answer = await visitor.view(path);
		if (answer.status !== 204) throw new Error(`The page view wasn't taken: ${answer.status}`);
	}
}

/** The emails sent to an address, oldest first. */
export function mailTo(install: TestInstall, address: string): SentEmail[] {
	return install.mail.sent.filter((email) => email.to === address);
}

/** What a Report's emailed PDF says. */
export function attachedReport(email: SentEmail | undefined): { filename: string; contentType: string; text: string } {
	const attachment = email?.attachments?.[0];
	if (!attachment) throw new Error("The email has no attachment.");
	return { filename: attachment.filename, contentType: attachment.contentType, text: pdfText(attachment.content) };
}

/** Moves the clock to `at` and runs every job due by then. */
export async function runUntil(install: TestInstall, at: string): Promise<void> {
	await install.clock.set(new Date(at));
	const drained = await install.drainJobs();
	if (drained.failed.length > 0) {
		throw new Error(`Jobs failed: ${drained.failed.map((job) => `${job.name}: ${job.error?.message}`).join("; ")}`);
	}
}
