import { z } from "zod";

import { onInstall } from "../context.ts";
import { id } from "../inputs.ts";

/** The `next` of the page before. */
const after = z.string().max(100);

/**
 * The Error log (Install health, spec story 17): unexpected failures grouped by cause, read by the
 * Superadmin only (`installHealth.manage`). Nothing writes it but WebCraft's own failures; marking
 * a cause resolved is recorded in the Audit log, and the cause opens again when it happens again.
 */
export const errorLog = {
	/** A page of causes, the most recently seen first: those not marked resolved unless `state` says. */
	list: onInstall("installHealth.manage")
		.input(
			z
				.object({
					state: z.enum(["open", "resolved", "all"]).default("open"),
					after: after.optional(),
					limit: z.number().int().min(1).max(100).default(50),
				})
				.default({ state: "open", limit: 50 }),
		)
		.handler(async ({ context, input }) => ({
			...(await context.services.errorLog.list(context.install, input)),
			/** How many days a cause is kept after it was last seen. */
			keptDays: 30,
		})),

	/** One cause, with its newest example's stack and every Workspace and Site it happened in. */
	get: onInstall("installHealth.manage")
		.input(z.object({ groupId: id }))
		.handler(async ({ context, input }) => ({
			group: await context.services.errorLog.get(context.install, input.groupId),
		})),

	/** Marks a cause resolved; it opens again if it happens again. Recorded as `errorLog.resolve`. */
	resolve: onInstall("installHealth.manage")
		.input(z.object({ groupId: id }))
		.handler(async ({ context, input }) => ({
			group: await context.services.errorLog.resolve(context.install, input.groupId),
		})),
};
