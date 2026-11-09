import { createFileRoute, redirect } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";

/** Opens the Site's first Post Type that Staff made (Pages when there is none yet). */
export const Route = createFileRoute("/_admin/sites/$siteId/post-types/")({
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) return;
		const api = await getApi();
		const { postTypes } = await api.postTypes.list({ siteId: params.siteId });
		const first = postTypes.find((postType) => postType.builtIn === null) ?? postTypes[0];
		if (first) {
			throw redirect({
				to: "/sites/$siteId/post-types/$postTypeId",
				params: { siteId: params.siteId, postTypeId: first.id },
				replace: true,
			});
		}
	},
	component: () => null,
});
