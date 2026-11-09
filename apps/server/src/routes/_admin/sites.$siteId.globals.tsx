import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { GlobalsEditor } from "../../ui/content/GlobalsEditor.tsx";
import { loadMedia } from "../../ui/content/loaders.ts";
import { HISTORY_CARD_COPIES } from "../../ui/history/HistoryCard.tsx";
import { useLeaveOnClose } from "../../ui/history/leave.ts";
import { pageTitle } from "../../ui/i18n.tsx";

/** Which language the editor shows; the Site's Default language when none is given. */
const search = z.object({ language: z.string().min(2).max(35).optional().catch(undefined) });

export const Route = createFileRoute("/_admin/sites/$siteId/globals")({
	staticData: { crumb: "globals.pageTitle", wide: true },
	validateSearch: search,
	loaderDeps: ({ search: { language } }) => ({ language }),
	loader: async ({ params, deps }) => {
		const api = await getApi();
		const { globals } = await api.globals.get({ siteId: params.siteId, language: deps.language });
		const [media, history] = await Promise.all([
			loadMedia(api, params.siteId, globals.fields, globals.draft),
			api.history.list({ siteId: params.siteId, item: { kind: "globals" }, limit: HISTORY_CARD_COPIES }),
		]);
		return { globals, media, history };
	},
	head: ({ match }) => ({ meta: [{ title: pageTitle(match.context.shell.language.code, "globals.pageTitle") }] }),
	component: GlobalsPage,
});

/** Site › Globals: the Site's site-wide values, saved to their Draft as people type, and published per role. */
function GlobalsPage() {
	const { globals, media, history } = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { place } = Route.useRouteContext();
	// Closing the editor keeps the Draft as a Checkpoint when it changed.
	useLeaveOnClose(siteId, { kind: "globals" });
	if (place.level !== "site") return null;
	return (
		<GlobalsEditor
			key={globals.language}
			siteId={siteId}
			globals={globals}
			permissions={place.permissions}
			languages={place.languages}
			media={media}
			history={history}
		/>
	);
}
