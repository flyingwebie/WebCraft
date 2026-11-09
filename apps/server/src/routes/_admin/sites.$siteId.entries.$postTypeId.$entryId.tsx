import { createFileRoute, getRouteApi, notFound } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { EntryEditor } from "../../ui/content/EntryEditor.tsx";
import { loadMedia, loadRelationshipTargets } from "../../ui/content/loaders.ts";
import { errorCode } from "../../ui/errors.ts";
import { pageTitleOf } from "../../ui/i18n.tsx";

/** Which language the editor shows; the Site's Default language when none is given. */
const search = z.object({ language: z.string().min(2).max(35).optional().catch(undefined) });

const parent = getRouteApi("/_admin/sites/$siteId/entries/$postTypeId");

export const Route = createFileRoute("/_admin/sites/$siteId/entries/$postTypeId/$entryId")({
	validateSearch: search,
	loaderDeps: ({ search: { language } }) => ({ language }),
	loader: async ({ params, deps }) => {
		const api = await getApi();
		const { siteId } = params;
		try {
			const [{ entry }, { postType }] = await Promise.all([
				api.entries.get({ siteId, entryId: params.entryId, language: deps.language }),
				api.postTypes.get({ siteId, postTypeId: params.postTypeId }),
			]);
			if (entry.postTypeId !== postType.id) throw notFound();
			const [relationships, media, pages] = await Promise.all([
				loadRelationshipTargets(api, siteId, postType.fields, entry.language),
				loadMedia(api, siteId, postType.fields, entry.draft.fields, [entry.draft.seo.image]),
				postType.builtIn === "page"
					? api.entries.list({ siteId, postTypeId: postType.id }).then(({ entries }) =>
							entries.map((page) => ({
								id: page.id,
								title: page.draft.title,
								slug: page.draft.slug,
								parentId: page.draft.parentId,
							})),
						)
					: null,
			]);
			return { entry, relationships, media, pages, crumb: entry.draft.title || undefined };
		} catch (error) {
			if (errorCode(error) === "ENTRY_NOT_FOUND" || errorCode(error) === "BAD_REQUEST") throw notFound();
			throw error;
		}
	},
	head: ({ match, loaderData }) => ({
		meta: [
			{ title: pageTitleOf(match.context.shell.language.code, loaderData?.entry.draft.title, match.context.site.name) },
		],
	}),
	component: EntryPage,
});

/** Site › an Entry: every Field of its Post Type, saved to the Draft as people type, and published per role. */
function EntryPage() {
	const { entry, relationships, media, pages } = Route.useLoaderData();
	const { postType } = parent.useLoaderData();
	const { siteId } = Route.useParams();
	const { place } = Route.useRouteContext();
	if (place.level !== "site") return null;
	return (
		<EntryEditor
			key={`${entry.id}:${entry.language}`}
			siteId={siteId}
			postType={postType}
			entry={entry}
			permissions={place.permissions}
			languages={place.languages}
			relationships={relationships}
			media={media}
			pages={pages}
		/>
	);
}
