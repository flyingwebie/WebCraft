import { formUploads } from "@webcraft/db/schema";
import { isNull } from "drizzle-orm";
import { z } from "zod";

import { defineJob } from "../jobs/define.ts";
import { defineSchedule } from "../jobs/schedules.ts";

/** Retry failed storage deletions and abandoned uploads, even when the Forms Module is off. */
export const formUploadsPurge = defineJob({
	name: "forms.purge-uploads",
	payload: z.object({}),
	async run(_payload, { database, data, forms }) {
		// Only discover Sites here; each Site's files are read and removed through its scope.
		const sites = await database.db
			.selectDistinct({ siteId: formUploads.siteId })
			.from(formUploads)
			.where(isNull(formUploads.submissionId));
		for (const { siteId } of sites) {
			const scope = await data.background(siteId);
			if (scope) await forms.uploads.purge(scope.site);
		}
	},
});

export const formUploadsPurgeSchedule = defineSchedule({ job: formUploadsPurge, cron: "53 3 * * *", payload: {} });
