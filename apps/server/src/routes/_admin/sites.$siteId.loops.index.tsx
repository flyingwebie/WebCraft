import { createFileRoute, redirect } from "@tanstack/react-router";

import { getApi } from "../../ui/api.ts";
import { useT } from "../../ui/i18n.tsx";

/** Opens the Site's first Loop; with none yet, says how to make one. */
export const Route = createFileRoute("/_admin/sites/$siteId/loops/")({
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) return;
		const api = await getApi();
		const { loops } = await api.loops.list({ siteId: params.siteId });
		const [first] = loops;
		if (first) {
			throw redirect({
				to: "/sites/$siteId/loops/$loopId",
				params: { siteId: params.siteId, loopId: first.id },
				replace: true,
			});
		}
	},
	component: NoLoops,
});

function NoLoops() {
	const t = useT();
	const { place } = Route.useRouteContext();
	if (!place.permissions.includes("structure.edit")) return null;
	return (
		<div className="grid content-start gap-2">
			<h1 className="text-2xl font-semibold tracking-tight">{t("loops.pageTitle")}</h1>
			<p className="text-muted-foreground">{t("loops.intro")}</p>
		</div>
	);
}
