import { createFileRoute } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { StructureEditor } from "../../ui/content/StructureEditor.tsx";

/** The Globals' Fields (Structure): one set of values per Site, which every Template reads as `site.x`. */
export const Route = createFileRoute("/_admin/sites/$siteId/post-types/globals")({
	staticData: { crumb: "postTypes.globals.heading" },
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) return { globals: null };
		const api = await getApi();
		const { globals } = await api.globals.get({ siteId: params.siteId });
		return { globals };
	},
	component: GlobalFieldsPage,
});

function GlobalFieldsPage() {
	const { globals } = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { place } = Route.useRouteContext();
	if (!globals) return null;
	const defaultLanguage = place.level === "site" ? place.languages.default : "en";
	return (
		<StructureEditor
			key="globals"
			subject={{ kind: "globals", fields: globals.fields }}
			siteId={siteId}
			defaultLanguage={defaultLanguage}
			postTypes={[]}
			save={async ({ fields }) => {
				const api = await getApi();
				const { globals: saved } = await api.globals.setFields({ siteId, fields });
				return saved.fields;
			}}
		/>
	);
}
