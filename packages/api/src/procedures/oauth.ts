import { defaultToolsets } from "@webcraft/core";
import { z } from "zod";

import {
	personActorOf as actorOf,
	inAdminSession,
	notWhileImpersonating,
	onWorkspace,
	sensitive,
	withinImpersonationReach,
} from "../context.ts";
import { id, memberSites, toolsetsInput } from "../inputs.ts";
import { toolsetOffer } from "../toolset-offer.ts";

/** An authorization request's parameters, as the AI client sent the person to `/oauth/authorize` with them. */
const parameters = z
	.record(z.string().max(100), z.string().max(4000))
	.refine((given) => Object.keys(given).length <= 30, "Too many parameters.");

/**
 * The admin's side of approving an AI client (`/oauth/authorize`): the page checks the request,
 * shows the person the client's name and where it sends them back, and approves or denies it.
 * Internal: only a person signed in to the admin approves a client.
 */
export const oauth = {
	/**
	 * Checks an authorization request: `check` is the request to show (`ask`), one that can't be
	 * answered (`refused`) or one to send back with an error (`redirect`). With it, the Workspaces
	 * (and their Sites) the person may approve it for, and the Toolsets on offer.
	 */
	check: inAdminSession.input(z.object({ parameters })).handler(async ({ context, input }) => {
		const { services } = context;
		const [check, actor] = await Promise.all([services.oauth.check(input.parameters), actorOf(context)]);
		return { check, workspaces: await services.apiTokens.offer(actor), toolsets: toolsetOffer(services) };
	}),

	/**
	 * Approves the request for one Workspace the person reaches: every Site of it (later ones too) or
	 * chosen ones, the Toolsets chosen (every one but Submissions unless chosen), read-only or not,
	 * and whether it may publish. A Sensitive action: it makes a credential that acts as them.
	 * Answers where to send the person back to, with the one-time code.
	 */
	approve: inAdminSession
		.use(notWhileImpersonating("aiClients"))
		.input(
			z.object({
				parameters,
				workspaceId: id,
				sites: memberSites.default("all"),
				readOnly: z.boolean().default(false),
				mayPublish: z.boolean().default(false),
				toolsets: toolsetsInput.optional(),
			}),
		)
		.use(onWorkspace("workspace.view"))
		.use(sensitive("aiClient.approve"))
		.handler(async ({ context, input }) => {
			const { redirectTo } = await context.services.oauth.approve(context.workspace, input.parameters, {
				sites: input.sites,
				readOnly: input.readOnly,
				mayPublish: input.mayPublish,
				toolsets: input.toolsets ?? defaultToolsets(context.services.apiTokens.toolsets()),
			});
			return { redirectTo };
		}),

	/** The person said no: where to send them back to, with `access_denied`. */
	deny: inAdminSession
		.use(notWhileImpersonating("aiClients"))
		.input(z.object({ parameters }))
		.handler(async ({ context, input }) => context.services.oauth.deny(input.parameters)),
};

/** Your account › AI clients: the AI clients the person approved, and revoking them. */
export const aiClients = {
	/** The person's approved AI clients, newest first: active, expired and revoked. Never a token. */
	list: inAdminSession.handler(async ({ context }) => {
		const grants = await context.services.oauth.list(context.person.id);
		return { grants: withinImpersonationReach(context, grants, (grant) => grant.workspace.id) };
	}),

	/** Revokes one of the person's AI clients at once: its next request is refused. */
	revoke: inAdminSession
		.use(notWhileImpersonating("aiClients"))
		.input(z.object({ grantId: id }))
		.handler(async ({ context, input }) => ({
			grant: await context.services.oauth.revoke(context.access, input.grantId),
		})),
};
