import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { MEDIA_KINDS } from "@webcraft/core/media-kinds";
import { z } from "zod";
import { getApi } from "../../ui/api.ts";
import { pageTitle } from "../../ui/i18n.tsx";
import { MediaLibrary } from "../../ui/media/MediaLibrary.tsx";

/**
 * What the Media library shows: a folder (`none`: files in no folder), a search, a kind, the file
 * open in Details, and `trash` for the files in the Trash.
 */
const search = z.object({
	folder: z
		.union([z.uuid(), z.literal("none")])
		.optional()
		.catch(undefined),
	q: z.string().max(200).optional().catch(undefined),
	kind: z.enum(MEDIA_KINDS).optional().catch(undefined),
	file: z.uuid().optional().catch(undefined),
	trash: z.boolean().optional().catch(undefined),
});

export type MediaSearch = z.infer<typeof search>;

export const Route = createFileRoute("/_admin/sites/$siteId/media")({
	staticData: { crumb: "media.pageTitle", wide: true },
	validateSearch: search,
	loaderDeps: ({ search: { folder, q, kind, file, trash } }) => ({ folder, q, kind, file, trash }),
	loader: async ({ params, deps }) => {
		const api = await getApi();
		const { siteId } = params;
		const trash = deps.trash === true;
		const [list, folders, overview] = await Promise.all([
			api.media.list({
				siteId,
				trash,
				folderId: trash ? undefined : deps.folder,
				search: deps.q,
				kind: deps.kind,
			}),
			api.media.folders.list({ siteId }),
			api.media.overview({ siteId }),
		]);
		let selected = deps.file ? list.items.find((item) => item.id === deps.file) : undefined;
		if (deps.file && !selected) {
			selected = await api.media.get({ siteId, mediaId: deps.file }).then(
				({ media }) => media,
				() => undefined,
			);
		}
		const usedIn = selected ? (await api.media.usage({ siteId, mediaId: selected.id })).usedIn : [];
		return { list, folders, overview, selected: selected ?? null, usedIn };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "media.pageTitle") }] }),
	component: MediaPage,
});

/** Site › Media: the Site's Media library, with folders, search, filters, the Trash and each file's details. */
function MediaPage() {
	const data = Route.useLoaderData();
	const searchParams = Route.useSearch();
	const { siteId } = Route.useParams();
	const { place } = Route.useRouteContext();
	const navigate = useNavigate({ from: Route.fullPath });
	const router = useRouter();
	return (
		<MediaLibrary
			siteId={siteId}
			permissions={place.permissions}
			list={data.list}
			folders={data.folders}
			overview={data.overview}
			selected={data.selected}
			usedIn={data.usedIn}
			search={searchParams}
			onSearch={(next, options) =>
				navigate({ search: (current) => ({ ...current, ...next }), replace: options?.replace })
			}
			onChanged={() => router.invalidate()}
		/>
	);
}
