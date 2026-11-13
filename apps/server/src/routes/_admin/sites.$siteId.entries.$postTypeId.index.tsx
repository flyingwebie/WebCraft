import { createFileRoute, getRouteApi, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { ENTRY_STATUSES, EntriesList } from "../../ui/content/EntriesList.tsx";
import { CsvImportSheet } from "../../ui/imports/CsvImportSheet.tsx";

/** What the list shows: a search over titles and slugs, and one status. */
const search = z.object({
	q: z.string().max(200).optional().catch(undefined),
	status: z.enum(ENTRY_STATUSES).optional().catch(undefined),
});

const parent = getRouteApi("/_admin/sites/$siteId/entries/$postTypeId");

export const Route = createFileRoute("/_admin/sites/$siteId/entries/$postTypeId/")({
	validateSearch: search,
	loader: async ({ params }) => {
		const api = await getApi();
		const { entries } = await api.entries.list({ siteId: params.siteId, postTypeId: params.postTypeId });
		return { entries };
	},
	component: EntriesPage,
});

/** Site › a Post Type's Entries: searched, filtered by status, with language chips; Pages as a tree. */
function EntriesPage() {
	const { entries } = Route.useLoaderData();
	const { postType } = parent.useLoaderData();
	const searchParams = Route.useSearch();
	const { siteId } = Route.useParams();
	const { place } = Route.useRouteContext();
	const navigate = useNavigate({ from: Route.fullPath });
	if (place.level !== "site") return null;
	return (
		<EntriesList
			siteId={siteId}
			postType={postType}
			entries={entries}
			languages={place.languages}
			permissions={place.permissions}
			search={searchParams}
			onSearch={(next, options) =>
				navigate({ search: (current) => ({ ...current, ...next }), replace: options?.replace })
			}
			actions={
				place.permissions.includes("import.run") ? (
					<CsvImportSheet
						siteId={siteId}
						postType={postType}
						languages={place.languages}
						addsFields={place.permissions.includes("structure.edit")}
					/>
				) : null
			}
		/>
	);
}
