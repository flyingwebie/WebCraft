import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";

const domain = z.object({ siteId: z.uuid(), domainId: z.uuid() });

/**
 * Checks one domain waiting for DNS, and verifies it when it reaches the Install. Not retried: a failed
 * check is simply the next one's to make.
 */
export const domainsVerify = defineJob({
	name: "domains.verify",
	payload: domain,
	queue: { retryLimit: 0, expireInSeconds: 120 },
	run: ({ siteId, domainId }, context) => context.domains.verifyQueued(siteId, domainId),
});

/** Every minute: hands each domain waiting for DNS whose check is due to a `domains.verify` job. */
export const domainsVerifyDue = defineJob({
	name: "domains.verify-due",
	payload: z.object({}),
	queue: { retryLimit: 0 },
	run: async (_payload, context) => {
		for (const due of await context.domains.claimDueVerifications()) await context.jobs.send(domainsVerify, due);
	},
});

export const domainsVerifyDueSchedule = defineSchedule({ job: domainsVerifyDue, cron: "* * * * *", payload: {} });
