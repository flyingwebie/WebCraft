import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { ContentApiPage } from "../../ui/content-api/ContentApi.tsx";
import { pageTitle } from "../../ui/i18n.tsx";

export const Route = createFileRoute("/_admin/sites/$siteId/content-api")({
	staticData: { crumb: "shell.nav.contentApi" },
	loader: async ({ params, context }) => {
		if (!context.place.permissions.includes("structure.edit")) return null;
		const api = await getApi();
		const { siteId } = params;
		const [view, { postTypes }, { globals }] = await Promise.all([
			api.contentApi.get({ siteId }),
			api.postTypes.list({ siteId }),
			api.globals.get({ siteId }),
		]);
		return {
			view,
			postTypes: postTypes.map(({ id, name, fields }) => ({ id, name, fields })),
			globals: globals.fields,
		};
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "shell.nav.contentApi") }] }),
	component: ContentApiRoute,
});

/** Site settings › Content API: its switch, its Content keys and what it shows (Staff only). */
function ContentApiRoute() {
	const data = Route.useLoaderData();
	const { siteId } = Route.useParams();
	if (!data) return null;
	return <ContentApiPage siteId={siteId} data={data} />;
}
