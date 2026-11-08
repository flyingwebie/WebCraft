import { permissionsOn, WORKSPACE_NAME_MAX_LENGTH } from "@webcraft/core";
import { z } from "zod";

import { onInstall, signedIn } from "../context.ts";
import { id } from "../inputs.ts";

/** Workspaces: one per client organisation. */
export const workspaces = {
	/** The Workspaces the person can see, with how many of their Sites they reach and the Staff assigned. */
	list: signedIn.handler(async ({ context }) => ({
		workspaces: await context.services.workspaces.list(context.access),
	})),

	/** One Workspace, and the Permissions the person holds in it (the admin shows what they may do). */
	get: signedIn.input(z.object({ workspaceId: id })).handler(async ({ context, input }) => {
		const { workspace } = await context.services.data.workspace(context.access, input.workspaceId, "workspace.view");
		const permissions = permissionsOn(context.access.actor, { level: "workspace", workspaceId: workspace.id });
		return { workspace, permissions };
	}),

	/** Creates a Workspace. */
	create: onInstall("workspace.create")
		.input(z.object({ name: z.string().trim().min(1).max(WORKSPACE_NAME_MAX_LENGTH) }))
		.handler(async ({ context, input }) => ({
			workspace: await context.services.workspaces.create(context.install, input),
		})),
};
