import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { pageTitle } from "../../ui/i18n.tsx";
import { ImportsList } from "../../ui/imports/ImportsList.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/imports/")({
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("import.run")) return { imports: [] };
		const api = await getApi();
		const { imports } = await api.imports.list({ siteId: params.siteId });
		return { imports };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "imports.pageTitle") }] }),
	component: ImportsPage,
});

/** Site › Imports: the Site's Imports with their last runs, and the ways to start one. */
function ImportsPage() {
	const { imports } = Route.useLoaderData();
	const { siteId } = Route.useParams();
	return <ImportsList siteId={siteId} imports={imports} />;
}
