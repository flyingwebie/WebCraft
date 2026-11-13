import { z } from "zod";

import { defineJob } from "./jobs/define.ts";
import { defineSchedule } from "./jobs/schedules.ts";

/**
 * Deletes OAuth codes and tokens past their end (used refresh tokens stay until then, so one that
 * comes back is still recognised and ends its grant), and AI clients nobody approved within a week
 * of registering.
 */
export const oauthPurge = defineJob({
	name: "oauth.purge",
	payload: z.object({}),
	async run(_payload, { oauth, log }) {
		const deleted = await oauth.purge();
		if (deleted > 0) log.debug("Deleted ended OAuth codes and tokens, and unapproved AI clients", { deleted });
	},
});

/** The OAuth purge runs every day at 04:41 UTC. */
export const oauthPurgeSchedule = defineSchedule({ job: oauthPurge, cron: "41 4 * * *", payload: {} });
