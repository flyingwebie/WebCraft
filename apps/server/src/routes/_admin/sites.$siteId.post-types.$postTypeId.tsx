import { createFileRoute, notFound } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { StructureEditor } from "../../ui/content/StructureEditor.tsx";
import { errorCode } from "../../ui/errors.ts";

/** One Post Type's settings and Fields (Structure). */
export const Route = createFileRoute("/_admin/sites/$siteId/post-types/$postTypeId")({
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit"))
			return { postType: null, postTypes: [], crumb: undefined };
		const api = await getApi();
		try {
			const [{ postType }, { postTypes }] = await Promise.all([
				api.postTypes.get({ siteId: params.siteId, postTypeId: params.postTypeId }),
				api.postTypes.list({ siteId: params.siteId }),
			]);
			return { postType, postTypes, crumb: postType.name };
		} catch (error) {
			if (errorCode(error) === "POST_TYPE_NOT_FOUND" || errorCode(error) === "BAD_REQUEST") throw notFound();
			throw error;
		}
	},
	component: PostTypePage,
});

function PostTypePage() {
	const { postType, postTypes } = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { place } = Route.useRouteContext();
	if (!postType) return null;
	const defaultLanguage = place.level === "site" ? place.languages.default : "en";
	return (
		<StructureEditor
			key={postType.id}
			subject={{ kind: "postType", ...postType }}
			siteId={siteId}
			defaultLanguage={defaultLanguage}
			postTypes={postTypes.map(({ key, name }) => ({ key, name }))}
			save={async ({ settings, fields }) => {
				const api = await getApi();
				const { postType: saved } = await api.postTypes.update({
					siteId,
					postTypeId: postType.id,
					name: settings?.name,
					urlPattern: postType.builtIn === "page" ? undefined : settings?.urlPattern,
					fields,
				});
				return saved.fields;
			}}
		/>
	);
}
