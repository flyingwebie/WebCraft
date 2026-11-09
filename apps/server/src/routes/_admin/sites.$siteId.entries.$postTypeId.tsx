import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { errorCode } from "../../ui/errors.ts";
import { pageTitleOf } from "../../ui/i18n.tsx";

/** A Post Type's Entries (Content): its list and the Entry editor below it. Everyone who reaches the Site sees them. */
export const Route = createFileRoute("/_admin/sites/$siteId/entries/$postTypeId")({
	staticData: { wide: true },
	loader: async ({ params }) => {
		const api = await getApi();
		try {
			const { postType } = await api.postTypes.get({ siteId: params.siteId, postTypeId: params.postTypeId });
			return { postType, crumb: postType.name };
		} catch (error) {
			if (errorCode(error) === "POST_TYPE_NOT_FOUND" || errorCode(error) === "BAD_REQUEST") throw notFound();
			throw error;
		}
	},
	head: ({ match, loaderData }) => ({
		meta: [
			{ title: pageTitleOf(match.context.shell.language.code, loaderData?.postType.name, match.context.site.name) },
		],
	}),
	component: Outlet,
});
