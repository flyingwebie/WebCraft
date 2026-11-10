import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";

/**
 * Reports' jobs (#104). Every quarter of an hour `reports.due` starts the Reports whose time came
 * (each Monday, or the 1st, at 06:00 UTC); `reports.prepare` works out what each shows and writes its
 * AI text; `reports.render` makes its PDF with headless Chromium (the worker's only, one at a time) and
 * emails it. A PDF that can't be made is tried again (`RENDER_ATTEMPTS`), then the history says it
 * failed; a Report is never sent without it. `reports.purge` keeps the history to its bounded time.
 */

const ref = z.object({ sendId: z.uuid(), workspaceId: z.uuid(), siteId: z.uuid().nullable() });

export const reportsDue = defineJob({
	name: "reports.due",
	payload: z.object({}),
	queue: { retryLimit: 1, expireInSeconds: 600 },
	async run(_payload, services) {
		await services.reports.runDue();
	},
});

export const reportsDueSchedule = defineSchedule({ job: reportsDue, cron: "*/15 * * * *", payload: {} });

export const reportsPrepare = defineJob({
	name: "reports.prepare",
	payload: ref,
	queue: { retryLimit: 3, retryDelay: 60, retryBackoff: true, expireInSeconds: 600 },
	async run(payload, services) {
		await services.reports.prepare(payload);
	},
});

export const reportsRender = defineJob({
	name: "reports.render",
	payload: ref,
	// Failures to render are tried again by the job itself (and then recorded); this covers the rest.
	queue: { retryLimit: 2, retryDelay: 60, retryBackoff: true, expireInSeconds: 600 },
	async run(payload, services) {
		await services.reports.render(payload);
	},
});

export const reportsPurge = defineJob({
	name: "reports.purge",
	payload: z.object({}),
	queue: { retryLimit: 1 },
	async run(_payload, services) {
		await services.reports.purge();
	},
});

export const reportsPurgeSchedule = defineSchedule({ job: reportsPurge, cron: "41 3 * * *", payload: {} });
