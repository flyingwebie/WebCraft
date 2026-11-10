import { createFileRoute, notFound } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { errorCode } from "../../ui/errors.ts";
import { pageTitle } from "../../ui/i18n.tsx";
import { SiteImportPage } from "../../ui/site-transfer/SiteImport.tsx";

export const Route = createFileRoute("/_admin/workspaces/$workspaceId/site-imports/$importId")({
	loader: async ({ params }) => {
		const api = await getApi();
		try {
			const { import: view } = await api.siteImports.get({
				workspaceId: params.workspaceId,
				importId: params.importId,
			});
			return { view, crumb: view.fileName };
		} catch (error) {
			const code = errorCode(error);
			if (code === "SITE_IMPORT_NOT_FOUND" || code === "BAD_REQUEST" || code === "FORBIDDEN") throw notFound();
			throw error;
		}
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "siteImportReport.heading") }],
	}),
	component: SiteImportRoute,
});

/** One Site import: started as a new Site from here, followed while it runs, then its Site import report. */
function SiteImportRoute() {
	const { view } = Route.useLoaderData();
	const { workspaceId } = Route.useParams();
	return <SiteImportPage workspaceId={workspaceId} initial={view} />;
}
