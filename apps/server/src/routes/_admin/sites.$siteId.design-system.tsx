import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { DesignSystemScreen } from "../../ui/design-system/DesignSystemScreen.tsx";
import { useLeaveOnClose } from "../../ui/history/leave.ts";
import { pageTitle, useT } from "../../ui/i18n.tsx";
import { Forbidden } from "../../ui/PageHeader.tsx";

/** Which tab is open, and the Class selected in the Classes tab. */
const search = z.object({
	tab: z.enum(["tokens", "classes", "base", "css"]).optional().catch(undefined),
	class: z.string().max(64).optional().catch(undefined),
});

/** Site › Design system (Structure, Staff only): Design tokens, Classes, base styles and custom CSS. */
export const Route = createFileRoute("/_admin/sites/$siteId/design-system")({
	staticData: { crumb: "designSystem.pageTitle", wide: true },
	validateSearch: search,
	loader: async ({ context, params }) => {
		if (!context.place.permissions.includes("structure.edit")) return { designSystem: null, preview: null };
		const api = await getApi();
		const [{ designSystem }, { preview }] = await Promise.all([
			api.designSystem.get({ siteId: params.siteId }),
			api.designSystem.preview({ siteId: params.siteId }),
		]);
		return { designSystem, preview };
	},
	head: ({ match }) => ({
		meta: [{ title: pageTitle(match.context.shell.language.code, "designSystem.pageTitle") }],
	}),
	component: DesignSystemPage,
});

function DesignSystemPage() {
	const t = useT();
	const { designSystem, preview } = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { tab, class: classId } = Route.useSearch();
	// Closing the screen keeps the Draft as a Checkpoint when it changed.
	useLeaveOnClose(siteId, { kind: "designSystem" });
	if (!designSystem || !preview) {
		return <Forbidden heading={t("designSystem.heading")} body={t("designSystem.staffOnly")} />;
	}
	return (
		<DesignSystemScreen siteId={siteId} designSystem={designSystem} preview={preview} tab={tab} classId={classId} />
	);
}
