import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { pageTitle } from "../../ui/i18n.tsx";
import { ProtectedTermsPage } from "../../ui/translations/ProtectedTermsPage.tsx";

export const Route = createFileRoute("/_admin/workspaces/$workspaceId/protected-terms")({
	staticData: { crumb: "protectedTerms.pageTitle" },
	loader: async ({ params, context }) => {
		const api = await getApi();
		const { workspaceId } = params;
		const { terms } = await api.protectedTerms.list({ workspaceId });
		// The Sites whose own terms the person may change: where they hold `protectedTerms.edit`.
		const sites = context.place.level === "workspace" ? context.place.sites : [];
		const editable = (
			await Promise.all(
				sites.map(async (site) => {
					const { permissions } = await api.sites.get({ siteId: site.id });
					return permissions.includes("protectedTerms.edit") ? { id: site.id, name: site.name } : null;
				}),
			)
		).filter((site): site is { id: string; name: string } => site !== null);
		return { terms, sites: editable };
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "protectedTerms.pageTitle") }],
	}),
	component: ProtectedTermsRoute,
});

/** Workspace › Protected terms: words AI translation leaves exactly as written, the Workspace's and its Sites'. */
function ProtectedTermsRoute() {
	const { terms, sites } = Route.useLoaderData();
	const { workspaceId } = Route.useParams();
	const { place } = Route.useRouteContext();
	return (
		<ProtectedTermsPage
			workspaceId={workspaceId}
			terms={terms}
			sites={sites}
			canEditWorkspace={place.permissions.includes("protectedTerms.edit")}
		/>
	);
}
