import { os } from "@orpc/server";
import { type Access, IMPERSONATION_REASON_MAX_LENGTH } from "@webcraft/core";
import { z } from "zod";

import { type ApiContext, inAdminSession, notWhileImpersonating, sensitive } from "../context.ts";
import { id } from "../inputs.ts";

/** A page of the admin to go back to: a path on the admin's own host, never another site. */
const adminPath = z
	.string()
	.max(500)
	.regex(/^\/(?![/\\])[^\s\\]*$/);

/**
 * Checks who may impersonate whom before the identity check, so nobody confirms who they are for
 * something they may not do: the Permission, the rules about the Superadmin, Staff and yourself, and
 * the impersonator's own second factor.
 */
const mayImpersonate = os
	.$context<ApiContext & { access: Access }>()
	.middleware(async ({ context, next }, input: { personId: string }) => {
		await context.services.impersonation.check(context.access, input.personId);
		return next();
	});

/** Impersonation (ADR 0008): the Superadmin or a Staff member acting in the admin as another person. */
export const impersonation = {
	/**
	 * Starts impersonating a person in this admin session, for at most an hour: the admin then acts
	 * as them, every action recorded as "<you> as <them>". The Superadmin impersonates any Staff member
	 * or Member, Staff only the Members of their Workspaces (and only there). Needs your own second
	 * factor and a recent identity check. `returnTo` is the admin page Stop goes back to.
	 */
	start: inAdminSession
		.input(
			z.object({
				personId: id,
				reason: z.string().trim().max(IMPERSONATION_REASON_MAX_LENGTH).optional(),
				returnTo: adminPath.optional(),
			}),
		)
		.use(notWhileImpersonating("impersonation"))
		.use(mayImpersonate)
		.use(sensitive("impersonation.start"))
		.handler(async ({ context, input }) => ({
			impersonation: await context.services.impersonation.start(context.access, context.session, {
				personId: input.personId,
				...(input.reason ? { reason: input.reason } : {}),
				...(input.returnTo ? { returnTo: input.returnTo } : {}),
			}),
		})),

	/**
	 * Stops the impersonation going on in this admin session: it is the impersonator's own again.
	 * Answers the admin page it was started from (`returnTo`, null when none or nothing was going on).
	 */
	stop: inAdminSession.handler(async ({ context }) => ({
		returnTo: (await context.services.impersonation.stop(context.session, "stopped"))?.returnTo ?? null,
	})),
};
