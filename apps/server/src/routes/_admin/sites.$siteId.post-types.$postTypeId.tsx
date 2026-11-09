import { createFileRoute, notFound, useNavigate } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { useCallback } from "react";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { DataTab } from "../../ui/content/DataTab.tsx";
import { SearchSettings } from "../../ui/content/SearchSettings.tsx";
import { StructureEditor } from "../../ui/content/StructureEditor.tsx";
import { errorCode } from "../../ui/errors.ts";
import { useT } from "../../ui/i18n.tsx";
import { Tabs } from "../../ui/Tabs.tsx";

/** Which tab is open: the Fields, the Data tab of the Post Type's Entry template, or its Site search settings. */
const search = z.object({ tab: z.enum(["fields", "data", "search"]).optional().catch(undefined) });

/** One Post Type's settings and Fields (Structure), the Data tab of its Entry template, and its Site search settings. */
export const Route = createFileRoute("/_admin/sites/$siteId/post-types/$postTypeId")({
	validateSearch: search,
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
	const t = useT();
	const navigate = useNavigate();
	const { postType, postTypes } = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { tab } = Route.useSearch();
	const { place } = Route.useRouteContext();
	const postTypeId = postType?.id ?? "";
	const load = useCallback(
		async (language: string) => (await getApi()).postTypes.data({ siteId, postTypeId, language }),
		[siteId, postTypeId],
	);
	if (!postType || place.level !== "site") return null;
	const defaultLanguage = place.languages.default;
	const editor = (embedded: boolean) => (
		<StructureEditor
			embedded={embedded}
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
	const searchTab = {
		id: "search",
		label: t("postTypes.tabs.search"),
		panel: <SearchSettings key={postType.id} postType={postType} siteId={siteId} />,
	};
	// Pages are arranged with a Page layout, so they have no Entry template to read the Data of.
	const tabs =
		postType.builtIn === "page"
			? [{ id: "fields", label: t("postTypes.tabs.fields"), panel: editor(true) }, searchTab]
			: [
					{ id: "fields", label: t("postTypes.tabs.fields"), panel: editor(true) },
					{
						id: "data",
						label: t("postTypes.tabs.data"),
						panel: <DataTab load={load} languages={place.languages} intro="data.entryTemplateIntro" />,
					},
					searchTab,
				];
	return (
		<div className="grid min-w-0 content-start gap-6">
			<div className="flex flex-wrap items-center gap-3">
				<h1 className="text-2xl font-semibold tracking-tight">{postType.name}</h1>
				<Badge variant="outline">{t("postTypes.staffOnly")}</Badge>
			</div>
			<Tabs
				key={postType.id}
				label={t("postTypes.tabs.label", { name: postType.name })}
				initial={tab}
				onSelect={(id) =>
					void navigate({
						to: "/sites/$siteId/post-types/$postTypeId",
						params: { siteId, postTypeId: postType.id },
						search: { tab: id === "data" || id === "search" ? id : undefined },
						replace: true,
					})
				}
				tabs={tabs}
			/>
		</div>
	);
}
