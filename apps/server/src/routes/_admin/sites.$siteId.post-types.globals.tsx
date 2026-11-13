import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { Badge } from "@webcraft/ui/components/badge.tsx";
import { useCallback } from "react";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { DataTab } from "../../ui/content/DataTab.tsx";
import { StructureEditor } from "../../ui/content/StructureEditor.tsx";
import { useT } from "../../ui/i18n.tsx";
import { Tabs } from "../../ui/Tabs.tsx";

/** Which tab is open: the Fields, or the Globals' Data tab. */
const search = z.object({ tab: z.enum(["fields", "data"]).optional().catch(undefined) });

/**
 * The Globals' Fields (Structure): one set of values per Site, which every Template reads as `site.x`,
 * and their Data tab.
 */
export const Route = createFileRoute("/_admin/sites/$siteId/post-types/globals")({
	staticData: { crumb: "postTypes.globals.heading" },
	validateSearch: search,
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) return { globals: null };
		const api = await getApi();
		const { globals } = await api.globals.get({ siteId: params.siteId });
		return { globals };
	},
	component: GlobalFieldsPage,
});

function GlobalFieldsPage() {
	const t = useT();
	const navigate = useNavigate();
	const { globals } = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { tab } = Route.useSearch();
	const { place } = Route.useRouteContext();
	const load = useCallback(async (language: string) => (await getApi()).globals.data({ siteId, language }), [siteId]);
	if (!globals || place.level !== "site") return null;
	const defaultLanguage = place.languages.default;
	const editor = (embedded: boolean) => (
		<StructureEditor
			embedded={embedded}
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
	return (
		<div className="grid min-w-0 content-start gap-6">
			<div className="flex flex-wrap items-center gap-3">
				<h1 className="text-2xl font-semibold tracking-tight">{t("postTypes.globals.heading")}</h1>
				<Badge variant="outline">{t("postTypes.staffOnly")}</Badge>
			</div>
			<Tabs
				label={t("postTypes.tabs.globalsLabel")}
				initial={tab}
				onSelect={(id) =>
					void navigate({
						to: "/sites/$siteId/post-types/globals",
						params: { siteId },
						search: { tab: id === "data" ? "data" : undefined },
						replace: true,
					})
				}
				tabs={[
					{ id: "fields", label: t("postTypes.tabs.fields"), panel: editor(true) },
					{
						id: "data",
						label: t("postTypes.tabs.data"),
						panel: <DataTab load={load} languages={place.languages} intro="data.globalsIntro" />,
					},
				]}
			/>
		</div>
	);
}
