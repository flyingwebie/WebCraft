import { z } from "zod";

import { onInstall } from "../context.ts";

/** The Audit log. Its screens, filters and the Workspace-level views come later. */
export const audit = {
	/** The newest entries of the whole Install's Audit log, newest first. */
	list: onInstall("audit.view")
		.input(z.object({ limit: z.number().int().min(1).max(200).default(50) }).default({ limit: 50 }))
		.handler(async ({ context, input }) => ({
			entries: await context.services.audit.list(context.install, { limit: input.limit }),
		})),
};
