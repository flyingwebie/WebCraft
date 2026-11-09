import { MEDIA_QUOTA_MIN_BYTES, permissionsOn, WORKSPACE_NAME_MAX_LENGTH } from "@webcraft/core";
import { z } from "zod";

import { onInstall, signedIn } from "../context.ts";
import { id } from "../inputs.ts";
import { languageOf } from "./modules.ts";

/** Workspaces: one per client organisation. */
export const workspaces = {
	/** The Workspaces the person can see, with how many of their Sites they reach and the Staff assigned. */
	list: signedIn.handler(async ({ context }) => ({
		workspaces: await context.services.workspaces.list(context.access),
	})),

	/** One Workspace, and the Permissions the person holds in it (the admin shows what they may do). */
	get: signedIn.input(z.object({ workspaceId: id })).handler(async ({ context, input }) => {
		const scope = await context.services.data.workspace(context.access, input.workspaceId, "workspace.view");
		const { workspace } = scope;
		const permissions = permissionsOn(context.access.actor, { level: "workspace", workspaceId: workspace.id });
		const language = await languageOf(context.services, context.person);
		return { workspace, permissions, modulePages: await context.services.modules.pages(scope, language) };
	}),

	/**
	 * The Workspace's Media storage: the bytes its Sites' Media takes (a file stored once counted
	 * once), its quota if Staff set one, and whether it passed 80% (`warning`) or 100% (`full`).
	 */
	storage: signedIn.input(z.object({ workspaceId: id })).handler(async ({ context, input }) => {
		const scope = await context.services.data.workspace(context.access, input.workspaceId, "workspace.view");
		return context.services.media.quota.get(scope);
	}),

	/** Sets the Workspace's Media storage quota (at least 1 MB), or removes it with null. Staff only. */
	setQuota: signedIn
		.input(
			z.object({
				workspaceId: id,
				quotaBytes: z
					.number()
					.int()
					.min(MEDIA_QUOTA_MIN_BYTES)
					.max(2 ** 50)
					.nullable(),
			}),
		)
		.handler(async ({ context, input }) => {
			const scope = await context.services.data.workspace(context.access, input.workspaceId, "quota.manage");
			return context.services.media.quota.set(scope, input.quotaBytes);
		}),

	/** Creates a Workspace. */
	create: onInstall("workspace.create")
		.input(z.object({ name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX_LENGTH) }))
		.handler(async ({ context, input }) => ({
			workspace: await context.services.workspaces.create(context.install, input),
		})),
};
