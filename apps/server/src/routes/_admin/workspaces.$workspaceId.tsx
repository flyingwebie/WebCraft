import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { errorCode } from "../../ui/errors.ts";
import type { AdminPlace } from "../../ui/shell/levels.ts";

/**
 * The Workspace level: every page below is inside one Workspace. Loads the Workspace, the
 * person's Permissions in it and its Sites they reach, for the sidebar, the breadcrumbs and the
 * context switcher. A Workspace the person can't reach is "not found".
 */
export const Route = createFileRoute("/_admin/workspaces/$workspaceId")({
	beforeLoad: async ({ params }) => {
		const api = await getApi();
		try {
			const [{ workspace, permissions }, { sites }] = await Promise.all([
				api.workspaces.get({ workspaceId: params.workspaceId }),
				api.sites.list({ workspaceId: params.workspaceId }),
			]);
			const place: AdminPlace = {
				level: "workspace",
				workspace: { id: workspace.id, name: workspace.name },
				sites: sites.map(({ id, name, slug }) => ({ id, name, slug })),
				permissions,
			};
			return { place };
		} catch (error) {
			if (errorCode(error) === "WORKSPACE_NOT_FOUND" || errorCode(error) === "BAD_REQUEST") throw notFound();
			throw error;
		}
	},
	component: Outlet,
});
