import { createFileRoute, notFound } from "@tanstack/react-router";
import { z } from "zod";

import { getApi } from "../../ui/api.ts";
import { LoopEditor } from "../../ui/content/LoopEditor.tsx";
import { errorCode } from "../../ui/errors.ts";

/** Which tab is open, and the language Loop items are written in (the Default language when none is given). */
const search = z.object({
	tab: z.enum(["settings", "items", "data"]).optional().catch(undefined),
	language: z.string().min(2).max(35).optional().catch(undefined),
});

/** One Loop's screen (Structure): its settings, its Loop items and its Data tab. */
export const Route = createFileRoute("/_admin/sites/$siteId/loops/$loopId")({
	validateSearch: search,
	loaderDeps: ({ search: { language } }) => ({ language }),
	loader: async ({ context, params, deps }) => {
		if (!context.place.permissions.includes("structure.edit")) return { loop: null, postTypes: [], crumb: undefined };
		const api = await getApi();
		try {
			const [{ loop }, { postTypes }] = await Promise.all([
				api.loops.get({ siteId: params.siteId, loopId: params.loopId, language: deps.language }),
				api.postTypes.list({ siteId: params.siteId }),
			]);
			return { loop, postTypes, crumb: loop.name };
		} catch (error) {
			if (errorCode(error) === "LOOP_NOT_FOUND" || errorCode(error) === "BAD_REQUEST") throw notFound();
			throw error;
		}
	},
	component: LoopPage,
});

function LoopPage() {
	const { loop, postTypes } = Route.useLoaderData();
	const { siteId } = Route.useParams();
	const { tab } = Route.useSearch();
	const { place } = Route.useRouteContext();
	if (!loop || place.level !== "site") return null;
	return (
		<LoopEditor
			key={`${loop.id}:${loop.language}`}
			siteId={siteId}
			loop={loop}
			postTypes={postTypes}
			languages={place.languages}
			tab={tab}
		/>
	);
}
