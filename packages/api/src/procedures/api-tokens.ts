import { API_TOKEN_LIFETIMES, DEFAULT_API_TOKEN_LIFETIME } from "@webcraft/core";
import { z } from "zod";

import { inAdminSession, onWorkspace, sensitive } from "../context.ts";
import { id, memberSites, toolsetsInput } from "../inputs.ts";
import { toolsetOffer } from "../toolset-offer.ts";

/**
 * The person's own API tokens (Your account › API tokens): for scripts and AI clients acting as
 * them through `/api/v1`. Internal to the admin: a token can't make or see tokens.
 */
export const apiTokens = {
	/**
	 * The person's tokens, newest first (active, expired and revoked; never a token itself), and the
	 * Workspaces they may make one for, each with the Sites they see there, and the Toolsets on offer.
	 */
	list: inAdminSession.handler(async ({ context }) => {
		const { services, person } = context;
		const [tokens, actor] = await Promise.all([services.apiTokens.list(person.id), services.actors.person(person.id)]);
		return { tokens, workspaces: await services.apiTokens.offer(actor), toolsets: toolsetOffer(services) };
	}),

	/**
	 * Makes a token for one Workspace the person reaches: every Site of it (later ones too) or chosen
	 * ones, read-only or not, with the Toolsets chosen (every one but Submissions unless chosen),
	 * ending after 30, 90 (the default) or 365 days, or never. A Sensitive
	 * action. Answers the token itself (`secret`) this once only; WebCraft keeps only a hash of it.
	 */
	create: inAdminSession
		.input(
			z.object({
				workspaceId: id,
				name: z.string().trim().min(1).max(100),
				sites: memberSites.default("all"),
				readOnly: z.boolean().default(false),
				/** The Toolsets switched on: every one but Submissions unless chosen. */
				toolsets: toolsetsInput.optional(),
				lifetimeDays: z.union(API_TOKEN_LIFETIMES.map((days) => z.literal(days))).default(DEFAULT_API_TOKEN_LIFETIME),
			}),
		)
		.use(onWorkspace("workspace.view"))
		.use(sensitive("apiToken.create"))
		.handler(async ({ context, input }) => {
			const { token, secret } = await context.services.apiTokens.create(context.workspace, {
				name: input.name,
				sites: input.sites,
				readOnly: input.readOnly,
				...(input.toolsets ? { toolsets: input.toolsets } : {}),
				lifetimeDays: input.lifetimeDays,
			});
			return { token, secret };
		}),

	/** Revokes one of the person's tokens at once: scripts using it are refused from their next request. */
	revoke: inAdminSession.input(z.object({ tokenId: id })).handler(async ({ context, input }) => ({
		token: await context.services.apiTokens.revoke(context.access, input.tokenId),
	})),
};
