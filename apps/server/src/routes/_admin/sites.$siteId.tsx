import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { errorCode } from "../../ui/errors.ts";
import type { AdminPlace } from "../../ui/shell/levels.ts";

/**
 * The Site level: every page below is about one Site. Loads the Site, its Workspace, the person's
 * Permissions on it, its Post Types (the sidebar lists their Entries), its Forms and languages, how
 * many of its Drafts they may publish (Publish all in the top bar) and how many Reviews wait for them
 * (the Overview item), and the Workspace's other Sites they reach (for the context switcher). A Site the person can't reach is "not found".
 */
export const Route = createFileRoute("/_admin/sites/$siteId")({
	beforeLoad: async ({ params }) => {
		const api = await getApi();
		try {
			const [
				{ site, workspace, permissions, modulePages, modulePermissions, languages },
				{ postTypes },
				{ count: drafts },
				{ count: reviews },
			] = await Promise.all([
				api.sites.get({ siteId: params.siteId }),
				api.postTypes.list({ siteId: params.siteId }),
				api.publishing.count({ siteId: params.siteId }),
				api.reviews.count({ siteId: params.siteId }),
			]);
			const { sites } = await api.sites.list({ workspaceId: workspace.id });
			// Each Form has its own sidebar item: for Staff (its Structure) and for the clients who read its
			// Submissions and change its emails, never Authors.
			const forms =
				permissions.includes("structure.edit") || permissions.includes("formEmails.edit")
					? (await api.forms.list({ siteId: params.siteId })).forms.map(({ id, name }) => ({ id, name }))
					: [];
			// Dashboards: Staff and Owners see them all; others only those shown to everyone.
			const dashboards =
				permissions.includes("dashboard.view") ||
				permissions.includes("dashboard.manage") ||
				(await api.dashboards.list({ siteId: params.siteId })).dashboards.length > 0;
			const place: AdminPlace = {
				level: "site",
				workspace,
				site: { id: site.id, name: site.name, slug: site.slug },
				sites: sites.map(({ id, name, slug }) => ({ id, name, slug })),
				permissions,
				modulePages,
				postTypes: postTypes.map(({ id, name, builtIn }) => ({ id, name, builtIn })),
				forms,
				languages,
				modulePermissions,
				drafts,
				reviews,
				dashboards,
			};
			return { place, site };
		} catch (error) {
			if (errorCode(error) === "SITE_NOT_FOUND" || errorCode(error) === "BAD_REQUEST") throw notFound();
			throw error;
		}
	},
	component: Outlet,
});
